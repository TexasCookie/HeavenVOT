/**
 * xAI streaming STT WebSocket client (wss://api.x.ai/v1/stt).
 * Binary PCM frames in → JSON transcript events out.
 *
 * Auth (browser cannot set Authorization on WebSocket constructor):
 *  1) Optional external/local relay query `_av_key`
 *  2) Ephemeral client secret → Sec-WebSocket-Protocol `xai-client-secret.*`
 * Never open bare DNR Bearer on direct api.x.ai — Chrome ignores modifyHeaders
 * on WS upgrades → "HTTP Authentication failed; no valid credentials available".
 * Never put the long-lived API key into Sec-WebSocket-Protocol.
 */

import { log } from '../logger.js';
import { resolveXaiWsUrl } from '../network/router.js';
import { isDirectXaiWsUrl, prepareAuthenticatedWs } from './ws-auth.js';

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}

/**
 * @typedef {{
 *   sample_rate?: number,
 *   encoding?: string,
 *   interim_results?: boolean,
 *   endpointing?: number,
 *   language?: string,
 *   keyterms?: string[],
 *   smart_turn?: number,
 *   smart_turn_timeout?: number,
 *   vad_threshold?: number,
 *   filler_words?: boolean,
 * }} SttWsConfig
 */

/**
 * @typedef {{
 *   type: string,
 *   text?: string,
 *   is_final?: boolean,
 *   speech_final?: boolean,
 *   words?: object[],
 *   duration?: number,
 *   end_of_turn_confidence?: number,
 *   channel?: number,
 *   error?: string,
 *   raw?: object,
 * }} SttWsEvent
 */

export class StreamingSttSession {
  /**
   * @param {{
   *   onEvent?: (ev: SttWsEvent) => void,
   *   onReady?: () => void,
   *   onClose?: (info?: object) => void,
   *   onError?: (err: Error) => void,
   * }} handlers
   */
  constructor(handlers = {}) {
    this.onEvent = handlers.onEvent || (() => {});
    this.onReady = handlers.onReady || (() => {});
    this.onClose = handlers.onClose || (() => {});
    this.onError = handlers.onError || (() => {});
    /** @type {WebSocket | null} */
    this.ws = null;
    this.ready = false;
    this.closed = false;
    this._openedAt = 0;
    this.url = '';
  }

  get connected() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN && this.ready;
  }

  /**
   * @param {SttWsConfig} config
   * @param {{
   *   token?: string,
   *   apiKey?: string,
   *   longLivedKey?: string,
   *   baseUrl?: string,
   *   forceDnr?: boolean,
   * }} [opts]
   *   token — handshake credential (ephemeral preferred; falls back to apiKey)
   *   apiKey / longLivedKey — long-lived XAI_API_KEY for classification + DNR
   *   baseUrl — force HTTPS root (…/v1). Pass relay when set so WS is not
   *   pinned to direct api.x.ai by REST auto-route.
   */
  async open(config = {}, opts = {}) {
    if (this.ws) this.close();
    this.closed = false;
    this.ready = false;

    const params = new URLSearchParams();
    params.set('sample_rate', String(config.sample_rate ?? 16000));
    params.set('encoding', config.encoding || 'pcm');
    params.set(
      'interim_results',
      config.interim_results === false ? 'false' : 'true',
    );
    // Silence ms before speech_final — lower = snappier turns (live dubbing)
    params.set('endpointing', String(config.endpointing ?? 280));
    if (config.language) params.set('language', String(config.language));
    if (typeof config.vad_threshold === 'number') {
      params.set('vad_threshold', String(config.vad_threshold));
    }
    if (config.filler_words) params.set('filler_words', 'true');
    if (typeof config.smart_turn === 'number') {
      params.set('smart_turn', String(config.smart_turn));
      params.set(
        'smart_turn_timeout',
        String(config.smart_turn_timeout ?? 1400),
      );
    }
    for (const term of config.keyterms || []) {
      const t = String(term || '').trim().slice(0, 50);
      if (t) params.append('keyterm', t);
    }

    const qs = params.toString();
    const baseUrl = String(opts.baseUrl || '').trim() || undefined;
    const rawUrl = resolveXaiWsUrl(`/stt?${qs}`, baseUrl);
    const longLived = String(
      opts.longLivedKey || opts.apiKey || '',
    ).trim();
    const token = String(opts.token || opts.apiKey || '').trim();
    this._openedAt = performance.now();

    // Relay _av_key | ephemeral protocol. Never bare DNR on direct api.x.ai
    // (Chrome cannot set Authorization on WebSocket → "no valid credentials").
    const primary = prepareAuthenticatedWs(rawUrl, token, {
      apiKey: longLived,
      forceDnr: !!opts.forceDnr,
    });
    const label = primary.mode || (primary.protocols ? 'protocol' : 'none');
    if (!token) {
      throw new Error(
        'STT WS: no auth token (set XAI_API_KEY in extension settings)',
      );
    }
    const direct = isDirectXaiWsUrl(primary.url);
    if (direct && !(primary.mode === 'protocol' && primary.protocols?.length)) {
      throw new Error(
        'STT WS: direct api.x.ai needs ephemeral client_secret protocol or CF/local relay (_av_key). ' +
          'Chrome cannot set Authorization on WebSocket (DNR ignored).',
      );
    }

    try {
      await this.#connectOnce({
        url: primary.url,
        protocols: primary.protocols,
        label,
      });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      log.warn('STT WS open failed', label, err.message);
      try {
        this.ws?.close?.();
      } catch {
        /* ignore */
      }
      this.ws = null;
      this.ready = false;
      if (/auth|credential|401|403|closed before ready|1006|no valid/i.test(err.message)) {
        throw new Error(
          `STT WebSocket auth failed (host=${hostOf(primary.url)}, auth=${label}). ` +
            'Chrome cannot set Authorization on WebSocket — mint ephemeral ' +
            'client_secret protocol, use CF/local relay (_av_key), or REST STT fallback.',
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
        ws.binaryType = 'arraybuffer';

        // SW open budget races at ~5.5s then falls back to native; keep this
        // slightly under that so finishErr wins with a clear message.
        // (stream-bridge content timeout is 12s — must never sit silent that long.)
        const openTimer = setTimeout(() => {
          if (!this.ready) {
            try {
              ws.close();
            } catch {
              /* ignore */
            }
            finishErr(new Error('STT WS ready timeout'));
          }
        }, 5000);

        const markReady = (reason) => {
          if (this.ready) return;
          this.ready = true;
          clearTimeout(openTimer);
          log.debug('STT WS ready', reason, label);
          this.onReady();
          finishOk();
        };

        ws.onopen = () => {
          log.debug(
            'STT WS open',
            this.url.replace(/([?&])_av_key=[^&]*/g, '$1_av_key=***').slice(0, 100),
            label,
          );
          // Wait for transcript.created before sending audio (docs).
        };

        ws.onmessage = (ev) => {
          let data = ev.data;
          if (typeof data !== 'string') {
            return;
          }
          let msg;
          try {
            msg = JSON.parse(data);
          } catch {
            return;
          }
          const type = String(msg?.type || msg?.event || '').toLowerCase();
          // Server ready — several historical / nested shapes
          if (
            type === 'transcript.created' ||
            type === 'created' ||
            type === 'session.created' ||
            type === 'ready' ||
            msg?.status === 'ready'
          ) {
            this.onEvent({ type: 'transcript.created', raw: msg });
            markReady(type || 'created');
            return;
          }
          if (type === 'error' || msg?.error) {
            const errText =
              msg?.error?.message ||
              msg?.message ||
              msg?.error ||
              'STT WS error';
            const err = new Error(String(errText));
            this.onError(err);
            this.onEvent({ type: 'error', error: String(errText), raw: msg });
            if (!this.ready) {
              clearTimeout(openTimer);
              finishErr(err);
            }
            return;
          }
          if (type === 'transcript.done') {
            if (!this.ready) markReady('transcript.done');
            this.onEvent({
              type: 'transcript.done',
              text: String(msg?.text || '').trim(),
              duration: msg?.duration,
              words: msg?.words || [],
              raw: msg,
            });
            return;
          }
          if (
            type === 'transcript.partial' ||
            type === 'results' ||
            msg?.channel ||
            msg?.is_final != null ||
            msg?.speech_final != null
          ) {
            // Defensive: some paths emit partials without an explicit created event
            if (!this.ready) {
              markReady('first-partial');
              this.onEvent({ type: 'transcript.created', raw: { inferred: true } });
            }
            const alt =
              msg?.channel?.alternatives?.[0] ||
              msg?.alternatives?.[0] ||
              null;
            const text = String(
              msg?.text ?? alt?.transcript ?? alt?.text ?? '',
            ).trim();
            const isFinal = !!(
              msg?.is_final ??
              msg?.isFinal ??
              (type === 'transcript.done')
            );
            const speechFinal = !!(
              msg?.speech_final ??
              msg?.speechFinal ??
              false
            );
            this.onEvent({
              type: type || 'transcript.partial',
              text,
              is_final: isFinal,
              speech_final: speechFinal,
              words: msg?.words || alt?.words || [],
              end_of_turn_confidence:
                msg?.end_of_turn_confidence ?? msg?.endOfTurnConfidence,
              raw: msg,
            });
            return;
          }
          if (type === 'transcript.done') {
            if (!this.ready) markReady('transcript.done');
            this.onEvent({
              type: 'transcript.done',
              text: String(msg?.text || '').trim(),
              duration: msg?.duration,
              words: msg?.words || [],
              raw: msg,
            });
            return;
          }
          log.debug('STT WS unknown msg', type || Object.keys(msg || {}).slice(0, 6));
          this.onEvent({ type: type || 'unknown', raw: msg, text: msg?.text });
        };

        ws.onerror = () => {
          const host = (() => {
            try {
              return new URL(this.url).host;
            } catch {
              return 'unknown';
            }
          })();
          const err = new Error(
            `STT WebSocket error (host=${host}, auth=${label})`,
          );
          // Only surface after handshake ready — pre-ready errors may be retried
          if (this.ready) this.onError(err);
          if (!this.ready) {
            clearTimeout(openTimer);
            finishErr(err);
          }
        };

        ws.onclose = (ev) => {
          clearTimeout(openTimer);
          const wasReady = this.ready;
          this.ready = false;
          this.ws = null;
          const host = (() => {
            try {
              return new URL(this.url).host;
            } catch {
              return 'unknown';
            }
          })();
          const detail = {
            code: ev.code,
            reason: ev.reason || '',
            host,
            wasClean: !!ev.wasClean,
            auth: label,
          };
          if (wasReady) {
            log.warn('STT WS closed', detail);
            this.onClose(detail);
          } else {
            log.debug('STT WS connect closed', detail);
          }
          if (!settled) {
            const hint =
              ev.code === 1006 || /auth|credential/i.test(ev.reason || '')
                ? ' (auth — xai-client-secret protocol or CF relay _av_key)'
                : '';
            finishErr(
              new Error(
                `STT WS closed before ready (${ev.code} ${
                  ev.reason || 'no reason'
                } host=${host} auth=${label})${hint}`,
              ),
            );
          }
        };
      } catch (e) {
        finishErr(e);
      }
    });
  }

  /**
   * Send raw PCM16 LE bytes (or ArrayBuffer / Uint8Array).
   * @param {ArrayBuffer | Uint8Array} pcm
   */
  sendPcm(pcm) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.ready) {
      return false;
    }
    try {
      const buf =
        pcm instanceof ArrayBuffer
          ? pcm
          : pcm?.buffer
            ? pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)
            : null;
      if (!buf || buf.byteLength === 0) return false;
      this.ws.send(buf);
      return true;
    } catch (e) {
      log.debug('STT sendPcm failed', e?.message || e);
      return false;
    }
  }

  /** Force speech_final on current utterance (session stays open). */
  finalize() {
    // Docs use "Finalize"; accept lowercase servers too via type field
    this.#sendJson({ type: 'Finalize' });
  }

  /** End stream; server flushes and closes. */
  audioDone() {
    this.#sendJson({ type: 'audio.done' });
  }

  #sendJson(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(obj));
    } catch (e) {
      log.debug('STT json send failed', e?.message || e);
    }
  }

  close() {
    this.closed = true;
    this.ready = false;
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    try {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'audio.done' }));
        } catch {
          /* ignore */
        }
        ws.close(1000, 'client close');
      } else if (ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    } catch {
      /* ignore */
    }
  }
}
