# AetherVox Full Debug Bug Report (v1.9.11)

Session: `v180-full-audit` (prior `a17762` / `37858e`) · Updated: 2026-08-12 (pass 2: gateway T1–T15)  
Evidence: full source audit of V1.80 + Node runtime proofs + `tools/bug-report-verify.mjs` (3× each) + `tools/self-test.mjs`

> Packaging folder name is `V1.80` — **canonical extension version is `1.9.11`** (manifest / README / `options/force-reload.js`). See B28 / B47.

## Loop rule

Each item has **3 consecutive tests**. If any run fails → fix → restart the **full** suite until every item is 3/3 green in one pass. Then re-run the full suite 3 consecutive times.

```bash
node tools/self-test.mjs
node tools/bug-report-verify.mjs
```

## New findings (this audit) — B39–B52

| ID | Severity | Claim | Evidence | Verdict |
|----|----------|--------|----------|---------|
| B39 | critical | Leftover agent debug `fetch(127.0.0.1:7419/ingest/…)` in SW / content / page-bridge / offscreen / ytdlp / extractor / DNR | `#region agent log` + ingest UUID | **REAL** → fixed (removed) |
| B40 | critical | `forceVodOnce` overwritten by later `vodMode2` → Live↔VOD loop | `content-main.js` prefer_vod + re-detect | **REAL** → `keepForcedVod` |
| B41 | critical | `#processChunk` throw only logged — index vanishes, full bank never unlocks | `.catch((e) => log.warn)` | **REAL** → `#onChunkSettled` + empty-bank fail |
| B42 | high | Gateway `/v1/media/youtube-audio` accepted any URL (yt-dlp SSRF) | `server.py` + CORS `*` | **REAL** → YouTube allowlist |
| B43 | high | Boot `GET_SETTINGS` had no timeout; failed SW hung content forever | `sendMessage` without `timeoutMs` | **REAL** → 8s + `settingsFromResponse` |
| B44 | high | Local chat always preferred Cyrillic extract — broke EN/JA/… targets | `_extract_cyrillic_candidate` first | **REAL** → `wants_cyrillic_target` |
| B45 | medium | yt-dlp cookie files + media cache never pruned | `MEDIA_CACHE_DIR` / `_media_cache` | **REAL** → `finally` unlink + LRU prune |
| B46 | medium | Native host leaked the autostart log file handle | `cmd_start` never closed `log_f` | **REAL** → `finally: log_f.close()` |
| B47 | medium | Folder `V1.80` vs manifest `1.9.10` vs overlay/popup hardcode | manifest/README/overlay/force-reload | **REAL** → `1.9.11` + manifest-driven UI |
| B48 | medium | Media-cache `{token}` used raw in `glob` (path/glob injection) | `MEDIA_CACHE_DIR.glob(f"{token}.*")` | **REAL** → hex token only |
| B49 | low | Abort in `fetchWithRetry` always said `STT fetch timeout` (TTS/MT too) | `client.js` | **REAL** → `fetch timeout` |
| B50 | medium | `host.endsWith('youtube.com')` / `includes` matched `evil-youtube.com` | innertube + `detectMediaIsLive` | **REAL** → `isYoutubeHost` |
| B51 | medium | page-bridge accepted `postMessage` from any iframe (`PLAY_TTS` / resolve) | no `ev.source === window` | **REAL** → same-window + origin |
| B52 | medium | Catch-all `/v1/{path}` proxied to LM Studio (`..` / `://`) | `proxy_unknown` | **REAL** → `is_safe_proxy_path` |
| B53 | high | Native host JSON/bat still pointed at **V1.79.5** + missing Python310 | `com.aethervox.local_gateway.json`, `native_host_launcher.bat` | **REAL** → V1.80 + `%~dp0` python finder |
| B54 | high | `close_fds=True` + redirected stdio on Windows → spawn fail; PID substring | `native_host.py` | **REAL** → `close_fds` only off-NT + token PID |
| B55 | high | Default `ara` mapped to **male** Piper `dmitri` | `voices.json` | **REAL** → `irina` + gender guard |
| B56 | high | Whisper `transcribe(ndarray)` without 16 kHz resample | `server.py` `_read_upload_audio` | **REAL** → `resample_to_16k` |
| B57 | medium | TTS always WAV but client asked mp3 | `_wav_to_mp3_or_wav` | **REAL** → always `audio/wav` |
| B58 | medium | `/health` always `ok:true`; autostart PID missing | `health()` / `main()` | **REAL** → `ready` + `engines_ok` + `.gateway.pid` |
| B59 | low | `self-test` unused `createRequire`; gender `&&`/`\|\|` precedence | `self-test.mjs` | **REAL** → parens + drop import |
| B60 | high | Health 20s kills local Whisper (90s+) | `HealthMonitor` + `inflightTimeoutMs` | **REAL** → provider-aware 100s |
| B61 | high | Live `Audio.play()` autoplay-blocked | `translator-pipeline` `#playPhrase` | **REAL** → unlock + offscreen fallback |
| B62 | high | Phrase cache 6h ignores learning revision | `XAI_TRANSLATE` | **REAL** → `phraseCacheUsable` |
| B63 | high | Dedup remembered before TTS success | `#enqueueClause` | **REAL** → inflight set, remember after audio |
| B64 | high | `createMediaElementSource` after CS remount | `audio-capture.js` | **REAL** → `__aethervoxGraph` + tab-refresh hint |
| B65 | high | Failed `networkReady` sticky | `ensureNetwork` | **REAL** → reuse only `ok===true` |
| B66 | medium | REST used deprecated 10s windows | `#chunkSec` | **REAL** → `restChunkSec` ~1.8s |
| B67 | medium | Learning/settings RMW races | SW + `storage.js` | **REAL** → write chains |
| B68 | medium | `\b` misses Cyrillic; uk/kk TTS `auto` | `learning.js` / `languages.js` | **REAL** → unicode bounds + tts codes |
| B69 | medium | `offscreen/*` in WAR | `manifest.json` | **REAL** → removed |
| B70 | high | YT DNR UA rewrote **all** tab Innertube/media | `youtube-ua-dnr.js` | **REAL** → initiatorDomains + Referer |
| B71 | high | STT WS 5.5s budget left leftover `openWithCred` | `stream-session.js` | **REAL** → `_sttWsAttempt` cancel |
| B72 | high | TTS timeout audio applied to next utterance | `tts-ws.js` | **REAL** → id/gen + close socket |
| B73 | high | Any :8787 got `_av_key` API key | `discoverLocalRelayBase` | **REAL** → `looksLikeXaiRelay` |
| B74 | medium | Gateway health `res.ok \|\| data.ok !== false` | `local-gateway-host.js` | **REAL** → `ok === true` |
| B75 | medium | Probe 404 = working; failed route cached 8 min | `router.js` | **REAL** → no 404; short fail TTL |
| B76 | medium | Cookie jar included `.google.com` SID | `youtube-cookies.js` | **REAL** → YouTube hosts only |
| B77 | medium | Native STT fetch no timeout/abort | `native-stt-stream.js` | **REAL** → 45s AbortController |
| B78 | low | `transcript.done` swallowed as partial | `stt-ws.js` | **REAL** → handle done first |
| B79 | high | `postMessage(..., '*')` + dead `PLAY_TTS` | `page-bridge.js` | **REAL** → origin + drop PLAY_TTS |
| B80 | high | `about:` skip killed `match_about_blank` | `content-bootstrap.js` | **REAL** → allow blank/srcdoc |
| B81 | high | Lost `<video>` never detached; FS listener leak | content-main / video-finder | **REAL** → detach + removeListener |
| B82 | medium | Subs/settings wipe on SW miss | content-main / overlay | **REAL** → persist + `settingsFromSetResponse` |
| B83 | medium | Popup treats SW-miss as no key; child iframe also toggles | popup / content-policy | **REAL** → gate + owner election |
| B84 | high | `#markInflightSpoken` before backpressure drop → phrase silenced forever | `translator-pipeline` `#enqueueClause` | **REAL** → `clauseShouldDispatch` then mark |
| B85 | high | Epoch/fallback zeroed counters; leftover `.finally` stole new slots | clause/REST finally | **REAL** → decrement only if `epoch === _epoch` |
| B86 | high | Timed-out STT open still accepted late `stt_ready` | stream-bridge / stream-session | **REAL** → open-gen + ignore timed-out gen |
| B87 | high | SW aborted xAI VOD STT at 8s (live budget) | `XAI_STT` handler | **REAL** → honor `payload.timeoutMs` |
| B88 | high | TTS WS timeout assigned `this.connected = false` (getter) → never reject | `tts-ws.js` | **REAL** → drop setter write |
| B89 | medium | Native STT `close()` aborted only the last fetch | `native-stt-stream.js` | **REAL** → AbortController set |
| B90 | medium | VOD overlap containment marked `'silent'` (cue hole + unlock) | `#isDuplicate` | **REAL** → near-exact only |
| B91 | high | `host.includes('twitch.tv')` + any YouTube path for yt-dlp (redirect SSRF) | context-builder / url-guard | **REAL** → `isTwitchHost` + path allowlist |
| B92 | high | `sendMessage` treated `undefined` response as `{ok:true}` | `messaging.js` | **REAL** → `interpretExtensionResponse` |
| B93 | medium | `postMessage(..., location.origin \|\| '*')` wildcard on empty origin | page-bridge / content-main | **REAL** → never `*` |

## Prior items (B1–B38) — still required green

| ID | Claim | Verdict |
|----|--------|---------|
| B1–B38 | See history below | **kept** — re-verified this session |

## Fixes shipped (session `v180-full-audit`)

1. **B39** — stripped every `127.0.0.1:7419` agent ingest + `AETHERVOX_DEBUG_PROBE`
2. **B40** — `keepForcedVod(forced, recomputed)` in content auto-detect
3. **B41** — thrown chunks enter retry/terminal-fail; empty all-fail bank is an error
4. **B42/B48/B52** — `gateway_policy.py` + `lib/media/url-guard.js`; SW/offscreen re-check streamUrl
5. **B43** — `SETTINGS_FETCH_TIMEOUT_MS` + `settingsFromResponse` on boot / popup / options
6. **B44** — extract Cyrillic only when the prompt targets Russian
7. **B45** — cookie unlink in `finally`; cache prune (age + max 8)
8. **B46** — native host closes the log handle after spawn
9. **B47** — version `1.9.11`; overlay/popup/options read `getManifest().version`
10. **B49** — generic `fetch timeout`
11. **B50** — shared `isYoutubeHost` (no suffix spoof); no loose id parse on foreign hosts
12. **B51** — page-bridge same-window + origin gate

## Historical B1–B38 (previous sessions)

| ID | Claim | Verdict |
|----|--------|---------|
| B1 | Failed VOD chunks unlocked empty “ready” | fixed |
| B2 | YT SPA keeps old VOD bank | fixed |
| B3 | Auto-VOD non-YT always fails | fixed |
| B4 | signatureCipher not implemented | mitigated |
| B5 | SW download 403 | mitigated |
| B6 | STT/MT/TTS fail silent | fixed |
| B7 | Failed TTS marked played | fixed |
| B8 | Proxy auth `blocking` illegal MV3 | fixed |
| B9 | Auto `play()` after hole blocked | fixed |
| B10 | Silent CORS capture looks “running” | mitigated |
| B11 | Page-bridge DOM inject only | fixed |
| B12 | Offscreen job memory-only | mitigated |
| B13 | Direct WS needs mint/relay | documented |
| B14 | README/manifest version drift | fixed |
| B15 | Offscreen download timeout ≈1ms | fixed |
| B16 | SW answers `OFFSCREEN_MEDIA_DOWNLOAD` | fixed |
| B17 | Popup blocks local without xAI key | fixed |
| B18 | Dual `onAuthRequired` ignore `isProxy` | fixed |
| B19 | Full VOD as base64 over BC | mitigated |
| B20 | `webNavigation` missing permission | fixed |
| B21 | Hotkey `sendMessage` unhandled rejection | fixed |
| B22 | Progressive unlock hole at t≈0 | fixed |
| B23 | Cue bank keeps all TTS PCM | mitigated |
| B24 | Bridge inject top-frame only | fixed |
| B25 | Local auth optimistic | fixed |
| B26 | Offscreen jobs accumulate | mitigated |
| B27 | HEALTH_ALERT regex spam | fixed |
| B28 | Folder vs manifest | documented (`V1.80` / `1.9.11`) |
| B29 | Seek-back silent after prune | fixed |
| B30 | B25 only checked health | fixed |
| B31 | Double OS toast on vod_ready | fixed |
| B32 | Unvalidated postMessage streamUrl | fixed |
| B33 | `audioAb` TDZ on success return | fixed |
| B34 | `self-test.mjs` SyntaxError EOF | fixed |
| B35 | Dual PLAY_TTS handlers race | fixed |
| B36 | LOCAL_VALIDATE 10s vs ≤70s start | fixed |
| B37 | durationHint overrides decoded length | fixed |
| B38 | e2e hardcodes version 1.9.7 | fixed |

## Residual (not silent bugs — known limits)

- YouTube `signatureCipher` still not deciphered (B4) — multi-client + yt-dlp fallback.
- Local Whisper/LLM models must exist on disk; empty `models/whisper` / `models/llm` is an install issue, not a code path.
- Gateway binds `127.0.0.1` — any local process can still call it; URL allowlists stop SSRF, not local use.
- CORS `*` remains on the local gateway (extension SW fetch is not CORS-bound).

## Verify

```bash
node tools/self-test.mjs
node tools/bug-report-verify.mjs   # 3 consecutive greens per item (B1–B93)
```

Result file: `tools/.vod-check/bug-report-verify-result.json`

**This session:** `self-test.mjs` + `bug-report-verify.mjs` **B1–B93×3** after B84–B93 (inflight leak, epoch slots, STT ready gen, VOD STT budget, TTS WS timeout, native abort set, VOD overlap, host/SSRF, empty SW response, postMessage origin). Extra: root `package.json` `"type": "module"` so Node can import extension ESM.
