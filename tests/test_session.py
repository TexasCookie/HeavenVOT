from lvt_host.backends import ToneSynthesizer
from lvt_host.quality import Cue
from lvt_host.session import BUFFERING, PAUSED_FOR_BUFFER, PLAYING, READY, SKIPPED, STOPPED, Session


class MapTranslator:
    def __init__(self, mapping: dict[str, str]) -> None:
        self.mapping = mapping
        self.seen: list[str] = []

    def translate(self, text: str, source_lang: str, target_lang: str) -> str:
        self.seen.append(text)
        return self.mapping[text]


def _cues() -> list[Cue]:
    return [
        Cue(0.0, 2.0, "Hello friends", "en"),
        Cue(2.0, 2.5, "Welcome to the talk", "en"),
        Cue(4.5, 3.5, "middle stretch", "en"),
        Cue(8.0, 2.0, "Later chapter", "en"),
    ]


def _mapping() -> dict[str, str]:
    return {
        "Hello friends": "Привет друзья",
        "Welcome to the talk": "Добро пожаловать",
        "middle stretch": "Середина",
        "Later chapter": "Позже",
    }


def test_already_target_does_not_start_voicing():
    session = Session(start_buffer_s=3.0)
    started = session.start(
        tab_id="1",
        video_id="vid",
        target_lang="en",
        cues=_cues(),
        video_duration=10.0,
        source_lang="en",
    )
    assert started.state == SKIPPED
    assert session.utterances == []


def test_start_buffer_then_play():
    session = Session(start_buffer_s=3.0)
    translator = MapTranslator(_mapping())
    tts = ToneSynthesizer()
    session.start(
        tab_id="1",
        video_id="vid",
        target_lang="ru",
        cues=_cues(),
        video_duration=10.0,
        source_lang="en",
    )
    assert session.on_playhead(0.0).pause_player is True
    session.process_pending(translator, tts, limit=2)
    assert translator.seen[0] == "Hello friends"
    assert session.utterances[0].target_text == "Привет друзья"
    assert session.utterances[0].target_text != session.utterances[0].source_text
    assert session.utterances[0].audio.startswith(b"RIFF")
    assert session.state in {READY, BUFFERING}
    tick = session.on_playhead(0.0)
    assert tick.pause_player is False
    assert tick.state == PLAYING
    assert tick.ready[0].target_text == "Привет друзья"


def test_pause_when_playhead_reaches_unready_cue():
    session = Session(start_buffer_s=1.0)
    translator = MapTranslator(_mapping())
    tts = ToneSynthesizer()
    session.start(
        tab_id="1",
        video_id="vid",
        target_lang="ru",
        cues=_cues(),
        video_duration=10.0,
        source_lang="en",
    )
    session.process_pending(translator, tts, limit=1)
    tick = session.on_playhead(8.0)
    assert tick.pause_player is True
    assert tick.state == PAUSED_FOR_BUFFER


def test_seek_keeps_ready_utterances():
    session = Session(start_buffer_s=1.0)
    translator = MapTranslator(_mapping())
    tts = ToneSynthesizer()
    session.start(
        tab_id="1",
        video_id="vid",
        target_lang="ru",
        cues=_cues(),
        video_duration=10.0,
        source_lang="en",
    )
    session.process_pending(translator, tts)
    assert any(u.start >= 8 for u in session.utterances)
    session.seek(7.5)
    assert any(u.start >= 8 for u in session.utterances)
    tick = session.on_playhead(8.0)
    assert tick.pause_player is False
    assert any(u.start >= 8 for u in tick.ready)


def test_second_tab_stops_first():
    session = Session(start_buffer_s=1.0)
    translator = MapTranslator(_mapping())
    tts = ToneSynthesizer()
    session.start(
        tab_id="tab-a",
        video_id="a",
        target_lang="ru",
        cues=_cues(),
        video_duration=10.0,
        source_lang="en",
        other_tab=True,
    )
    session.process_pending(translator, tts, limit=1)
    session.start(
        tab_id="tab-b",
        video_id="b",
        target_lang="ru",
        cues=_cues(),
        video_duration=10.0,
        source_lang="en",
        other_tab=True,
    )
    assert session.tab_id == "tab-b"
    assert session.utterances == []
    assert session.state == BUFFERING
