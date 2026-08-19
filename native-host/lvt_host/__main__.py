from __future__ import annotations

import json
import os
import sys
import threading
from typing import Any

from .fetching import fetch_caption_url
from .http_app import HostRuntime, serve
from .protocol import decode_stream, encode_message
from .file_asr import YtDlpSource
from .runtime_stack import load_asr, load_synthesizer, load_translator
from .session import Session


def main() -> None:
    session = Session()
    translator, t_notes = load_translator()
    synthesizer, s_notes = load_synthesizer()
    asr, a_notes = load_asr()
    runtime = HostRuntime(
        session=session,
        translator=translator,
        synthesizer=synthesizer,
        asr=asr,
        fetch=fetch_caption_url,
    )
    runtime.audio_source = YtDlpSource()
    runtime.degraded.extend(t_notes + s_notes + a_notes)
    port = int(os.environ.get("LVT_PORT") or "0")
    standalone = os.environ.get("LVT_STANDALONE") == "1" or "--standalone" in sys.argv
    server = serve(runtime, host="127.0.0.1", port=port)
    host, port = server.server_address[:2]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    sys.stdout.buffer.write(encode_message({"type": "ready", "port": port, "host": host}))
    sys.stdout.buffer.flush()
    if standalone:
        thread.join()
        return
    leftover = b""
    while True:
        chunk = sys.stdin.buffer.read(4096)
        if not chunk:
            break
        leftover = leftover + chunk
        try:
            messages, leftover = decode_stream(leftover)
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
            leftover = b""
            sys.stdout.buffer.write(encode_message({"type": "error", "error": "bad_frame"}))
            sys.stdout.buffer.flush()
            continue
        for message in messages:
            reply = _handle_native(runtime, message)
            sys.stdout.buffer.write(encode_message(reply))
            sys.stdout.buffer.flush()
    server.shutdown()


def _handle_native(runtime: HostRuntime, message: dict[str, Any]) -> dict[str, Any]:
    kind = message.get("type")
    if kind == "ping":
        return {"type": "pong", "health": runtime.health()}
    if kind == "stop":
        runtime.session.stop("native-stop")
        return {"type": "stopped"}
    return {"type": "error", "error": "unknown_message"}


if __name__ == "__main__":
    main()
