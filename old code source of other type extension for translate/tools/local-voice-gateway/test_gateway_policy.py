#!/usr/bin/env python3
"""Unit tests for gateway_policy (no models / network)."""

from __future__ import annotations

import math
import tempfile
import unittest
from pathlib import Path

from gateway_policy import (
    cache_file_is_safe,
    clamp_tts_speed,
    is_allowed_ytdlp_url,
    looks_like_raw_pcm16,
    native_wait_sec,
    pid_in_tasklist,
)


class PolicyTests(unittest.TestCase):
    def test_ytdlp_watch_ok(self):
        self.assertTrue(
            is_allowed_ytdlp_url("https://www.youtube.com/watch?v=dQw4w9wgGcQ")
        )
        self.assertTrue(is_allowed_ytdlp_url("https://youtu.be/dQw4w9wgGcQ"))
        self.assertTrue(
            is_allowed_ytdlp_url("https://www.youtube.com/embed/dQw4w9wgGcQ")
        )

    def test_ytdlp_redirect_blocked(self):
        self.assertFalse(
            is_allowed_ytdlp_url(
                "https://www.youtube.com/redirect?q=http://127.0.0.1/ssrf"
            )
        )
        self.assertFalse(is_allowed_ytdlp_url("https://www.youtube.com/playlist?list=PLx"))
        self.assertFalse(is_allowed_ytdlp_url("https://evil.example/watch?v=dQw4w9wgGcQ"))

    def test_clamp_speed(self):
        self.assertEqual(clamp_tts_speed("1.2"), 1.2)
        self.assertEqual(clamp_tts_speed("nope"), 1.0)
        self.assertEqual(clamp_tts_speed(99), 2.0)
        self.assertEqual(clamp_tts_speed(0.1), 0.5)
        self.assertEqual(clamp_tts_speed(math.nan), 1.0)

    def test_wait_sec(self):
        self.assertEqual(native_wait_sec(1e12), 120.0)
        self.assertEqual(native_wait_sec(-4), 3.0)
        self.assertEqual(native_wait_sec("x"), 45.0)

    def test_raw_pcm_gate(self):
        self.assertFalse(looks_like_raw_pcm16(b"junk"))
        self.assertFalse(looks_like_raw_pcm16(b"RIFF" + b"\x00" * 400))
        self.assertTrue(looks_like_raw_pcm16(b"\x00\x01" * 200))

    def test_pid_token(self):
        self.assertFalse(pid_in_tasklist(12, "1234"))
        self.assertTrue(pid_in_tasklist(12, "  12 "))

    def test_cache_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            real = root / "aabbccdd.txt"
            real.write_text("ok", encoding="utf-8")
            self.assertTrue(cache_file_is_safe(real, root))
            outside = Path(td).parent / "outside-av-test.txt"
            try:
                outside.write_text("secret", encoding="utf-8")
                link = root / "link.bin"
                try:
                    link.symlink_to(outside)
                except OSError:
                    self.skipTest("symlinks not permitted")
                self.assertFalse(cache_file_is_safe(link, root))
            finally:
                if outside.exists():
                    outside.unlink()


if __name__ == "__main__":
    unittest.main()
