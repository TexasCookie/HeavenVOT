/**
 * Browser-level proxy ONLY for xAI hosts.
 * Default off → chrome.proxy cleared → system VPN / OS proxy untouched.
 */

import { log } from '../logger.js';

/** Hosts that may be routed through extension proxy */
export const XAI_PROXY_HOSTS = ['api.x.ai', 'x.ai'];

/**
 * @typedef {{
 *   scheme: 'http'|'https'|'socks4'|'socks5',
 *   host: string,
 *   port: number,
 *   username?: string,
 *   password?: string,
 * }} ProxyEndpoint
 */

/**
 * Parse one proxy line / URL.
 * Accepts: socks5://user:pass@host:1080 | http://host:8080 | host:1080 | host:1080:user:pass
 * @param {string} raw
 * @returns {ProxyEndpoint|null}
 */
export function parseProxyString(raw) {
  const s = String(raw || '').trim();
  if (!s || s.startsWith('#')) return null;

  // URL form
  if (/^[a-z0-9]+:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      const scheme = normalizeScheme(u.protocol.replace(':', ''));
      const port = Number(u.port) || defaultPort(scheme);
      if (!u.hostname || !port) return null;
      return {
        scheme,
        host: u.hostname,
        port,
        username: u.username ? decodeURIComponent(u.username) : undefined,
        password: u.password ? decodeURIComponent(u.password) : undefined,
      };
    } catch {
      return null;
    }
  }

  // host:port | host:port:user | host:port:user:pass
  const parts = s.split(':');
  if (parts.length >= 2) {
    const host = parts[0].trim();
    const port = Number(parts[1]);
    if (!host || !Number.isFinite(port) || port <= 0) return null;
    if (parts.length === 3) {
      return { scheme: 'socks5', host, port, username: parts[2], password: undefined };
    }
    if (parts.length >= 4) {
      return {
        scheme: 'socks5',
        host,
        port,
        username: parts.slice(2, -1).join(':'),
        password: parts[parts.length - 1],
      };
    }
    return { scheme: 'socks5', host, port };
  }
  return null;
}

/**
 * Parse multi-line proxy list (one per line).
 * @param {string|string[]} text
 * @returns {ProxyEndpoint[]}
 */
export function parseProxyList(text) {
  const lines = Array.isArray(text)
    ? text
    : String(text || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const line of lines) {
    const p = parseProxyString(line);
    if (!p) continue;
    const key = `${p.scheme}://${p.host}:${p.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function normalizeScheme(s) {
  const x = String(s || 'socks5').toLowerCase();
  if (x === 'socks' || x === 'socks5') return 'socks5';
  if (x === 'socks4') return 'socks4';
  if (x === 'https') return 'https';
  if (x === 'http' || x === 'proxy') return 'http';
  return 'socks5';
}

function defaultPort(scheme) {
  if (scheme === 'https') return 443;
  if (scheme === 'http') return 8080;
  return 1080;
}

/**
 * PAC: only api.x.ai / *.x.ai → proxy; everything else DIRECT (no interference).
 * @param {ProxyEndpoint} proxy
 * @param {string[]} hosts
 */
export function buildXaiOnlyPac(proxy, hosts = XAI_PROXY_HOSTS) {
  const scheme = proxy.scheme;
  const host = proxy.host.replace(/"/g, '');
  const port = Number(proxy.port);
  let proxyToken;
  if (scheme === 'socks5') proxyToken = `SOCKS5 ${host}:${port}`;
  else if (scheme === 'socks4') proxyToken = `SOCKS ${host}:${port}`;
  else if (scheme === 'https') proxyToken = `HTTPS ${host}:${port}`;
  else proxyToken = `PROXY ${host}:${port}`;

  // Fallback DIRECT so a dead proxy does not blackhole the whole browser for xAI forever
  const proxyReturn = `${proxyToken}; DIRECT`;
  const hostChecks = hosts
    .map((h) => {
      const safe = String(h).replace(/"/g, '');
      return `host === "${safe}" || dnsDomainIs(host, ".${safe}") || dnsDomainIs(host, "${safe}")`;
    })
    .join(' || ');

  return `
function FindProxyForURL(url, host) {
  host = host.toLowerCase();
  if (${hostChecks}) {
    return "${proxyReturn}";
  }
  return "DIRECT";
}
`.trim();
}

let authListenerAttached = false;
/** @type {{username:string,password:string}|null} */
let currentAuth = null;

function ensureAuthListener() {
  if (authListenerAttached || !chrome.webRequest?.onAuthRequired) return;
  try {
    chrome.webRequest.onAuthRequired.addListener(
      (details, asyncCallback) => {
        const run = () => {
          // Only answer proxy challenges — never WWW-Authenticate for api.x.ai (B18)
          if (details && details.isProxy === false) {
            asyncCallback?.({});
            return;
          }
          if (!currentAuth?.username) {
            asyncCallback?.({});
            return;
          }
          asyncCallback?.({
            authCredentials: {
              username: currentAuth.username,
              password: currentAuth.password || '',
            },
          });
        };
        try {
          run();
        } catch {
          try {
            asyncCallback?.({});
          } catch {
            /* ignore */
          }
        }
      },
      { urls: ['<all_urls>'] },
      // MV3: asyncBlocking requires webRequestAuthProvider (blocking is illegal)
      ['asyncBlocking'],
    );
    authListenerAttached = true;
  } catch (e) {
    authListenerAttached = false;
  }
}

/**
 * Apply PAC that routes only xAI through the given proxy.
 * @param {ProxyEndpoint|null} proxy
 */
export async function applyBrowserProxyForXai(proxy) {
  if (!chrome.proxy?.settings) {
    throw new Error('chrome.proxy недоступен в этом браузере');
  }

  if (!proxy?.host || !proxy?.port) {
    await clearBrowserProxy();
    return { ok: true, mode: 'cleared' };
  }

  const control = await getProxyControlLevel();
  if (control === 'controlled_by_other_extensions') {
    throw new Error(
      'Прокси браузера занят другим расширением. Отключи его или используй HTTPS-relay / системный VPN.',
    );
  }

  currentAuth =
    proxy.username != null && proxy.username !== ''
      ? { username: proxy.username, password: proxy.password || '' }
      : null;
  if (currentAuth) ensureAuthListener();

  const pac = buildXaiOnlyPac(proxy);
  await chrome.proxy.settings.set({
    value: {
      mode: 'pac_script',
      pacScript: {
        data: pac,
        mandatory: false,
      },
    },
    scope: 'regular',
  });
  log.info('PAC proxy for xAI only', `${proxy.scheme}://${proxy.host}:${proxy.port}`);
  return { ok: true, mode: 'pac', proxy: summarizeProxy(proxy) };
}

function getProxyControlLevel() {
  return new Promise((resolve) => {
    try {
      chrome.proxy.settings.get({}, (cfg) => {
        resolve(cfg?.levelOfControl || 'unknown');
      });
    } catch {
      resolve('unknown');
    }
  });
}

/**
 * Release extension control over proxy → system VPN / browser defaults again.
 */
export async function clearBrowserProxy() {
  currentAuth = null;
  if (!chrome.proxy?.settings) return { ok: true, mode: 'unavailable' };
  try {
    await chrome.proxy.settings.clear({ scope: 'regular' });
    log.info('Browser proxy control released (system VPN/proxy intact)');
    return { ok: true, mode: 'system' };
  } catch (e) {
    log.warn('proxy clear failed', e?.message || e);
    return { ok: false, error: String(e?.message || e) };
  }
}

export function summarizeProxy(proxy) {
  if (!proxy) return null;
  return {
    scheme: proxy.scheme,
    host: proxy.host,
    port: proxy.port,
    hasAuth: !!(proxy.username && proxy.username.length),
  };
}

/**
 * Whether settings want an active browser PAC proxy.
 * @param {object} settings
 */
export function shouldUseBrowserProxy(settings) {
  const mode = settings?.networkMode || 'auto';
  if (mode === 'direct' || mode === 'relay') return false;
  if (mode === 'proxy') return true;
  // auto: only if we previously selected a proxy endpoint (router decides apply)
  return false;
}
