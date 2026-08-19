from pathlib import Path

from lvt_host.timedtext import parse_timedtext

FIXTURES = Path(__file__).parent / "fixtures"


def test_xml_cues_match_fixture():
    payload = (FIXTURES / "timedtext.xml").read_text(encoding="utf-8")
    cues = parse_timedtext(payload, lang="en")
    assert [(c.start, c.duration, c.text) for c in cues] == [
        (0.0, 2.0, "Hello friends"),
        (2.0, 2.5, "Welcome to the talk"),
        (4.5, 3.0, "Today we discuss memory"),
    ]
    assert cues[0].lang == "en"


def test_json3_cues_match_fixture():
    payload = (FIXTURES / "timedtext.json3.json").read_text(encoding="utf-8")
    cues = parse_timedtext(payload, lang="en")
    assert cues[0].text == "First line"
    assert cues[1].text == "Second line"
    assert cues[0].start == 0.0
    assert cues[1].duration == 2.2
