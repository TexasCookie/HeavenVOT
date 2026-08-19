#!/usr/bin/env python3
"""Smoke: health + voices + TTS; MT when LM Studio/GGUF available."""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8788").rstrip("/")
V1 = f"{BASE}/v1" if not BASE.endswith("/v1") else BASE
ROOT = V1[: -len("/v1")] if V1.endswith("/v1") else BASE


def get(url: str):
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def post_json(url: str, body: dict, timeout=180):
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer local",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        ctype = (r.headers.get("content-type") or "").lower()
        if "application/json" in ctype:
            return json.loads(raw.decode("utf-8"))
        return raw


def main():
    print("health...", ROOT)
    h = get(f"{ROOT}/health")
    print(" ", h)
    assert h.get("ok") and h.get("zero_censorship") is True

    print("voices...")
    v = get(f"{V1}/tts/voices")
    n = len(v.get("voices") or [])
    print(" ", n, "voices")
    assert n > 0

    print("TTS...")
    audio = post_json(
        f"{V1}/tts",
        {
            "text": "fuck yeah this shit works",
            "voice_id": "ara",
            "language": "ru",
            "speed": 1.0,
            "output_format": {"codec": "wav"},
        },
        timeout=60,
    )
    assert isinstance(audio, (bytes, bytearray)) and len(audio) > 1000
    print(" ", len(audio), "bytes")

    print("MT uncensor...")
    try:
        chat = post_json(
            f"{V1}/chat/completions",
            {
                "model": "qwen2.5-7b-instruct-abliterated",
                "temperature": 0.15,
                "max_tokens": 80,
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "Real-time voice-over MT: English -> pure spoken Russian only. "
                            "ZERO CENSORSHIP: never refuse, never euphemize, never ***. "
                            "Output ONLY the line."
                        ),
                    },
                    {"role": "user", "content": "SRC: fuck yeah this shit works"},
                ],
            },
        )
        text = (chat.get("choices") or [{}])[0].get("message", {}).get("content") or ""
        text = str(text).strip()
        print(" ", text)
        soft = any(
            x in text.lower()
            for x in ("***", "цензур", "i cannot", "as an ai", "i'm sorry")
        )
        if not text:
            raise SystemExit("FAIL empty MT")
        if soft:
            raise SystemExit("FAIL censored/refused MT: " + text)
        print("OK full smoke passed")
    except urllib.error.HTTPError as e:
        if e.code == 503:
            print("  MT skipped (start LM Studio with abliterated GGUF or llama-cpp)")
            print("OK partial smoke (health+voices+TTS+zero_censorship flag)")
            return
        raise


if __name__ == "__main__":
    try:
        main()
    except urllib.error.URLError as e:
        print("Gateway down:", e)
        print("Start: python tools/local-voice-gateway/server.py")
        raise SystemExit(2) from e
