from __future__ import annotations

import math
import struct
import wave
from io import BytesIO
from typing import Protocol


class Translator(Protocol):
    def translate(self, text: str, source_lang: str, target_lang: str) -> str: ...


class Synthesizer(Protocol):
    def synthesize(self, text: str, lang: str, voice_id: int) -> bytes: ...


class AsrBackend(Protocol):
    def transcribe(self, pcm16le: bytes, sample_rate: int, lang_hint: str | None) -> list[dict]: ...


class UnavailableTranslator:
    def translate(self, text: str, source_lang: str, target_lang: str) -> str:
        raise RuntimeError("translator_unavailable")


class ToneSynthesizer:
    """Always-present local synthesizer: short WAV whose duration tracks text length."""

    sample_rate = 24000
    chars_per_second = 14.0

    def synthesize(self, text: str, lang: str, voice_id: int) -> bytes:
        duration = max(0.35, min(12.0, (len(text) or 1) / self.chars_per_second))
        n_samples = int(self.sample_rate * duration)
        freq = 220.0 if int(voice_id) % 2 == 0 else 330.0
        if lang == "en":
            freq *= 1.12
        buf = BytesIO()
        with wave.open(buf, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(self.sample_rate)
            frames = bytearray()
            for i in range(n_samples):
                t = i / self.sample_rate
                envelope = min(1.0, t * 8.0) * min(1.0, (duration - t) * 8.0)
                sample = int(12000 * envelope * math.sin(2.0 * math.pi * freq * t))
                frames.extend(struct.pack("<h", sample))
            wav.writeframes(bytes(frames))
        return buf.getvalue()


class MissingAsr:
    def transcribe(self, pcm16le: bytes, sample_rate: int, lang_hint: str | None) -> list[dict]:
        raise RuntimeError("asr_unavailable")
