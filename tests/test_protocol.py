import json

import pytest

from lvt_host.protocol import HOST_TO_BROWSER_MAX, decode_stream, encode_message


def test_status_roundtrip_under_one_megabyte():
    payload = {"type": "ready", "port": 18765, "host": "127.0.0.1", "state": "idle"}
    framed = encode_message(payload)
    assert len(framed) - 4 < HOST_TO_BROWSER_MAX
    messages, rest = decode_stream(framed)
    assert rest == b""
    assert messages == [payload]


def test_two_frames_in_one_buffer():
    first = encode_message({"n": 1})
    second = encode_message({"n": 2})
    messages, rest = decode_stream(first + second)
    assert rest == b""
    assert messages == [{"n": 1}, {"n": 2}]


def test_partial_frame_is_held():
    framed = encode_message({"hello": "world"})
    messages, rest = decode_stream(framed[:6])
    assert messages == []
    assert rest == framed[:6]


def test_oversized_host_payload_rejected():
    huge = {"blob": "x" * (HOST_TO_BROWSER_MAX + 10)}
    with pytest.raises(ValueError):
        encode_message(huge)


def test_json_is_what_was_encoded():
    payload = {"ok": True, "values": [1, 2, 3]}
    framed = encode_message(payload)
    body = framed[4:]
    assert json.loads(body) == payload
