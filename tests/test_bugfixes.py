import json
import math
import threading
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from lvt_host.backends import ToneSynthesizer
from lvt_host.fetching import validate_caption_url
from lvt_host.http_app import HostRuntime, serve
from lvt_host.ingest import extract_caption_tracks, ingest_player_payload
from lvt_host.quality import ACCEPT, NEED_ASR, Cue, cue_coverage, evaluate_track
from lvt_host.session import BUFFERING, READY, Session
from lvt_host.timedtext import parse_timedtext


class MapTranslator:
    def translate(self, text: str, source_lang: str, target_lang: str) -> str:
        return "T:" + text


def test_overlapping_cues_do_not_inflate_coverage():
    cues = [Cue(0.0, 5.0, "a", "en"), Cue(0.0, 5.0, "b", "en")]
    assert cue_coverage(cues, 10.0) == pytest.approx(0.5)
    decision = evaluate_track(
        cues=cues,
        video_duration=10.0,
        source_lang="en",
        target_lang="ru",
        is_auto_translate=False,
    )
    assert decision.decision == ACCEPT


def test_nan_duration_still_accepts_speech():
    cues = [Cue(0.0, 8.0, "spoken words here", "en")]
    decision = evaluate_track(
        cues=cues,
        video_duration=float("nan"),
        source_lang="en",
        target_lang="ru",
        is_auto_translate=False,
    )
    assert decision.decision == ACCEPT


def test_empty_name_runs_does_not_crash_extract():
    payload = {
        "captions": {
            "playerCaptionsTracklistRenderer": {
                "captionTracks": [
                    {"baseUrl": "https://www.youtube.com/api/timedtext?v=x", "name": {"runs": []}}
                ]
            }
        }
    }
    tracks = extract_caption_tracks(payload)
    assert len(tracks) == 1
    assert tracks[0].name == ""


def test_bom_json3_parses():
    body = "\ufeff" + json.dumps({"events": [{"t": 0, "d": 1000, "segs": [{"utf8": "Hi"}]}]})
    cues = parse_timedtext(body, lang="en")
    assert cues[0].text == "Hi"


def test_invalid_timedtext_is_empty_not_throw():
    assert parse_timedtext("<not-xml") == []
    assert parse_timedtext("{not-json") == []


def test_seek_buffer_ignores_past_utterances():
    session = Session(start_buffer_s=3.0)
    cues = [Cue(float(i), 1.0, f"seg{i}", "en") for i in range(20)] + [Cue(20.0, 4.0, "later", "en")]
    session.start(
        tab_id="t",
        video_id="v",
        target_lang="ru",
        cues=cues,
        video_duration=24.0,
        source_lang="en",
    )
    session.process_pending(MapTranslator(), ToneSynthesizer(), limit=5)
    assert session.state == READY
    session.seek(20.0)
    assert session.state == BUFFERING
    assert session.on_playhead(20.0).pause_player is True


def test_process_pending_keeps_work_across_seek():
    session = Session(start_buffer_s=1.0)

    class SlowPopTranslator:
        def __init__(self) -> None:
            self.calls = 0

        def translate(self, text: str, source_lang: str, target_lang: str) -> str:
            self.calls += 1
            if self.calls == 1:
                session.seek(50.0)
            return "T:" + text

    cues = (
        [Cue(0.0, 8.0, "early", "en")]
        + [Cue(float(i), 1.0, f"pad{i}", "en") for i in range(8, 50)]
        + [Cue(50.0, 4.0, "late", "en")]
    )
    session.start(
        tab_id="t",
        video_id="v",
        target_lang="ru",
        cues=cues,
        video_duration=54.0,
        source_lang="en",
    )
    session.process_pending(SlowPopTranslator(), ToneSynthesizer())
    assert any(u.start < 1.0 for u in session.utterances)
    assert any(u.start >= 49.0 for u in session.utterances)


def test_ssrf_and_file_urls_rejected():
    for url in (
        "file:///C:/Windows/win.ini",
        "http://127.0.0.1/secret",
        "http://169.254.169.254/latest/meta-data",
        "https://evil.example/steal",
    ):
        with pytest.raises(ValueError):
            validate_caption_url(url)
    parsed = validate_caption_url("https://www.youtube.com/api/timedtext?v=abc")
    assert parsed.hostname == "www.youtube.com"


def test_http_rejects_non_object_json_and_bad_rate():
    runtime = HostRuntime(Session(), MapTranslator(), ToneSynthesizer())
    server = serve(runtime, host="127.0.0.1", port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address[:2]
    base = f"http://{host}:{port}"
    try:
        req = Request(
            base + "/v1/session/start",
            data=b"[1,2,3]",
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with pytest.raises(HTTPError) as err:
            urlopen(req)
        assert err.value.code == 400

        req2 = Request(
            base + "/v1/session/tick",
            data=b'{"playhead":"nope"}',
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with pytest.raises(HTTPError) as err2:
            urlopen(req2)
        assert err2.value.code == 400
    finally:
        server.shutdown()


def test_ingest_fetch_error_is_need_asr_not_crash():
    payload = {
        "captions": {
            "playerCaptionsTracklistRenderer": {
                "captionTracks": [
                    {
                        "baseUrl": "https://www.youtube.com/api/timedtext?v=x",
                        "languageCode": "en",
                    }
                ]
            }
        }
    }

    def boom(_url: str) -> str:
        raise OSError("network down")

    result = ingest_player_payload(payload, target_lang="ru", video_duration=10.0, fetch=boom)
    assert result.status == NEED_ASR
    assert result.cues == []
