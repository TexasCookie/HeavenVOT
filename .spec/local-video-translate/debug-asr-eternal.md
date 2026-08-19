---
feature: local-video-translate
stage: debug
created: 2026-08-18
updated: 2026-08-18
upstream: [implement]
---

## Debug: ASR stuck on «ASR…» after pause fix

### Symptom
Video play/pause works on 0.1.6. Button stays `ASR…` forever. No voice-over.

### Root Cause
Two defects on the same path:

1. `chrome.runtime.sendMessage` JSON-serializes the payload. The recorded `ArrayBuffer` arrives in the service worker as `{}` / empty. Host sees no audio (`empty_audio` or garbage) and returns no cues. Button only flips to `Выкл` when `added > 0`.
2. Isolated-world / `captureStream()` on YouTube often yields a silent audio track. Even a correct transport would feed Whisper zeros (`asr_empty`).

Infection chain: MediaRecorder/page hook produces bytes → `sendMessage({audio: ArrayBuffer})` drops bytes → `/v1/session/transcribe` never gets speech → `added = 0` → label stays `ASR…`.

### Reproduction Steps
1. Watch a YouTube VOD with no usable captions.
2. Click «Перевод».
3. Video plays; pause works.
4. Button remains `ASR…`.

### Fix
- Send WAV PCM via `fetch` to `127.0.0.1` (binary intact). Base64 through background only as fallback.
- Tap `HTMLMediaElement` in the page world (`createMediaElementSource` + ScriptProcessor), encode 16 kHz WAV.
- Unlock `AudioContext` on the click gesture.
- Button reports `ASR rec` / `ASR N` / `ASR тихо` / `ASR пусто` / `Выкл`.
- Version 0.1.7.

### Verification
- `node tests/test_asr_audio.js` — `jsonLosesArrayBuffer` true; WAV is RIFF.
- `pytest` — 48 passed, including transcribe + OPTIONS + last_transcribe bytes.
