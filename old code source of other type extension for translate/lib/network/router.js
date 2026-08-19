/**
 * Network router for xAI from restricted regions (e.g. RU).
 *
 * Goals:
 * 1) Prefer DIRECT so an already-enabled system VPN / OS proxy is used as-is
 * 2) Never hijack non-xAI traffic
 * 3) Pick lowest RTT among working paths (direct / relay / socks-http list)
 */

import { LOCAL_GATEWAY_BASE, XAI_BASE } from '../constants.js';
import { log } from '../logger.js';
import {
  applyBrowserProxyForXai,
  clearBrowserProxy,
  parseProxyList,
  parseProxyString,
  summarizeProxy,
} from './proxy.js';

const PROBE_PATH = '/tts/voices';
const CACHE_TTL_MS = 8 * 60 * 1000;
const PROBE_TIMEOUT_MS = 2800;

/** @type {null | {
 *   at: number,
 *   kind: 'direct'|'relay'|'proxy',
 *   baseUrl: string,
 *   rtt: number,
 *   proxy?: object|null,
 *   label?: string,
 * }} */
let routeCache = null;

/** @type {string} */
let activeBaseUrl = XAI_BASE;

export function getActiveBaseUrl() {
  return activeBaseUrl || XAI_BASE;
}

/**
 * Rewrite absolute xAI URL to current base (relay or direct).
 * @param {string} url
 * @param {string} [base]
 */
export function resolveXaiUrl(url, base = getActiveBaseUrl()) {
  const b = String(base || XAI_BASE).replace(/\/+$/, '');
  const u = String(url || '');
  // already under chosen base
  if (u.startsWith(b)) return u;
  // classic api.x.ai → swap origin+version root
  if (u.startsWith(XAI_BASE)) {
    return b + u.slice(XAI_BASE.length);
  }
  try {
    const parsed = new URL(u);
    if (parsed.hostname === 'api.x.ai' || parsed.hostname.endsWith('.x.ai')) {
      // map /v1/... onto relay base which already ends with /v1
      const path = parsed.pathname + parsed.search;
      const v1 = path.replace(/^\/v1/, '') || '';
      // if base is https://relay/v1 and path is /v1/stt → base + /stt
      if (path.startsWith('/v1')) {
        return b + path.slice(3);
      }
      return b + (v1.startsWith('/') ? v1 : `/${v1}`);
    }
  } catch {
    /* ignore */
  }
  return u;
}

/**
 * Build WebSocket URL for streaming STT/TTS under the active base.
 * https://api.x.ai/v1 → wss://api.x.ai/v1/stt?...
 * https://relay.example/v1 → wss://relay.example/v1/stt?...
 *
 * @param {string} pathAndQuery e.g. `/stt?sample_rate=16000` or `stt?...`
 * @param {string} [base]
 */
export function resolveXaiWsUrl(pathAndQuery, base = getActiveBaseUrl()) {
  const httpsBase = String(base || XAI_BASE).replace(/\/+$/, '');
  let path = String(pathAndQuery || '');
  if (!path.startsWith('/')) path = `/${path}`;
  // Avoid double /v1 if caller passes /v1/stt
  if (path.startsWith('/v1/')) path = path.slice(3);
  const httpUrl = resolveXaiUrl(`${httpsBase}${path}`, httpsBase);
  try {
    const u = new URL(httpUrl);
    u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
    return u.toString();
  } catch {
    return httpUrl
      .replace(/^https:/i, 'wss:')
      .replace(/^http:/i, 'ws:');
  }
}

/**
 * Normalize user relay base to .../v1
 * @param {string} raw
 */
export function normalizeRelayBase(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  s = s.replace(/\/+$/, '');
  // allow full https://host/v1 or https://host
  if (!/\/v1$/i.test(s)) {
    if (/\/v1\//i.test(s)) s = s.replace(/\/v1\/.*$/i, '/v1');
    else s = `${s}/v1`;
  }
  return s;
}

/**
 * @param {string} baseUrl
 * @param {string} [apiKey]
 * @param {number} [timeoutMs]
 * @returns {Promise<{ok:boolean,rtt:number,status?:number,error?:string}>}
 */
export async function probeEndpoint(baseUrl, apiKey = '', timeoutMs = PROBE_TIMEOUT_MS) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const url = `${base}${PROBE_PATH}`;
  const ctrl = new AbortController();
  const t0 = performance.now();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: ctrl.signal,
      cache: 'no-store',
    });
    const rtt = Math.round(performance.now() - t0);
    // 401/403 = network path works (auth issue still means reachable)
    if (res.ok || res.status === 401 || res.status === 403) {
      return { ok: true, rtt, status: res.status };
    }
    // 5xx / 429 — reachable but unhealthy
    if (res.status >= 500 || res.status === 429) {
      return { ok: true, rtt: rtt + 200, status: res.status, degraded: true };
    }
    return { ok: false, rtt, status: res.status, error: `HTTP ${res.status}` };
  } catch (e) {
    const rtt = Math.round(performance.now() - t0);
    return { ok: false, rtt, error: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Collect candidate routes from settings (order: direct, relays, proxies).
 * @param {object} settings
 */
export function buildCandidates(settings) {
  const mode = settings?.networkMode || 'auto';
  /** @type {Array<{kind:'direct'|'relay'|'proxy', baseUrl:string, proxy?:any, label:string}>} */
  const list = [];

  const relays = [];
  const customRelay = normalizeRelayBase(settings?.apiRelayBase || '');
  if (customRelay) relays.push(customRelay);
  // optional multi-line relays
  const extraRelays = String(settings?.apiRelayList || '')
    .split(/\r?\n/)
    .map((x) => normalizeRelayBase(x))
    .filter(Boolean);
  for (const r of extraRelays) {
    if (!relays.includes(r)) relays.push(r);
  }

  const proxies = [];
  if (settings?.proxyHost && settings?.proxyPort) {
    const one = parseProxyString(
      `${settings.proxyType || 'socks5'}://${
        settings.proxyUser
          ? `${encodeURIComponent(settings.proxyUser)}:${encodeURIComponent(settings.proxyPass || '')}@`
          : ''
      }${settings.proxyHost}:${settings.proxyPort}`,
    );
    if (one) proxies.push(one);
  }
  for (const p of parseProxyList(settings?.proxyList || '')) {
    proxies.push(p);
  }

  if (mode === 'direct') {
    list.push({ kind: 'direct', baseUrl: XAI_BASE, label: 'direct api.x.ai' });
    return list;
  }
  if (mode === 'relay') {
    for (const r of relays) {
      list.push({ kind: 'relay', baseUrl: r, label: `relay ${r}` });
    }
    if (!list.length) {
      list.push({ kind: 'direct', baseUrl: XAI_BASE, label: 'direct (no relay set)' });
    }
    return list;
  }
  if (mode === 'proxy') {
    for (const p of proxies) {
      list.push({
        kind: 'proxy',
        baseUrl: XAI_BASE,
        proxy: p,
        label: `proxy ${p.scheme}://${p.host}:${p.port}`,
      });
    }
    if (!list.length) {
      list.push({ kind: 'direct', baseUrl: XAI_BASE, label: 'direct (no proxy set)' });
    }
    return list;
  }

  // auto: direct first (system VPN path), then relays, then proxies
  list.push({ kind: 'direct', baseUrl: XAI_BASE, label: 'direct api.x.ai' });
  for (const r of relays) {
    list.push({ kind: 'relay', baseUrl: r, label: `relay ${r}` });
  }
  for (const p of proxies) {
    list.push({
      kind: 'proxy',
      baseUrl: XAI_BASE,
      proxy: p,
      label: `proxy ${p.scheme}://${p.host}:${p.port}`,
    });
  }
  return list;
}

/**
 * Race / sequential probe; prefer low RTT; direct wins if RTT within margin.
 * @param {object} settings
 * @param {{force?:boolean, apiKey?:string}} [opts]
 */
export async function selectBestRoute(settings, opts = {}) {
  if (String(settings?.providerMode || '') === 'local') {
    return applyNetworkSettings(settings, opts);
  }
  const force = !!opts.force;
  const apiKey = opts.apiKey || settings?.xaiApiKey || '';
  const now = Date.now();

  if (!force && routeCache && now - routeCache.at < CACHE_TTL_MS) {
    activeBaseUrl = routeCache.baseUrl;
    return { ...routeCache, cached: true };
  }

  const mode = settings?.networkMode || 'auto';
  const candidates = buildCandidates(settings);
  const results = [];

  // Always start with clean system proxy so DIRECT truly uses OS VPN/proxy
  await clearBrowserProxy();

  const preferDirectMaxMs = Number(settings?.preferDirectMaxMs) || 900;

  for (const c of candidates) {
    try {
      if (c.kind === 'proxy' && c.proxy) {
        await applyBrowserProxyForXai(c.proxy);
      } else {
        await clearBrowserProxy();
      }
      const probe = await probeEndpoint(c.baseUrl, apiKey);
      results.push({
        ...c,
        ok: probe.ok,
        rtt: probe.rtt,
        status: probe.status,
        error: probe.error,
      });
      // Auto: take direct immediately if healthy and fast enough
      if (mode === 'auto' && c.kind === 'direct' && probe.ok && probe.rtt <= preferDirectMaxMs) {
        break;
      }
      // Forced single mode with one success — can stop early if only one type
      if ((mode === 'direct' || mode === 'relay' || mode === 'proxy') && probe.ok) {
        // still allow more of same kind for min RTT, but cap time: continue only relays/proxies
      }
    } catch (e) {
      results.push({
        ...c,
        ok: false,
        rtt: PROBE_TIMEOUT_MS,
        error: String(e?.message || e),
      });
    }
  }

  const working = results.filter((r) => r.ok).sort((a, b) => a.rtt - b.rtt);
  let best = working[0];

  if (!best) {
    // Fail open: keep DIRECT so system VPN still works; clear PAC
    await clearBrowserProxy();
    activeBaseUrl = XAI_BASE;
    routeCache = {
      at: now - CACHE_TTL_MS + 15_000,
      kind: 'direct',
      baseUrl: XAI_BASE,
      rtt: -1,
      proxy: null,
      label: 'direct (all probes failed)',
    };
    log.warn('All network probes failed; staying on direct', results);
    return {
      ...routeCache,
      cached: false,
      ok: false,
      results,
      error: 'Не удалось достучаться до api.x.ai. Включи системный VPN или задай relay/прокси только для xAI.',
    };
  }

  // Apply chosen path
  if (best.kind === 'proxy' && best.proxy) {
    await applyBrowserProxyForXai(best.proxy);
    activeBaseUrl = XAI_BASE;
  } else {
    await clearBrowserProxy();
    activeBaseUrl = best.baseUrl || XAI_BASE;
  }

  routeCache = {
    at: now,
    kind: best.kind,
    baseUrl: activeBaseUrl,
    rtt: best.rtt,
    proxy: best.proxy ? summarizeProxy(best.proxy) : null,
    label: best.label,
  };
  log.info('Network route selected', routeCache);
  return { ...routeCache, cached: false, ok: true, results };
}

/**
 * Apply route without full race (used after settings save).
 * @param {object} settings
 * @param {{apiKey?:string, forceProbe?:boolean, soft?:boolean}} [opts]
 *   soft — skip multi-candidate probe race (streaming open must not wait 8–16s).
 *   Uses cache / configured relay / direct immediately; full probe still runs elsewhere.
 */
export async function applyNetworkSettings(settings, opts = {}) {
  // Full local STT/MT/TTS — pin base to gateway, skip xAI probe/PAC
  if (String(settings?.providerMode || '') === 'local') {
    await clearBrowserProxy();
    const base =
      String(settings?.localBaseUrl || LOCAL_GATEWAY_BASE || '')
        .trim()
        .replace(/\/+$/, '') || LOCAL_GATEWAY_BASE;
    activeBaseUrl = base;
    routeCache = {
      at: Date.now(),
      kind: 'local',
      baseUrl: base,
      rtt: 0,
      label: `local ${base}`,
      providerMode: 'local',
    };
    log.info('Network route: local gateway', base);
    return { ok: true, ...routeCache };
  }

  const mode = settings?.networkMode || 'auto';

  if (mode === 'direct') {
    await clearBrowserProxy();
    activeBaseUrl = XAI_BASE;
    routeCache = {
      at: Date.now(),
      kind: 'direct',
      baseUrl: XAI_BASE,
      rtt: 0,
      label: 'direct',
    };
    return { ok: true, ...routeCache };
  }

  if (mode === 'relay') {
    await clearBrowserProxy();
    const base = normalizeRelayBase(settings?.apiRelayBase || '') || XAI_BASE;
    activeBaseUrl = base;
    routeCache = {
      at: Date.now(),
      kind: 'relay',
      baseUrl: base,
      rtt: -1,
      label: `relay ${base}`,
    };
    if (opts.forceProbe) {
      return selectBestRoute(settings, { force: true, apiKey: opts.apiKey });
    }
    return { ok: true, ...routeCache };
  }

  if (mode === 'proxy') {
    const list = parseProxyList(settings?.proxyList || '');
    let proxy =
      list[0] ||
      (settings?.proxyHost
        ? parseProxyString(
            `${settings.proxyType || 'socks5'}://${
              settings.proxyUser
                ? `${encodeURIComponent(settings.proxyUser)}:${encodeURIComponent(settings.proxyPass || '')}@`
                : ''
            }${settings.proxyHost}:${settings.proxyPort}`,
          )
        : null);
    activeBaseUrl = XAI_BASE;
    if (!proxy) {
      await clearBrowserProxy();
      return { ok: false, error: 'Не задан SOCKS/HTTP прокси' };
    }
    await applyBrowserProxyForXai(proxy);
    routeCache = {
      at: Date.now(),
      kind: 'proxy',
      baseUrl: XAI_BASE,
      rtt: -1,
      proxy: summarizeProxy(proxy),
      label: `proxy ${proxy.scheme}://${proxy.host}:${proxy.port}`,
    };
    if (opts.forceProbe) {
      return selectBestRoute(settings, { force: true, apiKey: opts.apiKey });
    }
    return { ok: true, ...routeCache };
  }

  // auto + soft: never block stream open on sequential relay/proxy probes
  if (opts.soft && !opts.forceProbe) {
    const now = Date.now();
    if (routeCache && now - routeCache.at < CACHE_TTL_MS) {
      activeBaseUrl = routeCache.baseUrl || XAI_BASE;
      return { ok: true, ...routeCache, cached: true, soft: true };
    }
    const userRelay = normalizeRelayBase(settings?.apiRelayBase || '') || '';
    if (userRelay && !/api\.x\.ai/i.test(userRelay)) {
      await clearBrowserProxy();
      activeBaseUrl = userRelay;
      routeCache = {
        at: now,
        kind: 'relay',
        baseUrl: userRelay,
        rtt: -1,
        label: `relay ${userRelay} (soft)`,
      };
      return { ok: true, ...routeCache, soft: true };
    }
    await clearBrowserProxy();
    activeBaseUrl = XAI_BASE;
    routeCache = {
      at: now,
      kind: 'direct',
      baseUrl: XAI_BASE,
      rtt: -1,
      label: 'direct (soft, probe deferred)',
    };
    return { ok: true, ...routeCache, soft: true };
  }

  // auto
  return selectBestRoute(settings, {
    force: opts.forceProbe !== false,
    apiKey: opts.apiKey,
  });
}

export function getRouteStatus() {
  return {
    baseUrl: getActiveBaseUrl(),
    cache: routeCache,
  };
}

export function invalidateRouteCache() {
  routeCache = null;
}
