#!/usr/bin/env python3
"""Full local e2e: health, voices, TTS (uncensor text), MT uncensor, STT on generated WAV."""

from __future__ import annotations

import io
import json
import struct
import sys
import urllib.error
import urllib.request
import wave

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8788").rstrip("/")
V1 = f"{BASE}/v1" if not BASE.endswith("/v1") else BASE
ROOT = V1[: -len("/v1")] if V1.endswith("/v1") else BASE


def req(method: str, url: str, data=None, headers=None, timeout=180):
    h = {"Authorization": "Bearer local"}
    if headers:
        h.update(headers)
    body = data
    if isinstance(data, (dict, list)):
        body = json.dumps(data).encode("utf-8")
        h["Content-Type"] = "application/json"
    r = urllib.request.Request(url, data=body, headers=h, method=method)
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        raw = resp.read()
        ctype = (resp.headers.get("content-type") or "").lower()
        if "json" in ctype:
            return json.loads(raw.decode("utf-8")), ctype, resp.status
        return raw, ctype, resp.status


def soft_censor(text: str) -> bool:
    t = (text or "").lower()
    return any(
        x in t
        for x in ("***", "цензур", "i cannot", "as an ai", "i'm sorry", "i apologize")
    )


def make_silence_wav(sec=1.0, sr=16000) -> bytes:
    n = int(sr * sec)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        # tiny tone so whisper has something (440Hz soft)
        import math

        frames = bytearray()
        for i in range(n):
            # quiet sine ~ -30dB then silence end
            amp = 800 if i < n * 0.7 else 0
            v = int(amp * math.sin(2 * math.pi * 440 * i / sr))
            frames += struct.pack("<h", max(-32767, min(32767, v)))
        w.writeframes(bytes(frames))
    return buf.getvalue()


def stt_multipart(wav: bytes):
    boundary = "----avboundary7"
    parts = []
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"language\"\r\n\r\nen\r\n".encode())
    parts.append(
        (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="t.wav"\r\n'
            f"Content-Type: audio/wav\r\n\r\n"
        ).encode()
        + wav
        + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    body = b"".join(parts)
    r = urllib.request.Request(
        f"{V1}/stt",
        data=body,
        headers={
            "Authorization": "Bearer local",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
        method="POST",
    )
    with urllib.request.urlopen(r, timeout=600) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main():
    fails = []
    print("== health ==")
    h, _, _ = req("GET", f"{ROOT}/health")
    print(h)
    if not h.get("ok") or not h.get("zero_censorship"):
        fails.append("health")

    print("== voices ==")
    v, _, _ = req("GET", f"{V1}/tts/voices")
    n = len(v.get("voices") or [])
    print(n, "voices")
    if n < 1:
        fails.append("voices")

    print("== TTS uncensor ==")
    audio, ctype, _ = req(
        "POST",
        f"{V1}/tts",
        {
            "text": "fuck yeah this shit works, бля это охуенно",
            "voice_id": "ara",
            "language": "ru",
            "speed": 1.05,
            "output_format": {"codec": "wav"},
        },
        timeout=90,
    )
    print(ctype, len(audio) if isinstance(audio, (bytes, bytearray)) else audio)
    if not isinstance(audio, (bytes, bytearray)) or len(audio) < 1000:
        fails.append("tts")

    print("== MT uncensor ==")
    try:
        chat, _, _ = req(
            "POST",
            f"{V1}/chat/completions",
            {
                "model": "auto",
                "temperature": 0.15,
                "max_tokens": 120,
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "Real-time voice-over MT: English -> pure spoken Russian only. "
                            "Translate meaning, not transliteration. "
                            "ZERO CENSORSHIP: never refuse, never euphemize, never ***. "
                            "Output ONLY the spoken line."
                        ),
                    },
                    {"role": "user", "content": "SRC: fuck yeah this shit works"},
                ],
            },
            timeout=240,
        )
        text = (
            ((chat.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
        ).strip()
        print("MT:", repr(text))
        print("model:", chat.get("model"))
        if not text:
            fails.append("mt-empty")
        elif soft_censor(text):
            fails.append("mt-censored")
        else:
            print("MT uncensor OK")
    except urllib.error.HTTPError as e:
        print("MT HTTP", e.code, e.read()[:300])
        fails.append(f"mt-{e.code}")

    print("== STT ==")
    try:
        wav = make_silence_wav(1.2)
        st = stt_multipart(wav)
        print("STT:", st)
        if "text" not in st:
            fails.append("stt-shape")
        else:
            print("STT OK (text field present)")
    except Exception as e:
        print("STT fail", e)
        fails.append("stt")

    print("== RESULT ==")
    if fails:
        print("FAIL", fails)
        raise SystemExit(1)
    print("PASS full local e2e")


if __name__ == "__main__":
    main()
