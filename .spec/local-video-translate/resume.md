# Pause snapshot

Pipeline finished 2026-08-18. WSL off. Git Bash only if a script needs bash.

## Where we stopped

Stage: **implement done**. Version **0.2.0**. Tests: 57 pytest + JS.

Next user action: reload Edge extension 0.2.0, restart host, try a watch VOD. yt-dlp installed in `.venv`. Piper not required; SAPI still speaks if Silero missing.

Not a fourth verification-agent pass: source/contrarian/deep-technical already spot-checked their load-bearing URLs.

| Agent | id | Status | Result |
|---|---|---|---|
| source | `01a014f3-30fd-7861-9fd9-a4b38d2e1bb4` | cancelled | none — re-dispatch |
| contrarian | `01a014f3-30fd-7861-9fd9-a4c782319f34` | cancelled | none — re-dispatch |
| codebase (explore) | `01a014f3-30fd-7861-9fd9-a4d4c4a2b8f0` | **completed** | keep; resume_from if needed |
| deep-technical | `01a014f3-30fe-7863-83c9-0bbf22b5aaa6` | cancelled | none — re-dispatch |

Prompt files (may be gone from TEMP):  
`%TEMP%\vs-research-source-89c8cddd.md` and siblings. Rebuild via PowerShell concat (bash/WSL **not available**).

## Do not use WSL

`wsl.exe` is not registered (`REGDB_E_CLASSNOTREG`). Hung `wsl` processes were killed.  
User asked to turn WSL off and how to do it later. **Do not call wsl/bash again in this project.**

User can later:
- stop a running VM: `wsl --shutdown` (only if WSL actually works)
- kill leftovers: `Stop-Process -Name wsl -Force`
- disable the Windows feature: «Компоненты Windows» → снять «Подсистема Windows для Linux» и «Платформа виртуальной машины», перезагрузка

Research prompts: assemble with PowerShell (already done once this session), not `build-prompt.sh`.

## Product on disk (working, old pipeline)

- Extension **0.1.8** (`manifest.json` + `extension/manifest.json`)
- Pause/play ownership works
- ASR is still **live 2s tap** from the player (PCM / MediaRecorder) → `/v1/session/transcribe`
- TTS production: Silero if torch exists (it does not) → **Windows SAPI Irina**; tones removed from production
- Host: NLLB + faster-whisper large-v3-turbo already installed
- Tests last green: 53 pytest + JS unit tests

## Decisions already locked (grill.md)

Read `.spec/local-video-translate/grill.md` in full. Short:

- Audio = **file on host**, not live 2s capture. Live tap to be deleted.
- Captions YouTube if they pass simple gate; else Whisper on downloaded track.
- ~10s chunks, snap to silence.
- From playhead → end; cache chunks; seek does not recompute done work.
- Two modes, one pipeline: play-as-ready (default, pause if behind) vs wait-for-full.
- 2 voices only if 2 speakers; glue IDs across chunks; system assigns; no picker.
- Piper combat, Silero fallback. No clone. No Irina as combat voice.
- Backup ingest also yields a **file**. No fallback to current live tap.

Research questions still open (grill):

1. Stable YouTube audio-only download 2026 + first file backup.
2. Exact Piper RU/EN M/F voice IDs.
3. Diarization that glues 10s chunks on 8GB next to Whisper+NLLB+Piper.
4. Playhead align + pause-if-behind threshold.

## Codebase agent (already have)

Keep host session + transcribe + Whisper + TTS.  
There is **no** yt-dlp / SABR / PO token / 10s splitter.  
`asr_live` never pauses — 10s file chunks cannot use current no-caption start as-is.  
Caption harvest works; `player_payload` host ingest exists but extension never sends it.  
`COVERAGE_MIN` is unused.

## Next actions (in order)

1. Re-dispatch source + contrarian + deep-technical (codebase already done).
2. Synthesize + verification → overwrite `research.md`.
3. RFC for ingest+chunk pipeline.
4. Implement: download file → 10s VAD snap → whisper → NLLB → Piper; delete live capture.

User resume phrase: they will write when they want this continued.
