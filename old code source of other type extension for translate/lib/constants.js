/** @typedef {'idle'|'starting'|'running'|'paused'|'degraded'|'error'|'stopped'} PipelineStatus */

export const EXT_NAME = 'AetherVox';
/** Bump when VOD extract path ships */
export const EXT_VERSION_NOTE = 'vod-extract-10s';
export const XAI_BASE = 'https://api.x.ai/v1';
export const XAI_STT_URL = `${XAI_BASE}/stt`;
export const XAI_TTS_URL = `${XAI_BASE}/tts`;
export const XAI_CHAT_URL = `${XAI_BASE}/chat/completions`;
export const XAI_STT_WS = 'wss://api.x.ai/v1/stt';
export const XAI_TTS_WS = 'wss://api.x.ai/v1/tts';

/**
 * Flagship Grok for offline / deep re-translate / repair only.
 * NEVER use on the live STT→MT→TTS hot path (often 8–15s RTT).
 */
export const DEFAULT_TRANSLATE_MODEL = 'grok-4.5';
/**
 * Live voice-over MT model — all quality profiles (fast/balanced/max) use this
 * on the hot path. "max" quality = richer prompts + glossary, NOT flagship RTT.
 *
 * IMPORTANT (2026-05-15): grok-4-1-fast / grok-4-*-fast-* were retired and
 * redirected. Ambiguous slug "grok-4-1-fast" could hit reasoning defaults →
 * 6–12s MT. Live always uses grok-4.3 + reasoning_effort=none (see client.js).
 */
export const FAST_TRANSLATE_MODEL = 'grok-4.3';
/** Alias: live always pins to non-reasoning 4.3 */
export const LIVE_TRANSLATE_MODEL = FAST_TRANSLATE_MODEL;

/** Capture / chunking tuned for low start latency + continuous dubbing */
export const AUDIO = {
  sampleRate: 16000,
  channels: 1,
  /**
   * Rolling STT window (seconds).
   * Shorter = less wait before STT starts (main lever for real-time feel).
   * Overlap + silence flush keep words from dropping.
   *
   * IMPORTANT: when end-to-end API latency is already high, shorter windows
   * create MORE requests and make lag worse. See lagShed* + #chunkSec().
   */
  liveChunkSec: 1.25,
  /** @deprecated old capture-scan VOD; new path uses DEFAULT_SETTINGS.vodChunkSec */
  vodChunkSec: 10,
  /** Overlap so words on boundaries are not lost */
  chunkOverlapSec: 0.22,
  /** Max silence after speech before forcing STT flush (end-of-utterance) */
  silenceFlushSec: 0.4,
  /** Minimum buffered speech before silence can flush (avoid tiny noise clips) */
  minSpeechSecBeforeFlush: 0.45,
  /** How often health checks run */
  healthIntervalMs: 4000,
  /**
   * No capture samples while media is playing → degraded + auto-recover.
   * Silence alone is NOT a stall (quiet segments used to thrash recover).
   */
  stallTimeoutMs: 12000,
  /** In-flight STT/MT/TTS stuck this long → drop + recover (SW/network hang) */
  inflightTimeoutMs: 20000,
  /** Local Whisper/Piper cold path — HealthMonitor must not fire at 20s */
  localInflightTimeoutMs: 100000,
  /**
   * Soft max concurrent STT→MT→TTS pipelines.
   * 2 is ok when healthy; hard lag forces 1 via lagShedMaxBusy.
   */
  maxBusyChunks: 2,
  /** Soft max queue of pending TTS phrases (lower = less "talking about the past") */
  maxTtsQueue: 3,
  /** Auto-recover debounce / backoff */
  recoverMinDelayMs: 800,
  recoverMaxDelayMs: 20000,
  /**
   * After this many auto-recovers without a successful phrase, stop thrashing
   * and surface a hard error (user must toggle translation).
   */
  recoverMaxAttempts: 6,
  /**
   * When end-to-end phrase latency EMA exceeds this (ms), speed up TTS slightly.
   * Mild lag: keep windows, boost speed, compact MT.
   * Lowered so max-profile users shed fat MT before the 13s death spiral.
   */
  lagBoostLatencyMs: 2800,
  /**
   * Hard lag shed: single in-flight slot, only latest audio, ultra-compact MT,
   * slightly LONGER chunks (fewer API round-trips), drop mid-flight if superseded.
   * This is the main fix for 8–15s "ping" death spiral.
   */
  lagShedLatencyMs: 4500,
  /** Extreme lag — drop MT/TTS after STT if a fresher chunk is waiting */
  lagDropStaleMs: 6500,
  /** Under lagShed, never run more than this many concurrent pipelines */
  lagShedMaxBusy: 1,
  /** Max adaptive TTS speed under lag (1.0 = normal) */
  maxAdaptiveTtsSpeed: 1.28,
  /** Gapless: start next phrase this many ms before previous ends when queue non-empty */
  phraseOverlapMs: 100,
  /**
   * Streaming STT: PCM frame size (seconds) pushed over Port → WS.
   * ~100 ms matches xAI guidance for real-time-paced chunks.
   */
  streamFrameSec: 0.1,
  /** STT WS endpointing silence (ms) before speech_final */
  streamEndpointingMs: 180,
  /** Smart Turn confidence (0–1); lower = snappier end-of-turn */
  streamSmartTurn: 0.5,
  /** Max silence ms before force speech_final when smart_turn is on */
  streamSmartTurnTimeoutMs: 900,
  /** Min clause chars for partial MT peel */
  streamMinClauseChars: 10,
};

/** Default local gateway (STT+TTS+chat proxy). LM Studio stays on :1234. */
export const LOCAL_GATEWAY_BASE = 'http://127.0.0.1:8788/v1';
export const LOCAL_AUTH_TOKEN = 'local';
/** Chrome/Edge Native Messaging host (tools/local-voice-gateway) */
export const LOCAL_GATEWAY_NATIVE_HOST = 'com.aethervox.local_gateway';

export const DEFAULT_SETTINGS = {
  xaiApiKey: '',
  /**
   * local — STT/MT/TTS via local gateway (zero-censorship, no xAI key)
   * xai   — cloud api.x.ai (may refuse / filter)
   */
  providerMode: 'local',
  /** OpenAI/xAI-compatible root ending in /v1 */
  localBaseUrl: LOCAL_GATEWAY_BASE,
  /** Chat model id — leave default; gateway auto-picks loaded abliterated model */
  lmStudioModel: 'auto',
  /** LM Studio OpenAI server (gateway proxies chat here) */
  lmStudioBaseUrl: 'http://127.0.0.1:1234/v1',
  sourceLang: 'auto',
  targetLang: 'ru',
  favoriteTargetLangs: ['ru', 'en', 'uk', 'kk', 'ja', 'zh', 'ko', 'de', 'fr', 'es'],
  /** Prefer live/natural Grok voices (ara/carina/…) over classic robot-neural */
  preferNaturalVoice: true,
  /** Default: Ara — warm conversational (falls back to eve if unavailable) */
  voiceId: 'ara',
  /**
   * Auto-pick TTS by original speaker voice type + gender
   * (bass/baritone/tenor/alto/mezzo/soprano from pitch + spectrum).
   * Avoids ♂/♀ mismatch and matches register as closely as possible.
   * Session-only override; does not permanently overwrite voiceId.
   */
  autoMatchVoiceGender: true,
  /** Preferred female TTS when auto-match is on */
  voiceIdFemale: 'ara',
  /** Preferred male TTS when auto-match is on */
  voiceIdMale: 'orion',
  /** Light speech tags / pauses for more human prosody */
  expressiveSpeech: true,
  /**
   * Base TTS rate. Pipeline may raise this slightly under lag (see AUDIO.maxAdaptiveTtsSpeed).
   * 1.05 default = slightly snappier dubbing without chipmunk effect.
   */
  ttsSpeed: 1.05,
  originalVolume: 0.15,
  translationVolume: 1,
  duckOriginal: true,
  linkToVideoVolume: true,
  autoTranslate: false,
  autoSubtitles: true,
  showOriginalSubs: true,
  showTranslatedSubs: true,
  subtitlesStyle: {
    fontSize: 18,
    fontFamily: 'Segoe UI, system-ui, sans-serif',
    color: '#ffffff',
    background: 'rgba(0,0,0,0.62)',
    position: 'bottom',
    maxWidthPct: 88,
  },
  /**
   * auto — live streams → realtime pipeline; regular videos → VOD prepare
   * live — always realtime (STT stream + MT + TTS)
   * vod  — offline: extract audio (yt-dlp browser analog) → 10s chunks → xAI bank
   */
  mode: 'auto',
  /** Fixed timeline slice for VOD STT (seconds) */
  vodChunkSec: 10,
  /** Overlap between VOD slices for edge words (seconds) */
  vodChunkOverlapSec: 0.35,
  /** Prefer processing this many seconds ahead of playhead */
  vodLookaheadSec: 90,
  /** Parallel STT jobs for VOD extract path */
  vodSttConcurrency: 3,
  /** Parallel MT+TTS jobs for VOD */
  vodMtTtsConcurrency: 3,
  /** Hard-mute original tab audio while VOD dubbing runs */
  vodMuteOriginal: true,
  /**
   * false (default) — wait until ALL chunks done before unlock (full bank).
   * true — after first chunk ready, can play; rest prepares in background.
   */
  vodProgressive: false,
  /**
   * Min prepared coverage from start (or playhead) before unlock when progressive.
   * 0 = unlock as soon as first chunk with audio (or completed index 0).
   */
  vodMinBufferSec: 0,
  /**
   * Auto-pause video when playhead is about to leave prepared bank
   * (avoids silence while next chunks still cooking).
   */
  vodPauseOnBufferHole: true,
  /**
   * fast     — min latency (live feel)
   * balanced — default: short chunks + pure target language + rare learning
   * max      — quality first (longer windows, repair pass, more learning)
   */
  /** Prefer balanced (fast MT model + solid prompt). Use max only offline/hard pairs. */
  qualityProfile: 'balanced',
  skipIfSourceIsTarget: true,
  blockedSourceLangs: [],
  hotkeysEnabled: true,
  notifyOnError: true,
  notifyOnRecover: true,
  contextAware: true,
  domainHints: true,
  glossary: [], // [{from, to, note?}]
  /** Words that must not be translated (brands, names, code) — also auto-learned */
  exceptions: [], // string[] or {word, reason?}
  keyterms: [], // bias STT
  maxHistoryPhrases: 5,
  showOverlayButton: true,
  debugLogs: false,
  /** Self-learning: improve glossary/exceptions over time (never blocks TTS) */
  selfLearning: true,
  /**
   * Occasional Grok review pass (extra tokens + latency).
   * Off by default — pure live path first; enable in options if you want.
   */
  deepLearning: false,
  /** Auto re-translate recent phrases when learning revision jumps */
  autoUpdateStaleTranslations: true,
  /** Under lag, auto-raise TTS speed toward AUDIO.maxAdaptiveTtsSpeed */
  adaptiveTtsSpeed: true,
  /** Prefer continuous voice-over (overlap / soft interrupt) over strict timeline wait */
  continuousDubbing: true,
  /**
   * Token spend mode for MT (chat):
   *   glyphpack — PRIMARY: pack rules/glossary/history into dense PNG (Claude-plugin-style
   *               image-token economy). Auto-falls back to standard on failures.
   *   standard  — classic optimized text prompts only (backup path).
   *   auto      — glyph when context stack is fat enough, else ultra text.
   */
  /**
   * Live default: standard text MT (glyph vision adds RTT). Glyph still available
   * via options for fat offline glossaries.
   */
  tokenEconomyMode: 'standard',
  /**
   * Partial TTS: split long translations into sentences and speak the first unit ASAP
   * while remaining units queue (lowers first-audio latency).
   */
  partialSentenceTts: true,
  /**
   * Low-latency streaming pipeline (target ~1.5–3s first-audio):
   *   STT WebSocket + partial MT by clauses + TTS WebSocket.
   * Falls back to REST chunks if WS fails (auth / network / SW kill).
   */
  streamingPipeline: true,
  /** Use TTS WebSocket (else REST TTS even when streaming STT is on) */
  streamingTts: true,
  /** Partial MT as soon as STT peels a complete clause (before full utterance) */
  partialClauseMt: true,
  /** Prompt for API key when missing (popup + overlay modal). Off in local mode. */
  promptApiKey: false,

  /**
   * Network path for api.x.ai (RU / blocked regions).
   * auto   — direct first (system VPN untouched), then relay, then SOCKS/HTTP; min RTT
   * direct — only api.x.ai (uses OS VPN/proxy if already on)
   * relay  — HTTPS reverse-proxy base (does not touch browser proxy settings)
   * proxy  — PAC only for api.x.ai / *.x.ai (never whole browser)
   */
  networkMode: 'auto',
  /** Single reverse-proxy base, e.g. https://my-worker.example.workers.dev/v1 */
  apiRelayBase: '',
  /** Extra relays, one URL per line (optional) */
  apiRelayList: '',
  /** Primary browser proxy (used when mode=proxy or as auto candidate) */
  proxyType: 'socks5', // socks5 | socks4 | http | https
  proxyHost: '',
  proxyPort: 1080,
  proxyUser: '',
  proxyPass: '',
  /**
   * Extra proxies, one per line (race for lowest RTT):
   * socks5://host:1080
   * socks5://user:pass@host:1080
   * http://host:8080
   * host:1080
   */
  proxyList: '',
  /** In auto mode prefer direct if RTT ≤ this (ms) — keeps system VPN path when good */
  preferDirectMaxMs: 900,
};

export const MSG = {
  GET_SETTINGS: 'GET_SETTINGS',
  SET_SETTINGS: 'SET_SETTINGS',
  SETTINGS_CHANGED: 'SETTINGS_CHANGED',
  PING: 'PING',
  TOGGLE_TRANSLATION: 'TOGGLE_TRANSLATION',
  TOGGLE_SUBTITLES: 'TOGGLE_SUBTITLES',
  TOGGLE_ORIGINAL_MUTE: 'TOGGLE_ORIGINAL_MUTE',
  CYCLE_TARGET_LANG: 'CYCLE_TARGET_LANG',
  START_SESSION: 'START_SESSION',
  STOP_SESSION: 'STOP_SESSION',
  SESSION_STATUS: 'SESSION_STATUS',
  PIPELINE_EVENT: 'PIPELINE_EVENT',
  XAI_STT: 'XAI_STT',
  XAI_TTS: 'XAI_TTS',
  XAI_TRANSLATE: 'XAI_TRANSLATE',
  XAI_VALIDATE_KEY: 'XAI_VALIDATE_KEY',
  LOCAL_VALIDATE: 'LOCAL_VALIDATE',
  ENSURE_LOCAL_GATEWAY: 'ENSURE_LOCAL_GATEWAY',
  ENSURE_OFFSCREEN: 'ENSURE_OFFSCREEN',
  OFFSCREEN_READY: 'OFFSCREEN_READY',
  /** Play TTS via offscreen (content-script Audio.play is often blocked) */
  PLAY_TTS_CHUNK: 'PLAY_TTS_CHUNK',
  STOP_TTS_PLAYBACK: 'STOP_TTS_PLAYBACK',
  EXPORT_SUBS: 'EXPORT_SUBS',
  GET_ACTIVE_TAB_STATE: 'GET_ACTIVE_TAB_STATE',
  CONTENT_STATE: 'CONTENT_STATE',
  HEALTH_ALERT: 'HEALTH_ALERT',
  GET_LEARNING: 'GET_LEARNING',
  SET_LEARNING: 'SET_LEARNING',
  RESET_LEARNING: 'RESET_LEARNING',
  LEARN_PHRASE: 'LEARN_PHRASE',
  ADD_EXCEPTION: 'ADD_EXCEPTION',
  ADD_LEARNED_TERM: 'ADD_LEARNED_TERM',
  XAI_LEARN_PASS: 'XAI_LEARN_PASS',
  LIST_VOICES: 'LIST_VOICES',
  SAVE_API_KEY: 'SAVE_API_KEY',
  RETRANSLATE_STALE: 'RETRANSLATE_STALE',
  NETWORK_PROBE: 'NETWORK_PROBE',
  NETWORK_APPLY: 'NETWORK_APPLY',
  NETWORK_STATUS: 'NETWORK_STATUS',
  TOKEN_ECONOMY_STATS: 'TOKEN_ECONOMY_STATS',
  TOKEN_ECONOMY_RESET: 'TOKEN_ECONOMY_RESET',
  /** Streaming STT/TTS readiness probe (optional) */
  STREAM_STATUS: 'STREAM_STATUS',
  /**
   * VOD media extract (yt-dlp browser analog): resolve + download audio,
   * decode offscreen, serve 10s WAV slices for xAI STT.
   */
  MEDIA_EXTRACT: 'MEDIA_EXTRACT',
  MEDIA_CHUNK_WAV: 'MEDIA_CHUNK_WAV',
  MEDIA_JOB_STATUS: 'MEDIA_JOB_STATUS',
  MEDIA_JOB_ABORT: 'MEDIA_JOB_ABORT',
  /** Offscreen document: decode compressed audio → PCM meta */
  OFFSCREEN_DECODE_AUDIO: 'OFFSCREEN_DECODE_AUDIO',
  /** SW injects page-bridge.js into MAIN world (Trusted Types safe) */
  INJECT_PAGE_BRIDGE: 'INJECT_PAGE_BRIDGE',
  /** Install DNR User-Agent rewrite for Innertube / googlevideo */
  ENSURE_YT_CLIENT_UA: 'ENSURE_YT_CLIENT_UA',
};

export const STORAGE_KEYS = {
  settings: 'aethervox_settings',
  sessionCache: 'aethervox_session_cache',
  learning: 'aethervox_learning',
  availableVoices: 'aethervox_available_voices',
};
