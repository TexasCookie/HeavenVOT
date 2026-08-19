from lvt_host.quality import Cue
from lvt_host.voices import assign_voices, single_voice_map, voice_for_speaker, whole_file_speakers


def test_two_speakers_get_two_voices():
    mapping = assign_voices([0, 1, 0, 1])
    assert mapping[0] != mapping[1]
    assert set(mapping.values()) <= {0, 1}


def test_same_speaker_keeps_voice():
    assert voice_for_speaker(4) == voice_for_speaker(4)
    assert assign_voices([7, 7, 7])[7] == voice_for_speaker(7)


def test_third_speaker_reuses_a_voice():
    mapping = assign_voices([0, 1, 2])
    assert mapping[2] in {0, 1}
    assert len(set(mapping.values())) <= 2


def test_no_diarization_is_one_voice():
    assert single_voice_map() == {0: 0}


def test_whole_file_speakers_two_slots_max():
    cues = [
        Cue(0.0, 1.0, "a", "en", 7),
        Cue(1.0, 1.0, "b", "en", 9),
        Cue(2.0, 1.0, "c", "en", 3),
        Cue(3.0, 1.0, "d", "en", 7),
    ]
    mapped, roster = whole_file_speakers(cues)
    assert roster == [7, 9]
    assert [c.speaker for c in mapped] == [0, 1, 1, 0]


def test_whole_file_speakers_one_id_stays_one_slot():
    cues = [Cue(0.0, 1.0, "a", "en", 4), Cue(1.0, 1.0, "b", "en", 4)]
    mapped, roster = whole_file_speakers(cues)
    assert roster == [4]
    assert all(c.speaker == 0 for c in mapped)
