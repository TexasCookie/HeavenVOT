/**
 * In-extension native auth providers — replace external `node tools/xai-relay-local.mjs`.
 *
 * Browser cannot set Authorization on `new WebSocket()`. External local relay
 * only existed to inject that header. We embed the same capability natively:
 *
 *  1) chrome.webRequest.onAuthRequired (webRequestAuthProvider) — if api.x.ai
 *     issues an HTTP auth challenge on the WS upgrade, supply the API key.
 *  2) declarativeNetRequest Bearer (best-effort; Chrome often ignores on WS).
 *  3) Ephemeral client_secret + Sec-WebSocket-Protocol (primary WS path).
 *  4) SW-side fetch streaming TTS/STT with real Authorization (lib/xai/native-rest-stream.js)
 *     — full quality without any external process.
 */

import { log } from '../logger.js';
import { ensureWsAuthRules, clearWsAuthRules } from './ws-auth.js';

/** @type {boolean} */
let installed = false;
/** @type {string} */
let bearerFp = '';
/** @type {(() => Promise<string>|string)|null} */
let getBearer = null;
/** @type {((details: chrome.webRequest.WebAuthenticationChallengeDetails, cb: (r: chrome.webRequest.BlockingResponse) => void) => void)|null} */
let authListener = null;

function fpOf(token) {
  const t = String(token || '');
  if (!t) return '';
  return `${t.length}:${t.slice(0, 4)}…${t.slice(-3)}`;
}

/**
 * True after installNativeAuthProviders() succeeded at least once this SW life.
 */
export function isNativeAuthProviderInstalled() {
  return installed;
}

/**
 * Install SW-native auth providers (no Node, no Options, no local process).
 * Safe to call repeatedly on key change / warm.
 *
 * @param {{
 *   getApiKey: () => Promise<string>|string,
 *   getBearerToken?: () => Promise<string>|string,
 * }} deps
 * getBearerToken — prefer ephemeral client_secret when available, else API key
 */
export async function installNativeAuthProviders(deps) {
  getBearer =
    deps.getBearerToken ||
    deps.getApiKey ||
    (async () => '');

  // 1) onAuthRequired — MV3 asyncBlocking via webRequestAuthProvider
  if (
    chrome?.webRequest?.onAuthRequired &&
    !authListener
  ) {
    authListener = (details, asyncCallback) => {
      const run = async () => {
        try {
          // Proxy auth is handled by network/proxy.js — never send API key there (B18)
          if (details?.isProxy === true) {
            asyncCallback?.({});
            return;
          }
          const url = String(details?.url || '');
          if (!/api\.x\.ai/i.test(url) && !/\.x\.ai/i.test(url)) {
            asyncCallback?.({});
            return;
          }
          let token = '';
          try {
            token = String((await getBearer?.()) || '').trim();
          } catch {
            token = '';
          }
          if (!token) {
            asyncCallback?.({ cancel: true });
            return;
          }
          // HTTP Basic challenge: password carries the secret / API key.
          // (Bearer challenges are uncommon; protocol + fetch cover those.)
          asyncCallback?.({
            authCredentials: {
              username: 'xai',
              password: token.startsWith('Bearer ')
                ? token.slice(7).trim()
                : token,
            },
          });
        } catch (e) {
          log.debug('onAuthRequired handler', e?.message || e);
          try {
            asyncCallback?.({ cancel: true });
          } catch {
            /* ignore */
          }
        }
      };
      run();
    };

    try {
      chrome.webRequest.onAuthRequired.addListener(
        authListener,
        {
          urls: [
            '*://api.x.ai/*',
            'wss://api.x.ai/*',
            'ws://api.x.ai/*',
            '*://*.x.ai/*',
          ],
        },
        // MV3: asyncBlocking requires webRequestAuthProvider permission
        ['asyncBlocking'],
      );
      log.info('native onAuthRequired provider installed (in-extension relay)');
    } catch (e) {
      log.warn('onAuthRequired install failed', e?.message || e);
      authListener = null;
    }
  }

  // 2) DNR Bearer (best-effort companion)
  let key = '';
  try {
    key = String((await deps.getApiKey()) || '').trim();
  } catch {
    key = '';
  }
  let bearer = key;
  try {
    const t = String((await getBearer()) || '').trim();
    if (t) bearer = t;
  } catch {
    /* use key */
  }

  const fp = fpOf(bearer);
  if (bearer && fp !== bearerFp) {
    try {
      await ensureWsAuthRules(bearer, { force: true });
      bearerFp = fp;
    } catch (e) {
      log.debug('native DNR warm', e?.message || e);
    }
  }

  installed = true;
  return {
    ok: true,
    onAuthRequired: !!authListener,
    dnr: !!bearer,
  };
}

/**
 * Drop listeners / DNR (key cleared or tests).
 */
export async function uninstallNativeAuthProviders() {
  if (authListener && chrome?.webRequest?.onAuthRequired) {
    try {
      chrome.webRequest.onAuthRequired.removeListener(authListener);
    } catch {
      /* ignore */
    }
  }
  authListener = null;
  getBearer = null;
  bearerFp = '';
  installed = false;
  try {
    await clearWsAuthRules();
  } catch {
    /* ignore */
  }
}
