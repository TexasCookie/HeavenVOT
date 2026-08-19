from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from html import unescape

from .quality import Cue


def parse_timedtext(payload: str, lang: str = "") -> list[Cue]:
    text = (payload or "").lstrip().lstrip("\ufeff").lstrip()
    if not text:
        return []
    try:
        if text[0] in "{[":
            return parse_json3(text, lang=lang)
        return parse_xml_transcript(text, lang=lang)
    except (ET.ParseError, json.JSONDecodeError, TypeError, ValueError):
        return []


def parse_xml_transcript(payload: str, lang: str = "") -> list[Cue]:
    root = ET.fromstring(payload)
    cues: list[Cue] = []
    for node in root.iter("text"):
        start = float(node.attrib.get("start") or 0.0)
        duration = float(node.attrib.get("dur") or node.attrib.get("duration") or 0.0)
        body = unescape("".join(node.itertext())).replace("\n", " ").strip()
        cues.append(Cue(start=start, duration=duration, text=body, lang=lang))
    return cues


def parse_json3(payload: str, lang: str = "") -> list[Cue]:
    data = json.loads(payload)
    events = data.get("events") or []
    cues: list[Cue] = []
    for event in events:
        segs = event.get("segs")
        if not segs:
            continue
        start_ms = float(event.get("t") or 0.0)
        duration_ms = float(event.get("d") or 0.0)
        body = "".join(seg.get("utf8") or "" for seg in segs).replace("\n", " ").strip()
        if not body:
            continue
        cues.append(
            Cue(
                start=start_ms / 1000.0,
                duration=duration_ms / 1000.0,
                text=body,
                lang=lang,
            )
        )
    return cues
