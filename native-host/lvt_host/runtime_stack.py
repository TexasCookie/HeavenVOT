from __future__ import annotations

import os
import sys
from pathlib import Path

from .backends import MissingAsr, Synthesizer, Translator, UnavailableTranslator

MODELS_DIR = Path(__file__).resolve().parents[1] / "models"
NLLB_DIR = MODELS_DIR / "nllb-200-distilled-600M-ct2-int8"


def ensure_cuda_dlls() -> None:
    site = Path(sys.prefix) / "Lib" / "site-packages" / "nvidia"
    bins = [site / "cublas" / "bin", site / "cudnn" / "bin", site / "cuda_nvrtc" / "bin"]
    found = [str(path) for path in bins if path.is_dir()]
    if not found:
        return
    os.environ["PATH"] = os.pathsep.join(found + [os.environ.get("PATH", "")])
    adder = getattr(os, "add_dll_directory", None)
    if adder:
        for path in found:
            adder(path)


def _cuda_available() -> bool:
    ensure_cuda_dlls()
    try:
        import ctranslate2

        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False


def load_translator() -> tuple[Translator, list[str]]:
    notes: list[str] = []
    if not NLLB_DIR.is_dir():
        return UnavailableTranslator(), ["no local translator pack"]
    from .nllb import NllbTranslator

    devices = ["cuda", "cpu"] if _cuda_available() else ["cpu"]
    last_error = ""
    for device in devices:
        try:
            return NllbTranslator(NLLB_DIR, device=device), (
                [] if device == "cuda" else ["nllb running on cpu"]
            )
        except Exception as exc:
            last_error = str(exc)
    notes.append(f"nllb load failed: {last_error}")
    return UnavailableTranslator(), notes


PIPER_DIR = MODELS_DIR / "piper"
PIPER_VOICES = {
    ("ru", 0): "ru_RU-dmitri-medium",
    ("ru", 1): "ru_RU-irina-medium",
    ("en", 0): "en_US-joe-medium",
    ("en", 1): "en_US-lessac-medium",
}


def _piper_voice_files(root: Path) -> list[Path]:
    found = []
    for name in PIPER_VOICES.values():
        path = root / f"{name}.onnx"
        if path.is_file():
            found.append(path)
    return found


def load_synthesizer(piper_dir: Path | None = None) -> tuple[Synthesizer, list[str]]:
    root = piper_dir or PIPER_DIR
    piper = _try_piper(root)
    if piper is not None:
        return piper, ["piper"]
    try:
        import torch
        from silero import silero_tts

        del torch
        model, _ = silero_tts(language="ru", speaker="v5_ru")
        return SileroBridge(model), ["silero fallback"]
    except Exception:
        pass
    from .sapi import SilentSynthesizer

    return SilentSynthesizer(), ["no piper no silero"]


def _try_piper(root: Path) -> Synthesizer | None:
    files = _piper_voice_files(root)
    if not files:
        return None
    try:
        from piper import PiperVoice  # type: ignore
    except Exception:
        return None
    loaded = {}
    for path in files:
        try:
            loaded[path.stem] = PiperVoice.load(str(path))
        except Exception:
            continue
    if not loaded:
        return None
    return PiperSynthesizer(loaded)


def load_asr():
    return LazyAsr(), []


class PiperSynthesizer:
    def __init__(self, voices: dict) -> None:
        self._voices = voices

    def synthesize(self, text: str, lang: str, voice_id: int) -> bytes:
        spoken = (text or "").strip() or "."
        key = "en" if (lang or "").lower().startswith("en") else "ru"
        name = PIPER_VOICES.get((key, int(voice_id) % 2))
        voice = self._voices.get(name or "")
        if voice is None:
            same = [PIPER_VOICES.get((key, 0)), PIPER_VOICES.get((key, 1))]
            for candidate in same:
                voice = self._voices.get(candidate or "")
                if voice is not None:
                    break
        if voice is None:
            voice = next(iter(self._voices.values()))
        import io
        import wave

        buf = io.BytesIO()
        with wave.open(buf, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(getattr(voice, "sample_rate", 22050) or 22050)
            synthesize = getattr(voice, "synthesize", None)
            synthesize_wav = getattr(voice, "synthesize_wav", None)
            if synthesize_wav is not None:
                synthesize_wav(spoken, wav)
            elif synthesize is not None:
                result = synthesize(spoken)
                if hasattr(result, "audio_int16_bytes"):
                    wav.writeframes(result.audio_int16_bytes)
                elif hasattr(result, "audio_int16"):
                    wav.writeframes(bytes(result.audio_int16))
            else:
                wav.writeframes(b"\x00\x00" * 160)
        data = buf.getvalue()
        if data[:4] != b"RIFF":
            from .sapi import SilentSynthesizer

            return SilentSynthesizer().synthesize(spoken, lang, voice_id)
        return data


class SileroBridge:
    def __init__(self, model) -> None:
        self._model = model
        self._speakers = {0: "aidar", 1: "baya"}

    def synthesize(self, text: str, lang: str, voice_id: int) -> bytes:
        del lang
        speaker = self._speakers.get(int(voice_id) % 2, "aidar")
        audio = self._model.apply_tts(text=text, speaker=speaker, sample_rate=24000)
        import numpy as np

        if audio is None:
            from .sapi import SilentSynthesizer

            return SilentSynthesizer().synthesize(text, "ru", voice_id)
        try:
            import io
            import wave

            arr = np.asarray(audio, dtype=np.float32).reshape(-1)
            pcm = np.clip(arr * 32767.0, -32768, 32767).astype(np.int16)
            buf = io.BytesIO()
            with wave.open(buf, "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(24000)
                wav.writeframes(pcm.tobytes())
            return buf.getvalue()
        except Exception:
            from .sapi import SilentSynthesizer

            return SilentSynthesizer().synthesize(text, "ru", voice_id)


class LazyAsr:
    def __init__(self) -> None:
        self._inner = None

    def transcribe(
        self,
        audio: bytes,
        sample_rate: int = 16000,
        lang_hint: str | None = None,
        offset: float = 0.0,
    ) -> list[dict]:
        if self._inner is None:
            try:
                from faster_whisper import WhisperModel

                device = "cuda" if _cuda_available() else "cpu"
                compute = "int8_float16" if device == "cuda" else "int8"
                model = WhisperModel("large-v3-turbo", device=device, compute_type=compute)
                self._inner = FasterWhisperAsr(model)
            except Exception as exc:
                raise RuntimeError("asr_unavailable") from exc
        return self._inner.transcribe(audio, sample_rate, lang_hint, offset)


class FasterWhisperAsr:
    def __init__(self, model) -> None:
        self._model = model

    def transcribe(
        self,
        audio: bytes,
        sample_rate: int = 16000,
        lang_hint: str | None = None,
        offset: float = 0.0,
    ) -> list[dict]:
        import os
        import tempfile

        if not audio:
            raise RuntimeError("asr_unavailable")
        suffix = ".wav" if audio[:4] == b"RIFF" else ".webm"
        handle, path = tempfile.mkstemp(suffix=suffix)
        try:
            os.write(handle, audio)
            os.close(handle)
            handle = -1
            try:
                segments, info = self._model.transcribe(path, language=lang_hint or None)
            except Exception as exc:
                raise RuntimeError("asr_empty") from exc
            lang = getattr(info, "language", lang_hint or "") or ""
            out = []
            for seg in segments:
                text = (seg.text or "").strip()
                if not text:
                    continue
                out.append(
                    {
                        "start": float(seg.start) + float(offset),
                        "duration": max(0.2, float(seg.end) - float(seg.start)),
                        "text": text,
                        "lang": lang,
                        "speaker": 0,
                    }
                )
            if not out:
                raise RuntimeError("asr_empty")
            return out
        finally:
            if handle != -1:
                os.close(handle)
            try:
                os.remove(path)
            except OSError:
                pass
