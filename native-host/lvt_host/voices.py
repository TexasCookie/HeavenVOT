from __future__ import annotations

from typing import Iterable


def voice_for_speaker(speaker_id: int) -> int:
    return int(speaker_id) % 2


def assign_voices(speaker_ids: Iterable[int]) -> dict[int, int]:
    return {int(speaker): voice_for_speaker(speaker) for speaker in speaker_ids}


def single_voice_map() -> dict[int, int]:
    return {0: 0}


def whole_file_speakers(cues: list, roster: list[int] | None = None) -> tuple[list, list[int]]:
    """Map raw speaker ids onto at most two stable slots. roster is mutated/returned."""
    from .quality import Cue

    known = list(roster or [])
    out = []
    for cue in cues:
        raw = int(getattr(cue, "speaker", 0) or 0)
        if raw not in known and len(known) < 2:
            known.append(raw)
        if not known:
            slot = 0
        elif raw == known[0]:
            slot = 0
        else:
            slot = 1
        out.append(
            Cue(
                start=cue.start,
                duration=cue.duration,
                text=cue.text,
                lang=cue.lang,
                speaker=slot,
            )
        )
    return out, known
