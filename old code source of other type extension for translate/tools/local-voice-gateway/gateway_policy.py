"""Pure gateway policy helpers (imported by server.py, unit-tested)."""

from __future__ import annotations

import math
import re
from pathlib import Path
from urllib.parse import parse_qs, urlparse

_YT_HOST_EXACT = {
    "youtu.be",
    "youtube.com",
    "youtube-nocookie.com",
}

_TOKEN_RE = re.compile(r"^[0-9a-fA-F]{8,32}$")
_YT_ID_RE = re.compile(r"^[\w-]{11}$")


def is_youtube_host(host: str) -> bool:
    h = str(host or "").lower().rstrip(".")
    if h.startswith("www."):
        h = h[4:]
    return (
        h in _YT_HOST_EXACT
        or h.endswith(".youtube.com")
        or h.endswith(".youtube-nocookie.com")
    )


def is_allowed_ytdlp_url(url: str) -> bool:
    try:
        u = urlparse(str(url or ""))
    except Exception:
        return False
    if u.scheme not in ("http", "https"):
        return False
    if not is_youtube_host(u.hostname or ""):
        return False
    host = str(u.hostname or "").lower().rstrip(".")
    if host.startswith("www."):
        host = host[4:]
    if host == "youtu.be":
        vid = next((p for p in (u.path or "").split("/") if p), "")
        return is_allowed_video_id(vid)
    qs = parse_qs(u.query or "")
    vids = qs.get("v") or []
    if vids and is_allowed_video_id(vids[0]):
        return True
    path = u.path or ""
    if re.match(r"^/(embed|shorts|live|v|clip)/[\w-]{11}/?$", path, re.I):
        return True
    if re.match(r"^/live/?$", path, re.I):
        return True
    return False


def is_allowed_video_id(video_id: str) -> bool:
    return bool(_YT_ID_RE.fullmatch(str(video_id or "")))


def sanitize_media_token(token: str) -> str | None:
    t = str(token or "")
    return t if _TOKEN_RE.fullmatch(t) else None


def is_safe_proxy_path(path: str) -> bool:
    p = str(path or "")
    if not p or ".." in p or "://" in p or p.startswith("/") or "\\" in p:
        return False
    return True


_CYR_TARGET_RE = re.compile(
    r"(russian|русск|→\s*ru\b|target(?:lang)?\s*[:=]\s*ru\b|на русский)",
    re.I,
)


def wants_cyrillic_target(messages: list | None) -> bool:
    blob_parts: list[str] = []
    for m in messages or []:
        if not isinstance(m, dict):
            blob_parts.append(str(m))
            continue
        c = m.get("content")
        if isinstance(c, list):
            for p in c:
                if isinstance(p, dict):
                    blob_parts.append(str(p.get("text") or ""))
                else:
                    blob_parts.append(str(p))
        else:
            blob_parts.append(str(c or ""))
    return bool(_CYR_TARGET_RE.search(" ".join(blob_parts)))


def looks_like_meta_reasoning(text: str) -> bool:
    low = (text or "").strip().lower()
    if not low:
        return True
    prefixes = (
        "now,",
        "first,",
        "the user",
        "i need",
        "let me",
        "break down",
        "okay,",
        "alright,",
        "consider ",
        "looking at",
        "in russian",
    )
    return any(low.startswith(p) for p in prefixes)


def extract_cyrillic_candidate(blob: str) -> str:
    if not blob:
        return ""
    quotes = re.findall(r"[«\"“]([^«\"“”]*[\u0400-\u04FF][^«\"“”]*)[»\"”]", blob)
    for q in reversed(quotes):
        q = q.strip().strip(",.;:")
        if len(q) >= 3 and not looks_like_meta_reasoning(q):
            return q
    lines = [ln.strip() for ln in blob.splitlines() if ln.strip()]
    for ln in reversed(lines):
        if any("\u0400" <= ch <= "\u04FF" for ch in ln) and len(ln) >= 3:
            if looks_like_meta_reasoning(ln):
                continue
            return ln.strip('"«»“”').strip(",.;:")
    return ""


_MALE_PIPER = ("dmitri", "ryan")
_FEMALE_PIPER = ("irina", "lessac")


def piper_stem_gender(stem: str) -> str | None:
    s = str(stem or "").lower()
    if any(m in s for m in _MALE_PIPER):
        return "male"
    if any(f in s for f in _FEMALE_PIPER):
        return "female"
    return None


def piper_matches_gender(stem: str, gender: str) -> bool:
    want = (gender or "").lower()
    got = piper_stem_gender(stem)
    if not want or not got:
        return True
    return want == got


def resample_len(n_in: int, sr_in: int, sr_out: int = 16000) -> int:
    if n_in <= 0 or sr_in <= 0:
        return 0
    if sr_in == sr_out:
        return n_in
    return max(0, int(round(n_in * sr_out / sr_in)))


def resample_to_16k(audio, sr: int):
    """Linear resample → float32 mono @ 16 kHz (Whisper ndarray contract)."""
    import numpy as np

    arr = np.asarray(audio, dtype=np.float32)
    if getattr(arr, "ndim", 1) > 1:
        arr = arr.mean(axis=1)
    sr_i = int(sr or 16000)
    if sr_i == 16000:
        return arr, 16000
    n = resample_len(int(arr.size), sr_i, 16000)
    if n <= 0:
        return np.zeros(0, dtype=np.float32), 16000
    x_old = np.linspace(0.0, 1.0, num=int(arr.size), endpoint=False)
    x_new = np.linspace(0.0, 1.0, num=n, endpoint=False)
    return np.interp(x_new, x_old, arr).astype(np.float32), 16000


def pid_in_tasklist(pid: int, stdout: str) -> bool:
    """Whole-token PID match — '12' must not hit '1234'."""
    if pid <= 0:
        return False
    return bool(re.search(rf"(?:^|[\s,]){int(pid)}(?:[\s,]|$)", str(stdout or "")))


def output_audio_media_type(_codec: str | None = None) -> str:
    """Gateway emits WAV only (extension accepts non-JSON audio body)."""
    return "audio/wav"


def clamp_tts_speed(speed, default: float = 1.0) -> float:
    try:
        v = float(speed)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(v):
        return default
    return max(0.5, min(2.0, v))


def cache_file_is_safe(path, cache_dir) -> bool:
    """Serve only regular files that resolve inside the media-cache directory."""
    try:
        p = Path(path)
        if p.is_symlink():
            return False
        resolved = p.resolve()
        root = Path(cache_dir).resolve()
        return resolved.is_file() and resolved.parent == root
    except Exception:
        return False


def looks_like_raw_pcm16(data: bytes) -> bool:
    """Accept even-length s16le; reject named containers and tiny/odd junk."""
    if not data or len(data) < 320 or (len(data) % 2):
        return False
    if len(data) > 12 and data[:4] in (b"RIFF", b"OggS", b"fLaC", b"ID3\x03", b"ID3\x04"):
        return False
    return True


def native_wait_sec(raw, default: float = 45.0) -> float:
    try:
        v = float(raw)
    except (TypeError, ValueError):
        v = default
    if not math.isfinite(v):
        v = default
    return min(120.0, max(3.0, v))


def extract_spoken_text(content: str, reason: str = "", prefer_cyrillic: bool = False) -> str:
    content = str(content or "").strip()
    reason = str(reason or "").strip()
    if prefer_cyrillic:
        for blob in (content, reason):
            hit = extract_cyrillic_candidate(blob)
            if hit:
                return hit
    if content and not looks_like_meta_reasoning(content):
        return content
    if reason and not looks_like_meta_reasoning(reason):
        lines = [ln.strip() for ln in reason.splitlines() if ln.strip()]
        return (lines[-1] if lines else reason).strip('"«»')
    return content or ""
