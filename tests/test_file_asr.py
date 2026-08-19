import math
import struct
import wave
from io import BytesIO
from pathlib import Path

from lvt_host.backends import ToneSynthesizer
from lvt_host.chunker import snap_windows, wav_bytes_from_pcm16, pcm16_mono_from_wav
from lvt_host.file_asr import cues_from_file
from lvt_host.http_app import HostRuntime, serve
from lvt_host.quality import Cue
from lvt_host.session import BUFFERING, READY, Session
import json
import threading
from urllib.request import Request, urlopen


def _tone_wav(seconds: float, rate: int = 16000, freq: float = 440.0) -> bytes:
    n = int(seconds * rate)
    samples = []
    for i in range(n):
        t = i / rate
        gate = 1.0
        # 0.4s silence every 10s near the cut
        pos = t % 10.0
        if pos > 9.4:
            gate = 0.0
        samples.append(int(8000 * gate * math.sin(2 * math.pi * freq * t)))
    return wav_bytes_from_pcm16(samples, rate)


class MapTranslator:
    def translate(self, text: str, source_lang: str, target_lang: str) -> str:
        return "T:" + text


class FakeAsr:
    def transcribe(self, audio, sample_rate=16000, lang_hint=None, offset=0.0):
        assert audio[:4] == b"RIFF"
        return [
            {
                "start": float(offset),
                "duration": 2.0,
                "text": "chunk at " + str(int(offset)),
                "lang": lang_hint or "en",
                "speaker": 0,
            }
        ]


class FileSource:
    def __init__(self, wav: bytes) -> None:
        self.wav = wav

    def fetch(self, video_id: str, dest_dir: Path) -> Path:
        path = dest_dir / (video_id + ".wav")
        path.write_bytes(self.wav)
        return path


def test_player_session_extractor_args_and_direct_url(tmp_path):
    from lvt_host.file_asr import (
        DownloadError,
        YtDlpSource,
        looks_like_media,
        strip_playback,
        youtube_extractor_args,
    )

    args = youtube_extractor_args("web", "TOKEN", "VISITOR")
    assert "player_client=web" in args
    assert "po_token=web.gvs+TOKEN" in args
    assert "visitor_data=VISITOR" in args
    assert "player_skip=webpage" not in args
    tv = youtube_extractor_args("tv", "TOKEN", "")
    assert "po_token=tv.gvs+TOKEN" in tv
    assert "po_token=web.gvs+TOKEN" in tv
    assert youtube_extractor_args("web", "web.gvs+READY", "") == "youtube:player_client=web;po_token=web.gvs+READY"
    assert youtube_extractor_args("web", "bad token", "ok") == "youtube:player_client=web;visitor_data=ok"
    raw = "https://rr.googlevideo.com/videoplayback?itag=140&range=0-99&rn=1&rbuf=2"
    assert "range=" not in strip_playback(raw)
    assert looks_like_media(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 8)
    assert not looks_like_media(b"<html>nope</html>")

    seen = []

    def run(*_args, **_kwargs):
        seen.append(1)
        raise DownloadError("nope")

    def direct(url, dest, vid):
        path = dest / (vid + ".m4a")
        path.write_bytes(b"x" * 100)
        return path

    src = YtDlpSource(run=run)
    src._direct = direct
    src.direct_urls = ["https://rr.googlevideo.com/videoplayback?itag=140"]
    path = src.fetch("abc", tmp_path)
    assert path.exists()
    assert seen == []


def test_apply_player_session_onto_source():
    from lvt_host.file_asr import YtDlpSource
    from lvt_host.http_app import HostRuntime, _apply_player_session

    src = YtDlpSource(run=lambda *a, **k: None)
    runtime = HostRuntime(Session(), MapTranslator(), ToneSynthesizer(), asr=FakeAsr())
    runtime.audio_source = src
    _apply_player_session(
        runtime,
        {
            "po_token": " TOK ",
            "visitor_data": "VIS",
            "audio_url": "https://rr.googlevideo.com/videoplayback?itag=140",
            "audio_urls": ["https://rr.googlevideo.com/videoplayback?itag=251"],
        },
    )
    assert src.po_token == "TOK"
    assert src.visitor_data == "VIS"
    assert src.direct_urls[0].endswith("itag=140")
    assert len(src.direct_urls) == 2


def test_netscape_and_client_retry(tmp_path):
    from lvt_host.file_asr import DownloadError, YtDlpSource, netscape_cookies

    text = netscape_cookies([{"name": "SID", "value": "x", "domain": ".youtube.com", "path": "/", "secure": True}])
    assert "SID" in text and ".youtube.com" in text
    seen = []

    def run(video_id, dest, client, cookie_path):
        seen.append(client)
        if client != "tv":
            raise DownloadError("nope")
        (dest / f"{video_id}.webm").write_bytes(b"x" * 100)

    src = YtDlpSource(run=run)
    src.cookies = [{"name": "SID", "value": "x", "domain": ".youtube.com"}]
    path = src.fetch("abc", tmp_path)
    assert path.name.endswith(".webm")
    assert "tv" in seen


def test_snap_windows_skip_origin_and_cut_near_pause():
    wav = _tone_wav(25.0)
    samples, rate = pcm16_mono_from_wav(wav)
    windows = snap_windows(samples, rate, origin=10.0)
    assert windows
    assert windows[0][0] >= 9.9
    assert all(w[1] < 13.0 for w in windows)


def test_cues_from_file_starts_at_zero(tmp_path):
    path = tmp_path / "a.wav"
    path.write_bytes(_tone_wav(22.0))
    cues = cues_from_file(path, FakeAsr().transcribe, playhead=10.0, lang_hint="en")
    assert cues
    assert cues[0].start < 1.0
    sample = cues_from_file(path, FakeAsr().transcribe, until_s=30.0, lang_hint="en")
    assert sample
    assert all(c.start < 30.0 for c in sample)


def test_progress_and_fail_show_on_tick():
    session = Session()
    session.start(
        tab_id="t",
        video_id="v",
        target_lang="ru",
        cues=[],
        video_duration=10.0,
        source_lang="en",
        asr_mode=True,
    )
    session.set_progress("downloading")
    session.fail_asr("audio_download_failed boom")
    tick = session.on_playhead(0.0)
    assert tick.state == "error"
    assert "download" in tick.reason


def test_download_fail_is_hard_error():
    session = Session()
    session.start(
        tab_id="t",
        video_id="v",
        target_lang="ru",
        cues=[],
        video_duration=10.0,
        source_lang="en",
        asr_mode=True,
    )
    session.fail_asr("audio_download_failed")
    session.add_cues([Cue(0.0, 2.0, "from tap", "en")])
    session.process_pending(MapTranslator(), ToneSynthesizer())
    assert session.utterances == []
    assert session.state == "error"


def test_wait_full_stays_paused_until_job_done():
    session = Session(start_buffer_s=1.0)
    session.start(
        tab_id="t",
        video_id="v",
        target_lang="ru",
        cues=[],
        video_duration=20.0,
        source_lang="en",
        asr_mode=True,
        wait_full=True,
    )
    assert session.on_playhead(0.0).pause_player is True
    assert session.asr_live is False
    session.add_cues([Cue(0.0, 2.0, "a", "en"), Cue(2.0, 2.0, "b", "en")])
    session.process_pending(MapTranslator(), ToneSynthesizer())
    assert session.state == BUFFERING
    session.mark_asr_complete()
    session.process_pending(MapTranslator(), ToneSynthesizer())
    assert session.state == READY
    assert session.on_playhead(0.0).pause_player is False


def test_process_media_path_always_from_zero(tmp_path):
    from lvt_host.file_asr import process_media_path

    path = tmp_path / "snip.wav"
    path.write_bytes(_tone_wav(10.0))
    session = Session(start_buffer_s=1.0)
    session.start(
        tab_id="t",
        video_id="v",
        target_lang="ru",
        cues=[],
        video_duration=80.0,
        source_lang="en",
        asr_mode=True,
    )
    runtime = HostRuntime(session, MapTranslator(), ToneSynthesizer(), asr=FakeAsr())
    process_media_path(runtime, path, 50.0, "en", snippet=True)
    assert session.utterances
    assert session.utterances[0].start < 1.0


def test_http_uploaded_audio_file():
    runtime = HostRuntime(Session(start_buffer_s=1.0), MapTranslator(), ToneSynthesizer(), asr=FakeAsr())
    server = serve(runtime, host="127.0.0.1", port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address[:2]
    try:
        start = Request(
            f"http://{host}:{port}/v1/session/start",
            data=json.dumps(
                {
                    "tab_id": "t",
                    "video_id": "vid",
                    "target_lang": "ru",
                    "video_duration": 12.0,
                    "asr_mode": True,
                    "skip_download": True,
                    "source_lang": "en",
                }
            ).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(start) as resp:
            json.loads(resp.read().decode("utf-8"))
        up = Request(
            f"http://{host}:{port}/v1/session/audio-file",
            data=_tone_wav(12.0),
            headers={"X-Audio-Start": "0"},
            method="POST",
        )
        with urlopen(up) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        assert body["ready_count"] >= 1
    finally:
        server.shutdown()


class MatchAsr:
    def transcribe(self, audio, sample_rate=16000, lang_hint=None, offset=0.0):
        return [
            {
                "start": float(offset),
                "duration": 2.0,
                "text": "hello friends welcome",
                "lang": lang_hint or "en",
                "speaker": 0,
            }
        ]


class TwoSpeakerAsr:
    def transcribe(self, audio, sample_rate=16000, lang_hint=None, offset=0.0):
        return [
            {
                "start": float(offset),
                "duration": 2.0,
                "text": "chunk at " + str(int(offset)),
                "lang": lang_hint or "en",
                "speaker": 0 if float(offset) < 10 else 3,
            }
        ]


def test_caption_match_keeps_caption_text(tmp_path):
    from lvt_host.file_asr import apply_downloaded_file

    path = tmp_path / "a.wav"
    path.write_bytes(_tone_wav(12.0))
    session = Session(start_buffer_s=1.0)
    session.start(
        tab_id="t",
        video_id="v",
        target_lang="ru",
        cues=[],
        video_duration=12.0,
        source_lang="en",
        asr_mode=True,
    )
    runtime = HostRuntime(session, MapTranslator(), ToneSynthesizer(), asr=MatchAsr())
    runtime.candidate_cues = [Cue(0.0, 2.0, "hello friends welcome", "en"), Cue(2.0, 2.0, "hello friends welcome", "en")]
    apply_downloaded_file(runtime, path, "en")
    assert [u.source_text for u in session.utterances] == ["hello friends welcome", "hello friends welcome"]
    assert all(u.voice_id == 0 for u in session.utterances)


def test_caption_mismatch_whispers_from_zero(tmp_path):
    from lvt_host.file_asr import apply_downloaded_file

    path = tmp_path / "a.wav"
    path.write_bytes(_tone_wav(12.0))
    session = Session(start_buffer_s=1.0)
    session.start(
        tab_id="t",
        video_id="v",
        target_lang="ru",
        cues=[],
        video_duration=12.0,
        source_lang="en",
        asr_mode=True,
    )
    runtime = HostRuntime(session, MapTranslator(), ToneSynthesizer(), asr=FakeAsr())
    runtime.candidate_cues = [Cue(0.0, 2.0, "totally unrelated caption words", "en")]
    apply_downloaded_file(runtime, path, "en")
    assert session.utterances
    assert session.utterances[0].start < 1.0
    assert "chunk at" in session.utterances[0].source_text


def test_two_speakers_map_after_whole_file(tmp_path):
    from lvt_host.file_asr import process_media_path

    path = tmp_path / "a.wav"
    path.write_bytes(_tone_wav(22.0))
    session = Session(start_buffer_s=1.0)
    session.start(
        tab_id="t",
        video_id="v",
        target_lang="ru",
        cues=[],
        video_duration=22.0,
        source_lang="en",
        asr_mode=True,
    )
    runtime = HostRuntime(session, MapTranslator(), ToneSynthesizer(), asr=TwoSpeakerAsr())
    process_media_path(runtime, path, 0.0, "en")
    voices = {u.voice_id for u in session.utterances}
    assert voices == {0, 1}


def _http_start(base: str, payload: dict) -> dict:
    req = Request(
        base + "/v1/session/start",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _http_tick(base: str, playhead: float) -> dict:
    req = Request(
        base + "/v1/session/tick",
        data=json.dumps({"playhead": playhead}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _wait_snap(base: str, pred, tries: int = 80) -> dict:
    snap = {}
    for _ in range(tries):
        snap = json.loads(urlopen(base + "/v1/session").read().decode("utf-8"))
        if pred(snap):
            return snap
        threading.Event().wait(0.05)
    return snap


def test_http_file_asr_job():
    runtime = HostRuntime(Session(start_buffer_s=1.0), MapTranslator(), ToneSynthesizer(), asr=FakeAsr())
    runtime.audio_source = FileSource(_tone_wav(12.0))
    server = serve(runtime, host="127.0.0.1", port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address[:2]
    base = f"http://{host}:{port}"
    try:
        started = _http_start(
            base,
            {
                "tab_id": "t",
                "video_id": "vid",
                "target_lang": "ru",
                "video_duration": 12.0,
                "asr_mode": True,
                "play_mode": "ready",
                "playhead": 0.0,
                "source_lang": "en",
            },
        )
        assert started["state"] == "buffering"
        assert started["file_job"] is True
        assert started["start_reason"] == "waiting for asr file"
        snap = _wait_snap(base, lambda s: s.get("ready_count", 0) >= 1)
        assert snap["ready_count"] >= 1
        tick = _http_tick(base, 0.0)
        assert tick["pause_player"] is False
        assert tick["utterances"]
    finally:
        server.shutdown()


def test_http_start_matching_captions_keep_caption_texts():
    runtime = HostRuntime(Session(start_buffer_s=1.0), MapTranslator(), ToneSynthesizer(), asr=MatchAsr())
    runtime.audio_source = FileSource(_tone_wav(12.0))
    server = serve(runtime, host="127.0.0.1", port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    host, port = server.server_address[:2]
    base = f"http://{host}:{port}"
    try:
        _http_start(
            base,
            {
                "tab_id": "t",
                "video_id": "vid",
                "target_lang": "ru",
                "video_duration": 12.0,
                "source_lang": "en",
                "play_mode": "ready",
                "cues": [
                    {"start": 0, "duration": 2, "text": "hello friends welcome", "lang": "en"},
                    {"start": 2, "duration": 2, "text": "hello friends welcome", "lang": "en"},
                ],
            },
        )
        snap = _wait_snap(base, lambda s: s.get("asr_done") and s.get("ready_count", 0) >= 1)
        assert snap["ready_count"] >= 1
        tick = _http_tick(base, 0.0)
        texts = [u["text"] for u in tick["utterances"]]
        assert texts
        assert all(t == "T:hello friends welcome" for t in texts)
        assert all("chunk at" not in t for t in texts)
    finally:
        server.shutdown()


def test_http_start_mismatch_captions_whispers_from_zero():
    runtime = HostRuntime(Session(start_buffer_s=1.0), MapTranslator(), ToneSynthesizer(), asr=FakeAsr())
    runtime.audio_source = FileSource(_tone_wav(12.0))
    server = serve(runtime, host="127.0.0.1", port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    host, port = server.server_address[:2]
    base = f"http://{host}:{port}"
    try:
        _http_start(
            base,
            {
                "tab_id": "t",
                "video_id": "vid",
                "target_lang": "ru",
                "video_duration": 12.0,
                "source_lang": "en",
                "play_mode": "ready",
                "playhead": 40.0,
                "cues": [{"start": 0, "duration": 2, "text": "totally unrelated caption words", "lang": "en"}],
            },
        )
        snap = _wait_snap(base, lambda s: s.get("asr_done") and s.get("ready_count", 0) >= 1)
        assert snap["ready_count"] >= 1
        tick = _http_tick(base, 80.0)
        texts = [u["text"] for u in tick["utterances"]]
        assert texts
        assert texts[0].startswith("T:chunk at 0")
        assert tick["utterances"][0]["start"] < 1.0
    finally:
        server.shutdown()


def test_http_start_no_captions_ten_second_windows_from_zero():
    class RecAsr(FakeAsr):
        def __init__(self):
            self.offsets = []

        def transcribe(self, audio, sample_rate=16000, lang_hint=None, offset=0.0):
            self.offsets.append(float(offset))
            return FakeAsr.transcribe(self, audio, sample_rate, lang_hint, offset)

    asr = RecAsr()
    runtime = HostRuntime(Session(start_buffer_s=1.0), MapTranslator(), ToneSynthesizer(), asr=asr)
    runtime.audio_source = FileSource(_tone_wav(25.0))
    server = serve(runtime, host="127.0.0.1", port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    host, port = server.server_address[:2]
    base = f"http://{host}:{port}"
    try:
        started = _http_start(
            base,
            {
                "tab_id": "t",
                "video_id": "vid",
                "target_lang": "ru",
                "video_duration": 25.0,
                "source_lang": "en",
                "play_mode": "ready",
                "cues": [],
            },
        )
        assert started["file_job"] is True
        snap = _wait_snap(base, lambda s: s.get("asr_done") and s.get("ready_count", 0) >= 2)
        assert snap["asr_done"] is True
        assert asr.offsets
        assert asr.offsets[0] < 1.0
        assert all(b - a < 13.0 for a, b in zip(asr.offsets, asr.offsets[1:]))
        assert any(abs((b - a) - 10.0) < 2.5 for a, b in zip(asr.offsets, asr.offsets[1:]))
    finally:
        server.shutdown()


def test_http_ready_unpauses_then_pauses_past_last_window():
    class GateAsr:
        def __init__(self):
            self.n = 0
            self.first = threading.Event()
            self.gate = threading.Event()

        def transcribe(self, audio, sample_rate=16000, lang_hint=None, offset=0.0):
            self.n += 1
            if self.n > 1:
                self.first.set()
                self.gate.wait(timeout=5)
            return [
                {
                    "start": float(offset),
                    "duration": 2.0,
                    "text": "chunk at " + str(int(offset)),
                    "lang": lang_hint or "en",
                    "speaker": 0,
                }
            ]

    asr = GateAsr()
    runtime = HostRuntime(Session(start_buffer_s=1.0), MapTranslator(), ToneSynthesizer(), asr=asr)
    runtime.audio_source = FileSource(_tone_wav(25.0))
    server = serve(runtime, host="127.0.0.1", port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    host, port = server.server_address[:2]
    base = f"http://{host}:{port}"
    try:
        _http_start(
            base,
            {
                "tab_id": "t",
                "video_id": "vid",
                "target_lang": "ru",
                "video_duration": 25.0,
                "source_lang": "en",
                "play_mode": "ready",
                "cues": [],
            },
        )
        snap = _wait_snap(base, lambda s: s.get("ready_count", 0) >= 1 and not s.get("asr_done"))
        assert snap["asr_done"] is False
        assert snap["ready_count"] >= 1
        early = _http_tick(base, 0.0)
        assert early["pause_player"] is False
        late = _http_tick(base, 8.0)
        assert late["pause_player"] is True
        assert snap["asr_done"] is False
    finally:
        asr.gate.set()
        server.shutdown()


def test_http_need_file_without_source_is_hard_error():
    runtime = HostRuntime(Session(start_buffer_s=1.0), MapTranslator(), ToneSynthesizer(), asr=FakeAsr())
    server = serve(runtime, host="127.0.0.1", port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    host, port = server.server_address[:2]
    base = f"http://{host}:{port}"
    try:
        started = _http_start(
            base,
            {
                "tab_id": "t",
                "video_id": "vid",
                "target_lang": "ru",
                "video_duration": 12.0,
                "source_lang": "en",
                "skip_download": True,
            },
        )
        assert started["state"] == "buffering"
        req = Request(
            base + "/v1/session/need-file",
            data=b"{}",
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(req) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        assert body["state"] == "error"
        assert "download" in body["reason"]
        runtime.session.add_cues([Cue(0.0, 2.0, "from tap", "en")])
        runtime.session.process_pending(MapTranslator(), ToneSynthesizer())
        assert runtime.session.utterances == []
    finally:
        server.shutdown()


class FailSource:
    def fetch(self, video_id: str, dest_dir: Path) -> Path:
        raise RuntimeError("audio_download_failed boom")


class SlowFailSource:
    def __init__(self, delay: float = 0.25) -> None:
        self.delay = delay

    def fetch(self, video_id: str, dest_dir: Path) -> Path:
        threading.Event().wait(self.delay)
        raise RuntimeError("audio_download_failed late")


def _post_wav(base: str, wav: bytes) -> dict:
    req = Request(
        base + "/v1/session/audio-file",
        data=wav,
        headers={"X-Audio-Start": "0"},
        method="POST",
    )
    with urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))


def test_http_late_upload_after_ytdlp_fail():
    runtime = HostRuntime(Session(start_buffer_s=1.0), MapTranslator(), ToneSynthesizer(), asr=FakeAsr())
    runtime.audio_source = FailSource()
    server = serve(runtime, host="127.0.0.1", port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    host, port = server.server_address[:2]
    base = f"http://{host}:{port}"
    try:
        _http_start(
            base,
            {
                "tab_id": "t",
                "video_id": "vid",
                "target_lang": "ru",
                "video_duration": 12.0,
                "source_lang": "en",
            },
        )
        snap = _wait_snap(base, lambda s: s.get("state") == "error")
        assert snap["state"] == "error"
        body = _post_wav(base, _tone_wav(12.0))
        assert body.get("ready_count", 0) >= 1
        assert body["state"] != "error"
        tick = _http_tick(base, 0.0)
        assert tick["utterances"]
    finally:
        server.shutdown()


def test_http_ytdlp_fail_does_not_kill_successful_upload():
    runtime = HostRuntime(Session(start_buffer_s=1.0), MapTranslator(), ToneSynthesizer(), asr=FakeAsr())
    runtime.audio_source = SlowFailSource(0.3)
    server = serve(runtime, host="127.0.0.1", port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    host, port = server.server_address[:2]
    base = f"http://{host}:{port}"
    try:
        _http_start(
            base,
            {
                "tab_id": "t",
                "video_id": "vid",
                "target_lang": "ru",
                "video_duration": 12.0,
                "source_lang": "en",
            },
        )
        body = _post_wav(base, _tone_wav(12.0))
        assert body.get("ready_count", 0) >= 1
        threading.Event().wait(0.5)
        snap = json.loads(urlopen(base + "/v1/session").read().decode("utf-8"))
        assert snap["state"] != "error"
        assert snap["ready_count"] >= 1
    finally:
        server.shutdown()


def test_http_upload_grace_expires_to_error():
    runtime = HostRuntime(Session(start_buffer_s=1.0), MapTranslator(), ToneSynthesizer(), asr=FakeAsr())
    runtime.audio_source = FailSource()
    runtime.upload_grace_s = 0.15
    server = serve(runtime, host="127.0.0.1", port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    host, port = server.server_address[:2]
    base = f"http://{host}:{port}"
    try:
        started = _http_start(
            base,
            {
                "tab_id": "t",
                "video_id": "vid",
                "target_lang": "ru",
                "video_duration": 12.0,
                "source_lang": "en",
                "expect_upload": True,
            },
        )
        assert started["state"] == "buffering"
        snap = _wait_snap(base, lambda s: s.get("state") == "error", tries=40)
        assert snap["state"] == "error"
        assert "download" in snap["reason"]
    finally:
        server.shutdown()


def test_http_ytdlp_fail_waits_when_upload_still_open():
    runtime = HostRuntime(Session(start_buffer_s=1.0), MapTranslator(), ToneSynthesizer(), asr=FakeAsr())
    runtime.audio_source = FailSource()
    server = serve(runtime, host="127.0.0.1", port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    host, port = server.server_address[:2]
    base = f"http://{host}:{port}"
    try:
        started = _http_start(
            base,
            {
                "tab_id": "t",
                "video_id": "vid",
                "target_lang": "ru",
                "video_duration": 12.0,
                "source_lang": "en",
                "expect_upload": True,
            },
        )
        assert started["state"] == "buffering"
        snap = _wait_snap(base, lambda s: s.get("state") == "error", tries=15)
        assert snap["state"] != "error"
        body = _post_wav(base, _tone_wav(12.0))
        assert body.get("ready_count", 0) >= 1
        assert body["state"] != "error"
    finally:
        server.shutdown()


def test_http_play_mode_full_stays_paused_until_job_done():
    class GateAsr:
        def __init__(self):
            self.n = 0
            self.gate = threading.Event()

        def transcribe(self, audio, sample_rate=16000, lang_hint=None, offset=0.0):
            self.n += 1
            if self.n > 1:
                self.gate.wait(timeout=5)
            return [
                {
                    "start": float(offset),
                    "duration": 2.0,
                    "text": "chunk at " + str(int(offset)),
                    "lang": lang_hint or "en",
                    "speaker": 0,
                }
            ]

    asr = GateAsr()
    runtime = HostRuntime(Session(start_buffer_s=1.0), MapTranslator(), ToneSynthesizer(), asr=asr)
    runtime.audio_source = FileSource(_tone_wav(25.0))
    server = serve(runtime, host="127.0.0.1", port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    host, port = server.server_address[:2]
    base = f"http://{host}:{port}"
    try:
        _http_start(
            base,
            {
                "tab_id": "t",
                "video_id": "vid",
                "target_lang": "ru",
                "video_duration": 25.0,
                "source_lang": "en",
                "play_mode": "full",
                "cues": [],
            },
        )
        snap = _wait_snap(base, lambda s: s.get("ready_count", 0) >= 1 and not s.get("asr_done"))
        assert snap["wait_full"] is True
        assert snap["asr_done"] is False
        mid = _http_tick(base, 0.0)
        assert mid["pause_player"] is True
        asr.gate.set()
        done = _wait_snap(base, lambda s: s.get("asr_done") is True)
        assert done["asr_done"] is True
        late = _http_tick(base, 0.0)
        assert late["pause_player"] is False
    finally:
        asr.gate.set()
        server.shutdown()


def test_http_expect_upload_need_file_after_ytdlp_fail_is_error():
    runtime = HostRuntime(Session(start_buffer_s=1.0), MapTranslator(), ToneSynthesizer(), asr=FakeAsr())
    runtime.audio_source = FailSource()
    server = serve(runtime, host="127.0.0.1", port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    host, port = server.server_address[:2]
    base = f"http://{host}:{port}"
    try:
        started = _http_start(
            base,
            {
                "tab_id": "t",
                "video_id": "vid",
                "target_lang": "ru",
                "video_duration": 12.0,
                "source_lang": "en",
                "expect_upload": True,
            },
        )
        assert started["state"] == "buffering"
        failed = False
        for _ in range(40):
            if runtime.file_job_failed:
                failed = True
                break
            threading.Event().wait(0.05)
        assert failed is True
        mid = json.loads(urlopen(base + "/v1/session").read().decode("utf-8"))
        assert mid["state"] != "error"
        req = Request(
            base + "/v1/session/need-file",
            data=b"{}",
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(req) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        assert body["state"] == "error"
        assert "download" in body["reason"]
        runtime.session.add_cues([Cue(0.0, 2.0, "from tap", "en")])
        runtime.session.process_pending(MapTranslator(), ToneSynthesizer())
        assert runtime.session.utterances == []
    finally:
        server.shutdown()
