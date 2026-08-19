from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable, Sequence

ACCEPT = "accept"
ALREADY_TARGET = "already_target"
AUTO_TRANSLATE = "auto_translate"
NEED_ASR = "need_asr"

COVERAGE_MIN = 0.15
MUSIC_RATIO_MAX = 0.85
_MUSIC_MARKERS = ("[music]", "[applause]", "[laughter]", "[cheers]", "♪", "♫")


@dataclass(frozen=True)
class Cue:
    start: float
    duration: float
    text: str
    lang: str = ""
    speaker: int = 0


@dataclass(frozen=True)
class GateDecision:
    decision: str
    coverage: float
    music_ratio: float
    reason: str


def normalize_lang(code: str | None) -> str:
    if not code:
        return ""
    token = code.strip().lower().replace("_", "-")
    if not token:
        return ""
    primary = token.split("-", 1)[0]
    if primary in {"en", "eng"}:
        return "en"
    if primary in {"ru", "rus"}:
        return "ru"
    return primary


def is_non_speech_marker(text: str) -> bool:
    folded = (text or "").strip().lower()
    if not folded:
        return True
    return any(marker in folded for marker in _MUSIC_MARKERS)


def cue_coverage(cues: Sequence[Cue], video_duration: float) -> float:
    if not math.isfinite(video_duration) or video_duration <= 0:
        return 0.0
    intervals: list[tuple[float, float]] = []
    for cue in cues:
        start = max(0.0, float(cue.start))
        end = min(video_duration, start + max(0.0, float(cue.duration)))
        if end > start:
            intervals.append((start, end))
    if not intervals:
        return 0.0
    intervals.sort()
    merged_start, merged_end = intervals[0]
    covered = 0.0
    for start, end in intervals[1:]:
        if start <= merged_end:
            merged_end = max(merged_end, end)
            continue
        covered += merged_end - merged_start
        merged_start, merged_end = start, end
    covered += merged_end - merged_start
    return covered / video_duration


def music_ratio(cues: Sequence[Cue]) -> float:
    if not cues:
        return 1.0
    marked = sum(1 for c in cues if is_non_speech_marker(c.text))
    return marked / len(cues)


def evaluate_track(
    *,
    cues: Sequence[Cue],
    video_duration: float,
    source_lang: str | None,
    target_lang: str | None,
    is_auto_translate: bool,
    track_kind: str | None = None,
) -> GateDecision:
    del track_kind  # kind informs the caller; the gate uses coverage + flags
    if is_auto_translate:
        return GateDecision(AUTO_TRANSLATE, 0.0, 0.0, "auto-translated track cannot be a source")

    src = normalize_lang(source_lang)
    tgt = normalize_lang(target_lang)
    if src and tgt and src == tgt:
        return GateDecision(ALREADY_TARGET, 1.0, 0.0, "source language equals target")

    if not cues:
        return GateDecision(NEED_ASR, 0.0, 1.0, "no cues")

    coverage = (
        cue_coverage(cues, video_duration)
        if math.isfinite(video_duration) and video_duration > 0
        else 0.0
    )
    music = music_ratio(cues)
    speech = sum(1 for cue in cues if not is_non_speech_marker(cue.text))
    if speech == 0:
        return GateDecision(NEED_ASR, coverage, music, "no speech cues")
    if music > MUSIC_RATIO_MAX:
        return GateDecision(NEED_ASR, coverage, music, "too many non-speech markers")
    return GateDecision(ACCEPT, coverage, music, "usable source-language cues")


def cues_from_dicts(items: Iterable[dict]) -> list[Cue]:
    out: list[Cue] = []
    for item in items:
        out.append(
            Cue(
                start=float(item["start"]),
                duration=float(item["duration"]),
                text=str(item.get("text") or ""),
                lang=str(item.get("lang") or ""),
                speaker=int(item.get("speaker") or 0),
            )
        )
    return out
