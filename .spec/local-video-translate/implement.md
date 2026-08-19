---
feature: local-video-translate
stage: implement
created: 2026-08-18T22:20:00Z
updated: 2026-08-18T20:10:00Z
upstream:
  - rfc
---

## Implementation Plan

### Scope Assessment
Align the existing Edge MV3 + native host to grill 2026-08-18T19:07. File is mandatory. Piper then Silero. Pause-if-behind must survive the first window.

### Slices
1. File required + caption verify or whole-file ASR from 0:00
2. Ready vs wait-full; pause-if-behind past last voiced window
3. Piper first, then Silero; two slots only after whole-file pass
4. Extension enable is file-pipeline only; intercept fail kicks yt-dlp or errors

## Slice Reports

### Slice 1: File required + caption verify or whole-file ASR
**Status**: DONE
HTTP start + injected FileSource: matching sample keeps caption texts; mismatch/no captions Whisper from 0:00 in ~10 s pause-snapped windows. No file → ERROR; later add_cues ignored.

### Slice 2: Ready vs wait-full pause
**Status**: DONE (prior report STALE)
Old report claimed ready pause-if-behind while `add_cues` cleared `awaiting_asr` and `_next_unready_start` ignored a tail hole. Now: `awaiting_asr` stays until `mark_asr_complete`; playhead past last voiced window while `!asr_done` pauses. HTTP GateAsr start asserts unpause at 0 with `asr_done` false, then pause at 8.

### Slice 3: Combat voices and speaker slots
**Status**: DONE
`load_synthesizer` tries Piper pair, then Silero, then silent. Never Tone/SAPI.

### Slice 4: Extension enable is file-pipeline only
**Status**: DONE (prior report STALE)
Old enable set `skip_download` on intercept URL and ignored fetch errors → eternal `downloading`. Now enable never skips yt-dlp; intercept fail POSTs `/v1/session/need-file` (kick source or `audio_download_failed`). No live tap.

## Evolution Log

### 2026-08-19 -- leftover transcribe fail + HTTP full mode
- `/v1/session/transcribe` now uses `fail_file` so a dead tap POST cannot kill a claimed file session.
- Shipped HTTP start with `play_mode=full` stays `pause_player` until `asr_done`.

### 2026-08-18 -- need-file after both methods fail
- `file_job_failed` marks yt-dlp finished-failed. `need_file` now ERRORs if nothing claimed and that job already failed (was hanging: `file_job_started` return skipped `fail_file`). HTTP test: expect_upload + FailSource + need-file → error.

### 2026-08-18 -- dual file methods
- yt-dlp `run_file_job` exception no longer `fail_asr`s a session that already claimed a file or is still waiting on upload (`expect_upload` / `skip_download`).
- Late `/v1/session/audio-file` after yt-dlp ERROR reopens via `reopen_for_file` and voices. HTTP tests: late upload after fail; slow yt-dlp fail does not kill a successful upload; expect_upload keeps buffering.

### 2026-08-18 -- grill lock + skeptic gaps
- A1: CONFIRMED via injected FileSource on shipped `/v1/session/start`.
- A2: CONFIRMED — HTTP start matching vs mismatch caption tests.
- A3: CONFIRMED — no-captions 25 s gapped wav from real start: offsets ~10 s from 0:00.
- A4: CONFIRMED — ready unpauses with `asr_done` false; pauses past last window. Prior A4 was stale.
- A5: CONFIRMED — caption and ASR cues share process_pending.
- A6: CONFIRMED — loader never Tone/SAPI.
- A7: CONFIRMED — whole_file_speakers two-slot map.
- A8: CONFIRMED — JS: no live tap; no skip_download; need-file on intercept fail.
