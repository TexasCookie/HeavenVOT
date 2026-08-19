import json
from pathlib import Path

from lvt_host.ingest import extract_caption_tracks, ingest_player_payload, url_is_auto_translate
from lvt_host.quality import ACCEPT, AUTO_TRANSLATE, NEED_ASR

FIXTURES = Path(__file__).parent / "fixtures"
XML = (FIXTURES / "timedtext.xml").read_text(encoding="utf-8")


def _player(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def test_auto_translate_url_detected():
    assert url_is_auto_translate("http://127.0.0.1/manual?tlang=ru")
    assert not url_is_auto_translate("http://127.0.0.1/manual")


def test_manual_source_preferred_over_translate_url():
    fetched = []

    def fetch(url: str) -> str:
        fetched.append(url)
        return XML

    result = ingest_player_payload(
        _player("player_manual.json"),
        target_lang="ru",
        video_duration=7.5,
        fetch=fetch,
    )
    assert result.status == ACCEPT
    assert result.track is not None
    assert not result.track.is_auto_translate
    assert fetched == ["http://127.0.0.1/manual"]
    assert [c.text for c in result.cues][0] == "Hello friends"


def test_asr_track_used_when_it_is_the_only_source():
    result = ingest_player_payload(
        _player("player_asr_only.json"),
        target_lang="ru",
        video_duration=7.5,
        fetch=lambda url: XML,
    )
    assert result.status == ACCEPT
    assert result.track is not None
    assert result.track.kind == "asr"


def test_no_tracks_requires_asr():
    result = ingest_player_payload(
        _player("player_none.json"),
        target_lang="ru",
        video_duration=10.0,
        fetch=lambda url: XML,
    )
    assert result.status == NEED_ASR
    assert result.cues == []


def test_only_translate_urls_rejected():
    payload = {
        "captions": {
            "playerCaptionsTracklistRenderer": {
                "captionTracks": [
                    {
                        "baseUrl": "http://127.0.0.1/x?tlang=ru",
                        "languageCode": "en",
                    }
                ]
            }
        }
    }
    result = ingest_player_payload(payload, target_lang="ru", video_duration=10.0, fetch=lambda url: XML)
    assert result.status == AUTO_TRANSLATE
    tracks = extract_caption_tracks(payload)
    assert tracks[0].is_auto_translate
