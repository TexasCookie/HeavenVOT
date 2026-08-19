import json
import threading
from urllib.request import Request, urlopen

from lvt_host.backends import ToneSynthesizer
from lvt_host.http_app import HostRuntime, serve
from lvt_host.quality import Cue
from lvt_host.session import BUFFERING, Session


class MapTranslator:
    def translate(self, text: str, source_lang: str, target_lang: str) -> str:
        return "T:" + text


class FakeAsr:
    def transcribe(self, audio, sample_rate=16000, lang_hint=None, offset=0.0):
        assert audio
        return [
            {
                "start": float(offset),
                "duration": 2.0,
                "text": "hello from asr",
                "lang": lang_hint or "en",
                "speaker": 0,
            }
        ]


def test_whisper_decode_failure_is_empty_not_fatal():
    from lvt_host.runtime_stack import FasterWhisperAsr

    class Boom:
        def transcribe(self, path, language=None):
            raise RuntimeError("no decoder")

    try:
        FasterWhisperAsr(Boom()).transcribe(b"not-a-media-file", 16000, "en", 0.0)
    except RuntimeError as exc:
        assert str(exc) == "asr_empty"
    else:
        raise AssertionError("expected asr_empty")


def test_asr_mode_starts_buffering_without_cues():
    session = Session()
    started = session.start(
        tab_id="t",
        video_id="v",
        target_lang="ru",
        cues=[],
        video_duration=10.0,
        source_lang="en",
        asr_mode=True,
    )
    assert started.state == BUFFERING
    assert started.reason == "waiting for asr file"
    waiting = session.on_playhead(0.0)
    assert waiting.pause_player is True
    session.add_cues([Cue(0.0, 2.0, "hello from asr", "en")])
    session.process_pending(MapTranslator(), ToneSynthesizer())
    session.mark_asr_complete()
    session.process_pending(MapTranslator(), ToneSynthesizer())
    assert session.utterances[0].target_text == "T:hello from asr"
    tick = session.on_playhead(0.0)
    assert tick.pause_player is False


def test_http_transcribe_uses_asr_bytes():
    runtime = HostRuntime(Session(), MapTranslator(), ToneSynthesizer(), asr=FakeAsr())
    server = serve(runtime, host="127.0.0.1", port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address[:2]
    try:
        start_req = Request(
            f"http://{host}:{port}/v1/session/start",
            data=json.dumps(
                {
                    "tab_id": "t",
                    "video_id": "v",
                    "target_lang": "ru",
                    "video_duration": 10.0,
                    "asr_mode": True,
                    "source_lang": "en",
                }
            ).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(start_req) as resp:
            started = json.loads(resp.read().decode("utf-8"))
        assert started["state"] == "error"
        start_req = Request(
            f"http://{host}:{port}/v1/session/start",
            data=json.dumps(
                {
                    "tab_id": "t2",
                    "video_id": "v",
                    "target_lang": "ru",
                    "video_duration": 10.0,
                    "asr_mode": True,
                    "skip_download": True,
                    "source_lang": "en",
                }
            ).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(start_req) as resp:
            started = json.loads(resp.read().decode("utf-8"))
        assert started["state"] == "buffering"
        from lvt_host.chunker import wav_bytes_from_pcm16
        import math

        n = 16000
        wav = wav_bytes_from_pcm16(
            [int(8000 * math.sin(2 * math.pi * 440 * i / 16000)) for i in range(n)], 16000
        )
        asr_req = Request(
            f"http://{host}:{port}/v1/session/transcribe",
            data=wav,
            headers={"X-Audio-Start": "3.5"},
            method="POST",
        )
        with urlopen(asr_req) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        assert body["added"] >= 1
        assert body["ready_count"] >= 1
        health = json.loads(urlopen(f"http://{host}:{port}/v1/health").read().decode("utf-8"))
        assert health["last_transcribe"]["bytes"] == len(wav)
        assert health["last_transcribe"]["added"] >= 1

        opt = Request(
            f"http://{host}:{port}/v1/session/transcribe",
            method="OPTIONS",
            headers={
                "Origin": "https://www.youtube.com",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "x-audio-start, x-audio-lang",
            },
        )
        with urlopen(opt) as resp:
            allow = (resp.headers.get("Access-Control-Allow-Headers") or "").lower()
            assert resp.status == 204
            assert "x-audio-start" in allow
            assert resp.headers.get("Access-Control-Allow-Origin") == "*"
            assert (resp.headers.get("Access-Control-Allow-Private-Network") or "").lower() == "true"
    finally:
        server.shutdown()
