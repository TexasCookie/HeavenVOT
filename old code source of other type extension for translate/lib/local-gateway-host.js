/**
 * Talk to com.aethervox.local_gateway Native Messaging host
 * (starts / probes tools/local-voice-gateway/server.py).
 */

import { LOCAL_GATEWAY_NATIVE_HOST } from './constants.js';
import { log } from './logger.js';
import { looksLikeLocalGateway } from './xai/auth-policy.js';

/**
 * @param {object} msg
 * @param {number} [timeoutMs]
 * @returns {Promise<object>}
 */
export function nativeGatewaySend(msg, timeoutMs = 60000) {
  return new Promise((resolve) => {
    let port;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        port?.disconnect();
      } catch {
        /* ignore */
      }
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish({
        ok: false,
        error: `native host timeout ${timeoutMs}ms`,
        timeout: true,
      });
    }, timeoutMs);

    try {
      port = chrome.runtime.connectNative(LOCAL_GATEWAY_NATIVE_HOST);
    } catch (e) {
      clearTimeout(timer);
      finish({
        ok: false,
        error: String(e?.message || e),
        needInstall: true,
      });
      return;
    }

    port.onMessage.addListener((response) => {
      clearTimeout(timer);
      finish(response && typeof response === 'object' ? response : { ok: true, raw: response });
    });
    port.onDisconnect.addListener(() => {
      clearTimeout(timer);
      const err = chrome.runtime.lastError?.message || 'native host disconnected';
      const needInstall =
        /not found|specified native messaging host|access denied|host not found/i.test(
          err,
        );
      finish({ ok: false, error: err, needInstall });
    });

    try {
      port.postMessage(msg);
    } catch (e) {
      clearTimeout(timer);
      finish({ ok: false, error: String(e?.message || e), needInstall: true });
    }
  });
}

/**
 * Probe HTTP health; if down, ask native host to start gateway.
 * @param {{ baseUrl?: string, forceStart?: boolean }} [opts]
 */
export async function ensureLocalGateway(opts = {}) {
  const base = String(opts.baseUrl || 'http://127.0.0.1:8788/v1').replace(
    /\/+$/,
    '',
  );
  const healthUrl = `${base.replace(/\/v1$/i, '')}/health`;

  const probe = async () => {
    try {
      const res = await fetch(healthUrl, {
        cache: 'no-store',
        signal:
          typeof AbortSignal !== 'undefined' && AbortSignal.timeout
            ? AbortSignal.timeout(2500)
            : undefined,
      });
      const data = await res.json().catch(() => ({ ok: res.ok }));
      return {
        ok: looksLikeLocalGateway(res.status, data),
        data,
        status: res.status,
      };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  };

  let health = await probe();
  if (health.ok && !opts.forceStart) {
    return { ok: true, already: true, health, source: 'http' };
  }

  const started = await nativeGatewaySend({ cmd: 'start', waitSec: 50 }, 70000);

  if (started?.ok && (started.running || started.started || started.already)) {
    health = await probe();
    return {
      ok: !!health.ok,
      started: true,
      health,
      native: started,
      source: 'native',
    };
  }

  health = await probe();
  return {
    ok: !!health.ok,
    started: false,
    health,
    native: started,
    needInstall: !!started?.needInstall,
    error:
      started?.error ||
      health.error ||
      'шлюз недоступен — установи автозапуск (install-native-host.ps1)',
    source: 'native-failed',
  };
}

export function mapFetchError(err, fallback = 'шлюз недоступен') {
  const s = String(err || '');
  if (/failed to fetch|fetch failed|networkerror|load failed/i.test(s)) {
    return `${fallback} (127.0.0.1:8788) — автозапуск не установлен или Python/модели не готовы`;
  }
  return s || fallback;
}

export async function pingNativeHost() {
  try {
    return await nativeGatewaySend({ cmd: 'ping' }, 5000);
  } catch (e) {
    log.debug('native ping', e?.message || e);
    return { ok: false, error: String(e?.message || e), needInstall: true };
  }
}
