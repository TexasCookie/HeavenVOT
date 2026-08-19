---
feature: local-video-translate
stage: research
created: 2026-08-18T02:47:20Z
updated: 2026-08-18T22:00:00Z
upstream:
  - grill
---

## Bottom Line

Качать audio-only с YouTube можно только неофициально и это живой адаптер (yt-dlp + JS runtime + смена клиента), не стабильный API. Субтитры со страницы надёжнее, чем голый download. Нарезка ~10 с годится для Whisper, но **не** для диаризации: спикеров клеим по целому файлу на CPU. Боевой TTS — Piper `ru_RU-irina-medium` + `ru_RU-dmitri-medium` (EN: `en_US-lessac-medium` + `en_US-joe-medium`); Silero aidar/baya запас. Live 2 с tap выпилить.

## Findings

### Съём дорожки

- Официальный Data API медиафайл не отдаёт. Скачивание AV без разрешения YouTube запрещено политикой API. Для личного v1 неофициальный съём уже разрешён грилем.
- Рабочий FILE-путь: **yt-dlp** (stable 2026.07.04 / nightlies) → Innertube → googlevideo/HLS. Нужны Deno или Node 22 + `yt-dlp-ejs`. Клиент `web` — только SABR, без обычных HTTPS adaptive URL ([PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide), [#12482](https://github.com/yt-dlp/yt-dlp/issues/12482)).
- PO token часто привязан к video_id. `android_vr` больше не «бесплатный» (2026-08 [#17348](https://github.com/yt-dlp/yt-dlp/issues/17348)).
- Рецепт хоста: `player_client=tv,web_safari,mweb,web_embedded`, `-f ba`, фолбэк на muxed HLS. Перепроверять клиенты, таблица wiki устаревает за недели.
- Первый запасной FILE — **другой клиент yt-dlp**, не tabCapture. tabCapture — жест, глушит звук вкладки, не стартует с video_id, ловит рекламу. Второй запас — decoder-tap в wav, если все клиенты 403.
- Субтитры: URL со страницы (там уже pot) или `yt-dlp --write-subs --skip-download`. Official `captions.download` чужие треки не отдаёт (403).

### Piper / Silero

- RU в каталоге Piper только четыре medium @ 22.05 kHz: `denis`, `dmitri` (CC0, мужские имена), `ruslan` (CC BY-NC-SA), `irina` (единственная женская, лицензия Unknown / RHVoice). [VOICES.md](https://github.com/rhasspy/piper/blob/master/VOICES.md).
- Фиксированная пара: **`ru_RU-dmitri-medium` + `ru_RU-irina-medium`**. EN: **`en_US-joe-medium` + `en_US-lessac-medium`** (без NC). `hfc_male`/`hfc_female` и `ryan` — NC.
- Мужские Piper RU по CER хуже Silero (Alphacephei 2024: Denis/Dmitry ~3.6–3.7 vs Silero 0.7; Irina 1.4 — терпимо). Это цена Piper-first.
- Silero `v5_ru` / `v5_5_ru`: aidar, baya, kseniya, xenia, eugene — живы. CC BY-NC-SA. Запас, не GPU рядом с Whisper.

### Диаризация и 10 с

- Кластер **внутри** каждого куска 10 с ломает id: permutation-invariant (EEND-VC, pyannote, Bredin 2023). Клеить надо **глобально по файлу**, потом нарезать.
- Стек: Silero VAD (CPU) → **pyannote 3.1 на CPU** (`min_speakers=1, max_speakers=2`) по целому wav → Whisper large-v3-turbo на GPU → NLLB после unload Whisper → Piper CPU. pyannote 4.x на длинном файле пик ~9.5 ГБ ([#1963](https://github.com/pyannote/pyannote-audio/issues/1963)) — на 4060 не ставить.
- Эмбеддинги 1.5–3 с exclusive speech, не один вектор на смешанные 10 с.
- Если один спикер — не гонять полный кластер всегда: `max_speakers=2` + слить близкие центроиды.
- VAD для реза: Silero `max_speech_duration_s=10`, `min_silence_duration_ms≈400`. webrtcvad и ffmpeg silencedetect — не боевые на YouTube с музыкой.

### Код сейчас

- Скачивания YouTube-аудио нет. Live ASR = 2 с PCM/MediaRecorder.
- `asr_live` **не паузит**. Пауза-если-отстал есть только у caption-start с готовыми cues.
- Хост session + `/v1/session/transcribe` + Whisper + SAPI можно оставить. Live tap, `lvt-transcribe` base64, Tone — выпилить из боя.

### Пауза и окна

- 10 с для ASR ок, для диаризации нет. Лучше паковать VAD-острова ≤10 с (WhisperX cut-merge, max 10).
- Pause-if-behind как дефолт ломает просмотр (seek / дырка / музыка = спиннер). Фиксированная задержка или ждать кусок без дёрганья play — решать в RFC; гриль это ещё не сдвигал.

## Confidence Assessment

| Утверждение | Уровень |
|---|---|
| Data API не даёт файл; web-клиент SABR-only | HIGH |
| yt-dlp + ejs + смена клиента — единственный FILE-путь | HIGH |
| Конкретный набор клиентов стабилен месяц | LOW |
| tabCapture не замена download | HIGH |
| Piper RU IDs и «одна женщина = irina» | HIGH |
| Мужской Piper RU хуже Silero по CER | MEDIUM (один лабораторный бенч 2024) |
| Глобальная склейка, не per-chunk | HIGH |
| pyannote 3.1 CPU рядом с turbo на GPU влезает | MEDIUM |
| Точный VRAM turbo+NLLB на этой 4060 | UNVERIFIED |

## Counterarguments

- yt-dlp не «мёртв»: HLS/другие клиенты иногда качают. Мёртва иллюзия «просто `-f ba` и забыл».
- «Скачать с innertube со страницы» — тот же web/SABR. Со страницы ценны **уже подписанные timedtext**, не googlevideo URL.
- Piper не весь мусор: Irina ок, Denis/Dmitri слабые. Один женский официальный RU — развилка, не прятать.
- Pause-if-behind из гриля конфликтует с живым просмотром. Контрарий предлагает fixed delay; это ещё не решение пользователя.

## Open Questions

- Живой дефолт `player_client` в nightly на день имплементации — снять с исходника yt-dlp.
- Порог паузы vs fixed delay — гриль/RFC с пользователем.
- Лицензия `ru_RU-irina-medium` (Unknown / RHVoice) для личного инсталлятора.
- Замер `nvidia-smi` turbo int8 + NLLB int8 на этой карте.

## Sources

- https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide
- https://github.com/yt-dlp/yt-dlp/issues/12482
- https://github.com/yt-dlp/yt-dlp/issues/17348
- https://github.com/yt-dlp/yt-dlp/releases/tag/2026.07.04
- https://developers.google.com/youtube/v3/docs/videos
- https://developer.chrome.com/docs/extensions/reference/api/tabCapture
- https://github.com/rhasspy/piper/blob/master/VOICES.md
- https://huggingface.co/rhasspy/piper-voices
- https://github.com/snakers4/silero-models
- https://alphacephei.com/nsh/2024/07/12/russian-tts.html
- https://huggingface.co/pyannote/speaker-diarization-3.1
- https://github.com/pyannote/pyannote-audio/issues/1963
- https://github.com/snakers4/silero-vad
- https://github.com/SYSTRAN/faster-whisper
- https://herve.niderb.fr/fastpages/2022/10/23/One-speaker-segmentation-model-to-rule-them-all.html
- Bredin Interspeech 2023; Kinoshita arXiv:2010.13366; Plaquet arXiv:2310.13025; WhisperX arXiv:2303.00747
- Codebase explore: `session.py` asr_live, `injected.js` 2s tap, no yt-dlp in repo
