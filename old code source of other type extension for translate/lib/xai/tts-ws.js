/**
 * xAI streaming TTS WebSocket client (wss://api.x.ai/v1/tts).
 * text.delta / text.done → audio.delta / audio.done
 * Multi-utterance on one connection after audio.done.
 *
 * Auth (browser/extension cannot set Authorization on WebSocket constructor):
 *  1) Preferred: CF/local relay query `_av_key` (worker injects Authorization)
 *  2) Ephemeral client secret → Sec-WebSocket-Protocol `xai-client-secret.*`
 *     (Realtime-oriented; often rejected on /v1/tts — prefer SW REST instead)
 * Never open bare DNR Bearer on direct api.x.ai — Chrome ignores modifyHeaders
 * on WS upgrades → "HTTP Authentication failed; no valid credentials available".
 * Never raw API key as Sec-WebSocket-Protocol.
 *
 * Official TTS WS docs: Authorization: Bearer $XAI_API_KEY (server-side).
 * Zero-config extension path: StreamPortSession uses native REST
 * (fetch+Authorization in SW). This class is for relay WS only.
 */

import { log } from '../logger.js';
import { resolveXaiWsUrl } from '../network/router.js';
import { base64ToArrayBuffer } from '../pcm-utils.js';
import {
  isDirectXaiWsUrl,
  isPreparedWsAuthReady,
  prepareAuthenticatedWs,
} from './ws-auth.js';
import { ttsMessageMatchesUtterance } from './auth-policy.js';

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}

/**
 * @typedef {{
 *   voice?: string,
 *   language?: string,
 *   codec?: string,
 *   sample_rate?: number,
 *   bit_rate?: number,
 *   optimize_streaming_latency?: number,
 *   speed?: number,
 *   text_normalization?: boolean,
 * }} TtsWsConfig
 */

export class StreamingTtsSession {
  /**
   * @param {{
   *   onError?: (err: Error) => void,
   *   onClose?: (info?: object) => void,
   * }} [handlers]
   */
  constructor(handlers = {}) {
    this.onError = handlers.onError || (() => {});
    this.onClose = handlers.onClose || (() => {});
    /** @type {WebSocket | null} */
    this.ws = null;
    this.config = null;
    this._busy = false;
    /** @type {null | {
     *   id: string,
     *   chunks: Uint8Array[],
     *   resolve: Function,
     *   reject: Function,
     *   onFirstByte?: Function,
     *   onDelta?: Function,
     *   firstByteAt: number,
     *   startedAt: number,
     *   contentType: string,
     * }} */
    this._current = null;
    this.url = '';
  }

  get connected() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  get busy() {
    return this._busy;
  }

  /**
   * Open (or re-open) with synthesis config as query params.
   * @param {TtsWsConfig} config
   * @param {{
   *   token?: string,
   *   apiKey?: string,
   *   longLivedKey?: string,
   *   baseUrl?: string,
   *   forceDnr?: boolean,
   * }} [opts]
   *   token — handshake credential (ephemeral preferred)
   *   apiKey / longLivedKey — long-lived XAI_API_KEY for classification + DNR
   *   baseUrl — force HTTPS root (…/v1). Pass relay base when configured so WS
   *   does not follow REST auto-route to bare api.x.ai.
   */
  async open(config = {}, opts = {}) {
    if (this.ws && this.#configMatches(config)) {
      if (this.connected) return;
    }
    this.close();
    this.config = { ...config };

    const params = new URLSearchParams();
    params.set('voice', String(config.voice || 'ara').toLowerCase());
    params.set('language', String(config.language || 'ru'));
    // mp3 is easy for existing <audio> path; pcm for future gapless stream
    params.set('codec', config.codec || 'mp3');
    params.set('sample_rate', String(config.sample_rate ?? 24000));
    if (config.codec !== 'pcm') {
      params.set('bit_rate', String(config.bit_rate ?? 128000));
    }
    // Docs: only 0 = quality, 1 = lower TTFB (values ≥2 rejected)
    const optLat =
      config.optimize_streaming_latency === 0 ||
      config.optimize_streaming_latency === '0'
        ? 0
        : 1;
    params.set('optimize_streaming_latency', String(optLat));
    if (config.speed != null) params.set('speed', String(config.speed));
    if (config.text_normalization !== false) {
      params.set('text_normalization', 'true');
    }

    const baseUrl = String(opts.baseUrl || '').trim() || undefined;
    const rawUrl = resolveXaiWsUrl(`/tts?${params.toString()}`, baseUrl);
    const longLived = String(
      opts.longLivedKey || opts.apiKey || '',
    ).trim();
    const token = String(opts.token || opts.apiKey || '').trim();
    // Relay _av_key | ephemeral protocol | DNR last resort.
    const prepared = prepareAuthenticatedWs(rawUrl, token, {
      apiKey: longLived,
      forceDnr: !!opts.forceDnr,
    });
    this.url = prepared.url;
    const label = prepared.mode || (prepared.protocols ? 'protocol' : 'none');

    if (!isPreparedWsAuthReady(prepared, token || longLived)) {
      if (!token) {
        throw new Error(
          'TTS WS: no auth token (set XAI_API_KEY in extension settings)',
        );
      }
      if (isDirectXaiWsUrl(prepared.url)) {
        // Never open bare dnr-bearer — Chrome logs
        // "HTTP Authentication failed; no valid credentials available"
        throw new Error(
          'TTS WS: direct api.x.ai needs ephemeral client_secret protocol or CF/local relay (_av_key). ' +
            'Chrome cannot set Authorization on WebSocket (DNR ignored).',
        );
      }
      throw new Error('TTS WS: auth not ready for URL host');
    }

    try {
      await this.#connectOnce({
        url: prepared.url,
        protocols: prepared.protocols,
        label,
      });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      log.warn('TTS WS open failed', label, err.message);
      try {
        this.ws?.close?.();
      } catch {
        /* ignore */
      }
      this.ws = null;
      if (
        /auth|credential|401|403|protocol|closed|1006|timeout|no valid/i.test(
          err.message,
        )
      ) {
        throw new Error(
          `TTS WebSocket auth failed (host=${hostOf(prepared.url)}, auth=${label}). ` +
            'Chrome cannot set Authorization on WebSocket — mint ephemeral ' +
            'client_secret protocol, use CF/local relay (_av_key), or REST TTS fallback.',
        );
      }
      throw err;
    }
  }

  /**
   * @param {{ url: string, protocols?: string[], label: string }} strategy
   */
  #connectOnce(strategy) {
    this.url = strategy.url;
    const label = strategy.label || 'ws';

    return new Promise((resolve, reject) => {
      let settled = false;
      const finishOk = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const finishErr = (e) => {
        if (settled) return;
        settled = true;
        reject(e instanceof Error ? e : new Error(String(e)));
      };

      try {
        const ws = strategy.protocols
          ? new WebSocket(this.url, strategy.protocols)
          : new WebSocket(this.url);
        this.ws = ws;
        const timer = setTimeout(() => {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          finishErr(new Error('TTS WS open timeout'));
        }, 8000);

        ws.onopen = () => {
          clearTimeout(timer);
          log.debug(
            'TTS WS open',
            this.url
              .replace(/([?&])_av_key=[^&]*/g, '$1_av_key=***')
              .slice(0, 90),
            `auth=${label}`,
          );
          finishOk();
        };
        ws.onerror = () => {
          clearTimeout(timer);
          // Chrome surfaces auth rejects as onerror + this exact phrase in logs
          finishErr(
            new Error(
              `TTS WebSocket error (auth=${label}; no valid credentials / handshake)`,
            ),
          );
        };
        ws.onclose = (ev) => {
          clearTimeout(timer);
          this.ws = null;
          this._busy = false;
          const cur = this._current;
          this._current = null;
          if (cur) {
            cur.reject(
              new Error(
                `TTS WS closed mid-utterance (${ev.code} ${ev.reason || ''})`,
              ),
            );
          }
          this.onClose({ code: ev.code, reason: ev.reason });
          if (!settled) {
            const reason = String(ev.reason || '');
            const authish =
              ev.code === 1006 ||
              ev.code === 1008 ||
              /auth|credential|401|403/i.test(reason);
            finishErr(
              new Error(
                authish
                  ? `TTS WS closed before open (${ev.code} ${reason || 'auth?'})`
                  : `TTS WS closed (${ev.code}${reason ? ` ${reason}` : ''})`,
              ),
            );
          }
        };
        ws.onmessage = (ev) => this.#onMessage(ev);
      } catch (e) {
        finishErr(e);
      }
    });
  }

  #configMatches(config) {
    if (!this.config) return false;
    const keys = [
      'voice',
      'language',
      'codec',
      'sample_rate',
      'speed',
      'optimize_streaming_latency',
    ];
    for (const k of keys) {
      const a = this.config[k];
      const b = config[k];
      if (a != null || b != null) {
        if (String(a ?? '') !== String(b ?? '')) return false;
      }
    }
    return true;
  }

  #onMessage(ev) {
    if (typeof ev.data !== 'string') return;
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    const type = msg?.type || '';
    const cur = this._current;
    if (!cur) return;
    if (!ttsMessageMatchesUtterance(msg, cur)) return;
    if (cur.gen != null && cur.gen !== this._speakGen) return;

    if (type === 'audio.delta') {
      const b64 = msg?.audio || msg?.delta || msg?.data || '';
      if (!b64) return;
      try {
        const ab = base64ToArrayBuffer(b64);
        const u8 = new Uint8Array(ab);
        cur.chunks.push(u8);
        if (!cur.firstByteAt) {
          cur.firstByteAt = performance.now();
          cur.onFirstByte?.({
            id: cur.id,
            latencyMs: Math.round(cur.firstByteAt - cur.startedAt),
            byteLength: u8.byteLength,
          });
        }
        cur.onDelta?.({
          id: cur.id,
          audioBase64: b64,
          byteLength: u8.byteLength,
          contentType: cur.contentType,
        });
      } catch (e) {
        log.debug('TTS delta decode failed', e?.message || e);
      }
      return;
    }

    if (type === 'audio.done') {
      const buf = concatChunks(cur.chunks);
      const result = {
        id: cur.id,
        buffer: buf,
        contentType: cur.contentType,
        firstByteMs: cur.firstByteAt
          ? Math.round(cur.firstByteAt - cur.startedAt)
          : null,
        totalMs: Math.round(performance.now() - cur.startedAt),
        bytes: buf.byteLength,
      };
      this._busy = false;
      this._current = null;
      cur.resolve(result);
      return;
    }

    if (type === 'error' || msg?.error) {
      const errText =
        msg?.error?.message || msg?.message || msg?.error || 'TTS WS error';
      this._busy = false;
      this._current = null;
      const err = new Error(String(errText));
      this.onError(err);
      cur.reject(err);
    }
  }

  /**
   * Synthesize one utterance. Connection reusable after resolve.
   * @param {string} text
   * @param {{
   *   id?: string,
   *   onFirstByte?: (info: object) => void,
   *   onDelta?: (info: object) => void,
   *   timeoutMs?: number,
   * }} [opts]
   */
  async speak(text, opts = {}) {
    const t = String(text || '').trim();
    if (!t) throw new Error('empty TTS text');
    if (!this.connected) throw new Error('TTS WS not connected');
    if (this._busy) throw new Error('TTS WS busy');

    this._busy = true;
    this._speakGen = (this._speakGen || 0) + 1;
    const id = opts.id || `tts_${Date.now()}`;
    const contentType =
      (this.config?.codec || 'mp3') === 'pcm'
        ? 'audio/pcm'
        : (this.config?.codec || 'mp3') === 'wav'
          ? 'audio/wav'
          : 'audio/mpeg';

    const resultPromise = new Promise((resolve, reject) => {
      this._current = {
        id,
        gen: this._speakGen,
        chunks: [],
        resolve,
        reject,
        onFirstByte: opts.onFirstByte,
        onDelta: opts.onDelta,
        firstByteAt: 0,
        startedAt: performance.now(),
        contentType,
      };
    });

    try {
      // Stream as one delta (clause units are short) then done
      this.ws.send(JSON.stringify({ type: 'text.delta', delta: t, text: t }));
      this.ws.send(JSON.stringify({ type: 'text.done' }));
    } catch (e) {
      this._busy = false;
      this._current = null;
      throw e;
    }

    const timeoutMs = opts.timeoutMs ?? 20000;
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        // CRITICAL: leave _busy/_current stuck → every later speak fails with "TTS WS busy"
        // until the socket dies. Timeout must free the session (and drop a dead utterance).
        if (this._current?.id === id) {
          this._speakGen = (this._speakGen || 0) + 1;
          this._current = null;
          this._busy = false;
        }
        try {
          this.ws?.close?.();
        } catch {
          /* ignore */
        }
        this.ws = null;
        reject(new Error(`TTS WS timeout ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([resultPromise, timeoutPromise]);
    } catch (e) {
      // If we timed out (or raced), ensure session is not permanently busy.
      if (this._current?.id === id) {
        this._current = null;
        this._busy = false;
      }
      // Dead mid-utterance socket often never sends audio.done — soft-reset for next speak.
      if (/timeout/i.test(String(e?.message || e)) && this.ws) {
        try {
          // Do not hard-close: multi-utterance sockets are expensive to re-open.
          // Caller will fall back to REST; next open() recreates if needed.
        } catch {
          /* ignore */
        }
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  close() {
    const cur = this._current;
    this._current = null;
    this._busy = false;
    if (cur) {
      try {
        cur.reject(new Error('TTS session closed'));
      } catch {
        /* ignore */
      }
    }
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    try {
      if (
        ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING
      ) {
        ws.close(1000, 'client close');
      }
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {Uint8Array[]} chunks
 * @returns {ArrayBuffer}
 */
function concatChunks(chunks) {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out.buffer;
}
