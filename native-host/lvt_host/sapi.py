from __future__ import annotations

import base64
import json
import os
import subprocess
import tempfile
import threading
from pathlib import Path


def culture_for_lang(lang: str) -> str:
    token = (lang or "").strip().lower().replace("_", "-")
    if token.startswith("en"):
        return "en-US"
    return "ru-RU"


class SapiSynthesizer:
    def __init__(self, run=None) -> None:
        self._run = run or _run_powershell
        self._lock = threading.Lock()

    def synthesize(self, text: str, lang: str, voice_id: int) -> bytes:
        del voice_id
        spoken = (text or "").strip() or "."
        handle = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        handle.close()
        path = handle.name
        payload = json.dumps(
            {"text": spoken, "path": path, "culture": culture_for_lang(lang)},
            ensure_ascii=False,
        )
        token = base64.b64encode(payload.encode("utf-8")).decode("ascii")
        script = (
            "Add-Type -AssemblyName System.Speech;"
            f"$job = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{token}')) | ConvertFrom-Json;"
            "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer;"
            "$match = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq $job.culture } | Select-Object -First 1;"
            "if ($match) { $synth.SelectVoice($match.VoiceInfo.Name) };"
            "$synth.Rate = 1; $synth.Volume = 85;"
            "$synth.SetOutputToWaveFile($job.path);"
            "$synth.Speak($job.text);"
            "$synth.Dispose();"
        )
        try:
            with self._lock:
                self._run(script, path)
            data = Path(path).read_bytes()
        finally:
            try:
                os.remove(path)
            except OSError:
                pass
        if data[:4] != b"RIFF" or len(data) < 64:
            raise RuntimeError("sapi_failed")
        return data


def _run_powershell(script: str, path: str) -> None:
    del path
    completed = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True,
        timeout=45,
        check=False,
    )
    if completed.returncode != 0:
        err = (completed.stderr or completed.stdout or b"").decode("utf-8", errors="replace")
        raise RuntimeError(err or "sapi_failed")


class SilentSynthesizer:
    def synthesize(self, text: str, lang: str, voice_id: int) -> bytes:
        del text, lang, voice_id
        import io
        import wave

        buf = io.BytesIO()
        with wave.open(buf, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes(b"\x00\x00" * 160)
        return buf.getvalue()
