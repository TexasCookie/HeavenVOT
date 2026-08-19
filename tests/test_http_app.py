import json
import threading
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from lvt_host.backends import MissingAsr, ToneSynthesizer
from lvt_host.http_app import HostRuntime, serve
from lvt_host.session import Session
from lvt_host.chunker import wav_bytes_from_pcm16
import math

FIXTURES = Path(__file__).parent / "fixtures"
XML = (FIXTURES / "timedtext.xml").read_text(encoding="utf-8")


class MapTranslator:
    def translate(self, text: str, source_lang: str, target_lang: str) -> str:
        return {"Hello friends": "Привет друзья", "Welcome to the talk": "Добро пожаловать", "Today we discuss memory": "Память"}.get(
            text, "«" + text + "»"
        )


def _start_server(runtime: HostRuntime):
    server = serve(runtime, host="127.0.0.1", port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address[:2]
    return server, f"http://{host}:{port}"


def _json(url: str, payload: dict | None = None) -> dict:
    if payload is None:
        with urlopen(url) as resp:
            return json.loads(resp.read().decode("utf-8"))
    data = json.dumps(payload).encode("utf-8")
    req = Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    with urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _tone_wav(seconds: float = 8.0, rate: int = 16000) -> bytes:
    n = int(seconds * rate)
    samples = [int(8000 * math.sin(2 * math.pi * 440 * i / rate)) for i in range(n)]
    return wav_bytes_from_pcm16(samples, rate)


class FileSource:
    def __init__(self, wav: bytes) -> None:
        self.wav = wav

    def fetch(self, video_id, dest_dir):
        from pathlib import Path

        path = Path(dest_dir) / (video_id + ".wav")
        path.write_bytes(self.wav)
        return path


class MatchAsr:
    def transcribe(self, audio, sample_rate=16000, lang_hint=None, offset=0.0):
        return [
            {
                "start": float(offset),
                "duration": 2.0,
                "text": "Hello friends Welcome to the talk Today we discuss memory",
                "lang": lang_hint or "en",
                "speaker": 0,
            }
        ]


def test_health_and_caption_start_roundtrip():
    runtime = HostRuntime(Session(start_buffer_s=3.0), MapTranslator(), ToneSynthesizer(), asr=MatchAsr())
    runtime.audio_source = FileSource(_tone_wav())
    server, base = _start_server(runtime)
    try:
        health = _json(base + "/v1/health")
        assert health["ok"] is True
        started = _json(
            base + "/v1/session/start",
            {
                "tab_id": "t1",
                "video_id": "vid",
                "target_lang": "ru",
                "video_duration": 7.5,
                "playback_rate": 1.0,
                "cues": [
                    {"start": 0, "duration": 2, "text": "Hello friends", "lang": "en"},
                    {"start": 2, "duration": 2.5, "text": "Welcome to the talk", "lang": "en"},
                    {"start": 4.5, "duration": 3, "text": "Today we discuss memory", "lang": "en"},
                ],
            },
        )
        assert started["state"] in {"ready", "playing", "buffering"}
        for _ in range(40):
            snap = _json(base + "/v1/session")
            if snap.get("ready_count", 0) >= 1 and snap.get("asr_done"):
                break
            threading.Event().wait(0.05)
        tick = _json(base + "/v1/session/tick", {"playhead": 0.0})
        assert tick["pause_player"] is False
        assert tick["utterances"][0]["text"] == "Привет друзья"
        audio_url = base + tick["utterances"][0]["audio_path"]
        with urlopen(audio_url) as resp:
            wav = resp.read()
        assert wav.startswith(b"RIFF")
    finally:
        server.shutdown()


def test_captions_without_file_are_hard_error():
    runtime = HostRuntime(Session(start_buffer_s=3.0), MapTranslator(), ToneSynthesizer())
    server, base = _start_server(runtime)
    try:
        started = _json(
            base + "/v1/session/start",
            {
                "tab_id": "t1",
                "video_id": "vid",
                "target_lang": "ru",
                "video_duration": 7.5,
                "playback_rate": 1.0,
                "cues": [{"start": 0, "duration": 2, "text": "Hello friends", "lang": "en"}],
            },
        )
        assert started["state"] == "error"
        assert "download" in started["reason"]
    finally:
        server.shutdown()


def test_rate_not_one_rejected():
    runtime = HostRuntime(Session(), MapTranslator(), ToneSynthesizer())
    server, base = _start_server(runtime)
    try:
        try:
            _json(
                base + "/v1/session/start",
                {
                    "tab_id": "t1",
                    "video_id": "vid",
                    "target_lang": "ru",
                    "video_duration": 7.5,
                    "playback_rate": 1.5,
                    "cues": [{"start": 0, "duration": 2, "text": "Hello friends", "lang": "en"}],
                },
            )
            raise AssertionError("should have failed")
        except HTTPError as exc:
            assert exc.code == 409
            body = json.loads(exc.read().decode("utf-8"))
            assert body["error"] == "rate_not_1x"
    finally:
        server.shutdown()


def test_player_payload_uses_injected_fetch():
    player = json.loads((FIXTURES / "player_manual.json").read_text(encoding="utf-8"))
    runtime = HostRuntime(
        Session(start_buffer_s=3.0),
        MapTranslator(),
        ToneSynthesizer(),
        asr=MatchAsr(),
        fetch=lambda url: XML,
    )
    runtime.audio_source = FileSource(_tone_wav())
    server, base = _start_server(runtime)
    try:
        started = _json(
            base + "/v1/session/start",
            {
                "tab_id": "t1",
                "video_id": "vid",
                "target_lang": "ru",
                "video_duration": 7.5,
                "playback_rate": 1.0,
                "player_payload": player,
            },
        )
        assert started["state"] in {"ready", "playing", "buffering"}
        for _ in range(40):
            snap = _json(base + "/v1/session")
            if snap.get("ready_count", 0) >= 1:
                break
            threading.Event().wait(0.05)
        assert snap["ready_count"] >= 1
    finally:
        server.shutdown()


def test_asr_required_without_backend_errors():
    runtime = HostRuntime(Session(), MapTranslator(), ToneSynthesizer(), asr=MissingAsr())
    server, base = _start_server(runtime)
    try:
        started = _json(
            base + "/v1/session/start",
            {
                "tab_id": "t1",
                "video_id": "vid",
                "target_lang": "ru",
                "video_duration": 7.5,
                "playback_rate": 1.0,
                "cues": [],
                "source_lang": "en",
            },
        )
        assert started["state"] == "error"
        assert "download" in started["reason"]
    finally:
        server.shutdown()
