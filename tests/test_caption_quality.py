from lvt_host.caption_quality import caption_matches_sample
from lvt_host.quality import Cue


def test_matching_captions_pass():
    caps = [Cue(0.0, 2.0, "hello friends welcome", "en"), Cue(2.0, 2.0, "to the talk today", "en")]
    sample = [Cue(0.0, 2.0, "hello friends welcome", "en"), Cue(2.5, 2.0, "to the talk", "en")]
    assert caption_matches_sample(caps, sample) is True


def test_unrelated_captions_fail():
    caps = [Cue(0.0, 2.0, "completely different words here", "en")]
    sample = [Cue(0.0, 2.0, "hello friends welcome", "en")]
    assert caption_matches_sample(caps, sample) is False
