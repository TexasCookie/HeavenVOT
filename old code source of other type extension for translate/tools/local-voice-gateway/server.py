#!/usr/bin/env python3
"""
AetherVox local voice gateway — xAI-compatible REST surface, zero moderation.

  POST /v1/stt              → Faster-Whisper
  POST /v1/tts              → Piper (or SAPI fallback)
  GET  /v1/tts/voices
  POST /v1/chat/completions → LM Studio proxy (optional llama-cpp fallback)
  POST /v1/media/youtube-audio → yt-dlp bestaudio (cookies-from-browser)
  GET  /v1/media/cache/{id} → serve downloaded audio
  GET  /v1/models
  GET  /health

No content filtering. Transcripts / translations / TTS text pass through as-is.
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import shutil
import struct
import subprocess
import tempfile
import threading
import time
import uuid
import wave
from pathlib import Path
from typing import Any, Optional

import httpx
import numpy as np
import soundfile as sf
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from gateway_policy import (
    cache_file_is_safe,
    clamp_tts_speed,
    looks_like_raw_pcm16,
    extract_spoken_text,
    is_allowed_video_id,
    is_allowed_ytdlp_url,
    is_safe_proxy_path,
    output_audio_media_type,
    piper_matches_gender,
    resample_to_16k,
    sanitize_media_token,
    wants_cyrillic_target,
)

ROOT = Path(__file__).resolve().parent
MODELS = ROOT / "models"
WHISPER_DIR = MODELS / "whisper"
PIPER_DIR = MODELS / "piper"
LLM_DIR = MODELS / "llm"
VOICES_META = json.loads((ROOT / "voices.json").read_text(encoding="utf-8"))

LM_STUDIO_BASE = os.environ.get("LM_STUDIO_BASE", "http://127.0.0.1:1234/v1").rstrip("/")
HOST = os.environ.get("AV_GATEWAY_HOST", "127.0.0.1")
PORT = int(os.environ.get("AV_GATEWAY_PORT", "8788"))
WHISPER_MODEL = os.environ.get("AV_WHISPER_MODEL", "distil-large-v3")
WHISPER_FALLBACK = os.environ.get("AV_WHISPER_FALLBACK", "tiny")
LOCAL_WHISPER = os.environ.get(
    "AV_LOCAL_WHISPER",
    str(WHISPER_DIR / "faster-distil-whisper-large-v3"),
)
LOCAL_WHISPER_FALLBACK = os.environ.get(
    "AV_LOCAL_WHISPER_FALLBACK",
    str(WHISPER_DIR / "faster-whisper-tiny"),
)
LOCAL_GGUF = os.environ.get(
    "AV_LOCAL_GGUF",
    str(LLM_DIR / "Qwen2.5-7B-Instruct-abliterated.Q4_K_M.gguf"),
)
DEFAULT_CHAT_MODEL = os.environ.get(
    "AV_CHAT_MODEL", "auto"
)

# --- lazy engines -----------------------------------------------------------

_whisper = None
_whisper_name = ""
_llama = None
_whisper_lock = threading.Lock()
_llama_lock = threading.Lock()
_piper_cache: dict[str, Any] = {}
_media_cache: dict[str, dict[str, Any]] = {}
MEDIA_CACHE_DIR = ROOT / ".media-cache"
MEDIA_CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _load_whisper():
    global _whisper, _whisper_name
    if _whisper is not None:
        return _whisper
    with _whisper_lock:
        if _whisper is not None:
            return _whisper
        return _load_whisper_unlocked()


def _load_whisper_unlocked():
    global _whisper, _whisper_name
    from faster_whisper import WhisperModel

    WHISPER_DIR.mkdir(parents=True, exist_ok=True)
    device = "cuda" if os.environ.get("AV_WHISPER_DEVICE") == "cuda" else "cpu"
    compute = "float16" if device == "cuda" else "int8"

    # Prefer fully-local folders first (no Hub hit)
    candidates = []
    for p in (LOCAL_WHISPER, LOCAL_WHISPER_FALLBACK):
        local = Path(p)
        if (local / "model.bin").is_file():
            candidates.append(str(local))
    candidates.extend([WHISPER_MODEL, WHISPER_FALLBACK, "tiny"])

    last_err = None
    for name in candidates:
        try:
            # local_files_only when path exists on disk — never hit Hub
            local_only = Path(name).is_dir()
            _whisper = WhisperModel(
                name,
                device=device,
                compute_type=compute,
                download_root=str(WHISPER_DIR),
                local_files_only=local_only,
            )
            _whisper_name = name
            print(f"[gateway] Whisper loaded: {name} ({device}/{compute})")
            return _whisper
        except Exception as e:
            last_err = e
            print(f"[gateway] Whisper {name} failed: {e}")
    raise RuntimeError(f"Could not load Faster-Whisper model: {last_err}")


def _pcm16_mono_wav_bytes(audio: np.ndarray, sr: int) -> bytes:
    audio = np.asarray(audio, dtype=np.float32)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    pcm = np.clip(audio, -1.0, 1.0)
    pcm_i16 = (pcm * 32767.0).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm_i16.tobytes())
    return buf.getvalue()


def _read_upload_audio(data: bytes) -> tuple[np.ndarray, int]:
    """Decode wav/mp3/flac/ogg → float32 mono + sample rate."""
    try:
        audio, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=False)
        if getattr(audio, "ndim", 1) > 1:
            audio = audio.mean(axis=1)
        return resample_to_16k(np.asarray(audio, dtype=np.float32), int(sr))
    except Exception:
        if not looks_like_raw_pcm16(data):
            raise
        pcm = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
        return pcm, 16000


def _pick_piper_voice(voice_id: str, language: str, gender: str) -> Optional[Path]:
    """Resolve onnx under models/piper/. Zero filtering — pick by lang/gender."""
    PIPER_DIR.mkdir(parents=True, exist_ok=True)
    defaults = VOICES_META.get("piperDefaults") or {}
    lang = (language or "ru").lower()[:2]
    g = (gender or "female").lower()
    key = f"{lang}_{'female' if g != 'male' else 'male'}"
    preferred = defaults.get(key) or defaults.get("ru_female")
    # Explicit map from voice catalog — refuse male stem for female voices
    for v in VOICES_META.get("voices") or []:
        if v.get("voice_id") == voice_id and v.get("piper"):
            stem = str(v["piper"])
            if piper_matches_gender(stem, v.get("gender") or g):
                preferred = stem
            break
    candidates = []
    if preferred:
        candidates.append(PIPER_DIR / f"{preferred}.onnx")
    # Any onnx matching language
    for p in sorted(PIPER_DIR.glob("*.onnx")):
        if lang in p.name.lower() and piper_matches_gender(p.stem, g):
            candidates.append(p)
    for p in sorted(PIPER_DIR.glob("*.onnx")):
        if piper_matches_gender(p.stem, g):
            candidates.append(p)
    for c in candidates:
        if c.is_file():
            return c
    return None


def _tts_piper(text: str, onnx: Path, speed: float = 1.0) -> bytes:
    """Synthesize with piper CLI or piper-tts Python API → wav bytes."""
    # Try python API first
    try:
        from piper import PiperVoice  # type: ignore

        key = str(onnx)
        if key not in _piper_cache:
            _piper_cache[key] = PiperVoice.load(str(onnx))
        voice = _piper_cache[key]
        scale = 1.0 / max(0.5, min(2.0, speed))
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            try:
                voice.synthesize(text, w, length_scale=scale)
            except TypeError:
                syn = getattr(voice, "synthesize", None)
                cfg = None
                try:
                    from piper.config import SynthesisConfig  # type: ignore

                    cfg = SynthesisConfig(length_scale=scale)
                except Exception:
                    cfg = None
                chunks = syn(text, syn_config=cfg) if cfg is not None else syn(text)
                wrote_hdr = False
                for ch in chunks or []:
                    audio = getattr(ch, "audio_int16_bytes", None) or getattr(
                        ch, "audio_int16", None
                    )
                    sr = int(getattr(ch, "sample_rate", 22050) or 22050)
                    if audio is None:
                        continue
                    raw = bytes(audio) if not isinstance(audio, (bytes, bytearray)) else bytes(audio)
                    if not wrote_hdr:
                        w.setnchannels(1)
                        w.setsampwidth(2)
                        w.setframerate(sr)
                        wrote_hdr = True
                    w.writeframes(raw)
                if not wrote_hdr:
                    raise RuntimeError("piper iterator produced no audio")
        return buf.getvalue()
    except Exception as e:
        print(f"[gateway] piper-tts API: {e}; trying CLI")

    piper_bin = os.environ.get("PIPER_BIN", "piper")
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "out.wav"
        cmd = [
            piper_bin,
            "--model",
            str(onnx),
            "--output_file",
            str(out),
            "--length_scale",
            str(1.0 / max(0.5, min(2.0, speed))),
        ]
        proc = subprocess.run(
            cmd,
            input=text.encode("utf-8"),
            capture_output=True,
            check=False,
            timeout=60,
        )
        if proc.returncode != 0 or not out.is_file():
            raise RuntimeError(
                f"piper failed: {proc.stderr.decode('utf-8', 'ignore')[:400]}"
            )
        return out.read_bytes()


def _tts_sapi_fallback(text: str, speed: float = 1.0) -> bytes:
    """Windows SAPI via PowerShell — local, no content filter."""
    rate = int(max(-10, min(10, round((speed - 1.0) * 10))))
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "out.wav"
        # Escape for PowerShell single-quoted string
        text_path = Path(td) / "speak.txt"
        text_path.write_text(text, encoding="utf-8")
        out_posix = out.as_posix().replace("'", "''")
        text_posix = text_path.as_posix().replace("'", "''")
        ps = f"""
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.Rate = {rate}
$s.SetOutputToWaveFile('{out_posix}')
$s.Speak([IO.File]::ReadAllText('{text_posix}', [Text.Encoding]::UTF8))
$s.Dispose()
"""
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps],
            capture_output=True,
            check=False,
            timeout=60,
        )
        if proc.returncode != 0 or not out.is_file():
            raise RuntimeError(
                f"SAPI TTS failed: {proc.stderr.decode('utf-8', 'ignore')[:300]}"
            )
        return out.read_bytes()


def _wav_to_mp3_or_wav(wav_bytes: bytes, codec: str) -> tuple[bytes, str]:
    # WAV only — never advertise mp3 for a wav body
    return wav_bytes, output_audio_media_type(codec)


def _gender_for_voice(voice_id: str) -> str:
    for v in VOICES_META.get("voices") or []:
        if v.get("voice_id") == voice_id:
            return v.get("gender") or "female"
    if voice_id in ("orion", "zagan", "rex", "fenrir", "asus"):
        return "male"
    return "female"


async def _lm_studio_up() -> bool:
    try:
        async with httpx.AsyncClient(timeout=1.5) as client:
            r = await client.get(f"{LM_STUDIO_BASE}/models")
            return r.status_code < 500
    except Exception:
        return False


def _load_llama():
    global _llama
    if _llama is not None:
        return _llama
    with _llama_lock:
        if _llama is not None:
            return _llama
        path = Path(LOCAL_GGUF)
        if not path.is_file():
            return None
        try:
            from llama_cpp import Llama  # type: ignore

            _llama = Llama(
                model_path=str(path),
                n_ctx=8192,
                n_gpu_layers=int(os.environ.get("AV_N_GPU_LAYERS", "-1")),
                verbose=False,
            )
            print(f"[gateway] llama-cpp loaded: {path.name}")
            return _llama
        except Exception as e:
            print(f"[gateway] llama-cpp unavailable: {e}")
            return None


def _chat_local_llama(messages: list, temperature: float, max_tokens: int) -> str:
    llm = _load_llama()
    if llm is None:
        raise RuntimeError(
            "LM Studio not reachable and local GGUF/llama-cpp not available"
        )
    # Zero-censorship: no extra system refuse prompt
    out = llm.create_chat_completion(
        messages=messages,
        temperature=temperature,
        max_tokens=max_tokens,
        top_p=0.9,
        repeat_penalty=1.05,
    )
    return (out["choices"][0]["message"]["content"] or "").strip()


# --- app --------------------------------------------------------------------

app = FastAPI(title="AetherVox Local Voice Gateway", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    ytdlp_ok = False
    ytdlp_ver = None
    try:
        import yt_dlp

        ytdlp_ok = True
        ytdlp_ver = getattr(yt_dlp.version, "__version__", "ok")
    except Exception:  # noqa: BLE001
        ytdlp_ok = False
    lm = await _lm_studio_up()
    gguf = Path(LOCAL_GGUF).is_file()
    piper_n = len(list(PIPER_DIR.glob("*.onnx"))) if PIPER_DIR.exists() else 0
    whisper_disk = any(
        (Path(p) / "model.bin").is_file() for p in (LOCAL_WHISPER, LOCAL_WHISPER_FALLBACK)
    )
    ready = {
        "stt": bool(_whisper_name) or whisper_disk,
        "tts": piper_n > 0,
        "chat": bool(lm or gguf),
        "ytdlp": ytdlp_ok,
    }
    engines_ok = ready["tts"] or ready["stt"] or ready["chat"]
    return {
        "ok": engines_ok,
        "zero_censorship": True,
        "service": "aethervox-local-voice-gateway",
        "whisper": _whisper_name or WHISPER_MODEL,
        "lm_studio": lm,
        "lm_studio_base": LM_STUDIO_BASE,
        "local_gguf": gguf,
        "piper_voices": piper_n,
        "chat_model": DEFAULT_CHAT_MODEL,
        "ytdlp": ytdlp_ok,
        "ytdlpVersion": ytdlp_ver,
        "mediaCache": len(_media_cache),
        "ready": ready,
        "degraded": not all(ready.values()),
    }


def _guess_mime(path: Path) -> str:
    ext = path.suffix.lower()
    return {
        ".m4a": "audio/mp4",
        ".mp4": "audio/mp4",
        ".webm": "audio/webm",
        ".opus": "audio/opus",
        ".ogg": "audio/ogg",
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".flac": "audio/flac",
    }.get(ext, "application/octet-stream")


def _prune_media_cache(max_age_sec: float = 3600.0, max_items: int = 8) -> None:
    """Drop old in-memory entries and leftover cookie/audio files."""
    now = time.time()
    stale = [
        k
        for k, v in _media_cache.items()
        if now - float(v.get("created") or 0) > max_age_sec
    ]
    for k in stale:
        entry = _media_cache.pop(k, None)
        if not entry:
            continue
        try:
            p = Path(entry.get("path") or "")
            if p.is_file() and p.parent == MEDIA_CACHE_DIR:
                p.unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            pass
    while len(_media_cache) > max_items:
        oldest = min(
            _media_cache.items(),
            key=lambda kv: float(kv[1].get("created") or 0),
        )[0]
        entry = _media_cache.pop(oldest, None)
        if not entry:
            break
        try:
            p = Path(entry.get("path") or "")
            if p.is_file() and p.parent == MEDIA_CACHE_DIR:
                p.unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            pass
    try:
        for leftover in MEDIA_CACHE_DIR.glob("*.cookies.txt"):
            if now - leftover.stat().st_mtime > 300:
                leftover.unlink(missing_ok=True)
    except Exception:  # noqa: BLE001
        pass


def _download_youtube_audio(url: str, cookies_txt: str | None = None) -> dict[str, Any]:
    """yt-dlp bestaudio — prefers cookies exported from the extension (Arc-safe)."""
    try:
        import yt_dlp
    except ImportError as e:
        raise HTTPException(
            503,
            "yt-dlp not installed — pip install yt-dlp in gateway venv",
        ) from e

    token = uuid.uuid4().hex[:16]
    out_tmpl = str(MEDIA_CACHE_DIR / f"{token}.%(ext)s")
    cookie_file: Path | None = None
    if cookies_txt and len(cookies_txt) > 40:
        cookie_file = MEDIA_CACHE_DIR / f"{token}.cookies.txt"
        cookie_file.write_text(cookies_txt, encoding="utf-8")
    _prune_media_cache()

    def _base_opts() -> dict[str, Any]:
        opts: dict[str, Any] = {
            "format": "bestaudio/best",
            "outtmpl": out_tmpl,
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
            "noplaylist": True,
            "ignoreconfig": True,
            "socket_timeout": 20,
            "retries": 5,
            "fragment_retries": 5,
            "extractor_args": {
                "youtube": {
                    "player_client": ["android_vr", "web_safari", "tv", "web"],
                }
            },
            "http_headers": {
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/128.0.0.0 Safari/537.36"
                ),
                "Referer": "https://www.youtube.com/",
            },
        }
        if cookie_file and cookie_file.is_file():
            opts["cookiefile"] = str(cookie_file)
        return opts

    last_err = "unknown"
    info: dict[str, Any] = {}

    try:
        # 1) Extension cookies (best for Arc / locked Chrome DB)
        if cookie_file:
            try:
                with yt_dlp.YoutubeDL(_base_opts()) as ydl:
                    info = ydl.extract_info(url, download=True) or {}
                last_err = ""
            except Exception as e:  # noqa: BLE001
                last_err = f"cookiefile: {e}"

        # 2) Browser cookie DB fallbacks
        if last_err:
            browsers = ("chrome", "edge", "brave", "chromium", "firefox")
            for browser in browsers:
                opts = _base_opts()
                opts.pop("cookiefile", None)
                try:
                    opts["cookiesfrombrowser"] = (browser,)
                    with yt_dlp.YoutubeDL(opts) as ydl:
                        info = ydl.extract_info(url, download=True) or {}
                    last_err = ""
                    break
                except Exception as e:  # noqa: BLE001
                    last_err = f"{browser}: {e}"
                    continue

        # 3) No cookies last resort
        if last_err:
            try:
                opts = _base_opts()
                opts.pop("cookiefile", None)
                with yt_dlp.YoutubeDL(opts) as ydl:
                    info = ydl.extract_info(url, download=True) or {}
                last_err = ""
            except Exception as e:  # noqa: BLE001
                raise HTTPException(
                    502, f"yt-dlp failed: {last_err} · nocookie: {e}"
                ) from e
    finally:
        if cookie_file is not None:
            try:
                cookie_file.unlink(missing_ok=True)
            except Exception:  # noqa: BLE001
                pass

    candidates = list(MEDIA_CACHE_DIR.glob(f"{token}.*"))
    candidates = [c for c in candidates if c.suffix.lower() != ".txt"]
    if not candidates and info.get("requested_downloads"):
        for d in info["requested_downloads"]:
            p = Path(d.get("filepath") or "")
            if p.is_file():
                candidates = [p]
                break
    if not candidates:
        raise HTTPException(500, "yt-dlp produced no file")

    path = candidates[0]
    for c in candidates:
        if c.suffix.lower() in {".m4a", ".webm", ".opus", ".mp3", ".ogg", ".wav"}:
            path = c
            break

    mime = _guess_mime(path)
    duration = float(info.get("duration") or 0)
    title = str(info.get("title") or "")
    entry = {
        "path": str(path),
        "mime": mime,
        "durationSec": duration,
        "title": title,
        "created": time.time(),
        "bytes": path.stat().st_size,
    }
    _media_cache[token] = entry
    return {
        "ok": True,
        "id": token,
        "mime": mime,
        "durationSec": duration,
        "title": title,
        "byteLength": entry["bytes"],
        "streamUrl": f"http://{HOST}:{PORT}/v1/media/cache/{token}",
        "source": "yt-dlp-local",
    }


@app.post("/v1/media/youtube-audio")
async def youtube_audio(request: Request):
    body = await request.json()
    video_id = str(body.get("videoId") or "").strip()
    url = str(body.get("url") or "").strip()
    cookies_txt = body.get("cookiesTxt") or body.get("cookies") or None
    if cookies_txt is not None:
        cookies_txt = str(cookies_txt)
    if video_id and not is_allowed_video_id(video_id):
        raise HTTPException(400, "invalid videoId")
    if not url and video_id:
        url = f"https://www.youtube.com/watch?v={video_id}"
    if not url:
        raise HTTPException(400, "url or videoId required")
    if not is_allowed_ytdlp_url(url):
        raise HTTPException(400, "url must be a YouTube watch/embed/shorts link")
    return await asyncio.to_thread(_download_youtube_audio, url, cookies_txt)


@app.get("/v1/media/cache/{token}")
async def media_cache_get(token: str):
    safe = sanitize_media_token(token)
    if not safe:
        raise HTTPException(400, "invalid cache token")
    token = safe
    entry = _media_cache.get(token)
    if not entry:
        # Disk fallback after gateway restart
        matches = [
            c
            for c in MEDIA_CACHE_DIR.glob(f"{token}.*")
            if c.suffix.lower()
            in {".m4a", ".mp4", ".webm", ".opus", ".ogg", ".mp3", ".wav", ".flac"}
            and cache_file_is_safe(c, MEDIA_CACHE_DIR)
        ]
        if not matches:
            raise HTTPException(404, "cache miss")
        path = matches[0]
        return Response(
            content=path.read_bytes(),
            media_type=_guess_mime(path),
            headers={"Cache-Control": "no-store"},
        )
    path = Path(entry["path"])
    if not cache_file_is_safe(path, MEDIA_CACHE_DIR):
        raise HTTPException(404, "file gone")
    return Response(
        content=path.read_bytes(),
        media_type=entry.get("mime") or _guess_mime(path),
        headers={"Cache-Control": "no-store"},
    )


@app.get("/v1/models")
async def list_models():
    data = {"object": "list", "data": []}
    if await _lm_studio_up():
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                r = await client.get(f"{LM_STUDIO_BASE}/models")
                if r.status_code == 200:
                    return JSONResponse(r.json())
        except Exception:
            pass
    data["data"].append(
        {
            "id": DEFAULT_CHAT_MODEL,
            "object": "model",
            "owned_by": "aethervox-local",
        }
    )
    return data


@app.get("/v1/tts/voices")
async def tts_voices():
    # Shape compatible with xAI client.validateKey / listVoices
    voices = []
    for v in VOICES_META.get("voices") or []:
        voices.append(
            {
                "voice_id": v["voice_id"],
                "name": v.get("name") or v["voice_id"],
                "language": v.get("language") or "ru",
                "gender": v.get("gender") or "neutral",
            }
        )
    return {"voices": voices}


@app.post("/v1/stt")
async def stt(
    file: UploadFile = File(...),
    language: Optional[str] = Form(None),
    format: Optional[str] = Form(None),  # noqa: A002 — xAI field name
    filler_words: Optional[str] = Form(None),
    vad_threshold: Optional[str] = Form(None),
):
    """Multipart STT — no keyterms filtering / no content moderation."""
    raw = await file.read()
    if not raw:
        return {"text": ""}
    if len(raw) > 25 * 1024 * 1024:
        raise HTTPException(413, "audio too large")
    try:
        audio, sr = _read_upload_audio(raw)
    except Exception as e:
        raise HTTPException(400, f"audio decode failed: {e}") from e

    lang = (language or "").strip() or None
    if lang and lang.lower() in ("auto", "detect", ""):
        lang = None

    def _run_stt():
        model = _load_whisper()
        segments, info = model.transcribe(
            audio,
            language=lang,
            beam_size=1,
            vad_filter=True,
            condition_on_previous_text=False,
            word_timestamps=False,
        )
        parts = []
        for seg in segments:
            t = (seg.text or "").strip()
            if t:
                parts.append(t)
        return " ".join(parts).strip(), info

    text, info = await asyncio.to_thread(_run_stt)
    return {
        "text": text,
        "language": getattr(info, "language", lang) or "",
        "duration": getattr(info, "duration", None),
        "model": _whisper_name,
    }


@app.post("/v1/tts")
async def tts(request: Request):
    body = await request.json()
    text = str(body.get("text") or "")
    # Zero-censorship: never strip/mask text
    if not text.strip():
        return Response(content=b"", media_type="audio/wav")

    voice_id = str(body.get("voice_id") or "ara").lower()
    language = str(body.get("language") or "ru")
    speed = clamp_tts_speed(body.get("speed"), 1.0)
    out_fmt = body.get("output_format") or {}
    codec = str(out_fmt.get("codec") or "mp3")

    gender = _gender_for_voice(voice_id)
    onnx = _pick_piper_voice(voice_id, language, gender)

    def _run_tts():
        try:
            if onnx:
                return _tts_piper(text, onnx, speed=speed)
            return _tts_sapi_fallback(text, speed=speed)
        except Exception as e:
            try:
                return _tts_sapi_fallback(text, speed=speed)
            except Exception as e2:
                raise RuntimeError(f"TTS failed: {e}; fallback: {e2}") from e2

    try:
        wav = await asyncio.to_thread(_run_tts)
    except Exception as e:
        raise HTTPException(500, str(e)) from e

    data, ctype = _wav_to_mp3_or_wav(wav, codec)
    return Response(content=data, media_type=ctype)


def _extract_chat_text(data: dict, messages: list | None = None) -> str:
    """Pull assistant text; some local models put output only in reasoning_content."""
    try:
        msg = ((data.get("choices") or [{}])[0].get("message")) or {}
    except Exception:
        return ""
    content = str(msg.get("content") or "").strip()
    reason = str(
        msg.get("reasoning_content")
        or msg.get("reasoning")
        or data.get("output_text")
        or ""
    ).strip()
    prefer_cyr = wants_cyrillic_target(messages)
    return extract_spoken_text(content, reason, prefer_cyrillic=prefer_cyr)


async def _lm_studio_models() -> list[str]:
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.get(f"{LM_STUDIO_BASE}/models")
            if r.status_code >= 400:
                return []
            data = r.json()
            ids = []
            for m in data.get("data") or []:
                mid = str(m.get("id") or "")
                if not mid:
                    continue
                low = mid.lower()
                if "embed" in low:
                    continue
                ids.append(mid)
            return ids
    except Exception:
        return []


async def _resolve_chat_model(requested: str) -> str:
    ids = await _lm_studio_models()
    if not ids:
        return requested or DEFAULT_CHAT_MODEL
    req = (requested or "").strip()
    if req and req not in ("auto", "default") and req in ids:
        return req

    def score(mid: str) -> int:
        low = mid.lower()
        s = 0
        if "abliterat" in low or "uncensor" in low:
            s += 20
        if "instruct" in low or "chat" in low:
            s += 5
        if "coder" in low:
            s += 2
        # Prefer mid-size that fits consumer VRAM
        if any(x in low for x in ("3b", "4b", "7b", "8b", "9b")):
            s += 10
        if any(x in low for x in ("14b", "15b")):
            s += 4
        if any(x in low for x in ("30b", "32b", "34b", "70b", "72b")):
            s -= 25
        if "smollm" in low or "135m" in low:
            s -= 5  # too weak for MT quality
        return s

    ranked = sorted(ids, key=score, reverse=True)
    return ranked[0] if ranked else (req or DEFAULT_CHAT_MODEL)


async def _chat_via_lm_studio(payload: dict) -> dict | None:
    """Try payload model, then other ranked models on 4xx/empty."""
    ids = await _lm_studio_models()
    tried = []
    order = []
    primary = payload.get("model")
    if primary:
        order.append(primary)
    for mid in sorted(
        ids,
        key=lambda m: (
            20 if "abliterat" in m.lower() else 0,
            -25 if any(x in m.lower() for x in ("30b", "32b", "70b")) else 0,
            10 if any(x in m.lower() for x in ("7b", "8b", "9b", "3b")) else 0,
        ),
        reverse=True,
    ):
        if mid not in order:
            order.append(mid)

    async with httpx.AsyncClient(timeout=180.0) as client:
        for mid in order:
            if mid in tried:
                continue
            tried.append(mid)
            body = {**payload, "model": mid}
            try:
                r = await client.post(
                    f"{LM_STUDIO_BASE}/chat/completions",
                    json=body,
                    headers={"Authorization": "Bearer lm-studio"},
                )
                data = r.json()
            except Exception as e:
                print(f"[gateway] LM Studio transport {mid}: {e}")
                continue
            if r.status_code >= 400:
                print(f"[gateway] LM Studio {mid} -> {r.status_code}: {r.text[:220]}")
                continue
            text = _extract_chat_text(data, payload.get("messages"))
            if not text:
                print(f"[gateway] empty from {mid}")
                continue
            data.setdefault("choices", [{}])
            if data["choices"]:
                data["choices"][0].setdefault("message", {})
                data["choices"][0]["message"]["content"] = text
            return data
    return None


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    body = await request.json()
    # Strip xAI-only fields that confuse some local servers
    body.pop("reasoning_effort", None)
    body.pop("reasoning", None)

    messages = body.get("messages") or []
    # Flatten multimodal → text only (GlyphPack not used in local mode)
    flat = []
    for m in messages:
        role = m.get("role") or "user"
        content = m.get("content")
        if isinstance(content, list):
            texts = []
            for p in content:
                if isinstance(p, dict) and p.get("type") in ("text", "input_text"):
                    texts.append(str(p.get("text") or ""))
                elif isinstance(p, str):
                    texts.append(p)
            content = "\n".join(t for t in texts if t)
        flat.append({"role": role, "content": str(content or "")})

    model = await _resolve_chat_model(str(body.get("model") or DEFAULT_CHAT_MODEL))
    temperature = float(body.get("temperature") if body.get("temperature") is not None else 0.15)
    max_tokens = int(body.get("max_tokens") or body.get("max_output_tokens") or 200)

    payload = {
        "model": model,
        "messages": flat,
        "temperature": temperature,
        "max_tokens": max(max_tokens, 160),
        "top_p": float(body.get("top_p") if body.get("top_p") is not None else 0.9),
        "stream": False,
        # Kill CoT / thinking — otherwise max_tokens is eaten by reasoning_content
        "reasoning_effort": "none",
        "enable_thinking": False,
        "think": False,
    }

    if await _lm_studio_up():
        data = await _chat_via_lm_studio(payload)
        if data:
            return JSONResponse(data)
        # Retry without thinking keys / larger budget
        payload2 = {
            "model": model,
            "messages": flat,
            "temperature": temperature,
            "max_tokens": max(max_tokens * 3, 320),
            "top_p": 0.9,
            "stream": False,
        }
        data = await _chat_via_lm_studio(payload2)
        if data:
            return JSONResponse(data)

    # Local llama-cpp fallback
    try:
        text = await asyncio.to_thread(
            _chat_local_llama, flat, temperature, max(max_tokens, 120)
        )
    except Exception as e:
        raise HTTPException(
            503,
            f"Chat unavailable (load a mid-size abliterated chat model in LM Studio, or install llama-cpp + GGUF): {e}",
        ) from e

    return {
        "id": "av-local",
        "object": "chat.completion",
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop",
            }
        ],
    }


@app.api_route("/v1/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def proxy_unknown(path: str, request: Request):
    """Proxy remaining OpenAI-compatible paths to LM Studio when up."""
    if not is_safe_proxy_path(path):
        raise HTTPException(400, "bad proxy path")
    if not await _lm_studio_up():
        raise HTTPException(404, f"No handler for /v1/{path} and LM Studio down")
    url = f"{LM_STUDIO_BASE}/{path}"
    body = await request.body()
    async with httpx.AsyncClient(timeout=120.0) as client:
        r = await client.request(
            request.method,
            url,
            content=body,
            headers={
                "Authorization": "Bearer lm-studio",
                "Content-Type": request.headers.get("content-type", "application/json"),
            },
            params=dict(request.query_params),
        )
    return Response(content=r.content, status_code=r.status_code, media_type=r.headers.get("content-type"))


def main():
    import uvicorn

    try:
        (ROOT / ".gateway.pid").write_text(str(os.getpid()), encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    print(
        f"[gateway] AetherVox local voice gateway on http://{HOST}:{PORT}/v1 "
        f"(LM Studio -> {LM_STUDIO_BASE}, zero_censorship=ON)"
    )
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")


if __name__ == "__main__":
    main()
