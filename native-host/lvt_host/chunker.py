from __future__ import annotations

import math
import struct
import wave
from io import BytesIO
from pathlib import Path


TARGET_S = 10.0
SEARCH_S = 2.0
FRAME_S = 0.02


def pcm16_mono_from_wav(data: bytes) -> tuple[list[int], int]:
    with wave.open(BytesIO(data), "rb") as wav:
        channels = wav.getnchannels()
        rate = wav.getframerate()
        width = wav.getsampwidth()
        frames = wav.readframes(wav.getnframes())
    if width != 2:
        raise ValueError("need pcm16")
    samples = list(struct.unpack("<" + "h" * (len(frames) // 2), frames))
    if channels > 1:
        samples = [
            int(sum(samples[i : i + channels]) / channels) for i in range(0, len(samples), channels)
        ]
    return samples, rate


def wav_bytes_from_pcm16(samples: list[int], rate: int) -> bytes:
    buf = BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(struct.pack("<" + "h" * len(samples), *samples))
    return buf.getvalue()


def load_wav_file(path: Path) -> tuple[list[int], int]:
    return pcm16_mono_from_wav(path.read_bytes())


def load_media_pcm(path: Path) -> tuple[list[int], int]:
    if path.suffix.lower() == ".wav":
        try:
            return load_wav_file(path)
        except Exception:
            pass
    import av

    container = av.open(str(path))
    try:
        stream = container.streams.audio[0]
    except Exception as exc:
        raise RuntimeError("decode_failed") from exc
    resampler = av.audio.resampler.AudioResampler(format="s16", layout="mono", rate=16000)
    samples: list[int] = []

    def _eat(frames) -> None:
        if frames is None:
            return
        if not isinstance(frames, (list, tuple)):
            frames = [frames]
        for frame in frames:
            arr = frame.to_ndarray()
            flat = arr.reshape(-1)
            samples.extend(int(x) for x in flat.tolist())

    for frame in container.decode(stream):
        _eat(resampler.resample(frame))
    _eat(resampler.resample(None))
    if not samples:
        raise RuntimeError("decode_failed")
    return samples, 16000


def _energy(samples: list[int], start: int, end: int) -> float:
    if end <= start:
        return 0.0
    acc = 0.0
    for i in range(start, end):
        val = samples[i] / 32768.0
        acc += val * val
    return acc / (end - start)


def snap_windows(samples: list[int], rate: int, *, origin: float = 0.0) -> list[tuple[float, float, list[int]]]:
    """Return (start_s, duration_s, pcm) windows ~TARGET_S, cut at lowest energy in the last SEARCH_S."""
    if rate <= 0 or not samples:
        return []
    origin_i = max(0, int(origin * rate))
    if origin_i >= len(samples):
        return []
    frame = max(1, int(rate * FRAME_S))
    target = max(frame, int(rate * TARGET_S))
    search = max(frame, int(rate * SEARCH_S))
    cursor = origin_i
    out: list[tuple[float, float, list[int]]] = []
    while cursor < len(samples):
        remain = len(samples) - cursor
        if remain < int(rate * 0.4):
            break
        ideal = min(cursor + target, len(samples))
        if remain <= target + search // 2:
            end = len(samples)
        else:
            search_from = max(cursor + target - search, cursor + frame)
            best_end = ideal
            best_e = math.inf
            pos = search_from
            while pos + frame <= min(len(samples), cursor + target + search):
                e = _energy(samples, pos, pos + frame)
                if e < best_e:
                    best_e = e
                    best_end = pos + frame
                pos += frame
            end = max(best_end, cursor + frame)
        piece = samples[cursor:end]
        start_s = cursor / rate
        dur = max(0.2, (end - cursor) / rate)
        out.append((start_s, dur, piece))
        cursor = end
    return out
