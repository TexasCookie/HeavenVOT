from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse

from .quality import (
    AUTO_TRANSLATE,
    ALREADY_TARGET,
    ACCEPT,
    NEED_ASR,
    Cue,
    GateDecision,
    evaluate_track,
    normalize_lang,
)
from .timedtext import parse_timedtext


Fetcher = Callable[[str], str]


@dataclass(frozen=True)
class CaptionTrack:
    language: str
    base_url: str
    kind: str
    name: str
    is_auto_translate: bool


@dataclass(frozen=True)
class IngestResult:
    status: str
    cues: list[Cue]
    track: CaptionTrack | None
    gate: GateDecision | None
    reason: str


def url_is_auto_translate(url: str) -> bool:
    if not url:
        return False
    query = parse_qs(urlparse(url).query)
    return bool(query.get("tlang"))


def _simple_name(value: Any) -> str:
    if isinstance(value, dict):
        simple = value.get("simpleText")
        if simple:
            return str(simple)
        runs = value.get("runs") or []
        if runs and isinstance(runs[0], dict):
            return str(runs[0].get("text") or "")
        return ""
    return str(value or "")


def extract_caption_tracks(player_payload: dict[str, Any]) -> list[CaptionTrack]:
    if not isinstance(player_payload, dict):
        return []
    captions = player_payload.get("captions") or {}
    if not isinstance(captions, dict):
        return []
    renderer = captions.get("playerCaptionsTracklistRenderer") or {}
    if not isinstance(renderer, dict):
        return []
    raw_tracks = renderer.get("captionTracks") or []
    if not isinstance(raw_tracks, list):
        return []
    tracks: list[CaptionTrack] = []
    for raw in raw_tracks:
        if not isinstance(raw, dict):
            continue
        url = str(raw.get("baseUrl") or "")
        tracks.append(
            CaptionTrack(
                language=normalize_lang(raw.get("languageCode")),
                base_url=url,
                kind=str(raw.get("kind") or "standard"),
                name=_simple_name(raw.get("name")),
                is_auto_translate=url_is_auto_translate(url),
            )
        )
    return tracks


def select_source_track(tracks: list[CaptionTrack], target_lang: str) -> CaptionTrack | None:
    usable = [t for t in tracks if not t.is_auto_translate]
    if not usable:
        return None
    target = normalize_lang(target_lang)
    # Prefer a non-target language track so we have something to translate.
    foreign_manual = [t for t in usable if t.language != target and t.kind != "asr"]
    if foreign_manual:
        return foreign_manual[0]
    foreign_asr = [t for t in usable if t.language != target]
    if foreign_asr:
        return foreign_asr[0]
    # Only target-language tracks exist — caller will see already-target via the gate.
    manual = [t for t in usable if t.kind != "asr"]
    return (manual or usable)[0]


def ingest_player_payload(
    player_payload: dict[str, Any],
    *,
    target_lang: str,
    video_duration: float,
    fetch: Fetcher,
) -> IngestResult:
    tracks = extract_caption_tracks(player_payload)
    if not tracks:
        return IngestResult(NEED_ASR, [], None, None, "no caption tracks")

    if all(t.is_auto_translate for t in tracks):
        gate = evaluate_track(
            cues=[],
            video_duration=video_duration,
            source_lang="",
            target_lang=target_lang,
            is_auto_translate=True,
        )
        return IngestResult(AUTO_TRANSLATE, [], tracks[0], gate, gate.reason)

    track = select_source_track(tracks, target_lang)
    if track is None:
        return IngestResult(NEED_ASR, [], None, None, "no usable source track")

    if track.is_auto_translate:
        gate = evaluate_track(
            cues=[],
            video_duration=video_duration,
            source_lang=track.language,
            target_lang=target_lang,
            is_auto_translate=True,
        )
        return IngestResult(AUTO_TRANSLATE, [], track, gate, gate.reason)

    try:
        body = fetch(track.base_url)
    except (OSError, ValueError):
        return IngestResult(NEED_ASR, [], track, None, "caption fetch failed")
    cues = parse_timedtext(body, lang=track.language)
    gate = evaluate_track(
        cues=cues,
        video_duration=video_duration,
        source_lang=track.language or (cues[0].lang if cues else ""),
        target_lang=target_lang,
        is_auto_translate=False,
        track_kind=track.kind,
    )
    return IngestResult(gate.decision, cues, track, gate, gate.reason)
