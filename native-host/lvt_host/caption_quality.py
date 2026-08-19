from __future__ import annotations

import re

from .quality import Cue

_WORD = re.compile(r"[a-zа-яё0-9]+", re.IGNORECASE)
SAMPLE_S = 30.0
MIN_RATIO = 0.35


def words_of(text: str) -> set[str]:
    return {m.group(0).lower() for m in _WORD.finditer(text or "")}


def caption_matches_sample(captions: list[Cue], sample: list[Cue], *, window_s: float = SAMPLE_S) -> bool:
    cap = set()
    asr = set()
    for cue in captions:
        if cue.start < window_s:
            cap |= words_of(cue.text)
    for cue in sample:
        if cue.start < window_s:
            asr |= words_of(cue.text)
    if not cap:
        return False
    if not asr:
        return False
    hit = len(cap & asr)
    return (hit / max(len(asr), 1)) >= MIN_RATIO and (hit / max(len(cap), 1)) >= MIN_RATIO