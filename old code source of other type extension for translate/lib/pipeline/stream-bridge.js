/**
 * Content-side bridge to background StreamPortSession.
 * Long-lived Port: PCM → STT events, TTS speak → audio.
 */

import { log } from '../logger.js';
import { base64ToArrayBuffer } from '../pcm-utils.js';

export class StreamBridge {
  /**
   * @param {{
   *   onSttPartial?: (ev: object) => void,
   *   onSttReady?: () => void,
   *   onSttError?: (err: string, fatal?: boolean) => void,
   *   onSttClosed?: () => void,
   * }} handlers
   */
  constructor(handlers = {}) {
    this.handlers = handlers;
    /** @type {chrome.runtime.Port | null} */
    this.port = null;
    this.sttReady = false;
    this._ttsWaiters = new Map();
    this._connectGen = 0;
    /** @type {null | { resolve: Function, reject: Function }} */
    this._openWaiter = null;
    /**
     * Background marked TTS browser-WS unusable (direct api.x.ai without relay).
     * SW still serves speakTts via native REST; this flag only skips retries that
     * would open wss://api.x.ai and spam Chrome auth failures.
     */
    this.ttsAuthBroken = false;
    /** One-shot log for expected REST fallback */
    this._ttsAuthLogged = false;
    this._sttOpenGen = 0;
    this._sttOpenTimedOutGen = 0;
  }

  get connected() {
    return !!this.port;
  }

  connect() {
    if (this.port) return;
    this._connectGen += 1;
    const gen = this._connectGen;
    try {
      const port = chrome.runtime.connect({ name: 'aethervox-stream' });
      this.port = port;
      port.onMessage.addListener((msg) => this.#onMessage(msg));
      port.onDisconnect.addListener(() => {
        if (gen !== this._connectGen) return;
        this.port = null;
        this.sttReady = false;
        // Fail pending TTS
        for (const [, w] of this._ttsWaiters) {
          w.reject(new Error('stream port disconnected'));
        }
        this._ttsWaiters.clear();
        this.handlers.onSttClosed?.();
      });
    } catch (e) {
      log.warn('stream bridge connect failed', e?.message || e);
      this.port = null;
      throw e;
    }
  }

  disconnect() {
    this._connectGen += 1;
    this.sttReady = false;
    for (const [, w] of this._ttsWaiters) {
      w.reject(new Error('stream bridge closed'));
    }
    this._ttsWaiters.clear();
    try {
      this.port?.postMessage({ type: 'close' });
    } catch {
      /* ignore */
    }
    try {
      this.port?.disconnect();
    } catch {
      /* ignore */
    }
    this.port = null;
  }

  #post(msg) {
    if (!this.port) return false;
    try {
      this.port.postMessage(msg);
      return true;
    } catch (e) {
      log.debug('stream post failed', e?.message || e);
      this.port = null;
      this.sttReady = false;
      return false;
    }
  }

  /**
   * @param {object} config STT WS query config
   * @param {{ timeoutMs?: number }} [opts]
   */
  async openStt(config, opts = {}) {
    this.connect();
    this.sttReady = false;
    // Supersede any in-flight open (recover / re-open race).
    // Callers must treat "STT open superseded" as non-fatal (another open won).
    if (this._openWaiter) {
      try {
        this._openWaiter.reject(new Error('STT open superseded'));
      } catch {
        /* ignore */
      }
      this._openWaiter = null;
    }
    // SW posts stt_ready (native is near-instant; WS budget ~5.5s + native).
    // Keep content budget above SW open path but fail before dual 16s×2 death spiral.
    const timeoutMs = opts.timeoutMs ?? 12000;
    const myGen = ++this._sttOpenGen;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this._sttOpenTimedOutGen = myGen;
        if (this._openWaiter) this._openWaiter = null;
        // Abort in-flight SW open so a retry / REST fallback is not blocked
        try {
          this.#post({ type: 'stt_cancel_open' });
        } catch {
          /* ignore */
        }
        reject(new Error('STT stream open timeout'));
      }, timeoutMs);

      this._openWaiter = {
        resolve: () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this._openWaiter = null;
          this.sttReady = true;
          resolve(true);
        },
        reject: (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this._openWaiter = null;
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      };

      if (!this.#post({ type: 'open_stt', config })) {
        this._openWaiter.reject(new Error('stream port dead'));
      }
    });
  }

  /**
   * @param {ArrayBuffer | Uint8Array} pcm
   * @param {{ mediaTime?: number, duration?: number }} [meta]
   */
  sendPcm(pcm, meta = {}) {
    if (!this.sttReady || !this.port) return false;
    // Always send a detached copy — some worklet views share a recycled buffer
    // that gets overwritten before the Port structured-clone finishes.
    let payload = null;
    try {
      if (pcm instanceof ArrayBuffer) {
        payload = pcm.byteLength ? pcm.slice(0) : null;
      } else if (pcm instanceof Uint8Array || ArrayBuffer.isView(pcm)) {
        const u8 = pcm instanceof Uint8Array
          ? pcm
          : new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        if (u8.byteLength) {
          payload = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
        }
      }
    } catch {
      payload = null;
    }
    if (!payload || !payload.byteLength) return false;
    return this.#post({
      type: 'stt_pcm',
      pcm: payload,
      mediaTime: meta.mediaTime,
      duration: meta.duration,
    });
  }

  finalizeStt() {
    this.#post({ type: 'stt_finalize' });
  }

  closeStt() {
    this.sttReady = false;
    this.#post({ type: 'stt_close' });
  }

  /**
   * Streaming TTS via background WS.
   * @param {object} payload
   * @returns {Promise<{ audioBuffer: ArrayBuffer, contentType: string, voice_id: string, firstByteMs: number|null, totalMs: number|null }>}
   */
  async speakTts(payload) {
    if (this.ttsAuthBroken) {
      const err = new Error(
        'TTS WS auth broken for this session — use REST TTS / CF relay',
      );
      err.authBroken = true;
      throw err;
    }
    this.connect();
    const id = payload.id || `tts_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const timeoutMs = payload.timeoutMs || 18000;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._ttsWaiters.delete(id);
        reject(new Error(`TTS stream timeout ${timeoutMs}ms`));
      }, timeoutMs);

      this._ttsWaiters.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          this._ttsWaiters.delete(id);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          this._ttsWaiters.delete(id);
          reject(e);
        },
        onFirstByte: payload.onFirstByte,
      });

      if (
        !this.#post({
          type: 'tts_speak',
          id,
          text: payload.text,
          voice_id: payload.voice_id,
          language: payload.language,
          speed: payload.speed,
          codec: payload.codec || 'mp3',
          optimize_streaming_latency: payload.optimize_streaming_latency ?? 1,
          text_normalization: payload.text_normalization !== false,
          timeoutMs,
        })
      ) {
        clearTimeout(timer);
        this._ttsWaiters.delete(id);
        reject(new Error('stream port dead'));
      }
    });
  }

  #onMessage(msg) {
    if (!msg) return;
    const t = msg.type;

    if (t === 'stt_ready') {
      if (this._sttOpenTimedOutGen === this._sttOpenGen) return;
      this.sttReady = true;
      this._openWaiter?.resolve?.();
      this.handlers.onSttReady?.();
      return;
    }
    if (t === 'stt_partial') {
      this.handlers.onSttPartial?.(msg);
      return;
    }
    if (t === 'stt_done') {
      this.handlers.onSttPartial?.({
        ...msg,
        is_final: true,
        speech_final: true,
      });
      return;
    }
    if (t === 'stt_error') {
      // If open is still waiting, reject the promise once — caller handles fallback.
      // Do NOT also fire onSttError(fatal) → that double-counted streamFailCount.
      if (msg.fatal && this._openWaiter) {
        this._openWaiter.reject(new Error(msg.error || 'STT open failed'));
        return;
      }
      this.handlers.onSttError?.(msg.error || 'STT error', !!msg.fatal);
      return;
    }
    if (t === 'stt_closed') {
      this.sttReady = false;
      this.handlers.onSttClosed?.();
      return;
    }

    if (t === 'tts_first_byte') {
      const w = this._ttsWaiters.get(msg.id);
      w?.onFirstByte?.(msg);
      return;
    }
    if (t === 'tts_audio_done') {
      const w = this._ttsWaiters.get(msg.id);
      if (!w) return;
      try {
        // Prefer binary ArrayBuffer (native SW path) over base64
        const audioBuffer =
          msg.audioBuffer instanceof ArrayBuffer
            ? msg.audioBuffer
            : msg.audioBase64
              ? base64ToArrayBuffer(msg.audioBase64)
              : null;
        if (!audioBuffer) {
          w.reject(new Error('TTS done without audio'));
          return;
        }
        w.resolve({
          audioBuffer,
          contentType: msg.contentType || 'audio/mpeg',
          voice_id: msg.voice_id,
          firstByteMs: msg.firstByteMs ?? null,
          totalMs: msg.totalMs ?? null,
          mode: msg.mode || '',
        });
      } catch (e) {
        w.reject(e);
      }
      return;
    }
    if (t === 'tts_error') {
      if (msg.authBroken) {
        this.ttsAuthBroken = true;
        // SW already embeds native REST stream (fetch+Authorization); this flag
        // only means "skip further WS attempts" — not a product failure.
        if (!this._ttsAuthLogged) {
          this._ttsAuthLogged = true;
          log.info(
            'TTS WS unavailable — SW native REST stream / content REST',
            '(no external local relay required)',
          );
        }
      }
      const w = this._ttsWaiters.get(msg.id);
      if (w) {
        const err = new Error(msg.error || 'TTS stream error');
        if (msg.authBroken) err.authBroken = true;
        w.reject(err);
      }
      return;
    }
  }
}
