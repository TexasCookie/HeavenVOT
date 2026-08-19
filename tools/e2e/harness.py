"""Local /watch + host so the shipped content.js can be clicked without YouTube."""
from __future__ import annotations

import json
import math
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from lvt_host.backends import ToneSynthesizer
from lvt_host.chunker import wav_bytes_from_pcm16
from lvt_host.http_app import HostRuntime, serve
from lvt_host.session import Session

ROOT = Path(__file__).resolve().parents[2]
EXT = ROOT / "extension"
HOST_PORT = 18765
PAGE_PORT = 18766


class MapTranslator:
    def translate(self, text, source_lang, target_lang):
        return "T:" + text


class FakeAsr:
    def transcribe(self, audio, sample_rate=16000, lang_hint=None, offset=0.0):
        return [
            {
                "start": float(offset),
                "duration": 2.0,
                "text": "hello friends from file",
                "lang": lang_hint or "en",
                "speaker": 0,
            }
        ]


class FileSource:
    def __init__(self, wav: bytes) -> None:
        self.wav = wav

    def fetch(self, video_id: str, dest_dir: Path) -> Path:
        path = dest_dir / (video_id + ".wav")
        path.write_bytes(self.wav)
        return path


def tone(seconds=12.0, rate: int = 16000) -> bytes:
    n = int(seconds * rate)
    samples = []
    for i in range(n):
        t = i / rate
        gate = 0.0 if (t % 10.0) > 9.4 else 1.0
        samples.append(int(8000 * gate * math.sin(2 * math.pi * 440 * t)))
    return wav_bytes_from_pcm16(samples, rate)


class PageHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path.startswith("/extension/"):
            path = "/" + path[len("/extension/") :]
        if path == "/watch":
            body = f"""<!doctype html>
<html><head><meta charset="utf-8"><title>watch</title>
<link rel="stylesheet" href="/player-button.css">
</head>
<body>
<div id="player" class="html5-video-player">
  <ytd-player id="ytd-player">
    <video class="html5-main-video" controls style="width:400px;height:200px"></video>
  </ytd-player>
</div>
<script>
const _fetch = window.fetch.bind(window);
window.fetch = function(url, opts) {{
  const u = String(url);
  if (u.indexOf("youtube.com") !== -1 || u.indexOf("googlevideo.com") !== -1) {{
    return Promise.reject(new Error("no yt in fixture"));
  }}
  return _fetch(url, opts);
}};
window.chrome = {{
  runtime: {{
    lastError: null,
    getManifest() {{ return {{ background: {{ service_worker: "extension/background.js" }} }}; }},
    getURL(name) {{ return name; }},
    sendMessage(msg, cb) {{
      const reply = (function() {{
        if (msg.type === "lvt-status") return {{ httpBase: "http://127.0.0.1:{HOST_PORT}" }};
        if (msg.type === "lvt-media") return {{ videoId: "vGUNqq3jVLg", audioUrl: "" }};
        if (msg.type === "lvt-yt-cookies") return {{ cookies: [] }};
        if (msg.type === "lvt-claim-tab") return {{ ok: true }};
        if (msg.type === "lvt-harvest") return {{ text: "", language: "" }};
        if (msg.type === "lvt-release-tab") return {{ ok: true }};
        return {{}};
      }})();
      if (typeof cb === "function") setTimeout(function() {{ cb(reply); }}, 0);
      return Promise.resolve(reply);
    }},
    onMessage: {{ addListener: function() {{}} }}
  }},
  storage: {{ local: {{ get(keys, cb) {{ if (cb) cb({{}}); }}, set() {{}} }} }}
}};
</script>
<script src="/policy.js"></script>
<script src="/mixer.js"></script>
<script src="/player-button.js"></script>
<script src="/captions.js"></script>
<script src="/content.js"></script>
</body></html>""".encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        file = EXT / path.lstrip("/")
        if file.is_file():
            data = file.read_bytes()
            ctype = "text/javascript" if file.suffix == ".js" else "text/css"
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self.send_response(404)
        self.end_headers()


def main() -> None:
    runtime = HostRuntime(Session(start_buffer_s=1.0), MapTranslator(), ToneSynthesizer(), asr=FakeAsr())
    runtime.audio_source = FileSource(tone())
    api = serve(runtime, host="127.0.0.1", port=HOST_PORT)
    threading.Thread(target=api.serve_forever, daemon=True).start()
    pages = ThreadingHTTPServer(("127.0.0.1", PAGE_PORT), PageHandler)
    print(json.dumps({"host": HOST_PORT, "page": PAGE_PORT}), flush=True)
    pages.serve_forever()


if __name__ == "__main__":
    main()
