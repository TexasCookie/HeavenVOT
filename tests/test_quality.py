from lvt_host.quality import (
    ACCEPT,
    ALREADY_TARGET,
    AUTO_TRANSLATE,
    NEED_ASR,
    Cue,
    evaluate_track,
    normalize_lang,
)


def talk_cues():
    return [
        Cue(0.0, 3.0, "hello there", "en"),
        Cue(3.0, 3.0, "more spoken words", "en"),
        Cue(6.0, 4.0, "and a closing thought", "en"),
    ]


def test_already_target_refuses_translation():
    decision = evaluate_track(
        cues=talk_cues(),
        video_duration=10.0,
        source_lang="en-US",
        target_lang="en",
        is_auto_translate=False,
    )
    assert decision.decision == ALREADY_TARGET


def test_auto_translate_never_accepted():
    decision = evaluate_track(
        cues=talk_cues(),
        video_duration=10.0,
        source_lang="en",
        target_lang="ru",
        is_auto_translate=True,
    )
    assert decision.decision == AUTO_TRANSLATE


def test_dense_talk_is_accepted():
    decision = evaluate_track(
        cues=talk_cues(),
        video_duration=10.0,
        source_lang="en",
        target_lang="ru",
        is_auto_translate=False,
    )
    assert decision.decision == ACCEPT
    assert decision.coverage >= 0.8


def test_music_heavy_track_needs_asr():
    cues = [Cue(i, 1.0, "[Music]", "en") for i in range(10)]
    decision = evaluate_track(
        cues=cues,
        video_duration=10.0,
        source_lang="en",
        target_lang="ru",
        is_auto_translate=False,
    )
    assert decision.decision == NEED_ASR


def test_sparse_speech_is_accepted():
    cues = [Cue(0.0, 0.4, "hi there friend", "en")]
    decision = evaluate_track(
        cues=cues,
        video_duration=20.0,
        source_lang="en",
        target_lang="ru",
        is_auto_translate=False,
    )
    assert decision.decision == ACCEPT


def test_normalize_lang_folds_region():
    assert normalize_lang("ru-RU") == "ru"
    assert normalize_lang("ENG") == "en"
