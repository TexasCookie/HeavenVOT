import { MSG, LOCAL_AUTH_TOKEN, XAI_BASE, DEFAULT_SETTINGS } from '../lib/constants.js';
import {
  ensureLocalGateway,
  mapFetchError,
} from '../lib/local-gateway-host.js';
import { getSettings, setSettings, getCachedVoices, setCachedVoices } from '../lib/storage.js';
import { XaiClient, setClientLocalMode } from '../lib/xai/client.js';
import { translateWithGrok } from '../lib/xai/translate.js';
import {
  getTokenEconomyState,
  resetTokenEconomyState,
  forceResumeGlyph,
} from '../lib/xai/token-economy.js';
import { clearGlyphPackCache } from '../lib/xai/glyph-pack.js';
import { arrayBufferToBase64, base64ToArrayBuffer } from '../lib/pcm-utils.js';
import { log, setDebug } from '../lib/logger.js';
import {
  extractAudio,
  parseYoutubeVideoId,
  downloadUrl,
} from '../lib/media/audio-extractor.js';
import { isAllowedMediaStreamUrl } from '../lib/media/url-guard.js';
import { resolveYoutubeAudio } from '../lib/media/youtube-innertube.js';
import {
  ensureYoutubeClientUa,
  ANDROID_VR_UA,
} from '../lib/media/youtube-ua-dnr.js';
import { downloadYoutubeAudioViaYtdlp } from '../lib/media/ytdlp-gateway.js';
import {
  getLearning,
  saveLearning,
  updateLearning,
  resetLearning,
  learnFromPhrase,
  addException,
  addTerm,
  buildEffectiveGlossary,
  buildExceptionList,
  buildLearnMessages,
  parseLearnJson,
  applyLearningPayload,
  lookupPhrase,
} from '../lib/learning.js';
import {
  mergeVoiceCatalog,
  resolveVoiceId,
  naturalizeForTts,
  DEFAULT_NATURAL_VOICE,
  CLASSIC_FALLBACK_VOICE,
  resolveVoiceForGender,
} from '../lib/voices.js';
import {
  applyNetworkSettings,
  getActiveBaseUrl,
  getRouteStatus,
  invalidateRouteCache,
  normalizeRelayBase,
  probeEndpoint,
  selectBestRoute,
} from '../lib/network/router.js';
import { clearBrowserProxy } from '../lib/network/proxy.js';
import { attachStreamPortHandler } from '../lib/xai/stream-session.js';
import {
  clearDirectProtocolAuth,
  clearWsAuthRules,
  ensureWsAuthRules,
} from '../lib/xai/ws-auth.js';
import {
  ClientSecretPool,
  SECRET_ALARM_NAME,
  SECRET_ALARM_PERIOD_MIN,
} from '../lib/xai/client-secret-pool.js';
import { installNativeAuthProviders } from '../lib/xai/native-auth-provider.js';
import {
  networkRouteReusable,
  phraseCacheUsable,
} from '../lib/pipeline/live-policy.js';

const client = new XaiClient('');
let networkReady = null;

/** Hot-path STT: never block on full DNR/proxy probe (was hanging past content 20s). */
async function refreshClientForStt() {
  const s = await getSettingsCached();
  const isLocal =
    String(s?.providerMode || DEFAULT_SETTINGS.providerMode || 'local') ===
    'local';
  setClientLocalMode(isLocal);
  const key = isLocal
    ? LOCAL_AUTH_TOKEN
    : String(s?.xaiApiKey || lastKnownApiKey || '').trim();
  if (key) {
    if (!isLocal) lastKnownApiKey = key;
    client.setApiKey(key);
  } else if (!lastKnownApiKey) {
    client.setApiKey('');
  }
  try {
    await ensureNetwork(s || { xaiApiKey: key, providerMode: s?.providerMode }, {
      force: false,
      soft: true,
    });
  } catch (e) {
    log.debug('ensureNetwork soft in STT', e?.message || e);
  }
  return s;
}

/** @type {Map<string, { jobId: string, title?: string, videoId?: string }>} */
const mediaJobMeta = new Map();
let offscreenCreating = null;

async function ensureMediaOffscreen() {
  try {
    if (chrome.runtime.getContexts) {
      const existing = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [chrome.runtime.getURL('offscreen/media-decode.html')],
      });
      if (existing?.length) return true;
    }
  } catch {
    /* older API — try create anyway */
  }
  if (offscreenCreating) {
    await offscreenCreating;
    return true;
  }
  offscreenCreating = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen/media-decode.html',
        reasons: ['AUDIO_PLAYBACK', 'BLOBS'],
        justification:
          'Decode extracted VOD audio and slice 10s WAV chunks for xAI STT',
      });
      // Allow module + BroadcastChannel listener to bind
      await new Promise((r) => setTimeout(r, 250));
    } catch (e) {
      const msg = String(e?.message || e);
      // Already exists
      if (!/already exists|only a single/i.test(msg)) throw e;
    } finally {
      offscreenCreating = null;
    }
  })();
  await offscreenCreating;
  return true;
}

const MEDIA_BC = 'aethervox-offscreen-media';

/**
 * Talk to offscreen via BroadcastChannel (avoids nested runtime.sendMessage
 * from SW onMessage handlers — that path returned ChromeMethodBFE LOCK errors).
 * Falls back to runtime.sendMessage when BC unavailable.
 */
/** Coerce timeout — callers sometimes pass `{ timeoutMs }` by mistake (B15). */
function normalizeOffscreenTimeout(timeoutMs, fallback = 120000) {
  if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return timeoutMs;
  }
  const nested = Number(timeoutMs?.timeoutMs);
  if (Number.isFinite(nested) && nested > 0) return nested;
  return fallback;
}

function sendToOffscreen(message, timeoutMs = 120000) {
  const ms = normalizeOffscreenTimeout(timeoutMs, 120000);
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        bc?.close?.();
      } catch {
        /* ignore */
      }
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, error: `offscreen timeout ${ms}ms` });
    }, ms);

    let bc = null;
    try {
      bc = new BroadcastChannel(MEDIA_BC);
      const id = `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      bc.onmessage = (ev) => {
        const data = ev?.data;
        if (!data || data.channel !== MEDIA_BC) return;
        if (data.kind !== 'response' || data.id !== id) return;
        finish(data.payload ?? { ok: false, error: 'empty bc payload' });
      };
      bc.postMessage({
        channel: MEDIA_BC,
        kind: 'request',
        id,
        message,
      });
      return;
    } catch {
      /* fall through to runtime.sendMessage */
    }

    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          finish({
            ok: false,
            error: chrome.runtime.lastError.message,
          });
          return;
        }
        finish(response ?? { ok: false, error: 'empty offscreen response' });
      });
    } catch (e) {
      finish({ ok: false, error: String(e?.message || e) });
    }
  });
}

/** Zero-config browser WS auth: mint once, share across all stream ports. */
const clientSecretPool = new ClientSecretPool({
  getApiKey: async () => {
    const s = await getSettingsCached();
    return s.xaiApiKey || '';
  },
  mint: async (opts) => {
    await refreshClient({ forceNetwork: false });
    return client.createClientSecret({
      expiresSeconds: opts?.expiresSeconds || 3600,
    });
  },
});

/**
 * In-extension native relay stack (replaces mandatory local node relay):
 * onAuthRequired + DNR + client_secret warm + SW fetch TTS with Authorization.
 */
async function warmNativeAuthStack() {
  try {
    await installNativeAuthProviders({
      getApiKey: async () => {
        const s = await getSettingsCached();
        return s.xaiApiKey || '';
      },
      getBearerToken: async () => {
        const s = await getSettingsCached();
        const key = s.xaiApiKey || '';
        if (!key) return '';
        try {
          const snap = clientSecretPool.snapshot;
          if (snap.hasSecret && snap.ttlSec > 60) {
            const minted = await clientSecretPool.get({ forceRefresh: false });
            return minted?.value || key;
          }
        } catch {
          /* fall through to key */
        }
        return key;
      },
    });
  } catch (e) {
    log.debug('native auth stack', e?.message || e);
  }
}
/** Short-lived settings cache — every STT/MT/TTS used to hit chrome.storage */
let settingsCache = null;
let settingsCacheAt = 0;
const SETTINGS_CACHE_MS = 2500;

/**
 * @param {object} [settings]
 * @param {{ force?: boolean, soft?: boolean }} [opts]
 *   soft — stream Port open: skip multi-relay probe race (content openStt is 16s).
 */
async function ensureNetwork(settings, { force = false, soft = false } = {}) {
  const s = settings || (await getSettingsCached());
  // Reuse last route for all API calls — re-probe only on force / settings / startup
  if (!force && networkRouteReusable(networkReady)) {
    return networkReady;
  }
  try {
    networkReady = await applyNetworkSettings(s, {
      apiKey: s.xaiApiKey || '',
      // auto probes once on normal path; soft/stream never races dead relays
      forceProbe: soft ? false : force || s.networkMode === 'auto',
      soft: !!soft,
    });
  } catch (e) {
    log.warn('network apply failed', e?.message || e);
    await clearBrowserProxy().catch(() => {});
    networkReady = { ok: false, error: String(e?.message || e) };
  }
  return networkReady;
}

/** Last known good API key — chrome.storage LOCK must not wipe live client auth */
let lastKnownApiKey = '';

async function getSettingsCached({ force = false } = {}) {
  const now = Date.now();
  if (!force && settingsCache && now - settingsCacheAt < SETTINGS_CACHE_MS) {
    return settingsCache;
  }
  try {
    settingsCache = await getSettings();
    settingsCacheAt = now;
    if (settingsCache?.xaiApiKey) {
      lastKnownApiKey = String(settingsCache.xaiApiKey).trim();
    }
  } catch (e) {
    log.warn('getSettings failed', e?.message || e);
    // Keep previous cache if any; synthesize defaults + last key
    // (missing providerMode here made LIST_VOICES treat local as xAI → opaque errors)
    if (!settingsCache) {
      settingsCache = {
        ...DEFAULT_SETTINGS,
        xaiApiKey: lastKnownApiKey || DEFAULT_SETTINGS.xaiApiKey || '',
        debugLogs: false,
      };
    } else if (lastKnownApiKey && !settingsCache.xaiApiKey) {
      settingsCache = { ...settingsCache, xaiApiKey: lastKnownApiKey };
    }
    if (!settingsCache.providerMode) {
      settingsCache = {
        ...DEFAULT_SETTINGS,
        ...settingsCache,
        providerMode: DEFAULT_SETTINGS.providerMode || 'local',
      };
    }
    settingsCacheAt = now;
  }
  return settingsCache;
}

function invalidateSettingsCache() {
  settingsCache = null;
  settingsCacheAt = 0;
}

async function refreshClient({ forceNetwork = false, forceSettings = false } = {}) {
  const s = await getSettingsCached({ force: forceSettings });
  const isLocal =
    String(s?.providerMode || DEFAULT_SETTINGS.providerMode || 'local') ===
    'local';
  setClientLocalMode(isLocal);
  const key = isLocal
    ? LOCAL_AUTH_TOKEN
    : String(s?.xaiApiKey || lastKnownApiKey || '').trim();
  // Never clear a working in-memory key because storage briefly LOCK-failed
  if (key) {
    if (!isLocal) lastKnownApiKey = key;
    client.setApiKey(key);
    if (!isLocal) clientSecretPool.onApiKey(key);
  } else if (!lastKnownApiKey) {
    client.setApiKey('');
  }
  setDebug(!!s?.debugLogs);
  try {
    await ensureNetwork(s || { xaiApiKey: key, providerMode: s?.providerMode }, {
      force: forceNetwork,
    });
  } catch (e) {
    log.warn('ensureNetwork in refreshClient', e?.message || e);
  }
  // In-extension native auth (onAuthRequired + DNR) — skip for local gateway
  if (!isLocal) {
    await warmNativeAuthStack();
    try {
      await ensureWsAuthRules(key || lastKnownApiKey || '', { force: true });
    } catch (e) {
      log.debug('ws auth DNR install', e?.message || e);
    }
  }
  return s;
}

/** Pre-mint / refresh ephemeral secret so first WS open is free. */
async function warmClientSecret({ force = false } = {}) {
  const s = await getSettingsCached();
  if (!s.xaiApiKey) return { ok: false, error: 'no-key' };
  const r = await clientSecretPool.warm({ forceRefresh: force });
  // Successful mint → allow native protocol re-probe (clear sticky broken)
  if (r?.ok) clearDirectProtocolAuth('all');
  await warmNativeAuthStack();
  return r;
}

// Long-lived STT/TTS WebSocket sessions (content Port name: aethervox-stream)
attachStreamPortHandler({
  getApiKey: async () => {
    const s = await getSettingsCached();
    if (s.providerMode === 'local') return LOCAL_AUTH_TOKEN;
    return s.xaiApiKey || '';
  },
  getRelayBase: async () => {
    const s = await getSettingsCached();
    if (s.providerMode === 'local') {
      return String(s.localBaseUrl || '').replace(/\/+$/, '') || '';
    }
    let relay = normalizeRelayBase(s.apiRelayBase || '') || '';
    const active = getActiveBaseUrl() || '';
    if (!relay && active && !/api\.x\.ai/i.test(active)) {
      relay = normalizeRelayBase(active) || active;
    }
    return relay;
  },
  // Critical: cold SW had default api.x.ai base even when user uses relay;
  // REST messages call ensureNetwork, but Port WS previously did not.
  // soft:true — stream open must not wait sequential 2.8s×N probe timeouts
  // (that alone exceeded content "STT stream open timeout" 16s budget).
  ensureNetwork: async () => {
    const s = await getSettingsCached();
    return ensureNetwork(s, { force: false, soft: true });
  },
  // Default direct WS path: shared pool mint → Sec-WebSocket-Protocol
  // xai-client-secret.* (Chrome cannot set Authorization on WebSocket)
  createClientSecret: async (opts = {}) => {
    const s = await getSettingsCached();
    if (s.providerMode === 'local') {
      return { ok: false, error: 'local-mode-no-ws-secret' };
    }
    const r = await clientSecretPool.get({
      forceRefresh: !!opts.forceRefresh,
    });
    return r;
  },
  isLocalProvider: async () => {
    const s = await getSettingsCached();
    return s.providerMode === 'local';
  },
});

chrome.runtime.onInstalled.addListener(async (details) => {
  const s = await refreshClient({ forceNetwork: true });
  // One-time migrate default voice toward natural when upgrading
  if (details.reason === 'install' || details.reason === 'update') {
    if (s.preferNaturalVoice !== false && !s._userPickedVoice) {
      if (!s.voiceId || s.voiceId === 'eve') {
        await setSettings({
          voiceId: DEFAULT_NATURAL_VOICE,
          preferNaturalVoice: true,
          expressiveSpeech: true,
          selfLearning: true,
          _migratedNaturalVoice: true,
        });
      }
    }
  }
  // removeAll first — create() throws "duplicate id" on every extension update otherwise
  try {
    await chrome.contextMenus?.removeAll?.();
  } catch {
    /* ignore */
  }
  try {
    chrome.contextMenus?.create({
      id: 'aethervox-toggle',
      title: 'AetherVox: перевод вкл/выкл',
      contexts: ['page', 'video', 'audio'],
    });
  } catch (e) {
    log.debug('contextMenus.create', e?.message || e);
  }
  // Auto WS auth — no user relay step
  try {
    await chrome.alarms.create(SECRET_ALARM_NAME, {
      periodInMinutes: SECRET_ALARM_PERIOD_MIN,
    });
  } catch (e) {
    log.debug('secret alarm', e?.message || e);
  }
  warmClientSecret().catch(() => {});
  log.info('Installed', details.reason);
});

chrome.runtime.onStartup?.addListener(() => {
  refreshClient({ forceNetwork: true })
    .then(async (s) => {
      if (String(s?.providerMode || DEFAULT_SETTINGS.providerMode) === 'local') {
        ensureLocalGateway({
          baseUrl: s?.localBaseUrl || DEFAULT_SETTINGS.localBaseUrl,
        }).catch((e) => log.debug('startup gateway', e?.message || e));
      }
      return warmClientSecret();
    })
    .catch((e) => log.warn(e));
  try {
    chrome.alarms.create(SECRET_ALARM_NAME, {
      periodInMinutes: SECRET_ALARM_PERIOD_MIN,
    });
  } catch {
    /* ignore */
  }
});

chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'aethervox-toggle' && tab?.id) {
    chrome.tabs
      .sendMessage(tab.id, { type: MSG.TOGGLE_TRANSLATION })
      .catch(() => {});
  }
});

chrome.commands?.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const map = {
    'toggle-translation': MSG.TOGGLE_TRANSLATION,
    'toggle-subtitles': MSG.TOGGLE_SUBTITLES,
    'toggle-original-mute': MSG.TOGGLE_ORIGINAL_MUTE,
    'cycle-target-lang': MSG.CYCLE_TARGET_LANG,
  };
  const type = map[command];
  if (type) chrome.tabs.sendMessage(tab.id, { type }).catch(() => {});
});

chrome.alarms.create('aethervox-keepalive', { periodInMinutes: 1 });
try {
  chrome.alarms.create(SECRET_ALARM_NAME, {
    periodInMinutes: SECRET_ALARM_PERIOD_MIN,
  });
} catch {
  /* ignore */
}
chrome.alarms.onAlarm.addListener((alarm) => {
  /* keepalive: keeps SW warm enough for long sessions */
  if (alarm?.name === SECRET_ALARM_NAME) {
    warmClientSecret().catch(() => {});
    return;
  }
  // Opportunistic warm on keepalive if secret is missing/near expiry
  if (alarm?.name === 'aethervox-keepalive') {
    const snap = clientSecretPool.snapshot;
    if (!snap.hasSecret || snap.ttlSec < 300) {
      warmClientSecret().catch(() => {});
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const t = message?.type;
  // Offscreen document owns these — do not answer or we race sendResponse.
  if (
    t === 'OFFSCREEN_MEDIA_PREPARE' ||
    t === 'OFFSCREEN_MEDIA_CHUNK' ||
    t === 'OFFSCREEN_MEDIA_ABORT' ||
    t === 'OFFSCREEN_MEDIA_STATUS' ||
    t === 'OFFSCREEN_MEDIA_DOWNLOAD' ||
    t === 'OFFSCREEN_PLAY_TTS' ||
    t === 'OFFSCREEN_STOP_TTS' ||
    t === MSG.OFFSCREEN_DECODE_AUDIO
  ) {
    return false;
  }
  handleMessage(message, sender)
    .then((res) => sendResponse(res ?? { ok: true }))
    .catch((err) => {
      log.error(err);
      sendResponse({ ok: false, error: String(err?.message || err) });
    });
  return true;
});

async function broadcastSettings(settings) {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (t.id) {
      chrome.tabs
        .sendMessage(t.id, { type: MSG.SETTINGS_CHANGED, settings })
        .catch(() => {});
    }
  }
}

async function handleMessage(message, sender) {
  const type = message?.type;
  switch (type) {
    case MSG.PING:
      return { ok: true, pong: true };

    case MSG.INJECT_PAGE_BRIDGE: {
      try {
        const tabId = sender?.tab?.id;
        if (!tabId || !chrome.scripting?.executeScript) {
          return { ok: false, error: 'no tab / scripting' };
        }
        const frameId = sender?.frameId;
        const target =
          Number.isInteger(frameId) && frameId >= 0
            ? { tabId, frameIds: [frameId] }
            : { tabId, allFrames: true };
        // Clear MAIN-world guard so updated page-bridge can re-bind
        await chrome.scripting.executeScript({
          target,
          world: 'MAIN',
          func: () => {
            try {
              window.__AETHERVOX_PAGE_BRIDGE_VER__ = 0;
              window.__AETHERVOX_PAGE_BRIDGE__ = false;
            } catch {
              /* ignore */
            }
          },
        });
        await chrome.scripting.executeScript({
          target,
          files: ['content/page-bridge.js'],
          world: 'MAIN',
        });
        return { ok: true, via: 'scripting.MAIN', frameId: frameId ?? null };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    }

    case MSG.ENSURE_YT_CLIENT_UA: {
      const ua = message.userAgent || ANDROID_VR_UA;
      return ensureYoutubeClientUa(ua);
    }

    case MSG.ENSURE_OFFSCREEN:
      await ensureMediaOffscreen();
      return { ok: true };

    case MSG.OFFSCREEN_READY:
      return { ok: true };

    /**
     * Resolve + download audio (yt-dlp browser analog), decode in offscreen,
     * keep PCM job for MEDIA_CHUNK_WAV slices.
     */
    case MSG.MEDIA_EXTRACT: {
      try {
        // Fetch cannot set User-Agent — install DNR rewrite before resolve/download
        try {
          await ensureYoutubeClientUa(
            message.userAgent || ANDROID_VR_UA,
          );
        } catch (e) {
          log.debug('ENSURE_YT_CLIENT_UA', e?.message || e);
        }
        const pageUrl = message.pageUrl || message.url || '';
        const videoId =
          message.videoId || parseYoutubeVideoId(pageUrl) || undefined;
        const playerResponse = message.playerResponse || null;
        // Prefer pre-resolved stream from page MAIN world (SW innertube → 403)
        const preStreamUrl = message.streamUrl || null;
        const preMime = message.mime || null;
        const preDuration = Number(message.durationSec) || 0;
        const preTitle = message.title || '';
        const preSource = message.source || null;
        const preUserAgent = message.userAgent || null;

        let settings = {};
        try {
          settings = (await getSettingsCached()) || {};
        } catch (e) {
          log.warn('MEDIA_EXTRACT settings', e?.message || e);
        }
        const chunkSec = Number(message.chunkSec || settings.vodChunkSec || 10);
        const overlapSec = Number(
          message.overlapSec ?? settings.vodChunkOverlapSec ?? 0.35,
        );

        let streamUrl = preStreamUrl;
        if (streamUrl && !isAllowedMediaStreamUrl(streamUrl)) {
          return {
            ok: false,
            error: 'streamUrl host not allowed',
            stage: 'url_guard',
            videoId: videoId || null,
          };
        }
        let mime = preMime || 'audio/mp4';
        let durationSec = preDuration;
        let title = preTitle;
        let source = preSource || 'page-stream';
        let userAgent = preUserAgent || '';

        if (!streamUrl) {
          // Prefer local yt-dlp + extension cookies (Arc/Chrome bot-check immune)
          const ytdlpFirst = await downloadYoutubeAudioViaYtdlp({
            pageUrl,
            videoId,
          });
          if (ytdlpFirst?.ok && ytdlpFirst.streamUrl) {
            streamUrl = ytdlpFirst.streamUrl;
            mime = ytdlpFirst.mime || mime;
            durationSec = ytdlpFirst.durationSec || durationSec;
            title = ytdlpFirst.title || title;
            source = ytdlpFirst.source || 'yt-dlp-local';
            userAgent = '';
          }
        }

        if (!streamUrl) {
          let resolved;
          try {
            resolved = await resolveYoutubeAudio({
              pageUrl,
              videoId,
              playerResponse,
            });
          } catch (e) {
            resolved = {
              ok: false,
              error: `extract resolve: ${e?.message || e}`,
            };
          }

          if (resolved?.ok && !resolved.isLive && resolved.stream?.url) {
            streamUrl = resolved.stream?.url;
            mime = resolved.stream?.mime || mime;
            durationSec = resolved.durationSec || durationSec;
            title = resolved.title || title;
            source = resolved.source || source;
            userAgent = resolved.userAgent || userAgent;
          } else if (resolved?.isLive) {
            return {
              ok: false,
              error: resolved.reason || 'Live/HLS — режим Live',
              stage: 'live',
              videoId: resolved.videoId || videoId || null,
            };
          } else {
            return {
              ok: false,
              error:
                (resolved?.error || 'extract failed') +
                ' · yt-dlp недоступен — перезапусти local gateway (:8788) и Reload расширения (нужен cookies)',
              stage: 'resolve_unusable',
              videoId: videoId || null,
            };
          }
        }

        if (!streamUrl) {
          return {
            ok: false,
            error: 'no stream url',
            stage: 'no_url',
            videoId: videoId || null,
          };
        }
        if (!isAllowedMediaStreamUrl(streamUrl)) {
          return {
            ok: false,
            error: 'resolved streamUrl host not allowed',
            stage: 'url_guard',
            videoId: videoId || null,
          };
        }

        try {
          await ensureMediaOffscreen();
        } catch (e) {
          return {
            ok: false,
            error: `offscreen: ${e?.message || e}`,
            stage: 'offscreen_ensure',
          };
        }

        const jobId = `media_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

        // B19: prefer offscreen download+decode via streamUrl — avoids SW↔BC base64 of full file
        let prep = null;
        try {
          prep = await sendToOffscreen(
            {
              type: 'OFFSCREEN_MEDIA_PREPARE',
              jobId,
              streamUrl,
              referer: 'https://www.youtube.com/',
              userAgent: userAgent || undefined,
              mime,
              durationHint: durationSec || 0,
              chunkSec,
              overlapSec,
              title: title || '',
            },
            300000,
          );
        } catch (e) {
          prep = { ok: false, error: `prepare streamUrl: ${e?.message || e}` };
        }
        if (!prep?.ok) {
          // Fallback: SW download (+ B5 offscreen download on 403) then prepare via base64
          let audioAb = null;
          const isLocal =
            /127\.0\.0\.1|localhost/i.test(String(streamUrl || ''));
          try {
            audioAb = await downloadUrl(streamUrl, {
              referer: isLocal ? undefined : 'https://www.youtube.com/',
              userAgent: isLocal ? undefined : userAgent || undefined,
            });
          } catch (e) {
            const msg = String(e?.message || e);
            if (/HTTP 403|HTTP 401|HTTP 429/i.test(msg) && !isLocal) {
              // googlevideo PO-gate → yt-dlp local
              try {
                const ytdlp = await downloadYoutubeAudioViaYtdlp({
                  pageUrl,
                  videoId,
                });
                if (ytdlp?.ok && ytdlp.streamUrl) {
                  streamUrl = ytdlp.streamUrl;
                  mime = ytdlp.mime || mime;
                  durationSec = ytdlp.durationSec || durationSec;
                  title = ytdlp.title || title;
                  source = ytdlp.source || 'yt-dlp-local';
                  audioAb = await downloadUrl(streamUrl, {});
                }
              } catch {
                /* fall through */
              }
            }
            if (!audioAb && /HTTP 403|HTTP 401|HTTP 429/i.test(msg)) {
              try {
                const dl = await sendToOffscreen(
                  {
                    type: 'OFFSCREEN_MEDIA_DOWNLOAD',
                    streamUrl,
                    referer: isLocal
                      ? undefined
                      : 'https://www.youtube.com/',
                    userAgent: isLocal
                      ? undefined
                      : userAgent || undefined,
                  },
                  120000,
                );
                if (dl?.ok && dl.base64) {
                  audioAb = base64ToArrayBuffer(dl.base64);
                } else {
                  return {
                    ok: false,
                    error: `download: ${msg}; offscreen: ${dl?.error || prep?.error || 'fail'}`,
                    stage: 'download',
                  };
                }
              } catch (e2) {
                return {
                  ok: false,
                  error: `download: ${msg}; offscreen: ${e2?.message || e2}`,
                  stage: 'download',
                };
              }
            } else if (!audioAb) {
              return {
                ok: false,
                error: `download: ${msg}; prepare: ${prep?.error || ''}`,
                stage: 'download',
              };
            }
          }

          try {
            prep = await sendToOffscreen(
              {
                type: 'OFFSCREEN_MEDIA_PREPARE',
                jobId,
                base64: arrayBufferToBase64(audioAb),
                mime,
                durationHint: durationSec || 0,
                chunkSec,
                overlapSec,
                title: title || '',
              },
              300000,
            );
          } catch (e) {
            return {
              ok: false,
              error: `prepare: ${e?.message || e}`,
              stage: 'prepare_throw',
            };
          }
        }

        if (!prep?.ok) {
          return {
            ok: false,
            error: prep?.error || 'offscreen prepare failed',
            stage: 'prepare',
          };
        }

        mediaJobMeta.set(prep.jobId, {
          jobId: prep.jobId,
          title,
          videoId: videoId || null,
        });
        return {
          ok: true,
          jobId: prep.jobId,
          durationSec: prep.durationSec || durationSec,
          chunkCount: prep.chunkCount,
          chunkSec,
          overlapSec,
          title: title || '',
          videoId: videoId || null,
          provider: 'youtube',
          source,
          byteLength: prep.byteLength || 0,
          stage: 'done',
        };
      } catch (e) {
        return {
          ok: false,
          error: String(e?.message || e),
          stage: 'outer',
        };
      }
    }

    case MSG.MEDIA_CHUNK_WAV: {
      const jobId = message.jobId;
      const index = message.index;
      if (!jobId && jobId !== 0) {
        return { ok: false, error: 'jobId required' };
      }
      await ensureMediaOffscreen();
      const res = await sendToOffscreen(
        {
          type: 'OFFSCREEN_MEDIA_CHUNK',
          jobId,
          index,
        },
        60000,
      );
      return res;
    }

    case MSG.MEDIA_JOB_STATUS: {
      const jobId = message.jobId;
      await ensureMediaOffscreen();
      const res = await sendToOffscreen(
        { type: 'OFFSCREEN_MEDIA_STATUS', jobId },
        15000,
      );
      const meta = mediaJobMeta.get(jobId);
      return { ...res, meta: meta || null };
    }

    case MSG.MEDIA_JOB_ABORT: {
      const jobId = message.jobId;
      if (jobId) {
        await ensureMediaOffscreen().catch(() => {});
        await sendToOffscreen(
          { type: 'OFFSCREEN_MEDIA_ABORT', jobId },
          10000,
        ).catch(() => {});
        mediaJobMeta.delete(jobId);
      }
      return { ok: true };
    }

    /**
     * Play TTS from offscreen document (content-script Audio.play is often
     * blocked by autoplay policy → silent dubbing with only original audio).
     */
    case MSG.PLAY_TTS_CHUNK: {
      await ensureMediaOffscreen();
      const payload = message.payload || message;
      const res = await sendToOffscreen(
        {
          type: 'OFFSCREEN_PLAY_TTS',
          audioBase64: payload.audioBase64 || message.audioBase64,
          contentType:
            payload.contentType || message.contentType || 'audio/mpeg',
          volume:
            payload.volume != null
              ? payload.volume
              : message.volume != null
                ? message.volume
                : 1,
          playbackRate: payload.playbackRate || message.playbackRate || 1,
          offsetSec:
            payload.offsetSec != null
              ? payload.offsetSec
              : message.offsetSec != null
                ? message.offsetSec
                : 0,
        },
        30000,
      );
      return res;
    }

    case MSG.STOP_TTS_PLAYBACK: {
      await ensureMediaOffscreen().catch(() => {});
      const res = await sendToOffscreen(
        { type: 'OFFSCREEN_STOP_TTS' },
        10000,
      ).catch((e) => ({ ok: false, error: String(e?.message || e) }));
      return res || { ok: true };
    }

    case 'OPEN_OPTIONS':
      await chrome.runtime.openOptionsPage();
      return { ok: true };

    case MSG.GET_SETTINGS: {
      const settings = await getSettings();
      return { ok: true, settings };
    }

    case MSG.SET_SETTINGS: {
      const partial = message.partial || message.settings || {};
      const settings = await setSettings(partial);
      invalidateSettingsCache();
      settingsCache = settings;
      settingsCacheAt = Date.now();
      const isLocal = settings.providerMode === 'local';
      setClientLocalMode(isLocal);
      if (Object.prototype.hasOwnProperty.call(partial, 'xaiApiKey')) {
        lastKnownApiKey = String(partial.xaiApiKey || '').trim();
      }
      client.setApiKey(
        isLocal ? LOCAL_AUTH_TOKEN : settings.xaiApiKey || lastKnownApiKey || '',
      );
      setDebug(!!settings.debugLogs);
      const netKeys = [
        'networkMode',
        'apiRelayBase',
        'apiRelayList',
        'proxyType',
        'proxyHost',
        'proxyPort',
        'proxyUser',
        'proxyPass',
        'proxyList',
        'preferDirectMaxMs',
        'providerMode',
        'localBaseUrl',
      ];
      if (netKeys.some((k) => Object.prototype.hasOwnProperty.call(partial, k))) {
        invalidateRouteCache();
        networkReady = await applyNetworkSettings(settings, {
          apiKey: isLocal ? LOCAL_AUTH_TOKEN : settings.xaiApiKey || '',
          forceProbe: !isLocal && settings.networkMode === 'auto',
        });
      }
      await broadcastSettings(settings);
      return { ok: true, settings, network: networkReady };
    }

    case MSG.NETWORK_PROBE: {
      const settings = await getSettings();
      invalidateRouteCache();
      const route = await selectBestRoute(settings, {
        force: true,
        apiKey: message.apiKey || settings.xaiApiKey || '',
      });
      networkReady = route;
      return { ok: !!route.ok, route, status: getRouteStatus() };
    }

    case MSG.NETWORK_APPLY: {
      if (message.clearOnly) {
        await clearBrowserProxy();
        invalidateRouteCache();
        networkReady = null;
        return {
          ok: true,
          cleared: true,
          route: { kind: 'direct', label: 'PAC cleared · system VPN', baseUrl: 'https://api.x.ai/v1' },
        };
      }
      const settings = await getSettings();
      invalidateRouteCache();
      networkReady = await applyNetworkSettings(settings, {
        apiKey: settings.xaiApiKey || '',
        forceProbe: true,
      });
      return { ok: !!networkReady?.ok, route: networkReady, status: getRouteStatus() };
    }

    case MSG.NETWORK_STATUS: {
      return {
        ok: true,
        route: networkReady,
        status: getRouteStatus(),
        settings: {
          networkMode: (await getSettings()).networkMode,
        },
      };
    }

    case MSG.SAVE_API_KEY: {
      const key = String(message.apiKey || '').trim();
      if (!key) return { ok: false, error: 'Пустой ключ' };
      client.setApiKey(key);
      clientSecretPool.onApiKey(key);
      lastKnownApiKey = key;
      try {
        const r = await client.validateKey();
        let finalSettings = null;
        let storageOk = true;
        try {
          let settings = await setSettings({ xaiApiKey: key });
          invalidateSettingsCache();
          // cache voices for natural preference
          if (r.voices?.length) {
            await setCachedVoices(r.voices);
            const ids = r.voices.map((v) => v.voice_id || v.id).filter(Boolean);
            const preferred = resolveVoiceId(settings, ids);
            if (
              preferred !== settings.voiceId &&
              settings.preferNaturalVoice !== false
            ) {
              settings = await setSettings({ voiceId: preferred });
            }
          }
          finalSettings = await getSettings();
          invalidateSettingsCache();
          settingsCache = finalSettings;
          settingsCacheAt = Date.now();
          await broadcastSettings(finalSettings);
        } catch (storeErr) {
          storageOk = false;
          log.warn('SAVE_API_KEY storage', storeErr?.message || storeErr);
          // Key is live on client even if storage LOCK — keep session usable
          finalSettings = {
            ...(settingsCache || {}),
            xaiApiKey: key,
          };
          settingsCache = finalSettings;
          settingsCacheAt = Date.now();
        }
        // Immediately mint browser WS credential — no manual relay setup
        warmClientSecret({ force: true }).catch(() => {});
        return {
          ok: true,
          settings: finalSettings,
          voices: r.voices || [],
          storageOk,
        };
      } catch (e) {
        // Validation failed — still keep key in memory if format looks ok
        return { ok: false, error: e.message || String(e), keyHeld: !!lastKnownApiKey };
      }
    }

    case MSG.XAI_VALIDATE_KEY: {
      const key = message.apiKey;
      if (key) client.setApiKey(key);
      else await refreshClient();
      try {
        const r = await client.validateKey();
        if (r.voices?.length) await setCachedVoices(r.voices);
        return { ok: true, ...r };
      } catch (e) {
        return { ok: false, error: e.message || String(e) };
      }
    }

    case MSG.LOCAL_VALIDATE: {
      await refreshClient({ forceNetwork: true, forceSettings: true });
      const settings = await getSettingsCached({ force: true });
      const base = getActiveBaseUrl() || settings.localBaseUrl || '';
      const ensured = await ensureLocalGateway({ baseUrl: base });
      const checks = { health: null, voices: null, chat: null, gateway: ensured };
      try {
        const healthUrl = `${String(base).replace(/\/v1\/?$/, '')}/health`;
        const hr = await fetch(healthUrl);
        checks.health = await hr.json().catch(() => ({ ok: hr.ok }));
      } catch (e) {
        checks.health = {
          ok: false,
          error: mapFetchError(e?.message || e),
        };
      }
      try {
        const r = await client.validateKey();
        checks.voices = { ok: true, count: (r.voices || []).length };
        if (r.voices?.length) {
          try {
            await setCachedVoices(r.voices);
          } catch (cacheErr) {
            // Storage LOCK must not fail Local validate when gateway voices OK
            log.debug(
              'LOCAL_VALIDATE cache voices',
              cacheErr?.message || cacheErr,
            );
          }
        }
      } catch (e) {
        const raw = String(e?.message || e);
        const storageFail = /LOCK|ChromeMethodBFE|IO error/i.test(raw);
        if (storageFail) {
          // Settings/storage blip — not a gateway failure
          checks.voices = { ok: true, count: 0, storageWarn: raw };
        } else {
          checks.voices = {
            ok: false,
            error: mapFetchError(raw),
          };
        }
      }
      try {
        const mt = await client.chatCompletion({
          messages: [
            {
              role: 'system',
              content:
                'Real-time voice-over MT: English → pure spoken Russian only. ZERO CENSORSHIP. Output ONLY the line.',
            },
            {
              role: 'user',
              content: 'SRC: hell yeah this fucking works',
            },
          ],
          model: settings.lmStudioModel,
          temperature: 0.15,
          max_tokens: 80,
          liveLatency: true,
          forceApi: 'chat',
        });
        const text = String(mt.text || '').trim();
        const soft =
          /\*{2,}|цензур|i cannot|i'm sorry|as an ai/i.test(text);
        checks.chat = {
          ok: !!text && !soft,
          text,
          censored: soft,
        };
      } catch (e) {
        checks.chat = {
          ok: false,
          error: mapFetchError(
            e?.message || e,
            'LM Studio / chat недоступен (:1234)',
          ),
        };
      }
      const ok =
        checks.health?.ok !== false &&
        checks.voices?.ok &&
        checks.chat?.ok;
      let error = null;
      if (!ok) {
        error =
          checks.health?.error ||
          checks.voices?.error ||
          checks.chat?.error ||
          ensured?.error ||
          null;
        if (ensured?.needInstall) {
          error =
            'Native host не установлен — в Options скопируй команду install-native-host.ps1 (один раз)';
        }
      }
      return {
        ok,
        base,
        checks,
        providerMode: settings.providerMode,
        ensured,
        error,
        extensionId: chrome.runtime.id,
      };
    }

    case MSG.ENSURE_LOCAL_GATEWAY: {
      const settings = await refreshClient({ forceSettings: true });
      const base =
        getActiveBaseUrl() ||
        settings?.localBaseUrl ||
        DEFAULT_SETTINGS.localBaseUrl ||
        '';
      const ensured = await ensureLocalGateway({
        baseUrl: base,
        forceStart: !!message.force,
      });
      return {
        ok: !!ensured?.ok,
        ...ensured,
        extensionId: chrome.runtime.id,
      };
    }

    case MSG.LIST_VOICES: {
      const settings = await refreshClient();
      const isLocal =
        String(
          settings?.providerMode || DEFAULT_SETTINGS.providerMode || 'local',
        ) === 'local';
      const base =
        getActiveBaseUrl() ||
        settings?.localBaseUrl ||
        DEFAULT_SETTINGS.localBaseUrl ||
        '';
      const xaiKey = String(settings?.xaiApiKey || '').trim();
      try {
        let apiVoices = [];
        let source = 'none';

        if (isLocal) {
          // Probe first — avoid opaque "Failed to fetch" when gateway is down
          const probe = await probeEndpoint(base, LOCAL_AUTH_TOKEN, 1200);
          if (probe.ok) {
            apiVoices = await client.listVoices();
            source = 'local';
          } else if (xaiKey) {
            const xr = await fetch(`${XAI_BASE}/tts/voices`, {
              method: 'GET',
              headers: { Authorization: `Bearer ${xaiKey}` },
              cache: 'no-store',
            });
            if (!xr.ok) {
              throw new Error(`xAI voices HTTP ${xr.status}`);
            }
            const data = await xr.json().catch(() => ({}));
            apiVoices = data.voices || [];
            source = 'xai-fallback';
          } else {
            const cached = await getCachedVoices().catch(() => null);
            const catalog = mergeVoiceCatalog(cached?.voices || []);
            return {
              ok: true,
              voices: catalog,
              offline: true,
              notice: `шлюз офлайн (${base || 'http://127.0.0.1:8788/v1'})`,
              source: 'builtin-offline',
            };
          }
        } else if (client.apiKey) {
          apiVoices = await client.listVoices();
          source = 'xai';
        } else {
          const cached = await getCachedVoices().catch(() => null);
          apiVoices = cached?.voices || [];
          source = 'cache';
        }

        if (apiVoices.length) await setCachedVoices(apiVoices).catch(() => {});
        const catalog = mergeVoiceCatalog(apiVoices);
        return { ok: true, voices: catalog, raw: apiVoices, source };
      } catch (e) {
        const cached = await getCachedVoices().catch(() => null);
        const catalog = mergeVoiceCatalog(cached?.voices || []);
        const rawMsg = String(e?.message || e || '');
        const netFail =
          /failed to fetch|networkerror|load failed|fetch failed|aborted|network/i.test(
            rawMsg,
          );
        const storageFail = /LOCK|ChromeMethodBFE|IO error/i.test(rawMsg);
        // Local + net/storage fail: soft offline catalog (never raw TypeError)
        if (isLocal && (netFail || storageFail)) {
          return {
            ok: true,
            voices: catalog,
            offline: true,
            notice: `шлюз офлайн (${base || 'http://127.0.0.1:8788/v1'})`,
            source: 'builtin-offline',
          };
        }
        let error = rawMsg;
        if (netFail) {
          error = `сеть недоступна (${base || 'api.x.ai'}) — VPN/relay`;
        }
        return {
          ok: true,
          voices: catalog,
          error,
          partial: true,
          offline: netFail,
        };
      }
    }

    case MSG.GET_LEARNING: {
      const learning = await getLearning();
      return { ok: true, learning };
    }

    case MSG.SET_LEARNING: {
      const payload = message.learning || message.payload;
      if (!payload || typeof payload !== 'object') {
        return { ok: false, error: 'SET_LEARNING requires a full object' };
      }
      const learning = await updateLearning(() => payload);
      return { ok: true, learning };
    }

    case MSG.RESET_LEARNING: {
      const learning = await resetLearning();
      return { ok: true, learning };
    }

    case MSG.ADD_EXCEPTION: {
      let added = false;
      const learning = await updateLearning((mem) => {
        const r = addException(mem, message.word, message.reason || 'user');
        added = r.added;
        return r.learning;
      });
      // also mirror into settings.exceptions for visibility
      if (added) {
        const s = await getSettings();
        const list = [...(s.exceptions || [])];
        if (!list.some((w) => String(w).toLowerCase() === String(message.word).toLowerCase())) {
          list.push(message.word);
          const settings = await setSettings({ exceptions: list });
          await broadcastSettings(settings);
        }
      }
      return { ok: true, learning, added };
    }

    case MSG.ADD_LEARNED_TERM: {
      let added = false;
      const learning = await updateLearning((mem) => {
        const r = addTerm(mem, message.from, message.to, message.source || 'user');
        added = r.added;
        return r.learning;
      });
      return { ok: true, learning, added };
    }

    case MSG.LEARN_PHRASE: {
      const settings = await getSettings();
      if (settings.selfLearning === false) {
        return { ok: true, skipped: true };
      }
      const p = message.payload || {};
      let result = null;
      const learning = await updateLearning((mem) => {
        result = learnFromPhrase(mem, {
          sourceText: p.sourceText,
          translated: p.translated,
          sourceLang: p.sourceLang || settings.sourceLang,
          targetLang: p.targetLang || settings.targetLang,
          domain: p.domain || '',
          autoExceptions: true,
          autoGlossary: true,
        });
        return result.learning;
      });
      return {
        ok: true,
        revision: learning.revision,
        revisionBumped: result?.revisionBumped,
        newExceptions: result?.newExceptions,
        newTerms: result?.newTerms,
      };
    }

    case MSG.XAI_LEARN_PASS: {
      const settings = await getSettings();
      if (settings.selfLearning === false || settings.deepLearning === false) {
        return { ok: true, skipped: true };
      }
      await refreshClient();
      const isLocal = settings.providerMode === 'local';
      // Local: no xAI key required — refreshClient already set localMode + LOCAL_AUTH_TOKEN
      if (!isLocal && !String(settings.xaiApiKey || '').trim()) {
        return { ok: false, error: 'Нет XAI_API_KEY для deep-learn' };
      }
      const p = message.payload || {};
      const learnSource = isLocal ? 'local' : 'grok';
      const learnModel = isLocal
        ? settings.lmStudioModel || 'auto'
        : undefined;
      try {
        const messages = buildLearnMessages({
          sourceText: p.sourceText,
          translated: p.translated,
          targetLang: p.targetLang || settings.targetLang,
          context: p.context || {},
        });
        const chatOpts = {
          messages,
          temperature: 0.1,
          max_tokens: 400,
          liveLatency: false,
        };
        if (learnModel) {
          chatOpts.model = learnModel;
          chatOpts.forceApi = 'chat';
        }
        const { text } = await client.chatCompletion(chatOpts);
        const payload = parseLearnJson(text);
        if (!payload) return { ok: true, learned: false };

        let mem = await getLearning();
        const applied = applyLearningPayload(mem, payload, {
          source: learnSource,
        });
        mem = applied.learning;

        let better = payload.better || '';
        if (payload.wrong && better) {
          // store improved phrase
          const r = learnFromPhrase(mem, {
            sourceText: p.sourceText,
            translated: better,
            sourceLang: p.sourceLang || settings.sourceLang,
            targetLang: p.targetLang || settings.targetLang,
            domain: p.context?.domainHint || '',
          });
          mem = r.learning;
          await saveLearning(mem);
          return {
            ok: true,
            learned: true,
            better,
            terms: payload.terms,
            exceptions: payload.exceptions,
            revision: mem.revision,
            revisionBumped: true,
            providerMode: isLocal ? 'local' : 'xai',
          };
        }

        if (applied.changed) {
          await saveLearning(mem);
        }
        // also auto-exceptions list into settings when new
        if (payload.exceptions?.length) {
          const s = await getSettings();
          const list = [...(s.exceptions || [])];
          let ch = false;
          for (const w of payload.exceptions) {
            if (w && !list.some((x) => String(x).toLowerCase() === String(w).toLowerCase())) {
              list.push(w);
              ch = true;
            }
          }
          if (ch) {
            const settings2 = await setSettings({ exceptions: list });
            await broadcastSettings(settings2);
          }
        }
        return {
          ok: true,
          learned: applied.changed,
          better: '',
          terms: payload.terms,
          exceptions: payload.exceptions,
          revision: mem.revision,
          revisionBumped: applied.changed,
          providerMode: isLocal ? 'local' : 'xai',
        };
      } catch (e) {
        log.warn('learn pass failed', e.message);
        return { ok: false, error: e.message || String(e) };
      }
    }

    case MSG.XAI_STT: {
      const settingsForStt = await refreshClientForStt();
      const isLocal =
        String(settingsForStt?.providerMode || DEFAULT_SETTINGS.providerMode) ===
        'local';
      if (isLocal) {
        const base =
          String(settingsForStt?.localBaseUrl || 'http://127.0.0.1:8788/v1').replace(
            /\/+$/,
            '',
          );
        const ensured = await ensureLocalGateway({ baseUrl: base });
        if (!ensured?.ok) {
          return {
            ok: false,
            error:
              ensured?.error ||
              'Локальный gateway недоступен (127.0.0.1:8788) — запусти tools/local-voice-gateway',
            gatewayDown: true,
          };
        }
      }
      const { wavBase64, language, keyterms, format } = message.payload || {};
      if (!wavBase64) return { ok: false, error: 'empty audio' };
      const buf = base64ToArrayBuffer(wavBase64);
      const blob = new Blob([buf], { type: 'audio/wav' });
      const t0 = performance.now();
      try {
        const result = await client.speechToText(blob, {
          language,
          keyterms,
          format,
          filename: 'chunk.wav',
          // Local Whisper: long budget. xAI live: 8s. VOD sends payload.timeoutMs.
          timeoutMs: isLocal
            ? 90000
            : Number(message.payload?.timeoutMs) > 0
              ? Math.min(120000, Number(message.payload.timeoutMs))
              : 8000,
        });
        return {
          ok: true,
          text: result.text || '',
          language: result.language,
          duration: result.duration,
          words: result.words || [],
          latencyMs: Math.round(performance.now() - t0),
        };
      } catch (e) {
        notifyIfNeeded('STT error', e.message);
        return { ok: false, error: e.message || String(e) };
      }
    }

    case MSG.XAI_TRANSLATE: {
      await refreshClient();
      const settings = await getSettingsCached();
      const learning = await getLearning();
      const p = message.payload || {};
      const t0 = performance.now();

      const glossary = buildEffectiveGlossary(
        p.glossary || settings.glossary,
        settings.selfLearning !== false ? learning : null,
      );
      const exceptions = buildExceptionList(
        p.exceptions || settings.exceptions,
        settings.selfLearning !== false ? learning : null,
      );

      // Phrase memory hit → skip full Grok round-trip (huge live win on overlap/repeats)
      if (
        !p.forceRefresh &&
        p.allowCache !== false &&
        settings.selfLearning !== false
      ) {
        const hit = lookupPhrase(
          learning,
          p.text,
          p.sourceLang || settings.sourceLang,
          p.targetLang || settings.targetLang,
        );
        if (phraseCacheUsable(hit, learning.revision || 0)) {
          const text = String(hit.target || '').trim();
          return {
            ok: true,
            text,
            cached: true,
            domainHint: hit.domain || '',
            learningRevision: learning.revision || 0,
            latencyMs: Math.round(performance.now() - t0),
            model: 'cache',
          };
        }
      }

      try {
        // Live pipeline defaults liveLatency=true (fast model, no repair chain).
        // Offline retranslate may set liveLatency:false + forceFlagship.
        const liveLatency = p.liveLatency !== false;
        const isLocal = settings.providerMode === 'local';
        const result = await translateWithGrok(client, {
          ...p,
          glossary,
          exceptions,
          qualityProfile: p.qualityProfile || settings.qualityProfile,
          tokenEconomyMode: isLocal
            ? 'standard'
            : p.tokenEconomyMode || settings.tokenEconomyMode || 'glyphpack',
          liveLatency,
          allowRepair: p.allowRepair === true && !liveLatency,
          providerMode: isLocal ? 'local' : 'xai',
          localModel: isLocal ? settings.lmStudioModel : '',
        });
        // Phrase cache: NEVER block the MT response on chrome.storage write.
        // updateLearning serializes RMW so concurrent phrases don't clobber each other.
        if (result.text && settings.selfLearning !== false && p.text) {
          const src = p.text;
          const tgt = result.text;
          const domain = result.domainHint || p.context?.domainHint || '';
          const srcLang = p.sourceLang || settings.sourceLang;
          const tgtLang = p.targetLang || settings.targetLang;
          updateLearning((fresh) => {
            const learned = learnFromPhrase(fresh, {
              sourceText: src,
              translated: tgt,
              sourceLang: srcLang,
              targetLang: tgtLang,
              domain,
              autoExceptions: false,
              autoGlossary: false,
            });
            return learned.learning;
          }).catch((e) => log.debug('phrase cache store failed', e?.message || e));
        }
        return {
          ok: true,
          text: result.text,
          domainHint: result.domainHint,
          exceptionsApplied: result.exceptionsApplied,
          learningRevision: learning.revision || 0,
          latencyMs: Math.round(performance.now() - t0),
          model: result.model,
          cached: false,
          economyMode: result.economyMode || 'standard',
          economyFallback: !!result.economyFallback,
          economy: result.economy || null,
        };
      } catch (e) {
        notifyIfNeeded('Translate error', e.message);
        return { ok: false, error: e.message || String(e) };
      }
    }

    case MSG.TOKEN_ECONOMY_STATS: {
      return { ok: true, stats: getTokenEconomyState() };
    }

    case MSG.TOKEN_ECONOMY_RESET: {
      resetTokenEconomyState();
      clearGlyphPackCache();
      if (message.resumeGlyph) forceResumeGlyph();
      return { ok: true, stats: getTokenEconomyState() };
    }

    case MSG.STREAM_STATUS: {
      const s = await getSettingsCached();
      const isLocal = s.providerMode === 'local';
      return {
        ok: true,
        streamingPipeline: isLocal ? false : s.streamingPipeline !== false,
        streamingTts: isLocal ? false : s.streamingTts !== false,
        partialClauseMt: s.partialClauseMt !== false,
        hasKey: isLocal || !!s.xaiApiKey,
        providerMode: s.providerMode || 'xai',
        activeBase: getActiveBaseUrl(),
        localMode: isLocal,
      };
    }

    case MSG.RETRANSLATE_STALE: {
      await refreshClient();
      const settings = await getSettings();
      const learning = await getLearning();
      const items = message.payload?.items || [];
      const glossary = buildEffectiveGlossary(settings.glossary, learning);
      const exceptions = buildExceptionList(settings.exceptions, learning);
      const out = [];
      const isLocal = settings.providerMode === 'local';
      for (const item of items.slice(0, 6)) {
        try {
          const result = await translateWithGrok(client, {
            text: item.sourceText,
            sourceLang: item.sourceLang || settings.sourceLang,
            targetLang: item.targetLang || settings.targetLang,
            context: item.context || {},
            glossary,
            exceptions,
            history: item.history || [],
            qualityProfile: settings.qualityProfile,
            tokenEconomyMode: isLocal
              ? 'standard'
              : settings.tokenEconomyMode || 'glyphpack',
            // Background re-translate may use richer path but still not double-repair
            liveLatency: false,
            allowRepair: !isLocal && settings.qualityProfile === 'max',
            providerMode: isLocal ? 'local' : 'xai',
            localModel: isLocal ? settings.lmStudioModel : '',
          });
          const translated = result.text;
          if (translated && translated !== item.text) {
            const r = learnFromPhrase(learning, {
              sourceText: item.sourceText,
              translated,
              sourceLang: item.sourceLang || settings.sourceLang,
              targetLang: item.targetLang || settings.targetLang,
              domain: item.context?.domainHint || '',
            });
            Object.assign(learning, r.learning);
            learning.stats.retranslations = (learning.stats.retranslations || 0) + 1;
            out.push({
              id: item.id,
              sourceText: item.sourceText,
              text: translated,
              changed: true,
              learningRevision: learning.revision,
            });
          } else {
            out.push({
              id: item.id,
              sourceText: item.sourceText,
              text: item.text,
              changed: false,
              learningRevision: learning.revision,
            });
          }
        } catch (e) {
          out.push({ id: item.id, error: e.message, changed: false });
        }
      }
      await saveLearning(learning);
      return { ok: true, items: out, revision: learning.revision };
    }

    case MSG.XAI_TTS: {
      const settings = await refreshClient();
      const p = message.payload || {};
      const t0 = performance.now();
      const cached = await getCachedVoices();
      const availableIds = (cached?.voices || [])
        .map((v) => v.voice_id || v.id)
        .filter(Boolean);
      const genderHint =
        p.speaker_gender === 'female' || p.speaker_gender === 'male'
          ? p.speaker_gender
          : null;
      const typeHint = [
        'bass',
        'baritone',
        'tenor',
        'alto',
        'mezzo',
        'soprano',
      ].includes(p.speaker_voice_type)
        ? p.speaker_voice_type
        : null;
      const voiceId =
        genderHint || typeHint
          ? resolveVoiceForGender(
              {
                ...settings,
                voiceId: p.voice_id || settings.voiceId,
              },
              genderHint,
              availableIds.length ? availableIds : null,
              typeHint,
            )
          : resolveVoiceId(
              {
                voiceId: p.voice_id || settings.voiceId,
                preferNaturalVoice: settings.preferNaturalVoice,
              },
              availableIds.length ? availableIds : null,
            );
      const expressive = p.expressiveSpeech ?? settings.expressiveSpeech !== false;
      const text = naturalizeForTts(p.text, { expressiveSpeech: expressive });
      // xAI TTS accepts only 0|1 (was sending 2–4 → 400 silent-ish fails)
      const streamOpt =
        p.optimize_streaming_latency === 0 ||
        p.optimize_streaming_latency === '0'
          ? 0
          : 1;
      try {
        const { buffer, contentType, voice_id, fellBack } = await client.textToSpeech({
          text,
          voice_id: voiceId,
          language: p.language,
          speed: p.speed ?? settings.ttsSpeed ?? 1.0,
          optimize_streaming_latency: streamOpt,
          text_normalization: true,
          fallback_voices: [
            voiceId,
            DEFAULT_NATURAL_VOICE,
            'carina',
            'luna',
            CLASSIC_FALLBACK_VOICE,
            'sal',
          ],
        });
        // remember working voice if we fell back
        if (fellBack && voice_id && settings.preferNaturalVoice !== false) {
          // don't overwrite user pick permanently unless natural voice failed
          log.info('TTS fell back to', voice_id);
        }
        return {
          ok: true,
          audioBase64: arrayBufferToBase64(buffer),
          contentType,
          voice_id,
          fellBack: !!fellBack,
          latencyMs: Math.round(performance.now() - t0),
        };
      } catch (e) {
        notifyIfNeeded('TTS error', e.message);
        return { ok: false, error: e.message || String(e) };
      }
    }

    case MSG.HEALTH_ALERT: {
      const settings = await getSettings();
      if (settings.notifyOnError && message.level === 'error') {
        await showNotification(
          'AetherVox',
          message.message || 'Проблема с переводом',
        );
      }
      const okMsg = String(message.message || '');
      // Only toast VOD ready once via explicit kind — not every "готов" substring (B27)
      const vodReady = message.kind === 'vod_ready';
      if (
        message.level === 'ok' &&
        (settings.notifyOnRecover || vodReady)
      ) {
        await showNotification(
          'AetherVox',
          okMsg || 'Перевод восстановлен',
        );
      }
      return { ok: true };
    }

    case MSG.GET_ACTIVE_TAB_STATE: {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return { ok: false, error: 'no tab' };
      try {
        // Prefer the frame that owns a video / running pipeline.
        // Single sendMessage returns an arbitrary frame; probe all frames when API allows.
        let frames = null;
        try {
          if (chrome.webNavigation?.getAllFrames) {
            frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
          }
        } catch {
          frames = null;
        }
        if (frames?.length > 1) {
          const results = await Promise.all(
            frames.map(
              (f) =>
                new Promise((resolve) => {
                  try {
                    chrome.tabs.sendMessage(
                      tab.id,
                      { type: MSG.CONTENT_STATE },
                      { frameId: f.frameId },
                      (state) => {
                        if (chrome.runtime.lastError) {
                          resolve(null);
                          return;
                        }
                        resolve(state || null);
                      },
                    );
                  } catch {
                    resolve(null);
                  }
                }),
            ),
          );
          const ranked = results
            .filter((s) => s && (s.hasVideo || s.running || s.priority > 0))
            .sort((a, b) => (b.priority || 0) - (a.priority || 0));
          if (ranked[0]) {
            return { ok: true, tab, state: ranked[0] };
          }
        }
        const state = await chrome.tabs.sendMessage(tab.id, {
          type: MSG.CONTENT_STATE,
        });
        return { ok: true, tab, state };
      } catch (e) {
        return {
          ok: false,
          error: 'Контент-скрипт не ответил (обнови вкладку)',
          tab,
        };
      }
    }

    case MSG.CYCLE_TARGET_LANG: {
      return { ok: true };
    }

    default:
      if (sender?.tab?.id && message?.forward === false) {
        return { ok: true };
      }
      return { ok: false, error: `Unknown message ${type}` };
  }
}

/** Absolute icon URL — relative paths fail in SW with "Unable to download all specified images". */
function notificationIconUrl() {
  try {
    return chrome.runtime.getURL('assets/icons/icon128.png');
  } catch {
    return '';
  }
}

/**
 * chrome.notifications.create returns a Promise in modern Chrome; uncaught
 * rejections surface as: Uncaught (in promise) Error: Unable to download all specified images.
 */
async function showNotification(title, message) {
  if (!chrome.notifications?.create) return;
  const iconUrl = notificationIconUrl();
  const opts = {
    type: 'basic',
    title: String(title || 'AetherVox').slice(0, 120),
    message: String(message || '').slice(0, 180),
  };
  // iconUrl is required by some Chrome builds; omit only if resolve failed
  if (iconUrl) opts.iconUrl = iconUrl;
  try {
    await chrome.notifications.create(opts);
  } catch (e) {
    // Retry once without icon if icon fetch is the problem
    if (iconUrl && /download|image|icon/i.test(String(e?.message || e))) {
      try {
        const bare = { ...opts };
        delete bare.iconUrl;
        await chrome.notifications.create(bare);
        return;
      } catch {
        /* ignore */
      }
    }
    log.warn('notification failed', e?.message || e);
  }
}

async function notifyIfNeeded(title, msg) {
  const s = await getSettings();
  if (!s.notifyOnError) return;
  await showNotification(`AetherVox: ${title}`, msg);
}

// Preload settings + auto mint ephemeral WS secret (default path)
refreshClient()
  .then(async (s) => {
    if (String(s?.providerMode || DEFAULT_SETTINGS.providerMode) === 'local') {
      ensureLocalGateway({
        baseUrl: s?.localBaseUrl || DEFAULT_SETTINGS.localBaseUrl,
      }).catch((e) => log.debug('boot gateway ensure', e?.message || e));
    }
    return warmClientSecret();
  })
  .catch((e) => log.debug('boot warm', e?.message || e));
