---
feature: local-video-translate
stage: rfc
created: 2026-08-18T22:10:00Z
updated: 2026-08-18T20:10:00Z
upstream:
  - grill
  - research
---

# Spec: File-only YouTube watch zakadr (grill 2026-08-18T19:07)

**Status**: Validated

## Problem Statement

The user presses the YouTube player button and must get a local voice-over of the watch VOD from the start of the video: original ducked, translated speech on top. Previous builds ignored the grill: they voiced captions without a file, or fell back to a live player tap that does not work. This spec is a 1:1 projection of `.spec/local-video-translate/grill.md`. If code or older research disagrees, the grill wins.

## Design Decisions

### Decision 1: Zakadr from 0:00, Edge watch VOD only
**Context:** User chose voice-over of the whole watch VOD from the start, not playhead-only, not on-screen text, not lip-sync, not clone.
**Decision:** One Edge tab, one session, YouTube watch VOD only, 1× only. Target language is RU or EN (user pick). Source language is detected. Already-on-target does not start. Other playback rates are unsupported; do not stretch TTS to match them.
**Alternatives considered:** Playhead-only zakadr — rejected. On-screen captions — rejected. Chrome/other sites/Shorts/live — rejected. Any language pair — rejected.
**Consequences:** Shorts, live, multi-tab, and speed ≠ 1× are error-or-ignore, not extra modes.

### Decision 2: Audio is a file or the session is ERROR
**Context:** Live MediaRecorder / captureStream / PCM-tap failed in product. User forbade them including as fallback. No file must be a visible error.
**Decision:** The host must obtain a local audio file (yt-dlp with the tab’s cookies, a googlevideo URL written to disk, or an uploaded file). Methods may race. A fetch exception must not `fail_asr` if another method already claimed a file or can still deliver one. A late file must still apply even if the other method already failed (reopen a download ERROR). Only when no method has claimed and none can still deliver is the session ERROR. Caption text is never synthesized unless a file was obtained. Dead tap code must not be reachable from enable.
**Alternatives considered:** Caption-only when download fails — rejected. Live tap fallback — rejected. tabCapture — rejected by research (mutes tab, ads) and by grill.
**Consequences:** YouTube client/PO-token breakage surfaces as “no file”, not as a silent off or a tap.

### Decision 3: Captions are a text source only after a file sample matches
**Context:** User: always download; short Whisper vs captions; match keeps captions; else whole-file Whisper from 0:00.
**Decision:** After a file exists: if timedtext exists, Whisper ~30 s from the **start of the file**. Word-overlap ≥ 0.35 → keep those caption strings for the whole video (still run MT+TTS). Overlap below 0.35, empty, or missing captions → discard them and Whisper the **entire file 0:00→end**.
**Alternatives considered:** Trust captions and skip the file — rejected. Always Whisper — rejected when captions match. Verify at mid/end as well — rejected (start sample only).
**Consequences:** Enable with captions but no file is ERROR. Enable must not flip to “off/success” just because captions exist.

### Decision 4: Whole-file ASR is ~10 s pause-snapped windows from 0:00
**Context:** User locked window size, pause snap, and start-at-zero.
**Decision:** On the Whisper-the-file path, cut ~10 s windows, move the cut to a nearby pause, do not cut inside a word, walk 0:00 to the end. Do not start at playhead. Do not transcribe live player chunks.
**Alternatives considered:** Rigid 10 s grid — rejected. 30–60 s windows — rejected. Playhead-forward ASR — rejected.
**Consequences:** Ready mode can voice early windows before the tail exists. Seek does not restart the download or the 0:00 job.

### Decision 5: Ready by default, optional wait-full, pause if behind
**Context:** User: start when something is voiceable; pause the player if TTS lags; checkbox to wait for the whole file; user pause is sacred.
**Decision:** Default gate is ready: play zakadr when utterances exist; if the playhead hits a hole or TTS is behind, pause the player. A hole includes “past the last voiced window while the file job is not complete” (`asr_done` still false), not only a cue sitting in the pending list. `add_cues` must not clear “still awaiting the rest of the file.” wait-full: do not start zakadr until every window (or every caption line) is voiced. Never force play over a user pause. Never lock play/pause for the whole download so the user cannot use the player. Seek uses already-ready utterances; missing span follows the same pause-if-behind rule in ready mode.
**Alternatives considered:** Always wait for the full file — rejected as default. Never pause — rejected. Extension owns play/pause exclusively — rejected.
**Consequences:** Ready mode may pause on seek-into-a-hole. wait-full sits silent until the job completes.

### Decision 6: Voices — system mapped, two slots only after whole-file two-speaker pass
**Context:** User: one speaker one voice; second voice only if whole-file Whisper found two people; no picker; no clone. Caption path is one voice.
**Decision:** Caption-verified path always uses one slot. Whole-file ASR may assign at most two slots, and only if that pass reports two speakers. Mapping is automatic. Timbre is not cloned from the video.
**Alternatives considered:** Always two voices — rejected. Always diarize even on captions — rejected. User picker — rejected. Clone — rejected.
**Consequences:** A caption match never introduces a second voice. Isolated per-window speaker ids are forbidden (research: they permute). Glue speakers on the whole file, then slice.

### Decision 7: Piper then Silero; Tone and SAPI are not combat
**Context:** User forbade sine/Tone and Windows SAPI on the playback path. Research names the Piper pair.
**Decision:** Combat load order is Piper (`ru_RU-dmitri-medium` + `ru_RU-irina-medium`; EN `en_US-joe-medium` + `en_US-lessac-medium`) then Silero (aidar/baya). If neither is available, do not speak (honest failure/silence). Do not play tones. Do not use SAPI Irina (or any SAPI) as a stand-in.
**Alternatives considered:** Silero-only — rejected. SAPI last resort — rejected. Cloud TTS — rejected.
**Consequences:** Missing voice packs are an install/error problem, not a beep.

### Decision 8: Mix, late cues, toggle, errors
**Context:** User: duck original (not mute); play late utterances immediately; button on/off; popup language + wait-full; second click stops session; honest errors.
**Decision:** Duck original, mix TTS. An utterance ready after its timestamp still plays now (do not drop for being a few seconds late). Player button toggles the session. Popup sets target language and wait-full. Off restores original level and stops the host session. Button text is the real state (buffering / ready / error reason). Host dead, missing model, or no file → ERROR, not “Выкл”, not infinite “ASR…” with no path.
**Alternatives considered:** Full mute — rejected. Drop late cues — rejected. Silent off — rejected. Caption-only fallback on error — rejected.
**Consequences:** Content script must not start a recorder on toggle. Mixer must not steal the element in a way that blocks original audio when off.

### Decision 9: Engine stays MV3 + native host + loopback HTTP
**Context:** User kept the current engine. Local only. Models: faster-whisper large-v3-turbo and NLLB-600M (CTranslate2).
**Decision:** Extension handles UI, caption harvest, cookies, playhead, mix. Host downloads the file, verifies captions, runs ASR/MT/TTS, serves wavs. One session. Missing weights → install/error, not a network API. Unofficial ingest is allowed; client list is an install-time adapter, not a product mode.
**Alternatives considered:** In-extension-only — rejected. Desktop app rewrite — rejected. Cloud when local missing — rejected. Parallel sessions — rejected.
**Consequences:** yt-dlp/PO-token churn is handled in the host ingest adapter. It cannot reintroduce a tap.

## Assumptions

A1. At least one file method (yt-dlp with cookies, written googlevideo URL, or upload) can produce a decodable audio file on a real watch VOD. -- Decision 2, Slice 1
A2. Word overlap ≥ 0.35 on a ~30 s Whisper prefix is a stable enough caption-quality gate. -- Decision 3, Slice 1
A3. Energy/VAD pause snap around 10 s avoids mid-word cuts for typical speech. -- Decision 4, Slice 1
A4. Ready-mode pause-if-behind is acceptable and does not steal user pause. -- Decision 5, Slice 2
A5. Caption strings and ASR strings can share one translate+TTS+tick path. -- Decision 3, Slice 2
A6. Piper and Silero presence can be detected; absence must not select Tone or SAPI. -- Decision 7, Slice 3
A7. Whole-file speaker glue can decide 1 vs 2 slots without a neural diarizer dependency. -- Decision 6, Slice 3
A8. Enable from the player button can send captions + language + wait-full without starting a recorder. -- Decision 8, Slice 4

## Vertical Slices

### Slice 1: File required + caption verify or whole-file ASR
**Purpose**: Start never voices without a file; captions survive only if the 30 s sample matches; otherwise Whisper 0:00→end in ~10 s pause-snapped windows.
**Acceptance criteria**: Given already-on-target, the session does not start. Given no file method, the session is ERROR and later cues are ignored. Given captions whose 30 s sample overlap is ≥ 0.35, uttered source texts are those captions. Given mismatch or no captions, uttered source texts are ASR and the first window starts near 0:00 with ~10 s pause-snapped spans.
**Validates assumptions**: A1, A2, A3
**Testing strategy**: Injectable file + fake transcriber on the shipped start/job path. Assert ERROR when the file source is missing.

### Slice 2: Ready vs wait-full pause
**Purpose**: One tick path, two gates, pause if behind, user pause remains possible.
**Acceptance criteria**: ready can unpause after the first voiced buffer before the job is complete (`asr_done` still false). ready then pauses again if the playhead passes the last voiced window before the job marks complete. wait-full keeps the “pause because we are not ready” flag until the job is complete. A user pause is not overwritten by a force-play. A late utterance still plays.
**Validates assumptions**: A4, A5
**Testing strategy**: Session/HTTP start+tick with both play modes.

### Slice 3: Combat voices and speaker slots
**Purpose**: Piper then Silero; never Tone/SAPI; second slot only after whole-file two-speaker pass.
**Acceptance criteria**: Loader is Piper when the pair is present, else Silero if importable, never Tone or SAPI. One speaker or caption path → one slot. Two whole-file speaker ids → two slots.
**Validates assumptions**: A6, A7
**Testing strategy**: Loader with a temp Piper dir; speaker map unit tests.

### Slice 4: Extension enable is file-pipeline only
**Purpose**: Toggle and popup match the grill; live capture is unreachable.
**Acceptance criteria**: Enable sends target language, wait-full/ready, caption candidates, cookies/file hints. Enable does not construct MediaRecorder, captureStream, or PCM-tap and does not post a live-ASR start. Off stops the session and unducks. Button can show an error string from the host. Presence of captions alone does not mark success.
**Validates assumptions**: A8
**Testing strategy**: JS tests on shipped content/popup/policy; grep-level guarantee that enable does not call the tap.

## Out of Scope

- Lip-sync, voice clone, on-screen translated captions
- Live, Shorts, embeds, sites other than YouTube watch
- Cloud ASR / MT / TTS / download
- MediaRecorder, captureStream, PCM-tap, tabCapture
- SAPI or Tone as combat TTS
- Caption-only voicing without a file
- Playhead-only ASR
- User voice picker
- Pyannote as a required package
- playbackRate ≠ 1× support
- Hitting real YouTube in CI

## Open Questions

- Which yt-dlp `player_client` works on the user’s IP this week is install-time, not a product fork.
- Irina Piper license is Unknown/RHVoice; personal install only (research). Not a grill reopen.

## Evolution Log

*Maintained in the implementation artifact.*
