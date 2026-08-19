---
feature: local-video-translate
stage: grill
created: 2026-08-18T02:13:53Z
updated: 2026-08-18T19:07:01Z
upstream: []
---

## Shared Understanding

This file is the contract. Implement 1:1. Do not "improve", do not revive banned paths, do not add fallbacks this list forbids.

### Decisions Made

- **Job.** Player button starts **zakadr** (voice-over) of the YouTube **watch VOD from 0:00**: original ducked, local TTS on top. Not lip-sync, not voice clone, not on-screen captions, not a live/mic path.
- **Surface.** Microsoft **Edge** MV3 only. **YouTube watch VOD only.** Not Shorts, not live, not other sites. **One tab / one session.** Playback supported at **1× only**; do not time-stretch TTS to `playbackRate`. Other speeds are unsupported (no sync promise). Unofficial YouTube ingest is allowed.
- **Audio source — absolute.** Speech audio is **only a file on the native host**. `MediaRecorder`, `captureStream`, PCM-tap from `<video>`, and any live player tap **do not exist**, including as fallback. **No file after all attempts → hard ERROR on the button.** Never voice captions without a file. Never pretend the toggle is off-success.
- **Captions vs file.** Always obtain the file first. If YouTube timedtext exists: run **~30s Whisper from the start of that file**; **word overlap ≥ 0.35** → keep captions for the rest (MT+TTS). Mismatch, garbage, or **no captions** → **Whisper the whole file from 0:00 to the end**.
- **Whisper chunking (whole-file path).** Windows **~10s**, snap the cut to a **pause**, do not cut inside a word. Start at **0:00**, run to the end. Not from playhead. Not live chunks from the player.
- **Pause modes.** Same pipeline, two gates. **Default = ready:** start voicing as soon as some utterances exist; **if TTS lags the playhead, pause the player**. Optional popup checkbox **wait-full:** do not start zakadr until the whole file is done. User pause is sacred: do not force play over it. Do not lock the player for the entire BUFFERING such that the user cannot pause/play.
- **Seek.** One file, one session per `videoId`. Seek does **not** re-download. Play already-ready utterances at the new time. Holes wait on the **already running** 0:00 whole-file job (or caption path). In ready mode, may pause until caught up. In wait-full, seek inside a complete buffer just plays.
- **Languages.** User picks **target RU or EN** (popup). Source auto from captions/Whisper. If source **already is the target** → do not start (already on language). **Local only**, no cloud.
- **Models.** ASR: **faster-whisper large-v3-turbo**. MT: **NLLB-600M via CTranslate2**. Missing weights → honest install/error, **not** a network API.
- **Ingest.** Native host: **yt-dlp + Edge tab cookies + googlevideo intercept / page URL**. No cloud downloader. User file upload may exist as an extra way to *have a file*, not as a replacement for YouTube ingest. Still: no file → error, no tap.
- **Voices.** One speaker → one voice. **Second voice only if whole-file Whisper found two speakers** (max 2 slots, system maps, no picker). Caption-verified path → **one voice**. Not a clone of the original timbre.
- **TTS order.** **Piper first** (ru dmitri+irina, en joe+lessac or the shipped Piper pair). If Piper missing/fails → **Silero** (aidar/baya). **Tone/sine and Windows SAPI are banned in the combat path.** Silent/error rather than a beep or SAPI Irina.
- **Mix.** Original quieter, not fully muted, TTS on top. **Late utterance still plays immediately** (do not drop because it missed its cue by a few seconds).
- **UI.** Player **button = on/off**. Popup: **target language + wait-full checkbox**. Second click **stops the session**, restores original level. Button shows honest state (buffering / ready / error reason). Never start live capture on toggle. Never show "Выкл" as success when we never voiced.
- **Errors.** No file / no model / host dead → **ERROR on the button** with the reason. Session ERROR. No silent off. No infinite "ASR…" with no progress path. No caption-only voicing when the file is missing.
- **Engine.** Keep **Edge MV3 + local native host + loopback HTTP**. Extension: button/popup/mixer/cues. Host: download, caption verify, ASR/MT/TTS, wav paths. Content script does **not** run ASR and does **not** attach MediaRecorder. No rewrite into a standalone desktop app. No parallel videos.
- **Explicit non-goals (forbidden, not "later").** Lip-sync; voice clone; on-screen translated captions; live; Shorts; other sites; cloud ASR/MT/TTS; player tap / MediaRecorder / captureStream / PCM-tap; SAPI or Tone as combat TTS; caption-only path without a file; playhead-only ASR; dropping late cues; autoplay over user pause; multi-tab sessions.

### Open Questions

- None that block implementation. Numeric knobs that are now locked: caption sample **~30s from file start**, match **word overlap ≥ 0.35**, ASR windows **~10s pause-snapped**, max **2** speaker slots.

### Recommended Next Step

`/vs-core-rfc` then `/vs-core-implement` against this file only. Any conflict with older `research.md` / `rfc.md` / code: **this grill wins**. Banned paths must be deleted, not left as dead fallbacks that can be reached.
