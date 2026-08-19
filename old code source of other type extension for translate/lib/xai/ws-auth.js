/**
 * Auth for xAI WebSocket (STT/TTS) — browser cannot set Authorization.
 *
 * Chrome limitation (critical):
 *   `new WebSocket()` has no headers API.
 *   declarativeNetRequest modifyHeaders does **not** apply to WebSocket
 *   upgrade requests in Chrome (Crbug 40815149 / extensions community).
 *   Relying on DNR Bearer alone produces:
 *     "HTTP Authentication failed; no valid credentials available"
 *
 * Working browser paths (in order of preference):
 *   1) Optional external/local relay: query `_av_key` → worker injects
 *      `Authorization: Bearer …` upstream (tools/xai-relay-*.js).
 *   2) Ephemeral client secret (REST mint) + Sec-WebSocket-Protocol
 *      `xai-client-secret.<value>` (documented for Realtime; also tried for
 *      STT/TTS — never put the long-lived API key in the protocol).
 *
 * Do NOT open a bare WebSocket on direct api.x.ai with only DNR Bearer —
 * Chrome ignores modifyHeaders on WS upgrades and logs the credentials error.
 * DNR rules may still be installed as best-effort alongside protocol.
 *
 * Never put the long-lived API key into Sec-WebSocket-Protocol on direct
 * api.x.ai — that surfaces the same "no valid credentials" error.
 */

import { log } from '../logger.js';
import { XAI_BASE } from '../constants.js';
import { normalizeRelayBase } from '../network/router.js';
import { looksLikeXaiRelay } from './auth-policy.js';

const RULE_ID_API = 917701;
const RULE_ID_API_ALT = 917703;
const RULE_ID_API_WSS = 917704;
const RULE_ID_RELAY = 917702;

/** All session rule ids we own (clear on key change / disable). */
export const WS_AUTH_RULE_IDS = [
  RULE_ID_API,
  RULE_ID_API_ALT,
  RULE_ID_API_WSS,
  RULE_ID_RELAY,
];

/** xAI-documented browser subprotocol prefix */
export const XAI_WS_PROTOCOL_PREFIX = 'xai-client-secret.';

/**
 * Built-in native local relay (tools/xai-relay-local.mjs).
 * Hardcoded loopback twin: browser WS cannot set Authorization, so when this
 * process is running the extension auto-routes streaming STT/TTS through it
 * (`_av_key` → Authorization) without Options setup.
 */
export const NATIVE_LOCAL_RELAY_BASE = 'http://127.0.0.1:8787/v1';

/** Default local twin candidates (probe order) */
export const LOCAL_RELAY_CANDIDATES = [
  NATIVE_LOCAL_RELAY_BASE,
  'http://localhost:8787/v1',
];

/**
 * Direct api.x.ai auth probe state: null unknown, true worked, false failed → REST.
 * Tracks protocol and/or DNR attempts under one flag (back-compat name).
 * Broken is NOT permanent — expires after DIRECT_AUTH_BROKEN_TTL_MS so a later
 * mint / network recovery can retry native protocol without SW restart.
 * @type {{ tts: boolean|null, stt: boolean|null }}
 */
const directDnrOk = { tts: null, stt: null };
/** @type {{ tts: number, stt: number }} */
const directBrokenAt = { tts: 0, stt: 0 };
/** Re-probe native WS after this while marked broken (ms). */
export const DIRECT_AUTH_BROKEN_TTL_MS = 120_000;

/** @type {{ at: number, base: string }} */
let localRelayCache = { at: 0, base: '' };
const LOCAL_RELAY_CACHE_MS = 45_000;

/** Last installed DNR key fingerprint (avoid thrashing rules). */
let dnrKeyFp = '';

/**
 * @param {'tts'|'stt'} kind
 * @returns {boolean|null}
 */
export function getDirectProtocolAuthState(kind) {
  const k = kind === 'stt' ? 'stt' : 'tts';
  if (directDnrOk[k] === false) {
    const age = Date.now() - (directBrokenAt[k] || 0);
    if (age >= DIRECT_AUTH_BROKEN_TTL_MS) {
      directDnrOk[k] = null;
      directBrokenAt[k] = 0;
      return null;
    }
  }
  return directDnrOk[k];
}

/**
 * @param {'tts'|'stt'} kind
 * @param {boolean} ok
 */
export function markDirectProtocolAuth(kind, ok) {
  const k = kind === 'stt' ? 'stt' : 'tts';
  directDnrOk[k] = !!ok;
  if (!ok) {
    directBrokenAt[k] = Date.now();
    log.info(
      `direct WS auth marked broken for ${k} — REST; re-probe in ~${Math.round(DIRECT_AUTH_BROKEN_TTL_MS / 1000)}s`,
    );
  } else {
    directBrokenAt[k] = 0;
  }
}

/**
 * Clear broken/ok probe so next stream can try native auth again.
 * @param {'tts'|'stt'|'all'} [kind]
 */
export function clearDirectProtocolAuth(kind = 'all') {
  if (kind === 'all' || kind === 'tts') {
    directDnrOk.tts = null;
    directBrokenAt.tts = 0;
  }
  if (kind === 'all' || kind === 'stt') {
    directDnrOk.stt = null;
    directBrokenAt.stt = 0;
  }
}

/** @param {'tts'|'stt'} kind */
export function isDirectProtocolAuthKnownBroken(kind) {
  return getDirectProtocolAuthState(kind) === false;
}

/** @param {'tts'|'stt'} kind */
export function isDirectProtocolAuthKnownOk(kind) {
  return getDirectProtocolAuthState(kind) === true;
}

/** Test helper — reset DNR probe state */
export function _resetDirectProtocolAuthStateForTests() {
  directDnrOk.tts = null;
  directDnrOk.stt = null;
  directBrokenAt.tts = 0;
  directBrokenAt.stt = 0;
  localRelayCache = { at: 0, base: '' };
  dnrKeyFp = '';
}

/**
 * Pure native auth plan (no chrome / network). Used by stream hub + unit tests.
 *
 * @param {{
 *   viaRelay: boolean,
 *   apiKey: string,
 *   ephemeralSecret?: string|null,
 *   preferDnrOnly?: boolean,
 * }} opts
 * @returns {{
 *   ok: true,
 *   strategy: 'relay-query'|'protocol'|'dnr-bearer',
 *   token: string,
 *   installDnrToken?: string,
 *   mode: string,
 * } | { ok: false, error: string }}
 */
export function planNativeWsAuth(opts) {
  const apiKey = String(opts.apiKey || '').trim();
  if (opts.viaRelay) {
    if (!apiKey) return { ok: false, error: 'relay needs XAI_API_KEY for _av_key' };
    return {
      ok: true,
      strategy: 'relay-query',
      token: apiKey,
      mode: 'relay-key',
    };
  }
  if (opts.preferDnrOnly) {
    if (!apiKey) return { ok: false, error: 'DNR path needs XAI_API_KEY' };
    return {
      ok: true,
      strategy: 'dnr-bearer',
      token: apiKey,
      installDnrToken: apiKey,
      mode: 'dnr-key',
    };
  }
  const secret = String(opts.ephemeralSecret || '').trim();
  if (secret && secret === apiKey) {
    return {
      ok: false,
      error: 'refusing raw API key as protocol secret',
    };
  }
  if (secret && isEphemeralWsToken(secret, apiKey)) {
    // Native browser path: Sec-WebSocket-Protocol + best-effort DNR Bearer
    // with the same ephemeral (docs: token works as Bearer like API key).
    return {
      ok: true,
      strategy: 'protocol',
      token: secret,
      installDnrToken: secret,
      mode: 'ephemeral',
    };
  }
  if (apiKey) {
    return {
      ok: true,
      strategy: 'dnr-bearer',
      token: apiKey,
      installDnrToken: apiKey,
      mode: 'dnr-key',
    };
  }
  return {
    ok: false,
    error: 'need XAI_API_KEY (mint client_secret for native WS)',
  };
}

/**
 * @param {string} apiKey
 */
function keyFingerprint(apiKey) {
  const k = String(apiKey || '');
  if (!k) return '';
  return `${k.length}:${k.slice(0, 4)}…${k.slice(-3)}`;
}

/**
 * Best-effort discover tools/xai-relay-local.mjs (optional; not required).
 * @param {{ force?: boolean, candidates?: string[], timeoutMs?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function discoverLocalRelayBase(opts = {}) {
  const now = Date.now();
  if (
    !opts.force &&
    localRelayCache.at &&
    now - localRelayCache.at < LOCAL_RELAY_CACHE_MS
  ) {
    return localRelayCache.base || '';
  }
  const candidates = opts.candidates?.length
    ? opts.candidates
    : LOCAL_RELAY_CANDIDATES;
  const timeoutMs = Math.min(2000, Math.max(150, Number(opts.timeoutMs) || 450));

  for (const raw of candidates) {
    const base = normalizeRelayBase(raw) || String(raw || '').replace(/\/+$/, '');
    if (!base || /api\.x\.ai/i.test(base)) continue;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(`${base}/tts/voices`, {
        method: 'GET',
        signal: ctrl.signal,
        cache: 'no-store',
      });
      clearTimeout(timer);
      // Do NOT accept bare 404 / random listeners — require relay fingerprint.
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      if (looksLikeXaiRelay(res.status, body)) {
        localRelayCache = { at: now, base };
        log.info('auto-discovered local xAI relay', base);
        return base;
      }
    } catch {
      /* not running */
    }
  }
  localRelayCache = { at: now, base: '' };
  return '';
}

/**
 * Clamp + quantize TTS speed for WS query + connection reuse.
 * @param {unknown} speed
 * @param {number} [fallback=1.05]
 * @returns {number}
 */
export function quantizeTtsSpeed(speed, fallback = 1.05) {
  const n = Number(speed);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(Math.min(1.5, Math.max(0.7, n)) * 100) / 100;
}

/**
 * Pick HTTPS base for streaming STT/TTS WebSockets.
 * Native browser policy (hardcoded priority):
 *   1) User/CF relay (Options)
 *   2) Active REST base if it is already a non-api.x.ai relay
 *   3) Built-in local twin (NATIVE_LOCAL_RELAY_BASE / auto-discovered)
 *   4) Direct api.x.ai + ephemeral client_secret protocol
 *
 * Never rely on bare DNR Bearer for the open path (Chrome ignores WS headers).
 *
 * @param {{ activeBase?: string, relayBase?: string, localRelayBase?: string }} opts
 * @returns {{ base: string, viaRelay: boolean, relay: string, source: 'user-relay'|'active-relay'|'native-local'|'direct' }}
 */
export function pickStreamingWsBase(opts = {}) {
  const relayRaw = String(opts.relayBase || '').trim();
  const relay = relayRaw ? normalizeRelayBase(relayRaw) || relayRaw : '';
  if (relay && !/api\.x\.ai/i.test(relay)) {
    const base = relay.replace(/\/+$/, '');
    return { base, viaRelay: true, relay: base, source: 'user-relay' };
  }
  const active = String(opts.activeBase || '').trim().replace(/\/+$/, '');
  if (active && !/api\.x\.ai/i.test(active)) {
    const asRelay = (normalizeRelayBase(active) || active).replace(/\/+$/, '');
    return {
      base: asRelay,
      viaRelay: true,
      relay: asRelay,
      source: 'active-relay',
    };
  }
  const localRaw = String(opts.localRelayBase || '').trim();
  const local = localRaw ? normalizeRelayBase(localRaw) || localRaw : '';
  if (local && !/api\.x\.ai/i.test(local)) {
    const base = local.replace(/\/+$/, '');
    return {
      base,
      viaRelay: true,
      relay: base,
      source: 'native-local',
    };
  }
  const base = (active || XAI_BASE).replace(/\/+$/, '');
  return { base, viaRelay: false, relay: '', source: 'direct' };
}

/**
 * Resolve streaming route with native local-relay discovery baked in.
 * Call this instead of hand-rolling discover + pick in the SW.
 *
 * @param {{
 *   apiKey: string,
 *   relayBase?: string,
 *   activeBase?: string,
 *   forceLocalDiscover?: boolean,
 *   skipLocalDiscover?: boolean,
 * }} opts
 * @returns {Promise<{
 *   apiKey: string,
 *   relay: string,
 *   viaRelay: boolean,
 *   wsBase: string,
 *   source: string,
 *   localRelay: string,
 * }>}
 */
export async function resolveBrowserStreamingRoute(opts = {}) {
  const apiKey = String(opts.apiKey || '').trim();
  const relayBase = String(opts.relayBase || '').trim();
  const activeBase = String(opts.activeBase || '').trim();
  let localRelay = '';
  const needLocal =
    !opts.skipLocalDiscover &&
    (!relayBase || /api\.x\.ai/i.test(relayBase)) &&
    (!activeBase || /api\.x\.ai/i.test(activeBase) || !activeBase);
  // Always probe native local when direct would otherwise be used, or when forced
  // (e.g. after direct protocol auth failed → automatic failover to loopback twin).
  if (opts.forceLocalDiscover || needLocal) {
    try {
      localRelay =
        (await discoverLocalRelayBase({ force: !!opts.forceLocalDiscover })) ||
        '';
    } catch {
      localRelay = '';
    }
  }
  // localRelayBase carries the built-in twin when discover succeeds so
  // pickStreamingWsBase marks source=native-local (not user-relay).
  const picked = pickStreamingWsBase({
    activeBase,
    relayBase,
    localRelayBase: localRelay,
  });
  return {
    apiKey,
    relay: picked.relay || localRelay || '',
    viaRelay: picked.viaRelay,
    wsBase: picked.base,
    source: picked.source || (picked.viaRelay ? 'relay' : 'direct'),
    localRelay: localRelay || '',
  };
}

/**
 * @param {string} apiKey
 * @returns {string[] | undefined}
 */
export function buildWsAuthProtocols(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) return undefined;
  if (!/^[A-Za-z0-9._~+/=-]+$/.test(key)) {
    log.warn('token has chars unsafe for Sec-WebSocket-Protocol; use relay');
    return undefined;
  }
  return [`${XAI_WS_PROTOCOL_PREFIX}${key}`];
}

/**
 * @param {string} url
 */
export function isDirectXaiWsUrl(url) {
  try {
    const h = new URL(url).hostname;
    return h === 'api.x.ai';
  } catch {
    return false;
  }
}

/**
 * Pure builder for DNR session rules (unit-testable; no chrome API).
 * Injects Authorization on official api.x.ai WebSockets only.
 * NOTE: Chrome often ignores modifyHeaders for resourceType websocket.
 *
 * @param {string} apiKey
 * @returns {chrome.declarativeNetRequest.Rule[]}
 */
export function buildWsAuthDnrRules(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) return [];
  const value = key.startsWith('Bearer ') ? key : `Bearer ${key}`;
  /** @type {chrome.declarativeNetRequest.Rule[]} */
  const rules = [
    {
      id: RULE_ID_API_WSS,
      priority: 100,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          {
            header: 'Authorization',
            operation: 'set',
            value,
          },
        ],
      },
      condition: {
        // ||host/ matches wss://api.x.ai/... and https://api.x.ai/...
        urlFilter: '||api.x.ai/',
        resourceTypes: ['websocket'],
      },
    },
    // Mirror on legacy id so old clear lists stay consistent
    {
      id: RULE_ID_API,
      priority: 99,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          {
            header: 'Authorization',
            operation: 'set',
            value,
          },
        ],
      },
      condition: {
        urlFilter: '|wss://api.x.ai/',
        resourceTypes: ['websocket'],
      },
    },
  ];
  return rules;
}

/**
 * For non-api.x.ai relays: put key in query so worker can inject Authorization.
 * @param {string} url
 * @param {string} apiKey
 */
export function injectRelayWsAuthQuery(url, apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) return url;
  try {
    const u = new URL(url);
    if (isDirectXaiWsUrl(url)) return url;
    u.searchParams.set('_av_key', key);
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * True when prepared handshake has a workable **browser** auth path.
 *
 * Chrome cannot set Authorization on `new WebSocket()` and DNR
 * `modifyHeaders` does not apply to WebSocket upgrades — pure
 * `dnr-bearer` (API key, no Sec-WebSocket-Protocol) is therefore NOT ready
 * for a browser open. Opening it yields:
 *   "HTTP Authentication failed; no valid credentials available"
 *
 * Workable paths: ephemeral `xai-client-secret.*` protocol, or relay `_av_key`.
 *
 * @param {{ url: string, protocols?: string[], mode?: string }} prepared
 * @param {string} [apiKey]
 */
export function isPreparedWsAuthReady(prepared, apiKey = '') {
  if (!prepared?.url) return false;
  // Browser-viable: Sec-WebSocket-Protocol with ephemeral client secret
  if (prepared?.mode === 'protocol' && prepared?.protocols?.length) return true;
  if (prepared?.protocols?.length) return true;
  // Direct api.x.ai without protocol: DNR Bearer is not browser-workable
  if (isDirectXaiWsUrl(prepared.url)) {
    return false;
  }
  // Relay: worker injects Authorization from _av_key
  try {
    const u = new URL(prepared.url);
    if (u.searchParams.get('_av_key')) return true;
  } catch {
    /* ignore */
  }
  // Non-direct host with a key still counts (relay inject / local twin)
  return !!String(apiKey || '').trim();
}

/**
 * Build final WS URL + optional subprotocols for `new WebSocket(url, protocols?)`.
 *
 * Direct api.x.ai:
 *   - ephemeral token → mode `protocol` (Sec-WebSocket-Protocol)
 *   - long-lived API key → mode `dnr-bearer` (last resort; often ignored by Chrome)
 * Relay → `_av_key` query.
 *
 * @param {string} url
 * @param {string} token  handshake credential (ephemeral secret or API key)
 * @param {{ apiKey?: string, longLivedKey?: string, forceProtocol?: boolean, forceDnr?: boolean }} [opts]
 * @returns {{ url: string, protocols?: string[], mode: 'dnr-bearer'|'protocol'|'relay-query'|'none' }}
 */
export function prepareAuthenticatedWs(url, token, opts = {}) {
  const key = String(token || '').trim();
  if (!key) return { url, mode: 'none' };
  if (!isDirectXaiWsUrl(url)) {
    return {
      url: injectRelayWsAuthQuery(url, key),
      mode: 'relay-query',
    };
  }

  const longLived = String(
    opts.apiKey || opts.longLivedKey || '',
  ).trim();

  // Never put long-lived API key into Sec-WebSocket-Protocol
  if (longLived && key === longLived && !opts.forceProtocol) {
    return { url, mode: 'dnr-bearer' };
  }

  const ephemeral = isEphemeralWsToken(key, longLived || undefined);

  if (!opts.forceDnr && (opts.forceProtocol || ephemeral)) {
    // forceProtocol with raw API key is still refused unless token ≠ longLived
    if (longLived && key === longLived) {
      return { url, mode: 'dnr-bearer' };
    }
    const protocols = buildWsAuthProtocols(key);
    if (protocols) {
      return { url, protocols, mode: 'protocol' };
    }
  }

  // DNR last resort for long-lived (or when protocol build failed)
  return { url, mode: 'dnr-bearer' };
}

/**
 * Install built-in Authorization inject for wss://api.x.ai WebSockets.
 * Best-effort only — Chrome often does not apply modifyHeaders to WS upgrades.
 *
 * @param {string} [apiKey]
 * @param {{ relayBase?: string, force?: boolean }} [opts]
 */
export async function ensureWsAuthRules(apiKey = '', opts = {}) {
  const key = String(apiKey || '').trim();
  if (!key) {
    await clearWsAuthRules();
    dnrKeyFp = '';
    return { ok: false, rules: 0, mode: 'none' };
  }

  const fp = keyFingerprint(key);
  if (!opts.force && fp === dnrKeyFp && fp) {
    return { ok: true, rules: 2, mode: 'dnr-bearer', cached: true };
  }

  if (!chrome?.declarativeNetRequest?.updateSessionRules) {
    log.warn('DNR unavailable — streaming WS needs ephemeral protocol or relay');
    return { ok: false, rules: 0, mode: 'no-dnr' };
  }

  const addRules = buildWsAuthDnrRules(key);
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [...WS_AUTH_RULE_IDS],
      addRules,
    });
    dnrKeyFp = fp;
    log.debug('built-in WS DNR Authorization rules installed', {
      n: addRules.length,
    });
    return { ok: true, rules: addRules.length, mode: 'dnr-bearer' };
  } catch (e) {
    log.warn('DNR WS auth install failed', e?.message || e);
    dnrKeyFp = '';
    try {
      await clearWsAuthRules();
    } catch {
      /* ignore */
    }
    return { ok: false, rules: 0, mode: 'dnr-error', error: String(e?.message || e) };
  }
}

/**
 * True when token is an ephemeral client secret (not the long-lived API key).
 * @param {string} token
 * @param {string} [apiKey]
 */
export function isEphemeralWsToken(token, apiKey = '') {
  const t = String(token || '').trim();
  if (!t) return false;
  const key = String(apiKey || '').trim();
  if (key && t === key) return false;
  // Known mint prefixes (safe even without comparing to long-lived key)
  if (/^xai-realtime-client-secret[-.]/i.test(t)) return true;
  if (/^xai-client-secret[-.]/i.test(t)) return true;
  // Without a comparison key, do NOT treat arbitrary strings as ephemeral —
  // that would put a long-lived API key into Sec-WebSocket-Protocol.
  if (key && t !== key && t.length >= 24) return true;
  return false;
}

/**
 * Policy for browser WebSocket credentials (unit-testable).
 * - relay → full API key in `_av_key`
 * - direct + ephemeral → protocol token (preferred; Chrome WS has no headers)
 * - direct + API key only → dnr-key (last resort)
 * - never raw API key as protocol secret
 *
 * @param {{
 *   viaRelay: boolean,
 *   apiKey: string,
 *   ephemeralSecret?: string|null,
 *   preferDnr?: boolean,
 * }} opts
 * @returns {{ ok: true, token: string, mode: 'relay-key'|'dnr-key'|'ephemeral' }
 *   | { ok: false, error: string }}
 */
export function resolveBrowserWsCredential(opts) {
  const apiKey = String(opts.apiKey || '').trim();
  if (opts.viaRelay) {
    if (!apiKey) {
      return { ok: false, error: 'relay path needs API key for _av_key' };
    }
    return { ok: true, token: apiKey, mode: 'relay-key' };
  }

  const secret = String(opts.ephemeralSecret || '').trim();
  if (secret && secret === apiKey) {
    return {
      ok: false,
      error:
        'refusing raw API key as Sec-WebSocket-Protocol (mint ephemeral or use relay)',
    };
  }
  // Ephemeral protocol wins over DNR: Chrome does not reliably inject
  // Authorization on WebSocket upgrades via declarativeNetRequest.
  if (secret && isEphemeralWsToken(secret, apiKey)) {
    return { ok: true, token: secret, mode: 'ephemeral' };
  }

  if (apiKey) {
    // preferDnr=false without usable secret → still need a token for DNR/relay setup
    return { ok: true, token: apiKey, mode: 'dnr-key' };
  }
  return {
    ok: false,
    error: 'direct api.x.ai needs XAI_API_KEY (and preferably mint client_secret)',
  };
}

export async function clearWsAuthRules() {
  dnrKeyFp = '';
  if (!chrome?.declarativeNetRequest?.updateSessionRules) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [...WS_AUTH_RULE_IDS],
      addRules: [],
    });
  } catch {
    /* ignore */
  }
}
