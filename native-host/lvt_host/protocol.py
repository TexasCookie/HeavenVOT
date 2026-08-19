from __future__ import annotations

import json
import struct
from typing import Any

HOST_TO_BROWSER_MAX = 1024 * 1024
BROWSER_TO_HOST_MAX = 64 * 1024 * 1024
LENGTH_STRUCT = struct.Struct("<I")


def encode_message(payload: dict[str, Any]) -> bytes:
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(raw) > HOST_TO_BROWSER_MAX:
        raise ValueError("native-messaging payload exceeds 1 MiB host-to-browser limit")
    return LENGTH_STRUCT.pack(len(raw)) + raw


def decode_stream(buffer: bytes) -> tuple[list[dict[str, Any]], bytes]:
    messages: list[dict[str, Any]] = []
    view = buffer
    header = LENGTH_STRUCT.size
    while len(view) >= header:
        (size,) = LENGTH_STRUCT.unpack_from(view, 0)
        if size > BROWSER_TO_HOST_MAX:
            raise ValueError("native-messaging frame larger than browser-to-host limit")
        if len(view) < header + size:
            break
        chunk = view[header : header + size]
        messages.append(json.loads(chunk.decode("utf-8")))
        view = view[header + size :]
    return messages, view
