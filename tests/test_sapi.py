import os
from pathlib import Path

import pytest

from lvt_host.runtime_stack import load_synthesizer
from lvt_host.sapi import SapiSynthesizer, SilentSynthesizer, culture_for_lang


def test_culture_for_lang():
    assert culture_for_lang("ru") == "ru-RU"
    assert culture_for_lang("en-US") == "en-US"


def test_silent_wav_is_quiet_riff():
    wav = SilentSynthesizer().synthesize("x", "ru", 0)
    assert wav.startswith(b"RIFF")
    assert len(wav) < 2000


def test_load_synthesizer_is_not_tone_on_windows():
    synth, notes = load_synthesizer()
    assert type(synth).__name__ != "ToneSynthesizer"
    assert type(synth).__name__ not in {"SapiSynthesizer", "ToneSynthesizer"}
    assert type(synth).__name__ in {"PiperSynthesizer", "SileroBridge", "SilentSynthesizer"}


def test_load_synthesizer_piper_when_voices_present(tmp_path, monkeypatch):
    from lvt_host import runtime_stack

    class FakeVoice:
        sample_rate = 22050

        def synthesize_wav(self, text, wav):
            wav.writeframes(b"\x00\x00" * 220)

    class FakePiper:
        @staticmethod
        def load(path):
            return FakeVoice()

    for name in ("ru_RU-dmitri-medium", "ru_RU-irina-medium"):
        (tmp_path / f"{name}.onnx").write_bytes(b"onnx")
    monkeypatch.setitem(__import__("sys").modules, "piper", type("m", (), {"PiperVoice": FakePiper})())
    synth, notes = runtime_stack.load_synthesizer(tmp_path)
    assert type(synth).__name__ == "PiperSynthesizer"
    assert "piper" in notes
    wav = synth.synthesize("привет", "ru", 0)
    assert wav.startswith(b"RIFF")


def test_sapi_writes_speech_wav():
    if os.name != "nt":
        pytest.skip("windows sapi")
    wav = SapiSynthesizer().synthesize("привет", "ru", 0)
    assert wav.startswith(b"RIFF")
    assert len(wav) > 4000


def test_sapi_uses_injected_runner():
    seen = {}

    def run_ok(script: str, path: str) -> None:
        seen["script"] = script
        Path(path).write_bytes(b"RIFF" + b"\x00" * 80)

    wav = SapiSynthesizer(run=run_ok).synthesize("hello", "en", 0)
    assert wav.startswith(b"RIFF")
    assert "FromBase64String" in seen["script"]
