from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass

from .backends import Synthesizer, Translator
from .quality import ACCEPT, ALREADY_TARGET, AUTO_TRANSLATE, NEED_ASR, Cue, GateDecision, evaluate_track, normalize_lang
from .voices import voice_for_speaker


BUFFERING = "buffering"
READY = "ready"
PLAYING = "playing"
PAUSED_FOR_BUFFER = "paused_for_buffer"
STOPPED = "stopped"
ERROR = "error"
SKIPPED = "skipped"


@dataclass
class Utterance:
    id: str
    start: float
    duration: float
    source_text: str
    target_text: str
    voice_id: int
    audio: bytes
    ready: bool = True


@dataclass
class TickResult:
    state: str
    pause_player: bool
    reason: str
    ready: list[Utterance]


@dataclass
class StartResult:
    state: str
    reason: str
    gate: GateDecision | None = None


class SessionBusy(RuntimeError):
    pass


class Session:
    def __init__(self, *, start_buffer_s: float = 5.0, lead_s: float = 0.15) -> None:
        self.start_buffer_s = start_buffer_s
        self.lead_s = lead_s
        self._lock = threading.RLock()
        self.state = STOPPED
        self.reason = ""
        self.tab_id: str | None = None
        self.video_id: str | None = None
        self.target_lang = "ru"
        self.utterances: list[Utterance] = []
        self._pending: list[Cue] = []
        self.gate: GateDecision | None = None
        self._epoch = 0
        self._origin = 0.0
        self.awaiting_asr = False
        self.asr_live = False
        self.wait_full = False
        self.asr_done = False

    def start(
        self,
        *,
        tab_id: str,
        video_id: str,
        target_lang: str,
        cues: list[Cue],
        video_duration: float,
        source_lang: str,
        is_auto_translate: bool = False,
        track_kind: str | None = None,
        other_tab: bool = False,
        asr_mode: bool = False,
        wait_full: bool = False,
    ) -> StartResult:
        with self._lock:
            if self.state not in {STOPPED, SKIPPED, ERROR} and other_tab:
                self._stop_locked("preempted by another tab")
            elif self.state not in {STOPPED, SKIPPED, ERROR} and self.tab_id and self.tab_id != tab_id:
                self._stop_locked("preempted by another tab")

            self.tab_id = tab_id
            self.video_id = video_id
            self.target_lang = target_lang
            self.utterances = []
            self._pending = []
            self._epoch += 1
            self._origin = 0.0
            gate = evaluate_track(
                cues=cues,
                video_duration=video_duration,
                source_lang=source_lang,
                target_lang=target_lang,
                is_auto_translate=is_auto_translate,
                track_kind=track_kind,
            )
            self.gate = gate
            if gate.decision == ALREADY_TARGET:
                self.state = SKIPPED
                self.reason = gate.reason
                return StartResult(self.state, self.reason, gate)
            if gate.decision == AUTO_TRANSLATE:
                self.state = ERROR
                self.reason = gate.reason
                return StartResult(self.state, self.reason, gate)
            if gate.decision == NEED_ASR:
                if asr_mode:
                    self.awaiting_asr = True
                    self.wait_full = bool(wait_full)
                    self.asr_live = False
                    self.asr_done = False
                    self.state = BUFFERING
                    self.reason = "waiting for asr file"
                    return StartResult(self.state, self.reason, gate)
                self.state = ERROR
                self.reason = NEED_ASR
                return StartResult(self.state, self.reason, gate)
            if gate.decision != ACCEPT:
                self.state = ERROR
                self.reason = gate.reason
                return StartResult(self.state, self.reason, gate)

            self.awaiting_asr = False
            self.asr_live = False
            self.wait_full = False
            self.asr_done = True
            self._pending = list(cues)
            self.state = BUFFERING
            self.reason = "filling start buffer"
            return StartResult(self.state, self.reason, gate)

    def add_cues(self, cues: list[Cue]) -> None:
        with self._lock:
            if self.state in {STOPPED, SKIPPED, ERROR}:
                return
            self._pending.extend(cues)

    def mark_asr_complete(self) -> None:
        with self._lock:
            if self.state in {STOPPED, SKIPPED, ERROR}:
                return
            self.awaiting_asr = False
            self.asr_done = True

    def set_progress(self, reason: str) -> None:
        with self._lock:
            if self.state in {STOPPED, SKIPPED, ERROR}:
                return
            self.reason = reason

    def fail_asr(self, reason: str) -> None:
        with self._lock:
            self.state = ERROR
            self.reason = reason or "asr_failed"
            self.awaiting_asr = False
            self.asr_done = True

    def reopen_for_file(self) -> bool:
        with self._lock:
            if self.state == STOPPED or self.state == SKIPPED:
                return False
            if self.state != ERROR:
                return True
            self.state = BUFFERING
            self.reason = "waiting for asr file"
            self.awaiting_asr = True
            self.asr_done = False
            return True

    def process_pending(self, translator: Translator, synthesizer: Synthesizer, limit: int | None = None) -> int:
        produced = 0
        while True:
            with self._lock:
                if self.state in {STOPPED, SKIPPED, ERROR}:
                    return produced
                if not self._pending:
                    if self.state == BUFFERING and self.wait_full and not self.asr_done:
                        return produced
                    if self.state == BUFFERING:
                        filled = self._ready_from(self._origin) >= self.start_buffer_s
                        if (not self.wait_full or self.asr_done) and (filled or self.asr_done):
                            self.state = READY
                            self.reason = "buffer ready or cues exhausted"
                    return produced
                if limit is not None and produced >= limit:
                    return produced
                cue = self._pending.pop(0)
                epoch = self._epoch
            target_text = translator.translate(cue.text, cue.lang or "", self.target_lang)
            src_lang = normalize_lang(cue.lang)
            tgt_lang = normalize_lang(self.target_lang)
            if target_text == cue.text and src_lang and tgt_lang and src_lang != tgt_lang:
                raise RuntimeError("translator returned source text")
            voice = voice_for_speaker(cue.speaker)
            audio = synthesizer.synthesize(target_text, self.target_lang, voice)
            utterance = Utterance(
                id=uuid.uuid4().hex,
                start=cue.start,
                duration=max(cue.duration, 0.2),
                source_text=cue.text,
                target_text=target_text,
                voice_id=voice,
                audio=audio,
            )
            with self._lock:
                if self.state in {STOPPED, SKIPPED, ERROR}:
                    return produced
                if epoch != self._epoch:
                    continue
                self.utterances.append(utterance)
                produced += 1
                if (
                    self.state == BUFFERING
                    and self._ready_from(self._origin) >= self.start_buffer_s
                    and (not self.wait_full or self.asr_done)
                ):
                    self.state = READY
                    self.reason = "start buffer filled"
        return produced

    def on_playhead(self, playhead: float) -> TickResult:
        with self._lock:
            if self.state in {STOPPED, SKIPPED, ERROR}:
                return TickResult(self.state, False, self.reason, [])
            if self.asr_live:
                due = [u for u in self.utterances if u.ready and u.start <= playhead + self.lead_s]
                return TickResult(self.state if self.state != STOPPED else PLAYING, False, "asr live", due)
            if self.state == BUFFERING:
                return TickResult(BUFFERING, True, self.reason or "waiting for start buffer", [])

            due = [u for u in self.utterances if u.ready and u.start <= playhead + self.lead_s]
            next_unready_time = self._next_unready_start(playhead)
            if next_unready_time is not None and playhead + self.lead_s >= next_unready_time:
                self.state = PAUSED_FOR_BUFFER
                self.reason = "playhead reached unready utterance"
                return TickResult(self.state, True, self.reason, due)

            self.state = PLAYING
            self.reason = ""
            return TickResult(self.state, False, "", due)

    def seek(self, playhead: float) -> None:
        with self._lock:
            if self.state in {STOPPED, SKIPPED, ERROR}:
                return
            self._origin = max(0.0, playhead)
            if self.wait_full and not self.asr_done:
                self.state = BUFFERING
                self.reason = "seek wait full"
                return
            hole = self._next_unready_start(playhead)
            covered = any(
                u.start <= playhead + self.lead_s and u.start + u.duration > playhead - 0.25
                for u in self.utterances
            )
            if hole is not None and playhead + self.lead_s >= hole and not covered:
                self.state = BUFFERING
                self.reason = "seek hole"
            elif self.utterances:
                self.state = READY
                self.reason = "seek"
            else:
                self.state = BUFFERING
                self.reason = "seek"

    def stop(self, reason: str = "stopped") -> None:
        with self._lock:
            self._stop_locked(reason)

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "state": self.state,
                "reason": self.reason,
                "tab_id": self.tab_id,
                "video_id": self.video_id,
                "target_lang": self.target_lang,
                "ready_count": len(self.utterances),
                "pending_count": len(self._pending),
                "gate": None if self.gate is None else self.gate.decision,
                "wait_full": self.wait_full,
                "asr_done": self.asr_done,
            }

    def get_audio(self, utterance_id: str) -> bytes | None:
        with self._lock:
            for item in self.utterances:
                if item.id == utterance_id:
                    return item.audio
        return None

    def _stop_locked(self, reason: str) -> None:
        self.state = STOPPED
        self.reason = reason
        self._pending = []
        self.utterances = []

    def _ready_from(self, origin: float) -> float:
        pieces = sorted(
            ((u.start, u.start + u.duration) for u in self.utterances if u.start + u.duration > origin),
            key=lambda item: item[0],
        )
        cursor = origin
        slack = 0.05
        for start, end in pieces:
            if start > cursor + slack:
                break
            cursor = max(cursor, end)
        return cursor - origin

    def _next_unready_start(self, playhead: float = 0.0) -> float | None:
        future = [c.start for c in self._pending if c.start >= playhead - 0.05]
        if future:
            return min(future)
        if not self.asr_done and self.utterances:
            return max(u.start + u.duration for u in self.utterances)
        return None


_ACTIVE = Session()
_ACTIVE_GUARD = threading.Lock()


def active_session() -> Session:
    return _ACTIVE


def replace_active_session(session: Session) -> Session:
    global _ACTIVE
    with _ACTIVE_GUARD:
        _ACTIVE = session
        return _ACTIVE
