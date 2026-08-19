from lvt_host.backends import ToneSynthesizer
from lvt_host.http_app import HostRuntime, serve
from lvt_host.quality import Cue
from lvt_host.session import Session
from lvt_host.voices import assign_voices
import json
import threading
from urllib.request import Request, urlopen


class ScriptAsr:
    def transcribe(self, pcm16le: bytes, sample_rate: int, lang_hint: str | None):
        assert sample_rate == 16000
        return [
            {"start": 0.0, "duration": 4.0, "text": "Hello friends", "lang": lang_hint or "en", "speaker": 0},
            {"start": 4.0, "duration": 4.0, "text": "Welcome to the talk", "lang": lang_hint or "en", "speaker": 1},
        ]


class MapTranslator:
    def translate(self, text: str, source_lang: str, target_lang: str) -> str:
        return {"Hello friends": "Привет друзья", "Welcome to the talk": "Добро пожаловать"}[text]


def test_asr_cues_enter_the_same_session():
    session = Session(start_buffer_s=3.0)
    raw = ScriptAsr().transcribe(b"", 16000, "en")
    cues = [
        Cue(
            start=item["start"],
            duration=item["duration"],
            text=item["text"],
            lang=item["lang"],
            speaker=item["speaker"],
        )
        for item in raw
    ]
    started = session.start(
        tab_id="t",
        video_id="v",
        target_lang="ru",
        cues=cues,
        video_duration=8.0,
        source_lang="en",
    )
    assert started.state == "buffering"
    session.process_pending(MapTranslator(), ToneSynthesizer())
    voices = {u.voice_id for u in session.utterances}
    assert voices == {0, 1}
    assert session.utterances[0].target_text == "Привет друзья"


def test_http_asr_without_file_is_error():
    runtime = HostRuntime(
        Session(start_buffer_s=3.0),
        MapTranslator(),
        ToneSynthesizer(),
        asr=ScriptAsr(),
        fetch=lambda url: "<transcript></transcript>",
    )
    server = serve(runtime, host="127.0.0.1", port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address[:2]
    try:
        payload = {
            "tab_id": "t",
            "video_id": "v",
            "target_lang": "ru",
            "video_duration": 8.0,
            "playback_rate": 1.0,
            "player_payload": {"captions": {"playerCaptionsTracklistRenderer": {"captionTracks": []}}},
        }
        req = Request(
            f"http://{host}:{port}/v1/session/start",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(req) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        assert body["state"] == "error"
        assert "download" in body["reason"]
        assert assign_voices([0, 1])[0] != assign_voices([0, 1])[1]
    finally:
        server.shutdown()
