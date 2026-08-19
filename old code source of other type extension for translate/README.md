# AetherVox

**Edge / Chromium extension** (v1.9.11) — voice-over translation for **any site’s video or livestream**, any language → any language (default target: **Russian**).

**Two pipelines (v1.9):**
- **Live realtime** — streams / forced live: STT WS → clause MT → TTS (~1.5–3s first-audio)
- **VOD prepare** — regular videos: offline scan → full cue bank → timed playback (Yandex-style)

GUI (popup · overlay · options) surfaces pipeline mode, VOD progress, and live telemetry.

Built on **xAI Grok** *or* a **fully local** stack (default):

| Stage | Cloud (xAI) | Local (default) |
|--------|-------------|-----------------|
| Speech → text | `api.x.ai/v1/stt` | Faster-Whisper via gateway `:8788` |
| Meaning + MT | Grok chat | Abliterated Qwen in LM Studio `:1234` (proxied) |
| Text → speech | Grok TTS | Piper / Windows SAPI |

**Zero-censorship (local):** no refuse / euphemize / `***` in prompts or gateway. Cloud xAI may still filter.

Local setup: see [`tools/local-voice-gateway/README.md`](tools/local-voice-gateway/README.md) and [`tools/lmstudio/`](tools/lmstudio/).

---

## Install (Microsoft Edge)

1. Open `edge://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this folder (the one with `manifest.json`)
4. Open **AetherVox → Настройки**
5. Paste **XAI_API_KEY** from [console.x.ai](https://console.x.ai/team/default/api-keys)  
   (popup, options, or on-video modal — auto prompt if missing)
6. Click **Проверить ключ** → **Сохранить**
7. Open any video page → click the blue **AV** button on the player → **Перевод**

Works the same in Chrome / Brave / Vivaldi (Chromium MV3).

---

## What it does (VOT / Yandex-class features + more)

### Core (parity+)
- Voice-over translation for videos on **any site** with a `<video>` element  
- **Natural / live Grok voices** (Ara, Carina, Luna, Orion…) on by default; classic neural fallback  
- **Auto voice type + gender match**: F0 + spectral cues classify the original as bass / baritone / tenor / alto / mezzo / soprano and pick the closest Grok TTS (Zagan…Helix / Luna…Carina) so the dub doesn’t clash with the author  

- **Self-learning**: glossary + do-not-translate exceptions improve over time; stale phrases re-translated while watching  
- Auto **API key** entry window (popup + overlay) when key is missing  
- **Subtitles** (source + translated), styleable  
- Separate **original / translation** volumes  
- **Duck** original while translated speech plays  
- **Auto-translate / auto-subtitles**  
- **Hotkeys**: `Alt+Shift+T` translate, `S` subtitles, `M` mute original, `L` cycle target language  
- **Export SRT**  
- Context menu: toggle translation  
- Overlay panel on the player  

### Quality & reliability (the “why this exists”)

| Pain from Yandex / TM scripts | AetherVox response |
|--------------------------------|--------------------|
| Nonsense translations (“коробка для…” in a drawing tutorial about cube/sphere/…) | **Grok 4.5** prompt with video title, domain hint, glossary, phrase history + STT **keyterms** |
| Desync voice vs video | **SyncEngine**: timed queue, adaptive offset, drop stale phrases instead of infinite lag |
| Translation silently dies, must restart by hand | **HealthMonitor**: stall detection, toast, OS notification, **auto-recover** capture |
| Long wait before first audio | **Streaming STT WS** (~100 ms PCM frames) + **partial MT by clauses** + **TTS WS** (target **1.5–3s first-audio**); REST chunk fallback |
| No real live streams | **Live mode**: continuous stream pipeline (not “finished VOD only”) |
| JP / KO / ZH / AR → RU awful | Hard-pair translation rules + multilingual Grok STT + glossary |

### Extra QoL
- Quality profiles: **fast / balanced / max**  
- Mode: **auto / live / vod**  
- Favorite target languages cycle  
- Debug logs toggle  
- Domain auto-hints (art, code, gaming, science, cooking…)  

### Token economy (MT)
- **GlyphPack** (default/primary): packs rules + glossary + history + video context into a dense monochrome PNG and sends it as vision input (Claude-plugin-style: fat text stack → cheaper image-token stack). The live **SRC** line stays as plain text so ASR text is never OCR-garbled.  
- **Standard** (backup): classic optimized text prompts (`fast` ultra-compact, `balanced`/`max` full purity rules).  
- Auto-fallback + circuit breaker: 3 GlyphPack fails → temporary Standard-only, then resume.  
- **Partial sentence TTS**: long translations speak the first sentence ASAP while the rest queues (lower first-audio).  
- **Streaming pipeline** (default on, v1.7): STT WebSocket + clause-level MT + TTS WebSocket. Options can disable each piece; auto-falls back to REST if WS fails.


### Сеть из РФ / прокси (не ломает системный VPN)
- Режим **Авто**: сначала direct (идёт через уже включённый VPN на ПК), затем HTTPS-relay, затем SOCKS/HTTP — берётся путь с **минимальным RTT**
- PAC-прокси расширения **только для `api.x.ai`** — YouTube, вкладки и системный VPN не перехватываются
- Можно указать локальный SOCKS от Outline / Hiddify / v2rayN (`127.0.0.1:…`) или свой reverse-proxy (`…/v1`)
- Кнопка «Сбросить PAC» возвращает контроль прокси системе

### Streaming WebSocket auth (browser)
Chrome **не умеет** слать `Authorization` в `new WebSocket`, а DNR
`modifyHeaders` **часто не применяется** к WebSocket upgrade (Crbug 40815149).
Поэтому AetherVox использует каскад:

1. **Relay** (Options / auto local `127.0.0.1:8787`) → query `_av_key` → worker
   ставит `Authorization: Bearer` upstream
2. **Ephemeral client_secret** (REST `POST /realtime/client_secrets`) →
   `Sec-WebSocket-Protocol: xai-client-secret.<token>` на direct `api.x.ai`
3. **DNR Bearer** — last resort (часто ломается в Chrome)
4. **REST fallback** — перевод не умирает

| Путь | Когда |
|------|--------|
| CF / local relay | если задан / auto `127.0.0.1:8787` |
| **Ephemeral protocol** | **default native**: SW mint `client_secrets` → `xai-client-secret.*` |
| DNR Bearer | last resort (Chrome часто игнорит на WS) |
| REST fallback | WS auth fail; broken-флаг сбрасывается через ~2 мин / новый mint |

```bash
node tools/self-test.mjs
set XAI_API_KEY=xai-... & node tools/self-test.mjs   # + live
```


---

## Architecture

```
<video> audio
   → Web Audio capture (PCM 16 kHz)
        ├─ streaming: ~100ms frames → Port → SW → wss STT
        │     → interim / speech_final
        │     → peel clauses → Grok MT (fast) → wss TTS
        └─ fallback REST: rolling WAV chunks → POST /stt → MT → POST /tts
   → SyncEngine + <audio> playback + subtitles overlay
   → HealthMonitor (stall → notify → restart capture)
```

API key lives in `chrome.storage.local` and is used only from the **service worker** (not injected into page JS).  
Browser WebSocket cannot set `Authorization` — SW mints an ephemeral client secret for `Sec-WebSocket-Protocol`, or uses a relay (`_av_key`). DNR Bearer is last resort. On WS failure → automatic **REST** path.

---

## Project layout

```
manifest.json
background/service-worker.js
content/          overlay + video detection + pipeline host
lib/xai/          Grok client, STT/TTS/translate, STT+TTS WebSocket, WS auth
lib/pipeline/     capture, stream-bridge, clause-splitter, sync, health, context
popup/ options/   UI
_locales/         ru (default), en
assets/icons/
```

No build step — load unpacked as-is.

---

## API cost note

You pay xAI usage (STT / chat / TTS). See [xAI pricing](https://docs.x.ai/developers/models).  
- **STT / TTS** are billed as speech (time / characters), not chat tokens.  
- **MT (chat)** is where GlyphPack vs Standard matters. Default is GlyphPack with Standard fallback.  
- For long streams prefer **fast** quality profile; for hard language pairs prefer **max**.  
- Options → «Экономия токенов API» shows GlyphPack hit/fallback stats.

---

## Limitations (honest)

1. Sites that fully block Web Audio / cross-origin media without CORS may not allow capture (rare for normal HTML5 players; common for some DRM).  
2. First-audio target is **~1.5–3s** on a healthy path (stream STT + clause MT + stream TTS). Network/VPN RTT still dominates; SyncEngine keeps later speech from drifting forever.  
3. Browser WebSocket cannot set `Authorization` — use ephemeral `client_secret` protocol and/or CF/local relay. DNR alone is unreliable on Chrome WS. On WS failure → automatic **REST** chunk path.  

4. TTS language coverage follows xAI TTS list; other targets still translate in text/subs and may use `auto` voice language.  
5. If you use a custom HTTPS relay, re-deploy `tools/xai-relay-worker.js` so it proxies **WebSocket** upgrades for `/v1/stt` and `/v1/tts`.  

---

## Hotkeys

| Shortcut | Action |
|----------|--------|
| `Alt+Shift+T` | Toggle translation |
| `Alt+Shift+S` | Toggle subtitles |
| `Alt+Shift+M` | Mute / restore original |
| `Alt+Shift+L` | Cycle favorite target language |

---

## License

MIT — use, fork, improve. Not affiliated with Yandex or xAI.
