from __future__ import annotations

import io
import json
import math
import threading
import wave
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable
from urllib.parse import urlparse

from .backends import MissingAsr, Synthesizer, Translator
from .ingest import ingest_player_payload
from .quality import cues_from_dicts
from .session import Session, TickResult

MAX_BODY_BYTES = 64 * 1024 * 1024


def _finite_float(value: Any, default: float = 0.0) -> float | None:
    if value is None or value == "":
        return default
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return default
    return number


def _json(handler: BaseHTTPRequestHandler, code: int, payload: dict[str, Any]) -> None:
    raw = json.dumps(payload).encode("utf-8")
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(raw)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.end_headers()
    handler.wfile.write(raw)


class HostRuntime:
    def __init__(
        self,
        session: Session,
        translator: Translator,
        synthesizer: Synthesizer,
        asr: MissingAsr | None = None,
        fetch: Callable[[str], str] | None = None,
    ) -> None:
        self.session = session
        self.translator = translator
        self.synthesizer = synthesizer
        self.asr = asr or MissingAsr()
        self.fetch = fetch
        self.degraded: list[str] = []
        self.last_transcribe: dict[str, Any] = {"bytes": 0, "added": 0, "warning": ""}
        self.audio_source = None
        self.yt_cookies: list | None = None
        self.candidate_cues: list = []
        self.speaker_roster: list[int] = []
        self._file_lock = threading.Lock()
        self.file_claimed = False
        self.file_job_started = False
        self.file_job_video_id = ""
        self.file_job_lang: str | None = None
        self.upload_open = False
        self.file_job_failed = False
        self.upload_grace_s = 8.0
        self._grace_started = False
        self._watchdog_started = False

    def claim_file(self) -> bool:
        with self._file_lock:
            if self.file_claimed:
                return False
            self.file_claimed = True
            self.upload_open = False
            return True

    def fail_file(self, reason: str) -> None:
        with self._file_lock:
            claimed = self.file_claimed
            upload_open = self.upload_open
        if claimed and self.session.state != "error":
            return
        if self.session.state in {"stopped", "skipped"}:
            return
        if self.session.state == "error":
            return
        if upload_open:
            return
        if self.session.asr_done and self.session.state not in {"error", "buffering"}:
            return
        self.session.fail_asr(reason)

    def _end_upload_grace(self) -> None:
        with self._file_lock:
            if self.file_claimed:
                return
            self.upload_open = False
        self.fail_file("audio_download_failed")

    def arm_download_watchdog(self) -> None:
        if self._watchdog_started:
            return
        self._watchdog_started = True

        def fire() -> None:
            if self.session.state != "buffering":
                return
            if self.file_claimed or self.session.asr_done:
                return
            with self._file_lock:
                self.upload_open = False
            self.fail_file("audio_download_failed timeout")

        threading.Timer(90.0, fire).start()

    def note_ytdlp_failed(self) -> None:
        with self._file_lock:
            self.file_job_failed = True
            if self.upload_open and not self._grace_started:
                self._grace_started = True
                wait = float(getattr(self, "upload_grace_s", 8.0) or 8.0)
                threading.Timer(max(0.05, wait), self._end_upload_grace).start()

    def kick_file_asr(self, video_id: str, playhead: float, lang_hint: str | None) -> None:
        from .file_asr import run_file_job

        with self._file_lock:
            if self.file_job_started:
                return
            self.file_job_started = True
            self.file_job_video_id = video_id
            self.file_job_lang = lang_hint

        def run() -> None:
            run_file_job(self, video_id, playhead, lang_hint)

        threading.Thread(target=run, daemon=True, name="lvt-file-asr").start()

    def need_file(self) -> None:
        with self._file_lock:
            self.upload_open = False
            claimed = self.file_claimed
            job_failed = self.file_job_failed
        if self.session.state in {"stopped", "skipped"}:
            return
        if claimed:
            return
        if self.session.asr_done and self.session.state != "error":
            return
        if job_failed:
            self.fail_file("audio_download_failed")
            return
        if self.audio_source is not None:
            vid = self.file_job_video_id or (self.session.video_id or "")
            self.kick_file_asr(vid, 0.0, self.file_job_lang)
            if self.file_job_failed:
                self.fail_file("audio_download_failed")
                return
            if self.file_job_started:
                return
        self.fail_file("audio_download_failed")

    def health(self) -> dict[str, Any]:
        return {
            "ok": True,
            "degraded": list(self.degraded),
            "session": self.session.snapshot(),
            "last_transcribe": dict(self.last_transcribe),
        }

    def warmup_asr(self) -> None:
        def run() -> None:
            try:
                self.asr.transcribe(_silence_wav(), 16000, None, 0.0)
            except Exception:
                return

        threading.Thread(target=run, daemon=True, name="lvt-asr-warmup").start()


def make_handler(runtime: HostRuntime):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args: Any) -> None:
            return

        def do_OPTIONS(self) -> None:  # noqa: N802
            requested = self.headers.get("Access-Control-Request-Headers") or (
                "Content-Type, X-Audio-Start, X-Audio-Lang"
            )
            self.send_response(HTTPStatus.NO_CONTENT)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
            self.send_header("Access-Control-Allow-Headers", requested)
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Max-Age", "86400")
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            path = urlparse(self.path).path
            if path == "/v1/health":
                _json(self, HTTPStatus.OK, runtime.health())
                return
            if path == "/v1/session":
                _json(self, HTTPStatus.OK, runtime.session.snapshot())
                return
            if path.startswith("/v1/audio/"):
                audio_id = path.rsplit("/", 1)[-1]
                if not audio_id.isalnum() or len(audio_id) > 64:
                    _json(self, HTTPStatus.NOT_FOUND, {"error": "unknown_audio"})
                    return
                blob = runtime.session.get_audio(audio_id)
                if blob is None:
                    _json(self, HTTPStatus.NOT_FOUND, {"error": "unknown_audio"})
                    return
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(blob)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(blob)
                return
            _json(self, HTTPStatus.NOT_FOUND, {"error": "not_found"})

        def do_POST(self) -> None:  # noqa: N802
            path = urlparse(self.path).path
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except (TypeError, ValueError):
                _json(self, HTTPStatus.BAD_REQUEST, {"error": "invalid_length"})
                return
            if length < 0 or length > MAX_BODY_BYTES:
                _json(self, HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "body_too_large"})
                return
            body = self.rfile.read(length) if length else b"{}"
            if path == "/v1/session/transcribe":
                offset = _finite_float(self.headers.get("X-Audio-Start"), 0.0) or 0.0
                lang = self.headers.get("X-Audio-Lang") or None
                self._transcribe_bytes(body, offset, lang)
                return
            if path == "/v1/session/audio-file":
                offset = _finite_float(self.headers.get("X-Audio-Start"), 0.0) or 0.0
                lang = self.headers.get("X-Audio-Lang") or None
                self._audio_file(body, offset, lang)
                return
            try:
                data = json.loads(body.decode("utf-8") or "{}")
            except (json.JSONDecodeError, UnicodeDecodeError):
                _json(self, HTTPStatus.BAD_REQUEST, {"error": "invalid_json"})
                return
            if not isinstance(data, dict):
                _json(self, HTTPStatus.BAD_REQUEST, {"error": "invalid_json"})
                return
            if path == "/v1/session/start":
                self._start(data)
                return
            if path == "/v1/session/tick":
                playhead = _finite_float(data.get("playhead"), 0.0)
                if playhead is None:
                    _json(self, HTTPStatus.BAD_REQUEST, {"error": "invalid_playhead"})
                    return
                result = runtime.session.on_playhead(playhead)
                _json(self, HTTPStatus.OK, _tick_payload(result))
                return
            if path == "/v1/session/seek":
                playhead = _finite_float(data.get("playhead"), 0.0)
                if playhead is None:
                    _json(self, HTTPStatus.BAD_REQUEST, {"error": "invalid_playhead"})
                    return
                runtime.session.seek(playhead)
                try:
                    runtime.session.process_pending(runtime.translator, runtime.synthesizer)
                except RuntimeError as exc:
                    runtime.session.stop(str(exc))
                    _json(self, HTTPStatus.CONFLICT, {"state": "error", "reason": str(exc)})
                    return
                _json(self, HTTPStatus.OK, runtime.session.snapshot())
                return
            if path == "/v1/session/stop":
                runtime.session.stop(str(data.get("reason") or "stopped"))
                _json(self, HTTPStatus.OK, runtime.session.snapshot())
                return
            if path == "/v1/session/need-file":
                runtime.need_file()
                _json(self, HTTPStatus.OK, runtime.session.snapshot())
                return
            _json(self, HTTPStatus.NOT_FOUND, {"error": "not_found"})

        def _start(self, data: dict[str, Any]) -> None:
            tab_id = str(data.get("tab_id") or "")
            video_id = str(data.get("video_id") or "")
            target_lang = str(data.get("target_lang") or "ru")
            video_duration = _finite_float(data.get("video_duration"), 0.0)
            playback_rate = _finite_float(data.get("playback_rate"), 1.0)
            if video_duration is None or playback_rate is None:
                _json(self, HTTPStatus.BAD_REQUEST, {"error": "invalid_number"})
                return
            if abs(playback_rate - 1.0) > 0.001:
                _json(self, HTTPStatus.CONFLICT, {"error": "rate_not_1x", "state": "error"})
                return
            raw_cues = data.get("cues") or []
            if raw_cues and not isinstance(raw_cues, list):
                _json(self, HTTPStatus.BAD_REQUEST, {"error": "invalid_cues"})
                return
            try:
                cues = cues_from_dicts(raw_cues)
            except (KeyError, TypeError, ValueError):
                _json(self, HTTPStatus.BAD_REQUEST, {"error": "invalid_cues"})
                return
            source_lang = str(data.get("source_lang") or (cues[0].lang if cues else ""))
            is_auto = bool(data.get("is_auto_translate"))
            if not cues and data.get("player_payload") is not None:
                if runtime.fetch is None:
                    _json(self, HTTPStatus.BAD_REQUEST, {"error": "no_fetcher"})
                    return
                ingested = ingest_player_payload(
                    data["player_payload"],
                    target_lang=target_lang,
                    video_duration=video_duration,
                    fetch=runtime.fetch,
                )
                cues = ingested.cues
                source_lang = ingested.track.language if ingested.track else source_lang
                is_auto = ingested.status == "auto_translate"
            playhead = _finite_float(data.get("playhead"), 0.0) or 0.0
            wait_full = str(data.get("play_mode") or "ready") == "full"
            asr_mode = bool(data.get("asr_mode"))
            raw_cookies = data.get("cookies")
            if isinstance(raw_cookies, list):
                runtime.yt_cookies = raw_cookies
                if runtime.audio_source is not None and hasattr(runtime.audio_source, "cookies"):
                    runtime.audio_source.cookies = raw_cookies
            _apply_player_session(runtime, data)
            from .quality import ACCEPT, ALREADY_TARGET, AUTO_TRANSLATE, evaluate_track

            gate_peek = evaluate_track(
                cues=cues,
                video_duration=video_duration,
                source_lang=source_lang,
                target_lang=target_lang,
                is_auto_translate=is_auto,
            )
            if gate_peek.decision == ALREADY_TARGET:
                started = runtime.session.start(
                    tab_id=tab_id,
                    video_id=video_id,
                    target_lang=target_lang,
                    cues=cues,
                    video_duration=video_duration,
                    source_lang=source_lang,
                    is_auto_translate=is_auto,
                    other_tab=True,
                )
                _json(self, HTTPStatus.OK, {**runtime.session.snapshot(), "start_reason": started.reason})
                return
            candidates = cues if gate_peek.decision == ACCEPT else []
            started = runtime.session.start(
                tab_id=tab_id,
                video_id=video_id,
                target_lang=target_lang,
                cues=[],
                video_duration=video_duration,
                source_lang=source_lang,
                is_auto_translate=False,
                other_tab=True,
                asr_mode=True,
                wait_full=wait_full,
            )
            if started.state in {"buffering", "ready"}:
                runtime.candidate_cues = candidates
                runtime.speaker_roster = []
                runtime.file_claimed = False
                runtime.file_job_started = False
                runtime.file_job_failed = False
                runtime.file_job_video_id = video_id
                runtime.file_job_lang = source_lang or None
                runtime._grace_started = False
                runtime._watchdog_started = False
                runtime.upload_open = bool(data.get("skip_download") or data.get("expect_upload"))
                runtime.arm_download_watchdog()
                if runtime.audio_source is not None:
                    runtime.kick_file_asr(video_id, 0.0, source_lang or None)
                    if runtime.upload_open:
                        runtime.session.set_progress("downloading")
                elif runtime.upload_open:
                    runtime.session.set_progress("downloading")
                else:
                    runtime.fail_file("audio_download_failed")
            _json(
                self,
                HTTPStatus.OK,
                {
                    **runtime.session.snapshot(),
                    "start_reason": started.reason,
                    "file_job": True,
                },
            )

        def _audio_file(self, audio: bytes, offset: float, lang: str | None) -> None:
            if not audio:
                runtime.fail_file("empty_audio")
                _json(self, HTTPStatus.BAD_REQUEST, {"error": "empty_audio"})
                return
            from .file_asr import run_uploaded_bytes

            try:
                run_uploaded_bytes(runtime, audio, offset, lang)
            except Exception as exc:
                runtime.fail_file(str(exc) or "audio_download_failed")
                _json(self, HTTPStatus.CONFLICT, {"error": str(exc)})
                return
            _json(self, HTTPStatus.OK, {**runtime.session.snapshot(), "added": runtime.session.snapshot()["ready_count"]})

        def _transcribe_bytes(self, audio: bytes, offset: float, lang: str | None) -> None:
            del offset
            if not audio:
                runtime.last_transcribe = {"bytes": 0, "added": 0, "warning": "empty_audio"}
                runtime.fail_file("empty_audio")
                _json(self, HTTPStatus.BAD_REQUEST, {"error": "empty_audio"})
                return
            from .file_asr import run_uploaded_bytes

            before = runtime.session.snapshot()["ready_count"]
            try:
                run_uploaded_bytes(runtime, audio, 0.0, lang)
            except Exception as exc:
                runtime.fail_file(str(exc) or "audio_download_failed")
                runtime.last_transcribe = {"bytes": len(audio), "added": 0, "warning": str(exc)}
                _json(self, HTTPStatus.CONFLICT, {"error": str(exc)})
                return
            snap = runtime.session.snapshot()
            added = max(0, snap["ready_count"] - before)
            runtime.last_transcribe = {"bytes": len(audio), "added": added, "warning": ""}
            _json(self, HTTPStatus.OK, {**snap, "added": added})

    return Handler


def _tick_payload(result: TickResult) -> dict[str, Any]:
    return {
        "state": result.state,
        "pause_player": result.pause_player,
        "reason": result.reason,
        "utterances": [
            {
                "id": u.id,
                "start": u.start,
                "duration": u.duration,
                "text": u.target_text,
                "voice_id": u.voice_id,
                "audio_path": f"/v1/audio/{u.id}",
            }
            for u in result.ready
        ],
    }


def _apply_player_session(runtime: HostRuntime, data: dict[str, Any]) -> None:
    source = runtime.audio_source
    if source is None:
        return
    if isinstance(data.get("po_token"), str) and hasattr(source, "po_token"):
        source.po_token = str(data.get("po_token") or "").strip()
    if isinstance(data.get("visitor_data"), str) and hasattr(source, "visitor_data"):
        source.visitor_data = str(data.get("visitor_data") or "").strip()
    urls: list[str] = []
    raw_url = data.get("audio_url")
    if isinstance(raw_url, str) and raw_url.strip():
        urls.append(raw_url.strip())
    extra = data.get("audio_urls")
    if isinstance(extra, list):
        for item in extra:
            if isinstance(item, str) and item.strip() and item.strip() not in urls:
                urls.append(item.strip())
    if hasattr(source, "direct_urls"):
        source.direct_urls = urls


def _silence_wav(duration: float = 0.2, rate: int = 16000) -> bytes:
    frames = int(rate * duration)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(b"\x00\x00" * frames)
    return buf.getvalue()


def serve(runtime: HostRuntime, host: str = "127.0.0.1", port: int = 0) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), make_handler(runtime))
    return server
