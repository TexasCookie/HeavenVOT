---
feature: local-video-translate
stage: debug
created: 2026-08-18
updated: 2026-08-18
upstream: [implement]
---

## Debug: oppressive drone after ASR starts working

### Symptom
Strong 220/330 Hz hum. Button flips `ASR N` ↔ `Выкл`. Hum dies ~3s after pause.

### Root Cause
`load_synthesizer()` fell back to `ToneSynthesizer` (torch/silero not installed). Each ASR chunk became a loud sine WAV. Ticks started every due utterance at once; pause did not stop already-started buffer sources.

### Fix
Windows SAPI (Irina ru-RU) instead of tones. Barge-in + stop sources on pause. Button stays `Выкл` after first speech. 0.1.8.

### Verification
`pytest` 53 passed including `test_sapi_writes_speech_wav` and `test_load_synthesizer_is_not_tone_on_windows`.
