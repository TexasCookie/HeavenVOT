/**
 * Shared ephemeral client-secret pool for browser WebSockets.
 *
 * Default path (no CF/local relay, no per-session setup):
 *   REST POST /realtime/client_secrets  (Authorization works)
 *   → Sec-WebSocket-Protocol: xai-client-secret.<value>
 *
 * Lives in the service worker module scope so every Port/session reuses one mint.
 * Refresh before expiry via chrome.alarms (wired in service-worker).
 */

import { log } from '../logger.js';
import { isEphemeralWsToken } from './ws-auth.js';

/** Default mint lifetime (xAI max 3600). */
export const SECRET_TTL_SEC = 3600;
/** Refresh when less than this remains. */
export const SECRET_REFRESH_MARGIN_SEC = 180;
/** Alarm period (minutes) — keep SW warm + secret fresh. */
export const SECRET_ALARM_PERIOD_MIN = 20;
export const SECRET_ALARM_NAME = 'aethervox-client-secret';

/**
 * @param {string} apiKey
 */
function keyFp(apiKey) {
  const k = String(apiKey || '');
  if (!k) return '';
  return `${k.length}:${k.slice(0, 6)}…${k.slice(-4)}`;
}

export class ClientSecretPool {
  /**
   * @param {{
   *   mint: (opts?: { expiresSeconds?: number }) => Promise<{ value: string, expires_at?: number }>,
   *   getApiKey?: () => Promise<string>|string,
   * }} deps
   */
  constructor(deps) {
    this._mint = deps.mint;
    this._getApiKey = deps.getApiKey || (() => '');
    /** @type {string|null} */
    this._value = null;
    this._expiresAt = 0;
    this._fp = '';
    /** @type {Promise<{ value: string, expires_at: number }>|null} */
    this._inflight = null;
    this._lastError = '';
    this._mintCount = 0;
    this._failCount = 0;
  }

  get snapshot() {
    const now = Math.floor(Date.now() / 1000);
    return {
      hasSecret: !!this._value,
      expiresAt: this._expiresAt,
      ttlSec: this._value ? Math.max(0, this._expiresAt - now) : 0,
      mintCount: this._mintCount,
      failCount: this._failCount,
      lastError: this._lastError || '',
      fp: this._fp,
    };
  }

  invalidate(reason = '') {
    this._mintGen = (this._mintGen || 0) + 1;
    this._value = null;
    this._expiresAt = 0;
    this._inflight = null;
    if (reason) log.debug('client-secret pool invalidate', reason);
  }

  /**
   * Call when API key changes.
   * @param {string} apiKey
   */
  onApiKey(apiKey) {
    const fp = keyFp(apiKey);
    if (fp !== this._fp) {
      this._fp = fp;
      this.invalidate('api-key-changed');
    }
  }

  /**
   * @param {{ forceRefresh?: boolean, minTtlSec?: number }} [opts]
   * @returns {Promise<{ value: string, expires_at: number }>}
   */
  async get(opts = {}) {
    const force = !!opts.forceRefresh;
    const minTtl = Number(opts.minTtlSec) || SECRET_REFRESH_MARGIN_SEC;
    const now = Math.floor(Date.now() / 1000);

    let apiKey = '';
    try {
      apiKey = String((await this._getApiKey()) || '').trim();
    } catch {
      apiKey = '';
    }
    if (apiKey) this.onApiKey(apiKey);
    if (!apiKey) {
      this.invalidate('no-key');
      throw new Error('client-secret pool: no API key');
    }

    if (
      !force &&
      this._value &&
      this._expiresAt > now + minTtl &&
      isEphemeralWsToken(this._value, apiKey)
    ) {
      return { value: this._value, expires_at: this._expiresAt };
    }

    if (this._inflight && !force) return this._inflight;
    if (force) {
      this._mintGen = (this._mintGen || 0) + 1;
      this._inflight = null;
    }

    const mintGen = this._mintGen || 0;
    this._inflight = this.#mintOnce(apiKey, force)
      .then((r) => {
        if (mintGen !== (this._mintGen || 0)) {
          throw new Error('client-secret pool: stale mint');
        }
        this._inflight = null;
        return r;
      })
      .catch((e) => {
        if (this._inflight && mintGen === (this._mintGen || 0)) {
          this._inflight = null;
        }
        throw e;
      });

    return this._inflight;
  }

  /**
   * Best-effort warm (never throws).
   * @param {{ forceRefresh?: boolean }} [opts]
   */
  async warm(opts = {}) {
    try {
      await this.get(opts);
      return { ok: true, ...this.snapshot };
    } catch (e) {
      this._lastError = String(e?.message || e);
      this._failCount += 1;
      log.debug('client-secret warm failed', this._lastError);
      return { ok: false, error: this._lastError, ...this.snapshot };
    }
  }

  /**
   * @param {string} apiKey
   * @param {boolean} force
   */
  async #mintOnce(apiKey, force) {
    const now = Math.floor(Date.now() / 1000);
    // Double-check after waiting for another inflight path
    if (
      !force &&
      this._value &&
      this._expiresAt > now + SECRET_REFRESH_MARGIN_SEC &&
      isEphemeralWsToken(this._value, apiKey)
    ) {
      return { value: this._value, expires_at: this._expiresAt };
    }

    const raw = await this._mint({ expiresSeconds: SECRET_TTL_SEC });
    const value = String(raw?.value || '').trim();
    if (!value) {
      this._failCount += 1;
      this._lastError = 'empty mint value';
      throw new Error('client-secret pool: empty mint value');
    }
    if (!isEphemeralWsToken(value, apiKey)) {
      this._failCount += 1;
      this._lastError = 'mint looked like raw API key';
      throw new Error(
        'client-secret pool: mint rejected (looks like raw API key)',
      );
    }
    const expires_at =
      Number(raw.expires_at) || now + SECRET_TTL_SEC;
    this._value = value;
    this._expiresAt = expires_at;
    this._mintCount += 1;
    this._lastError = '';
    log.info('client-secret pool mint', {
      exp: expires_at,
      n: this._mintCount,
      forced: force,
    });
    return { value, expires_at };
  }
}

/** @type {ClientSecretPool|null} */
let singleton = null;

/**
 * @param {ConstructorParameters<typeof ClientSecretPool>[0]} deps
 */
export function getClientSecretPool(deps) {
  if (!singleton) {
    singleton = new ClientSecretPool(deps);
  }
  return singleton;
}

/** Test helper */
export function _resetClientSecretPoolForTests() {
  singleton = null;
}
