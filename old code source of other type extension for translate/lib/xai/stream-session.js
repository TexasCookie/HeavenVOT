/**
 * Background long-lived stream hub for one content-script Port.
 *
 * This IS the in-extension native relay (no Node, no Options required):
 *   content ──Port──► SW ──(WS protocol | fetch+Authorization)──► api.x.ai
 *
 * External `tools/xai-relay-local.mjs` is optional bonus only.
 */

import { log } from '../logger.js';
import { getActiveBaseUrl, normalizeRelayBase } from '../network/router.js';
import { naturalizeForTts } from '../voices.js';
import { StreamingSttSession } from './stt-ws.js';
import { StreamingTtsSession } from './tts-ws.js';
import {
  arrayBufferToBase64,
  nativeRestStreamTts,
} from './native-rest-stream.js';
import { NativeSttStreamSession } from './native-stt-stream.js';
import {
  clearDirectProtocolAuth,
  ensureWsAuthRules,
  isDirectProtocolAuthKnownBroken,
  isEphemeralWsToken,
  markDirectProtocolAuth,
  NATIVE_LOCAL_RELAY_BASE,
  planNativeWsAuth,
  quantizeTtsSpeed,
  resolveBrowserStreamingRoute,
} from './ws-auth.js';

export class StreamPortSession {
  /**
   * @param {chrome.runtime.Port} port
   * @param {{
   *   getApiKey: () => Promise<string>,
   *   getRelayBase?: () => Promise<string>,
   *   ensureNetwork?: () => Promise<object>,
   *   createClientSecret?: (opts?: { forceRefresh?: boolean }) =>
   *     Promise<{ value: string, expires_at?: number }>,
   * }} deps
   */
  constructor(port, deps) {
    this.port = port;
    this.getApiKey = deps.getApiKey;
    this.getRelayBase = deps.getRelayBase || (async () => '');
    this.ensureNetwork = deps.ensureNetwork || (async () => ({}));
    this.createClientSecret = deps.createClientSecret || null;
    this.isLocalProvider = deps.isLocalProvider || (async () => false);
    /** @type {StreamingSttSession | NativeSttStreamSession | null} */
    this.stt = null;
    /** @type {'ws'|'native-rest'|''} */
    this._sttMode = '';
    /** @type {StreamingTtsSession | null} */
    this.tts = null;
    this._ttsVoiceKey = '';
    this.alive = true;
    this._pcmBytes = 0;
    this._sttOpenedAt = 0;
    /** Last open_stt config (for native failover) */
    this._sttConfig = null;
    /** Cached ephemeral browser WS token */
    this._clientSecret = null;
    this._clientSecretExpiresAt = 0;
    /** Serialize open_stt / ignore superseded generations */
    this._sttOpenGen = 0;
    this._sttWsAttempt = 0;
    this._sttOpenInFlight = null;
    /**
     * After repeated TTS WS auth failures on direct api.x.ai, stop opening
     * new sockets (each dynamic speed was reconnecting → console spam).
     * Content falls back to REST TTS. Cleared when port disposes / new secret works.
     */
    this._ttsWsAuthBroken = false;
    this._ttsWsAuthFails = 0;

    port.onMessage.addListener((msg) => {
      this.#onMessage(msg).catch((e) => {
        log.warn('stream port msg', e?.message || e);
        this.#post({ type: 'error', error: String(e?.message || e) });
      });
    });
    port.onDisconnect.addListener(() => {
      this.dispose();
    });
  }

  #post(msg) {
    if (!this.alive) return;
    try {
      this.port.postMessage(msg);
    } catch {
      this.dispose();
    }
  }

  /**
   * Race a promise against a wall-clock budget. Does not cancel the work.
   * @template T
   * @param {Promise<T>} promise
   * @param {number} ms
   * @param {string} label
   * @returns {Promise<T>}
   */
  #withBudget(promise, ms, label, onTimeout) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          onTimeout?.();
        } catch {
          /* ignore */
        }
        reject(new Error(label || `budget ${ms}ms exceeded`));
      }, Math.max(50, ms));
      promise.then(
        (v) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  async #ensureAuth(opts = {}) {
    // Apply route (direct / relay / proxy) before any WS — SW may be cold.
    // Soft path (service-worker ensureNetwork soft:true) must stay fast.
    try {
      await this.ensureNetwork();
    } catch (e) {
      log.warn('stream ensureNetwork', e?.message || e);
    }
    const key = await this.getApiKey();
    if (!key) throw new Error('Нет XAI_API_KEY для streaming WS');
    let relay = '';
    try {
      relay = (await this.getRelayBase()) || '';
    } catch {
      relay = '';
    }
    // Also use active base if it is a relay (not api.x.ai)
    const active = getActiveBaseUrl() || '';
    if (!relay && active && !/api\.x\.ai/i.test(active)) {
      relay = normalizeRelayBase(active) || active;
    }
    // Local twin probe is opt-in (forceLocalDiscover) or when we already have
    // a user/active relay. Cold open skips discover so we don't hang on :8787.
    const skipLocal =
      opts.skipLocalDiscover === true ||
      (!opts.forceLocalDiscover && !relay);
    const route = await resolveBrowserStreamingRoute({
      apiKey: key,
      relayBase: relay,
      activeBase: active,
      forceLocalDiscover: !!opts.forceLocalDiscover,
      skipLocalDiscover: skipLocal,
    });
    // Best-effort DNR — never block open on DNR install failures
    let dnr = { mode: 'skipped', ok: false };
    try {
      dnr = await this.#withBudget(
        ensureWsAuthRules(key, {
          relayBase: route.relay || relay,
          force: false,
        }),
        1200,
        'DNR install budget',
      );
    } catch (e) {
      log.debug('stream DNR skip', e?.message || e);
    }
    log.debug('stream WS route', {
      restBase: active,
      wsBase: route.wsBase,
      viaRelay: route.viaRelay,
      source: route.source,
      relay: route.relay ? String(route.relay).slice(0, 64) : '',
      localRelay: route.localRelay
        ? String(route.localRelay).slice(0, 48)
        : '',
      nativeLocal: NATIVE_LOCAL_RELAY_BASE,
      dnrMode: dnr?.mode || 'unknown',
      dnrOk: !!dnr?.ok,
    });
    return {
      apiKey: key,
      relay: route.relay || relay || route.localRelay,
      viaRelay: route.viaRelay,
      wsBase: route.wsBase,
      source: route.source,
      dnrMode: dnr?.mode || 'none',
      dnrOk: !!dnr?.ok,
    };
  }

  /**
   * Native failover: direct protocol/DNR unusable → force loopback twin
   * (tools/xai-relay-local.mjs on NATIVE_LOCAL_RELAY_BASE) if it is up.
   * This encodes the manual "start local relay" step the user would do.
   * @returns {Promise<object|null>} new auth or null if no local twin
   */
  async #tryNativeLocalRelayFailover() {
    try {
      const auth = await this.#ensureAuth({ forceLocalDiscover: true });
      if (auth.viaRelay && auth.wsBase && !/api\.x\.ai/i.test(auth.wsBase)) {
        log.info('native local relay failover', auth.wsBase.slice(0, 48));
        this._ttsWsAuthBroken = false;
        clearDirectProtocolAuth('all');
        return auth;
      }
    } catch (e) {
      log.debug('native local relay failover miss', e?.message || e);
    }
    return null;
  }

  /**
   * Credential for WebSocket handshake (native-first, zero user relay).
   * Relay: full API key in `_av_key` → worker sets Authorization.
   * Direct: mint ephemeral → Sec-WebSocket-Protocol (+ best-effort DNR Bearer
   *   with same token). Never put raw API key in protocol.
   * @param {{
   *   apiKey: string,
   *   relay?: string,
   *   viaRelay?: boolean,
   *   wsBase?: string,
   * }} auth
   * @param {{ forceRefresh?: boolean, preferDnr?: boolean }} [opts]
   * @returns {Promise<{ token: string, mode: string, strategy: string, forceDnr?: boolean }>}
   */
  async #wsCredential(auth, opts = {}) {
    const viaRelay =
      auth.viaRelay === true ||
      (!!auth.relay && !/api\.x\.ai/i.test(String(auth.relay))) ||
      (!!auth.wsBase && !/api\.x\.ai/i.test(String(auth.wsBase)));

    // Preferred direct path: mint ephemeral → native protocol.
    // Never open bare DNR Bearer on direct api.x.ai — Chrome cannot inject
    // Authorization on WebSocket upgrades ("no valid credentials available").
    let ephemeral = '';
    let mintError = '';
    if (!viaRelay && this.createClientSecret) {
      try {
        const minted = await this.createClientSecret({
          forceRefresh: !!opts.forceRefresh,
        });
        ephemeral = String(minted?.value || '').trim();
        if (ephemeral && isEphemeralWsToken(ephemeral, auth.apiKey)) {
          this._clientSecret = ephemeral;
          this._clientSecretExpiresAt = Number(minted?.expires_at) || 0;
          // New mint → allow another native attempt even if previously broken
          clearDirectProtocolAuth('all');
        } else {
          ephemeral = '';
          mintError = 'mint value rejected (not ephemeral)';
        }
      } catch (e) {
        mintError = String(e?.message || e);
        log.warn(
          'client_secret mint failed — direct WS needs relay or REST',
          mintError,
        );
        ephemeral = '';
      }
    } else if (
      !viaRelay &&
      this._clientSecret &&
      isEphemeralWsToken(this._clientSecret, auth.apiKey)
    ) {
      const now = Math.floor(Date.now() / 1000);
      if (
        !opts.forceRefresh &&
        this._clientSecretExpiresAt > now + 60
      ) {
        ephemeral = this._clientSecret;
      }
    }

    const plan = planNativeWsAuth({
      viaRelay,
      apiKey: auth.apiKey,
      ephemeralSecret: ephemeral || null,
    });
    if (!plan.ok) throw new Error(plan.error);

    // Browser cannot handshake with dnr-bearer alone — fail before opening WS
    if (!viaRelay && plan.strategy === 'dnr-bearer') {
      throw new Error(
        mintError
          ? `direct WS auth unavailable (client_secret mint failed: ${mintError}). ` +
              'Use CF/local relay (tools/xai-relay-*.js) or REST fallback.'
          : 'direct WS auth unavailable (need ephemeral client_secret or relay). ' +
              'Chrome cannot set Authorization on WebSocket.',
      );
    }

    // Best-effort DNR alongside protocol (some Chromium builds may inject)
    if (plan.installDnrToken) {
      try {
        await ensureWsAuthRules(plan.installDnrToken, {
          force: !!opts.forceRefresh || plan.strategy === 'protocol',
        });
      } catch {
        /* ignore — protocol/relay still viable */
      }
    }

    return {
      token: plan.token,
      mode: plan.mode,
      strategy: plan.strategy,
      forceDnr: false,
    };
  }

  async #onMessage(msg) {
    if (!msg || !this.alive) return;
    const type = msg.type;

    if (type === 'ping') {
      this.#post({ type: 'pong', t: Date.now() });
      return;
    }

    if (type === 'open_stt') {
      // Serialize: concurrent open_stt (soft reopen race) must not open two WS
      const gen = ++this._sttOpenGen;
      const run = this.#openStt(msg.config || {}, { gen });
      this._sttOpenInFlight = run;
      try {
        await run;
      } finally {
        if (this._sttOpenInFlight === run) this._sttOpenInFlight = null;
      }
      return;
    }

    if (type === 'stt_cancel_open') {
      // Content openStt timed out — supersede in-flight open, free the socket
      this._sttOpenGen += 1;
      try {
        this.stt?.close?.();
      } catch {
        /* ignore */
      }
      this.stt = null;
      this._sttMode = '';
      return;
    }

    if (type === 'stt_pcm') {
      let pcm = msg.pcm;
      if (!pcm) return;
      if (!this.stt?.connected) {
        // Drop quietly — content may reconnect
        return;
      }
      // Port structured-clone can deliver ArrayBuffer or {…} typed views
      if (!(pcm instanceof ArrayBuffer) && !(pcm instanceof Uint8Array)) {
        try {
          if (pcm?.buffer instanceof ArrayBuffer) {
            pcm = new Uint8Array(pcm.buffer, pcm.byteOffset || 0, pcm.byteLength || 0);
          } else {
            return;
          }
        } catch {
          return;
        }
      }
      const meta = {
        mediaTime: msg.mediaTime,
        duration: msg.duration,
      };
      const ok =
        this._sttMode === 'native-rest'
          ? this.stt.sendPcm(pcm, meta)
          : this.stt.sendPcm(pcm);
      if (ok) {
        const n =
          pcm.byteLength ||
          (pcm.buffer && pcm.byteLength) ||
          (pcm.length ? pcm.length * 2 : 0);
        this._pcmBytes += n || 0;
      }
      return;
    }

    if (type === 'stt_finalize') {
      this.stt?.finalize?.();
      return;
    }

    if (type === 'stt_close') {
      this.stt?.close?.();
      this.stt = null;
      this.#post({ type: 'stt_closed' });
      return;
    }

    if (type === 'tts_speak') {
      await this.#ttsSpeak(msg);
      return;
    }

    if (type === 'tts_close') {
      this.tts?.close?.();
      this.tts = null;
      this._ttsVoiceKey = '';
      return;
    }

    if (type === 'close') {
      this.dispose();
    }
  }

  #sttHandlers(gen) {
    return {
      onReady: () => {
        if (gen != null && gen !== this._sttOpenGen) return;
        this._sttOpenedAt = performance.now();
        this.#post({ type: 'stt_ready' });
      },
      onEvent: (ev) => {
        if (ev.type === 'transcript.created') return;
        if (ev.type === 'error') {
          // Server ASR timeouts close the socket; content soft-reopens.
          // Mark non-fatal so pipeline does not immediately abandon streaming.
          const errText = String(ev.error || 'STT error');
          const soft =
            /timed out|timeout|stream timed|pipeline/i.test(errText);
          this.#post({
            type: 'stt_error',
            error: errText,
            fatal: false,
            soft,
          });
          return;
        }
        if (ev.type === 'transcript.done') {
          this.#post({
            type: 'stt_done',
            text: ev.text || '',
            duration: ev.duration,
            words: ev.words || [],
          });
          return;
        }
        this.#post({
          type: 'stt_partial',
          text: ev.text || '',
          is_final: !!ev.is_final,
          speech_final: !!ev.speech_final,
          words: ev.words || [],
          end_of_turn_confidence: ev.end_of_turn_confidence,
        });
      },
      onError: (err) => {
        this.#post({ type: 'stt_error', error: err?.message || String(err) });
      },
      onClose: (info) => {
        this.#post({ type: 'stt_closed', ...info });
      },
    };
  }

  /**
   * @param {object} config
   * @param {{ gen?: number }} [opts]
   */
  /**
   * Full-quality native STT stream in SW (fetch+/v1/stt + VAD).
   * Same Port events as WS path — content pipeline unchanged.
   */
  async #openNativeStt(config, auth, gen) {
    if (!this.alive || gen !== this._sttOpenGen) return;
    try {
      this.stt?.close?.();
    } catch {
      /* ignore */
    }
    const key = auth?.apiKey || (await this.getApiKey());
    const native = new NativeSttStreamSession({
      onPartial: (ev) => {
        this.#post({
          type: 'stt_partial',
          text: ev.text || '',
          is_final: true,
          speech_final: true,
          words: ev.words || [],
          mediaStart: ev.mediaStart,
          mediaEnd: ev.mediaEnd,
          mode: 'native-rest-stream',
          latencyMs: ev.latencyMs,
        });
      },
      onError: (err) => {
        this.#post({
          type: 'stt_error',
          error: err?.message || String(err),
          fatal: false,
          soft: true,
        });
      },
    });
    await native.open({
      apiKey: key,
      baseUrl: getActiveBaseUrl() || auth?.wsBase || undefined,
      language: config?.language || '',
      keyterms: config?.keyterms || [],
    });
    if (!this.alive || gen !== this._sttOpenGen) {
      native.close();
      return;
    }
    this.stt = native;
    this._sttMode = 'native-rest';
    this._sttOpenedAt = performance.now();
    this.#post({ type: 'stt_ready', mode: 'native-rest-stream' });
    log.info('STT native stream open (SW fetch VAD — full /v1/stt, no relay)');
  }

  async #openStt(config, opts = {}) {
    const gen = opts.gen ?? ++this._sttOpenGen;
    this._sttConfig = config || {};

    // Local gateway: no xAI WS protocol — native REST STT + VAD only
    let local = false;
    try {
      local = !!(await this.isLocalProvider());
    } catch {
      local = false;
    }
    if (local) {
      this._ttsWsAuthBroken = true;
      let key = '';
      try {
        key = await this.getApiKey();
      } catch {
        key = 'local';
      }
      const auth = {
        apiKey: key || 'local',
        viaRelay: false,
        wsBase: getActiveBaseUrl() || '',
        relay: '',
        source: 'local-gateway',
      };
      log.info('STT → native SW stream (local provider)');
      await this.#openNativeStt(config, auth, gen);
      return;
    }

    /**
     * Content openStt defaults to 16s. Everything below MUST post stt_ready
     * (or fatal stt_error) before that, or the UI shows:
     *   "Streaming → REST fallback (STT stream open timeout)"
     *
     * Root cause of that toast: cold ensureNetwork auto-probe (2.8s × N) +
     * local :8787 discover + WS ready 14s often exceeded 16s with no reply.
     *
     * Policy (reliable first-audio):
     *   - direct / unknown protocol → native SW stream immediately
     *     (fetch + Authorization + VAD, full /v1/stt quality)
     *   - viaRelay or protocol known OK → try browser WS under a short budget,
     *     ALWAYS fall back to native (even when viaRelay fails)
     */
    const openNativeSafe = async (auth, reason) => {
      if (!this.alive || gen !== this._sttOpenGen) return;
      log.info('STT → native SW stream', reason || '');
      await this.#openNativeStt(config, auth, gen);
    };

    let auth;
    try {
      // Cap auth setup — never burn the whole content budget here
      auth = await this.#withBudget(
        this.#ensureAuth({ skipLocalDiscover: true }),
        3500,
        'STT ensureAuth budget',
      );
    } catch (e) {
      log.warn('STT ensureAuth budget/fail — native with raw key', e?.message || e);
      let key = '';
      try {
        key = await this.getApiKey();
      } catch {
        key = '';
      }
      if (!key) {
        this.#post({
          type: 'stt_error',
          error: e?.message || 'Нет XAI_API_KEY',
          fatal: true,
        });
        throw e instanceof Error ? e : new Error(String(e));
      }
      auth = {
        apiKey: key,
        viaRelay: false,
        wsBase: getActiveBaseUrl() || '',
        relay: '',
        source: 'direct-budget-fallback',
      };
    }
    if (!this.alive || gen !== this._sttOpenGen) return;

    const wantWs =
      !!auth.viaRelay || isDirectProtocolAuthKnownOk('stt');

    // Zero-config / broken protocol: native first — no local-relay detour
    // that can mis-detect :8787 and hang on WS until content times out.
    if (!wantWs || isDirectProtocolAuthKnownBroken('stt')) {
      try {
        await openNativeSafe(
          auth,
          isDirectProtocolAuthKnownBroken('stt')
            ? 'protocol marked broken'
            : 'direct zero-config',
        );
        return;
      } catch (eN) {
        log.warn('native STT open failed', eN?.message || eN);
        this.#post({
          type: 'stt_error',
          error: eN?.message || String(eN),
          fatal: true,
        });
        throw eN;
      }
    }

    /**
     * @param {{ token: string, mode: string, strategy?: string, forceDnr?: boolean }} c
     */
    const wsAttempt = ++this._sttWsAttempt || (this._sttWsAttempt = 1);
    const openWithCred = async (c) => {
      if (wsAttempt !== this._sttWsAttempt) return false;
      this.stt?.close?.();
      this.stt = new StreamingSttSession(this.#sttHandlers(gen));
      this._sttMode = 'ws';
      await this.stt.open(config, {
        token: c.token,
        apiKey: auth.apiKey,
        forceDnr: false,
        baseUrl: auth.wsBase,
      });
      if (gen !== this._sttOpenGen || wsAttempt !== this._sttWsAttempt) {
        try {
          this.stt?.close?.();
        } catch {
          /* ignore */
        }
        this.stt = null;
        this._sttMode = '';
        return false;
      }
      return true;
    };

    // WS under short budget (content still has ~12s left for native escape)
    const WS_OPEN_BUDGET_MS = 5500;
    try {
      await this.#withBudget(
        (async () => {
          let cred;
          try {
            cred = await this.#wsCredential(auth);
          } catch (e) {
            throw e instanceof Error ? e : new Error(String(e));
          }
          if (!this.alive || gen !== this._sttOpenGen) return;
          const ok = await openWithCred(cred);
          if (ok && !auth.viaRelay) markDirectProtocolAuth('stt', true);
        })(),
        WS_OPEN_BUDGET_MS,
        'STT WS open budget',
        () => {
          this._sttWsAttempt = (this._sttWsAttempt || 0) + 1;
        },
      );
      // Only accept a live WS session — mode flag alone can be stale after cancel
      if (this.stt?.connected) return;
    } catch (e) {
      if (!this.alive || gen !== this._sttOpenGen) return;
      const msg = String(e?.message || e);
      log.warn('STT WS open failed/budget — native fallback', msg);
      if (!auth.viaRelay) markDirectProtocolAuth('stt', false);
      try {
        this.stt?.close?.();
      } catch {
        /* ignore */
      }
      this.stt = null;
      this._sttMode = '';
      this._clientSecret = null;
      this._clientSecretExpiresAt = 0;
    }

    // Always prefer native over hard fail (relay down / WS hung / mint stuck)
    try {
      await openNativeSafe(auth, 'after WS miss');
    } catch (eN) {
      if (gen !== this._sttOpenGen) return;
      this.#post({
        type: 'stt_error',
        error: eN?.message || String(eN),
        fatal: true,
      });
      throw eN;
    }
  }

  /**
   * In-extension native TTS "relay": fetch + Authorization in the SW.
   * Same max quality as external local relay, zero process for the user.
   */
  async #ttsSpeakNativeRest(params) {
    const {
      id,
      text,
      voice,
      language,
      speed,
      codec,
      opt,
      sample_rate,
      bit_rate,
      text_normalization,
      apiKey,
      baseUrl,
    } = params;
    const result = await nativeRestStreamTts({
      apiKey,
      text,
      voice_id: voice,
      language,
      speed,
      codec,
      sample_rate: sample_rate ?? 24000,
      bit_rate: bit_rate ?? 128000,
      optimize_streaming_latency: opt,
      text_normalization: text_normalization !== false,
      // REST uses active HTTPS base (Authorization works); not WS host
      baseUrl: baseUrl || getActiveBaseUrl() || undefined,
      onFirstByte: (info) => {
        this.#post({
          type: 'tts_first_byte',
          id,
          latencyMs: info.latencyMs,
          byteLength: info.byteLength,
        });
      },
    });
    this.#post({
      type: 'tts_audio_done',
      id,
      // Binary preferred (structured clone); base64 kept for older content builds
      audioBuffer: result.buffer,
      audioBase64: arrayBufferToBase64(result.buffer),
      contentType: result.contentType,
      voice_id: result.voice_id || voice,
      firstByteMs: result.firstByteMs,
      totalMs: result.totalMs,
      bytes: result.bytes,
      mode: 'native-rest-stream',
    });
    return result;
  }

  async #ttsSpeak(msg) {
    const id = msg.id || `t${Date.now()}`;
    const rawText = String(msg.text || '').trim();
    if (!rawText) {
      this.#post({ type: 'tts_error', id, error: 'empty text' });
      return;
    }

    const voice = String(msg.voice_id || msg.voice || 'ara').toLowerCase();
    const language = msg.language || 'ru';
    const speed = quantizeTtsSpeed(msg.speed ?? 1.05);
    const codec = msg.codec || 'mp3';
    const opt =
      msg.optimize_streaming_latency === 0 ||
      msg.optimize_streaming_latency === '0'
        ? 0
        : 1;
    const expressive = msg.expressiveSpeech !== false;
    const text = naturalizeForTts(rawText, { expressiveSpeech: expressive });
    const sample_rate = msg.sample_rate ?? 24000;
    const bit_rate = msg.bit_rate ?? 128000;
    const text_normalization = msg.text_normalization !== false;

    try {
      let auth = await this.#ensureAuth();

      // Direct api.x.ai (no CF/local relay): never open browser WebSocket TTS.
      // Chrome cannot set Authorization on WS upgrades (DNR ignored) → console:
      //   "HTTP Authentication failed; no valid credentials available"
      // Ephemeral client_secret protocol is Realtime-oriented and often rejected
      // on /v1/tts. SW fetch + Authorization (native REST stream) is the default
      // zero-config path. Streaming WS only when viaRelay injects _av_key.
      if (!auth.viaRelay) {
        const failOver = await this.#tryNativeLocalRelayFailover();
        if (failOver?.viaRelay) {
          auth = failOver;
        } else {
          // Sticky for this port: content StreamBridge may skip WS speak attempts
          if (!this._ttsWsAuthBroken) {
            this._ttsWsAuthBroken = true;
            if (!isDirectProtocolAuthKnownBroken('tts')) {
              markDirectProtocolAuth('tts', false);
              log.info(
                'TTS: direct path uses SW native REST (no browser WS auth)',
              );
            }
          }
          await this.#ttsSpeakNativeRest({
            id,
            text,
            voice,
            language,
            speed,
            codec,
            opt,
            sample_rate,
            bit_rate,
            text_normalization,
            apiKey: auth.apiKey,
            baseUrl: getActiveBaseUrl() || auth.wsBase,
          });
          return;
        }
      }

      /** @type {{ token: string, mode: string }|null} */
      let cred = null;
      try {
        cred = await this.#wsCredential(auth);
      } catch (credErr) {
        if (!auth.viaRelay) {
          const failOver = await this.#tryNativeLocalRelayFailover();
          if (failOver?.viaRelay) {
            auth = failOver;
            try {
              cred = await this.#wsCredential(auth);
            } catch {
              cred = null;
            }
          }
        }
        if (!cred) {
          // Embedded native relay: fetch+Authorization (no external process)
          this._ttsWsAuthBroken = true;
          if (!auth.viaRelay) markDirectProtocolAuth('tts', false);
          log.info(
            'TTS WS cred unavailable — native in-extension REST stream',
            credErr?.message || credErr,
          );
          await this.#ttsSpeakNativeRest({
            id,
            text,
            voice,
            language,
            speed,
            codec,
            opt,
            sample_rate,
            bit_rate,
            text_normalization,
            apiKey: auth.apiKey,
            baseUrl: getActiveBaseUrl() || undefined,
          });
          return;
        }
      }

      const makeVoiceKey = () =>
        `${voice}|${language}|${speed.toFixed(2)}|${codec}|${opt}|${auth.wsBase || ''}`;
      let voiceKey = makeVoiceKey();

      if (!this.tts?.connected || this._ttsVoiceKey !== voiceKey) {
        const openCfg = {
          voice,
          language,
          speed,
          codec,
          sample_rate,
          bit_rate,
          optimize_streaming_latency: opt,
          text_normalization,
        };
        const openTts = async (c) => {
          this.tts?.close?.();
          this.tts = new StreamingTtsSession({
            onError: (err) =>
              this.#post({
                type: 'tts_error',
                id,
                error: err?.message || String(err),
              }),
          });
          await this.tts.open(openCfg, {
            token: c.token,
            apiKey: auth.apiKey,
            forceDnr: false,
            baseUrl: auth.wsBase,
          });
        };
        try {
          await openTts(cred);
          if (!auth.viaRelay) markDirectProtocolAuth('tts', true);
        } catch (openErr) {
          let lastErr =
            openErr instanceof Error ? openErr : new Error(String(openErr));
          const omsg = String(lastErr.message || lastErr);
          const authish =
            /auth|credential|401|403|protocol|no valid|closed before|1006|client secret/i.test(
              omsg,
            );
          if (authish && !auth.viaRelay) {
            log.warn('TTS open auth fail — re-mint / native failover', omsg);
            let recovered = false;
            try {
              cred = await this.#wsCredential(auth, { forceRefresh: true });
              await openTts(cred);
              markDirectProtocolAuth('tts', true);
              recovered = true;
            } catch (e2) {
              const failOver = await this.#tryNativeLocalRelayFailover();
              if (failOver?.viaRelay) {
                auth = failOver;
                voiceKey = makeVoiceKey();
                try {
                  cred = await this.#wsCredential(auth);
                  await openTts(cred);
                  recovered = true;
                } catch (e3) {
                  lastErr = e3 instanceof Error ? e3 : new Error(String(e3));
                }
              } else {
                lastErr = e2 instanceof Error ? e2 : new Error(String(e2));
              }
            }
            if (!recovered) {
              this._ttsWsAuthFails += 1;
              this._ttsWsAuthBroken = true;
              markDirectProtocolAuth('tts', false);
              try {
                this.tts?.close?.();
              } catch {
                /* ignore */
              }
              this.tts = null;
              this._ttsVoiceKey = '';
              log.info(
                'TTS WS failed — native in-extension REST stream (no local process)',
                lastErr.message,
              );
              await this.#ttsSpeakNativeRest({
                id,
                text,
                voice,
                language,
                speed,
                codec,
                opt,
                sample_rate,
                bit_rate,
                text_normalization,
                apiKey: auth.apiKey,
                baseUrl: getActiveBaseUrl() || undefined,
              });
              return;
            }
          } else if (authish) {
            this._ttsWsAuthFails += 1;
            this._ttsWsAuthBroken = true;
            try {
              this.tts?.close?.();
            } catch {
              /* ignore */
            }
            this.tts = null;
            this._ttsVoiceKey = '';
            await this.#ttsSpeakNativeRest({
              id,
              text,
              voice,
              language,
              speed,
              codec,
              opt,
              sample_rate,
              bit_rate,
              text_normalization,
              apiKey: auth.apiKey,
              baseUrl: getActiveBaseUrl() || undefined,
            });
            return;
          } else {
            throw lastErr;
          }
        }
        this._ttsVoiceKey = voiceKey;
        this._ttsWsAuthFails = 0;
      }

      let spins = 0;
      while (this.tts?.busy && spins < 80) {
        await new Promise((r) => setTimeout(r, 40));
        spins += 1;
      }

      const result = await this.tts.speak(text, {
        id,
        timeoutMs: msg.timeoutMs || 18000,
        onFirstByte: (info) => {
          this.#post({
            type: 'tts_first_byte',
            id,
            latencyMs: info.latencyMs,
            byteLength: info.byteLength,
          });
        },
        onDelta: (info) => {
          this.#post({
            type: 'tts_audio_delta',
            id,
            audioBase64: info.audioBase64,
            contentType: info.contentType,
          });
        },
      });

      this.#post({
        type: 'tts_audio_done',
        id,
        audioBase64: arrayBufferToBase64(result.buffer),
        contentType: result.contentType,
        voice_id: voice,
        firstByteMs: result.firstByteMs,
        totalMs: result.totalMs,
        bytes: result.bytes,
        mode: 'ws',
      });
    } catch (e) {
      const em = String(e?.message || e);
      if (
        /timeout|closed|not connected|busy|auth|credential|no valid/i.test(em)
      ) {
        try {
          this.tts?.close?.();
        } catch {
          /* ignore */
        }
        this.tts = null;
        this._ttsVoiceKey = '';
        // Last resort: native REST stream still in SW
        try {
          const key = await this.getApiKey();
          if (key && text) {
            log.info('TTS WS error — native REST stream recovery', em);
            this._ttsWsAuthBroken = true;
            markDirectProtocolAuth('tts', false);
            await this.#ttsSpeakNativeRest({
              id,
              text,
              voice,
              language,
              speed,
              codec,
              opt,
              sample_rate,
              bit_rate,
              text_normalization,
              apiKey: key,
              baseUrl: getActiveBaseUrl() || undefined,
            });
            return;
          }
        } catch (e2) {
          this.#post({
            type: 'tts_error',
            id,
            error: e2?.message || String(e2),
          });
          return;
        }
      }
      this.#post({
        type: 'tts_error',
        id,
        error: e?.message || String(e),
      });
    }
  }

  dispose() {
    if (!this.alive) return;
    this.alive = false;
    this._clientSecret = null;
    this._clientSecretExpiresAt = 0;
    this._ttsWsAuthBroken = false;
    this._ttsWsAuthFails = 0;
    // Session end does not permanently kill native auth — TTL handles that.
    try {
      this.stt?.close?.();
    } catch {
      /* ignore */
    }
    try {
      this.tts?.close?.();
    } catch {
      /* ignore */
    }
    this.stt = null;
    this._sttMode = '';
    this.tts = null;
    try {
      this.port.disconnect();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Wire chrome.runtime.onConnect for streaming ports.
 * @param {{
 *   getApiKey: () => Promise<string>,
 *   getRelayBase?: () => Promise<string>,
 *   ensureNetwork?: () => Promise<object>,
 *   createClientSecret?: (opts?: { forceRefresh?: boolean }) =>
 *     Promise<{ value: string, expires_at?: number }>,
 * }} deps
 */
export function attachStreamPortHandler(deps) {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'aethervox-stream') return;
    log.info('stream port connected', port.sender?.tab?.id);
    // eslint-disable-next-line no-new
    new StreamPortSession(port, deps);
  });
}
