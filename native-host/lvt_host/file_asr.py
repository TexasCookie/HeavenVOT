from __future__ import annotations

import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Callable, Protocol

from .chunker import load_media_pcm, snap_windows, wav_bytes_from_pcm16
from .quality import Cue


class AudioSource(Protocol):
    def fetch(self, video_id: str, dest_dir: Path) -> Path: ...


class DownloadError(RuntimeError):
    pass


def netscape_cookies(rows: list) -> str:
    lines = ["# Netscape HTTP Cookie File"]
    for raw in rows or []:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or "")
        if not name:
            continue
        domain = str(raw.get("domain") or ".youtube.com")
        flag = "TRUE" if domain.startswith(".") else "FALSE"
        path = str(raw.get("path") or "/")
        secure = "TRUE" if raw.get("secure") else "FALSE"
        try:
            exp = int(float(raw.get("expirationDate") or 0))
        except (TypeError, ValueError):
            exp = 0
        value = str(raw.get("value") or "")
        lines.append(f"{domain}\t{flag}\t{path}\t{secure}\t{exp}\t{name}\t{value}")
    return "\n".join(lines) + "\n"


CLIENTS = (
    "tv",
    "web_safari",
    "mweb",
    "web",
    "web_embedded",
    "android",
)
CLIENT_TIMEOUT_S = 18
JOB_DEADLINE_S = 55.0


def _clean_token(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if any(ch in text for ch in "; \t\n\r\"'"):
        return ""
    return text


def youtube_extractor_args(client: str, po_token: str = "", visitor_data: str = "") -> str:
    parts = [f"player_client={client}"]
    visitor = _clean_token(visitor_data)
    if visitor:
        parts.append(f"visitor_data={visitor}")
    token = _clean_token(po_token)
    if token:
        if "+" in token:
            parts.append(f"po_token={token}")
        else:
            parts.append(f"po_token={client}.gvs+{token}")
            if client != "web":
                parts.append("po_token=web.gvs+" + token)
    return "youtube:" + ";".join(parts)


def looks_like_media(buf: bytes) -> bool:
    if not buf or len(buf) < 12:
        return False
    if buf[4:8] == b"ftyp":
        return True
    if buf.startswith((b"\x1aE\xdf\xa3", b"ID3", b"OggS", b"RIFF")):
        return True
    if buf[0] == 0xFF and (buf[1] & 0xE0) == 0xE0:
        return True
    return False


def strip_playback(url: str) -> str:
    text = str(url or "")
    if "videoplayback" not in text:
        return ""
    return re.sub(r"&(range|rn|rbuf)=[^&]*", "", text)


AUDIO_ITAGS = {139, 140, 141, 249, 250, 251, 599, 600}

INNERTUBE_CLIENTS = (
    {
        "name": "TVHTML5",
        "version": "7.20260114.12.00",
        "id": "7",
        "ua": (
            "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/25.lts.30.1034943-gold "
            "(unlike Gecko), Unknown_TV_Unknown_0/Unknown (Unknown, Unknown)"
        ),
    },
    {
        "name": "ANDROID",
        "version": "21.02.35",
        "id": "3",
        "ua": "com.google.android.youtube/21.02.35 (Linux; U; Android 11) gzip",
    },
)


def cookie_header(rows: list) -> str:
    parts: list[str] = []
    for raw in rows or []:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or "")
        if not name:
            continue
        parts.append(name + "=" + str(raw.get("value") or ""))
    return "; ".join(parts)


def urls_from_player(payload: dict) -> list[str]:
    if not isinstance(payload, dict):
        return []
    sd = payload.get("streamingData") or {}
    if not isinstance(sd, dict):
        return []
    items = list(sd.get("adaptiveFormats") or []) + list(sd.get("formats") or [])
    audio: list[str] = []
    other: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        url = str(item.get("url") or "")
        if not url or "videoplayback" not in url:
            continue
        url = strip_playback(url)
        mime = str(item.get("mimeType") or item.get("mime") or "")
        try:
            itag = int(item.get("itag") or 0)
        except (TypeError, ValueError):
            itag = 0
        if "audio/" in mime or itag in AUDIO_ITAGS:
            if url not in audio:
                audio.append(url)
        elif url not in other:
            other.append(url)
    return audio + other


def innertube_audio_urls(video_id: str, cookies: list | None, visitor: str = "") -> list[str]:
    vid = str(video_id or "").strip()
    if not vid:
        return []
    found: list[str] = []
    for client in INNERTUBE_CLIENTS:
        payload = _innertube_player(vid, cookies, visitor, client)
        for url in urls_from_player(payload):
            if url not in found:
                found.append(url)
        if found:
            return found
    return found


def _innertube_player(video_id: str, cookies: list | None, visitor: str, client: dict) -> dict:
    import json
    import shutil

    curl = shutil.which("curl")
    if not curl:
        return {}
    body = {
        "context": {
            "client": {
                "clientName": client["name"],
                "clientVersion": client["version"],
                "hl": "en",
                "visitorData": _clean_token(visitor),
            }
        },
        "videoId": video_id,
        "playbackContext": {"contentPlaybackContext": {"html5Preference": "HTML5"}},
        "contentCheckOk": True,
        "racyCheckOk": True,
    }
    if client["name"] == "ANDROID":
        body["context"]["client"]["androidSdkVersion"] = 30
        body["context"]["client"]["osName"] = "Android"
        body["context"]["client"]["osVersion"] = "11"
    tmp = Path(tempfile.mkdtemp(prefix="lvt-it-"))
    src = tmp / "body.json"
    dest = tmp / "player.json"
    src.write_text(json.dumps(body), encoding="utf-8")
    cmd = [
        curl,
        "-sS",
        "-L",
        "--max-time",
        "10",
        "-A",
        client["ua"],
        "-H",
        "Content-Type: application/json",
        "-H",
        "Origin: https://www.youtube.com",
        "-H",
        "Referer: https://www.youtube.com/",
        "-H",
        "X-YouTube-Client-Name: " + client["id"],
        "-H",
        "X-YouTube-Client-Version: " + client["version"],
        "-X",
        "POST",
        "--data-binary",
        "@" + str(src),
        "-o",
        str(dest),
        "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
    ]
    cookie = cookie_header(cookies or [])
    if cookie:
        cmd[1:1] = ["-H", "Cookie: " + cookie]
    visitor = _clean_token(visitor)
    if visitor:
        cmd[1:1] = ["-H", "X-Goog-Visitor-Id: " + visitor]
    proxy = _detect_proxy()
    if proxy:
        cmd[1:1] = ["-x", proxy]
    try:
        subprocess.run(cmd, capture_output=True, timeout=14, check=False)
        raw = dest.read_text(encoding="utf-8") if dest.is_file() else ""
        data = json.loads(raw) if raw else {}
        return data if isinstance(data, dict) else {}
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError, UnicodeError):
        return {}
    finally:
        try:
            src.unlink(missing_ok=True)
            dest.unlink(missing_ok=True)
            tmp.rmdir()
        except OSError:
            pass


class YtDlpSource:
    def __init__(self, run=None) -> None:
        self.cookies: list | None = None
        self.po_token = ""
        self.visitor_data = ""
        self.direct_urls: list[str] = []
        self._run = run or _run_ytdlp
        self._direct = _download_direct

    def fetch(self, video_id: str, dest_dir: Path) -> Path:
        dest_dir.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + JOB_DEADLINE_S
        urls = list(self.direct_urls or [])
        try:
            for url in innertube_audio_urls(video_id, self.cookies, self.visitor_data):
                if url not in urls:
                    urls.append(url)
        except Exception:
            pass
        for url in urls[:4]:
            if time.monotonic() >= deadline:
                break
            remain = max(6.0, min(12.0, deadline - time.monotonic()))
            try:
                got = self._direct(url, dest_dir, video_id, timeout=remain)
            except TypeError:
                got = self._direct(url, dest_dir, video_id)
            if got is not None and got.exists() and got.stat().st_size > 64:
                return got
        cookie_path = None
        if self.cookies:
            cookie_path = dest_dir / "cookies.txt"
            cookie_path.write_text(netscape_cookies(self.cookies), encoding="utf-8")
        last = "audio_download_failed"
        extras = {"po_token": self.po_token, "visitor_data": self.visitor_data}
        for client in CLIENTS:
            if time.monotonic() >= deadline:
                raise DownloadError("audio_download_failed timeout")
            try:
                try:
                    self._run(video_id, dest_dir, client, cookie_path, extras)
                except TypeError:
                    self._run(video_id, dest_dir, client, cookie_path)
            except DownloadError as exc:
                last = str(exc)
                continue
            found = [
                p
                for p in dest_dir.glob(video_id + ".*")
                if p.suffix.lower() != ".txt" and p.stat().st_size > 64
            ]
            if found:
                return sorted(found, key=lambda p: p.stat().st_size, reverse=True)[0]
            last = "audio_download_failed empty"
        raise DownloadError(last)


def _detect_proxy() -> str:
    for key in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy"):
        val = __import__("os").environ.get(key) or ""
        if val.strip():
            return val.strip()
    import socket

    for port, scheme in ((10808, "socks5"), (10809, "http"), (7890, "http"), (1080, "socks5")):
        sock = socket.socket()
        sock.settimeout(0.15)
        try:
            sock.connect(("127.0.0.1", port))
        except OSError:
            continue
        finally:
            sock.close()
        return f"{scheme}://127.0.0.1:{port}"
    return ""


def _http_proxy() -> str:
    proxy = _detect_proxy()
    if not proxy:
        return ""
    if not proxy.startswith("socks"):
        return proxy
    import socket

    sock = socket.socket()
    sock.settimeout(0.15)
    try:
        sock.connect(("127.0.0.1", 10809))
    except OSError:
        return ""
    finally:
        sock.close()
    return "http://127.0.0.1:10809"


def _download_curl(url: str, dest: Path, timeout: float) -> bool:
    import shutil

    curl = shutil.which("curl")
    if not curl:
        return False
    cmd = [
        curl,
        "-sS",
        "-L",
        "--fail",
        "--max-time",
        str(max(8, int(timeout))),
        "-A",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
        "-H",
        "Referer: https://www.youtube.com/",
        "-H",
        "Origin: https://www.youtube.com",
        "-o",
        str(dest),
        url,
    ]
    proxy = _detect_proxy()
    if proxy:
        cmd[1:1] = ["-x", proxy]
    try:
        completed = subprocess.run(cmd, capture_output=True, timeout=timeout + 5, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return completed.returncode == 0 and dest.is_file() and dest.stat().st_size > 64


def _download_direct(url: str, dest_dir: Path, video_id: str, timeout: float = 12.0) -> Path | None:
    import urllib.error
    import urllib.request

    cleaned = strip_playback(url)
    if not cleaned:
        return None
    dest = dest_dir / f"{video_id}.bin"
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0"
        ),
        "Referer": "https://www.youtube.com/",
        "Origin": "https://www.youtube.com",
        "Accept": "*/*",
    }
    req = urllib.request.Request(cleaned, headers=headers)
    proxy = _http_proxy()
    handlers = []
    if proxy:
        handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    opener = urllib.request.build_opener(*handlers)
    try:
        with opener.open(req, timeout=timeout) as resp:
            ctype = str(resp.headers.get("Content-Type") or "").lower()
            if "text/html" in ctype or "json" in ctype or "ump" in ctype:
                raise ValueError("not media")
            written = 0
            with dest.open("wb") as out:
                while True:
                    chunk = resp.read(256 * 1024)
                    if not chunk:
                        break
                    if written == 0 and not looks_like_media(chunk):
                        raise ValueError("not media")
                    out.write(chunk)
                    written += len(chunk)
            if written >= 64:
                return dest
    except (OSError, urllib.error.URLError, ValueError):
        try:
            dest.unlink(missing_ok=True)
        except OSError:
            pass
    if _download_curl(cleaned, dest, timeout):
        with dest.open("rb") as fh:
            head = fh.read(32)
        if looks_like_media(head):
            return dest
    try:
        dest.unlink(missing_ok=True)
    except OSError:
        pass
    return None


def _run_ytdlp(
    video_id: str,
    dest_dir: Path,
    client: str,
    cookie_path: Path | None,
    extras: dict | None = None,
) -> None:
    import shutil

    extras = extras or {}
    out_tmpl = str(dest_dir / f"{video_id}.%(ext)s")
    url = "https://www.youtube.com/watch?v=" + video_id
    cmd = [
        sys.executable,
        "-m",
        "yt_dlp",
        "-f",
        "ba/bestaudio/best",
        "--no-playlist",
        "--no-warnings",
        "--extractor-args",
        youtube_extractor_args(
            client,
            str(extras.get("po_token") or ""),
            str(extras.get("visitor_data") or ""),
        ),
        "-o",
        out_tmpl,
        url,
    ]
    node = shutil.which("node")
    if node:
        cmd.extend(["--js-runtimes", "node", "--remote-components", "ejs:github"])
    if cookie_path is not None:
        cmd.extend(["--cookies", str(cookie_path)])
    proxy = _detect_proxy()
    if proxy:
        cmd.extend(["--proxy", proxy])
    try:
        completed = subprocess.run(cmd, capture_output=True, timeout=CLIENT_TIMEOUT_S, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise DownloadError("audio_download_failed") from exc
    if completed.returncode != 0:
        err = (completed.stderr or completed.stdout or b"").decode("utf-8", errors="replace")
        tail = " ".join(err.strip().splitlines()[-2:])[:160]
        raise DownloadError("audio_download_failed " + tail)


def cues_from_file(
    path: Path,
    transcribe: Callable,
    *,
    playhead: float = 0.0,
    lang_hint: str | None = None,
    until_s: float | None = None,
) -> list[Cue]:
    del playhead
    samples, rate = load_media_pcm(path)
    windows = snap_windows(samples, rate, origin=0.0)
    cues: list[Cue] = []
    for start, _dur, piece in windows:
        if until_s is not None and start >= until_s:
            break
        raw = transcribe(wav_bytes_from_pcm16(piece, rate), rate, lang_hint, start)
        for item in raw:
            cues.append(
                Cue(
                    start=float(item["start"]),
                    duration=max(0.2, float(item["duration"])),
                    text=str(item["text"]),
                    lang=str(item.get("lang") or lang_hint or ""),
                    speaker=int(item.get("speaker") or 0),
                )
            )
    return cues


def process_media_path(
    runtime,
    path: Path,
    playhead: float,
    lang_hint: str | None,
    *,
    snippet: bool = False,
) -> None:
    del playhead, snippet
    from .voices import whole_file_speakers

    runtime.session.set_progress("transcribing")
    samples, rate = load_media_pcm(path)
    windows = snap_windows(samples, rate, origin=0.0)
    roster = list(getattr(runtime, "speaker_roster", None) or [])
    added = 0
    for start, _dur, piece in windows:
        if runtime.session.state in {"stopped", "error", "skipped"}:
            return
        try:
            raw = runtime.asr.transcribe(wav_bytes_from_pcm16(piece, rate), rate, lang_hint, start)
        except RuntimeError as exc:
            if str(exc) in {"asr_empty", "asr_unavailable"}:
                continue
            raise
        cues = [
            Cue(
                start=float(item["start"]),
                duration=max(0.2, float(item["duration"])),
                text=str(item["text"]),
                lang=str(item.get("lang") or lang_hint or ""),
                speaker=int(item.get("speaker") or 0),
            )
            for item in raw
        ]
        if not cues:
            continue
        cues, roster = whole_file_speakers(cues, roster)
        runtime.speaker_roster = roster
        runtime.session.add_cues(cues)
        runtime.session.process_pending(runtime.translator, runtime.synthesizer)
        added += len(cues)
    if added == 0:
        runtime.session.fail_asr("asr_empty")
        return
    runtime.session.mark_asr_complete()
    runtime.session.process_pending(runtime.translator, runtime.synthesizer)


def apply_downloaded_file(runtime, path: Path, lang_hint: str | None) -> None:
    reopen = getattr(runtime.session, "reopen_for_file", None)
    if callable(reopen) and not reopen():
        return
    claim = getattr(runtime, "claim_file", None)
    if callable(claim) and not claim():
        return
    candidates = list(getattr(runtime, "candidate_cues", None) or [])
    if candidates:
        runtime.session.set_progress("checking captions")
        sample = cues_from_file(
            path, runtime.asr.transcribe, playhead=0.0, lang_hint=lang_hint, until_s=30.0
        )
        from .caption_quality import caption_matches_sample

        windowed = [c for c in sample if c.start < 30.0]
        if caption_matches_sample(candidates, windowed):
            one_voice = [
                Cue(c.start, c.duration, c.text, c.lang, 0) for c in candidates
            ]
            runtime.session.add_cues(one_voice)
            runtime.session.process_pending(runtime.translator, runtime.synthesizer)
            runtime.session.mark_asr_complete()
            runtime.session.process_pending(runtime.translator, runtime.synthesizer)
            return
    process_media_path(runtime, path, 0.0, lang_hint)


def run_uploaded_bytes(runtime, audio: bytes, playhead: float, lang_hint: str | None) -> None:
    del playhead
    tmp = Path(tempfile.mkdtemp(prefix="lvt-up-"))
    suffix = ".wav" if audio[:4] == b"RIFF" else ".bin"
    path = tmp / ("audio" + suffix)
    try:
        path.write_bytes(audio)
        apply_downloaded_file(runtime, path, lang_hint)
    except Exception as exc:
        fail = getattr(runtime, "fail_file", None)
        if callable(fail):
            fail(str(exc) or "audio_download_failed")
        else:
            runtime.session.fail_asr(str(exc) or "audio_download_failed")
    finally:
        try:
            path.unlink()
            tmp.rmdir()
        except OSError:
            pass


def run_file_job(runtime, video_id: str, playhead: float, lang_hint: str | None) -> None:
    del playhead
    source = getattr(runtime, "audio_source", None)

    def _fail(reason: str) -> None:
        note = getattr(runtime, "note_ytdlp_failed", None)
        if callable(note):
            note()
        fail = getattr(runtime, "fail_file", None)
        if callable(fail):
            fail(reason)
        else:
            runtime.session.fail_asr(reason)

    if source is None:
        _fail("audio_download_failed")
        return
    tmp = Path(tempfile.mkdtemp(prefix="lvt-audio-"))
    try:
        runtime.session.set_progress("downloading")
        path = source.fetch(video_id, tmp)
        apply_downloaded_file(runtime, path, lang_hint)
    except Exception as exc:
        _fail(str(exc) or "audio_download_failed")
    finally:
        try:
            for item in tmp.glob("*"):
                item.unlink()
            tmp.rmdir()
        except OSError:
            pass
