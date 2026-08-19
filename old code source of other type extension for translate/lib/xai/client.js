import {
  DEFAULT_TRANSLATE_MODEL,
  LOCAL_AUTH_TOKEN,
  LOCAL_GATEWAY_BASE,
  XAI_BASE,
} from '../constants.js';
import { log } from '../logger.js';
import { getActiveBaseUrl, resolveXaiUrl } from '../network/router.js';

/**
 * Sticky MT transport: first success wins so we never pay double RTT
 * (responses empty/fail → chat was a common 2× latency bug on live).
 * @type {null | 'responses' | 'chat'}
 */
let preferredMtApi = null;

/** @type {boolean} */
let localMode = false;

export function setClientLocalMode(on) {
  localMode = !!on;
}

export function isClientLocalMode() {
  return localMode;
}

function extractResponseText(data) {
  if (!data) return '';
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  // Responses API: output[] → message → content[] → output_text
  const parts = [];
  for (const item of data.output || []) {
    if (item?.type === 'message') {
      for (const c of item.content || []) {
        if (c?.type === 'output_text' && c.text) parts.push(c.text);
        else if (c?.text) parts.push(c.text);
      }
    } else if (item?.content) {
      for (const c of item.content || []) {
        if (c?.text) parts.push(c.text);
      }
    }
  }
  if (parts.length) return parts.join('\n').trim();
  return String(data?.choices?.[0]?.message?.content || '').trim();
}

function messagesHaveImage(messages) {
  for (const m of messages || []) {
    const c = m?.content;
    if (!Array.isArray(c)) continue;
    for (const p of c) {
      if (
        p?.type === 'input_image' ||
        p?.type === 'image_url' ||
        p?.image_url
      ) {
        return true;
      }
    }
  }
  return false;
}

export class XaiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'XaiError';
    this.status = status;
    this.body = body;
  }
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Shared xAI HTTP client with retries for 429/5xx.
 * API key stays in background / offscreen — never logged.
 * Base URL can be direct api.x.ai or a user relay (low-ping RU path).
 */
export class XaiClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  setApiKey(key) {
    this.apiKey = key;
  }

  /** Current API root (.../v1), may be relay */
  get base() {
    return getActiveBaseUrl() || XAI_BASE;
  }

  url(path) {
    const p = path.startsWith('/') ? path : `/${path}`;
    return resolveXaiUrl(`${this.base}${p}`);
  }

  get headersJson() {
    const key = this.apiKey || (localMode ? LOCAL_AUTH_TOKEN : '');
    return {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    };
  }

  get headersAuth() {
    const key = this.apiKey || (localMode ? LOCAL_AUTH_TOKEN : '');
    return { Authorization: `Bearer ${key}` };
  }

  assertKey() {
    if (localMode) return;
    if (!this.apiKey || !String(this.apiKey).trim()) {
      throw new XaiError(
        'Нет XAI_API_KEY. Открой настройки AetherVox и вставь ключ с console.x.ai (или включи Local provider)',
        401,
      );
    }
  }

  async fetchWithRetry(
    url,
    init,
    {
      // Live pipeline: default 1 retry — 3× with 0.5–8s sleeps was a major source of 10–15s "ping"
      retries = 1,
      retryOn = [429, 500, 502, 503],
      /** Cap hung fetches so SW can answer before content sendMessage timeout */
      timeoutMs = 0,
    } = {},
  ) {
    this.assertKey();
    const finalUrl = resolveXaiUrl(url);
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ac =
        timeoutMs > 0 && typeof AbortController !== 'undefined'
          ? new AbortController()
          : null;
      let timer = null;
      if (ac) {
        timer = setTimeout(() => {
          try {
            ac.abort();
          } catch {
            /* ignore */
          }
        }, timeoutMs);
      }
      try {
        const res = await fetch(finalUrl, {
          ...init,
          signal: ac
            ? typeof AbortSignal !== 'undefined' && AbortSignal.any && init?.signal
              ? AbortSignal.any([ac.signal, init.signal])
              : ac.signal
            : init?.signal,
        });
        if (timer) clearTimeout(timer);
        if (res.ok) return res;
        const text = await res.text().catch(() => '');
        if (retryOn.includes(res.status) && attempt < retries) {
          const wait = Math.min(2500, 350 * 2 ** attempt);
          log.warn(`xAI ${res.status}, retry in ${wait}ms`, finalUrl);
          await sleep(wait);
          continue;
        }
        throw new XaiError(
          `xAI error ${res.status}: ${text.slice(0, 400) || res.statusText}`,
          res.status,
          text,
        );
      } catch (e) {
        if (timer) clearTimeout(timer);
        lastErr = e;
        if (e instanceof XaiError) throw e;
        const aborted =
          e?.name === 'AbortError' || /aborted|AbortError/i.test(String(e?.message || e));
        if (aborted) {
          const timedOut = !!(ac && ac.signal && ac.signal.aborted && timeoutMs > 0);
          throw new XaiError(
            timedOut ? `fetch timeout ${timeoutMs}ms` : 'fetch aborted',
            timedOut ? 408 : 499,
          );
        }
        if (attempt < retries) {
          await sleep(280 * 2 ** attempt);
          continue;
        }
        throw new XaiError(String(e?.message || e), 0);
      }
    }
    throw lastErr;
  }

  async validateKey() {
    this.assertKey();
    // Lightweight call: list TTS voices
    const res = await this.fetchWithRetry(this.url('/tts/voices'), {
      method: 'GET',
      headers: this.headersAuth,
    }, { retries: 1 });
    const data = await res.json();
    return { ok: true, voices: data.voices || [] };
  }

  async listVoices() {
    this.assertKey();
    const res = await this.fetchWithRetry(
      this.url('/tts/voices'),
      { method: 'GET', headers: this.headersAuth },
      { retries: 1 },
    );
    const data = await res.json();
    return data.voices || [];
  }

  /**
   * Normalize messages for Responses API (input_image / input_text / plain string).
   * Accepts either plain string content or multimodal content arrays.
   */
  #toResponsesInput(messages) {
    return (messages || []).map((m) => {
      const c = m.content;
      if (typeof c === 'string' || c == null) {
        return { role: m.role, content: c ?? '' };
      }
      if (!Array.isArray(c)) {
        return { role: m.role, content: String(c) };
      }
      // Already Responses-shaped or mixed — normalize each part
      const parts = c.map((p) => {
        if (!p || typeof p === 'string') {
          return { type: 'input_text', text: String(p || '') };
        }
        if (p.type === 'input_image' || p.type === 'image_url' || p.image_url) {
          const url =
            typeof p.image_url === 'string'
              ? p.image_url
              : p.image_url?.url || p.url || '';
          const detail = p.detail || p.image_url?.detail || 'high';
          return {
            type: 'input_image',
            image_url: url,
            detail,
          };
        }
        if (p.type === 'input_text' || p.type === 'text' || p.text != null) {
          return { type: 'input_text', text: String(p.text ?? p.content ?? '') };
        }
        return p;
      });
      return { role: m.role, content: parts };
    });
  }

  /**
   * Normalize messages for chat/completions (OpenAI vision shape).
   */
  #toChatMessages(messages) {
    return (messages || []).map((m) => {
      const c = m.content;
      if (typeof c === 'string' || c == null) {
        return { role: m.role, content: c ?? '' };
      }
      if (!Array.isArray(c)) {
        return { role: m.role, content: String(c) };
      }
      const parts = c.map((p) => {
        if (!p || typeof p === 'string') {
          return { type: 'text', text: String(p || '') };
        }
        if (p.type === 'input_image' || p.type === 'image_url' || p.image_url) {
          const url =
            typeof p.image_url === 'string'
              ? p.image_url
              : p.image_url?.url || p.url || '';
          const detail = p.detail || p.image_url?.detail || 'high';
          return {
            type: 'image_url',
            image_url: { url, detail },
          };
        }
        if (p.type === 'input_text' || p.type === 'text' || p.text != null) {
          return { type: 'text', text: String(p.text ?? p.content ?? '') };
        }
        return p;
      });
      return { role: m.role, content: parts };
    });
  }

  /**
   * @param {{
   *   messages: object[],
   *   model?: string,
   *   temperature?: number,
   *   max_tokens?: number,
   *   liveLatency?: boolean,
   *   forceApi?: 'responses'|'chat'|null,
   * }} opts
   */
  async chatCompletion({
    messages,
    model = DEFAULT_TRANSLATE_MODEL,
    temperature = 0.2,
    max_tokens = 800,
    liveLatency = false,
    forceApi = null,
    /** none|low|medium|high — live always forces none to skip CoT tokens */
    reasoningEffort = null,
  }) {
    const hasImage = messagesHaveImage(messages);
    // Live text MT: fewer retries (retry sleep was stacking into 15s "ping")
    const retries = liveLatency ? 0 : 1;
    const retryOn = [429, 500, 502, 503];
    // Live / local: never pay for reasoning tokens
    const effort = localMode
      ? null
      : reasoningEffort || (liveLatency ? 'none' : null);

    // Sticky API: avoid responses→empty→chat double RTT on every phrase
    /** @type {Array<'responses'|'chat'>} */
    let order;
    if (localMode) {
      // Local gateway / LM Studio: chat only (no xAI /responses)
      order = ['chat'];
    } else if (forceApi === 'responses' || forceApi === 'chat') {
      order = [forceApi];
    } else if (preferredMtApi === 'chat' && !hasImage) {
      order = ['chat'];
    } else if (preferredMtApi === 'responses') {
      order = hasImage ? ['responses'] : ['responses', 'chat'];
    } else if (hasImage) {
      // Vision: responses first (better multimodal), chat as backup once
      order = ['responses', 'chat'];
    } else if (liveLatency) {
      // Live text: chat first (snappy). Responses only if chat hard-fails.
      order = ['chat'];
    } else {
      order = ['responses', 'chat'];
    }

    let lastErr = null;
    for (let i = 0; i < order.length; i++) {
      const api = order[i];
      try {
        if (api === 'responses') {
          const input = this.#toResponsesInput(messages);
          /** @type {Record<string, unknown>} */
          const body = {
            model,
            input,
            temperature,
            max_output_tokens: max_tokens,
          };
          if (effort) {
            body.reasoning = { effort };
            body.reasoning_effort = effort;
          }
          const res = await this.fetchWithRetry(
            this.url('/responses'),
            {
              method: 'POST',
              headers: this.headersJson,
              body: JSON.stringify(body),
            },
            { retries, retryOn },
          );
          const data = await res.json();
          const text = extractResponseText(data);
          if (text) {
            preferredMtApi = 'responses';
            return { text, raw: data, api: 'responses' };
          }
          lastErr = new Error('responses empty text');
          log.debug('responses empty, try next', order[i + 1] || 'none');
          continue;
        }

        const chatMessages = this.#toChatMessages(messages);
        /** @type {Record<string, unknown>} */
        const chatBody = {
          model,
          messages: chatMessages,
          temperature,
          max_tokens,
        };
        if (effort) {
          chatBody.reasoning_effort = effort;
        }
        const res = await this.fetchWithRetry(
          this.url('/chat/completions'),
          {
            method: 'POST',
            headers: this.headersJson,
            body: JSON.stringify(chatBody),
          },
          { retries, retryOn },
        );
        const data = await res.json();
        const text = String(
          data?.choices?.[0]?.message?.content ?? '',
        ).trim();
        if (text) {
          preferredMtApi = 'chat';
          return { text, raw: data, api: 'chat' };
        }
        lastErr = new Error('chat empty text');
      } catch (e) {
        lastErr = e;
        log.debug(`MT ${api} failed`, e?.message || e);
        // On auth/model errors don't bother second transport with same key issues
        if (e?.status === 401 || e?.status === 403) throw e;
        // Live: one responses retry only on transport/5xx, not empty content
        if (
          liveLatency &&
          api === 'chat' &&
          !hasImage &&
          order.length === 1 &&
          e?.status !== 400
        ) {
          order.push('responses');
        }
      }
    }

    throw lastErr instanceof Error
      ? lastErr
      : new XaiError(String(lastErr || 'MT empty'), 0);
  }

  /**
   * Mint a short-lived browser WebSocket token.
   * Use with Sec-WebSocket-Protocol: `xai-client-secret.<value>`
   * (browser cannot set Authorization on WebSocket; DNR is unreliable in Chrome).
   * Documented for Realtime; primary direct-path auth for STT/TTS streaming too.
   * @param {{ expiresSeconds?: number }} [opts]
   * @returns {Promise<{ value: string, expires_at: number }>}
   */
  async createClientSecret(opts = {}) {
    this.assertKey();
    const seconds = Math.min(
      3600,
      Math.max(60, Number(opts.expiresSeconds) || 3600),
    );
    const res = await this.fetchWithRetry(this.url('/realtime/client_secrets'), {
      method: 'POST',
      headers: this.headersJson,
      body: JSON.stringify({
        expires_after: { seconds },
      }),
    });
    const data = await res.json();
    const value = String(data?.value || data?.client_secret || '').trim();
    if (!value) {
      throw new XaiError(
        'client_secrets: empty value in response',
        res.status,
        data,
      );
    }
    return {
      value,
      expires_at: Number(data?.expires_at) || Math.floor(Date.now() / 1000) + seconds,
    };
  }

  /**
   * REST STT — multipart WAV/PCM file.
   * @param {Blob} fileBlob
   * @param {{ language?: string, keyterms?: string[], format?: boolean, vad_threshold?: number }} opts
   */
  async speechToText(fileBlob, opts = {}) {
    const form = new FormData();
    // Docs: format=true requires language. With auto/omitted language, sending
    // format=true can 400 or empty the transcript — only enable when language set.
    const lang = opts.language ? String(opts.language).trim() : '';
    if (lang) {
      form.append('language', lang);
      if (opts.format !== false) form.append('format', 'true');
    } else if (opts.format === true) {
      // Explicit force without language still rejected by API — skip format
      log.debug('STT: format skipped (no language for ITN)');
    }
    if (opts.filler_words) form.append('filler_words', 'true');
    if (typeof opts.vad_threshold === 'number') {
      form.append('vad_threshold', String(opts.vad_threshold));
    }
    for (const term of opts.keyterms || []) {
      if (term && term.trim()) form.append('keyterm', term.trim().slice(0, 50));
    }
    // file MUST be last
    form.append('file', fileBlob, opts.filename || 'chunk.wav');

    const res = await this.fetchWithRetry(
      this.url('/stt'),
      {
        method: 'POST',
        headers: this.headersAuth,
        body: form,
      },
      // Live chunks: one retry max — stacked 429 sleeps were a latency trap.
      // Local Whisper often needs ≫8s; xAI REST should answer faster.
      {
        retries: 1,
        timeoutMs:
          Number(opts.timeoutMs) > 0
            ? Number(opts.timeoutMs)
            : localMode
              ? 90000
              : 8000,
      },
    );
    const data = await res.json();
    // Normalize common response shapes so callers always get .text
    if (data && typeof data.text !== 'string') {
      const alt =
        data?.transcript ||
        data?.text ||
        data?.channel?.alternatives?.[0]?.transcript ||
        data?.results?.channels?.[0]?.alternatives?.[0]?.transcript ||
        '';
      if (alt) data.text = String(alt);
    }
    return data;
  }

  /**
   * REST TTS → ArrayBuffer audio
   * Falls back to classic voices if preferred natural voice is unknown (404).
   */
  async textToSpeech({
    text,
    voice_id = 'ara',
    language = 'ru',
    speed = 1.0,
    codec = 'mp3',
    sample_rate = 24000,
    bit_rate = 128000,
    // API expects i32 0|1 (JSON number). String "1" → 422 deserialize error.
    // Values ≥2 were rejected historically; clamp to enum.
    optimize_streaming_latency = 1,
    text_normalization = true,
    fallback_voices = ['ara', 'carina', 'eve', 'sal'],
  }) {
    const chain = [];
    const primary = String(voice_id || 'ara').toLowerCase();
    chain.push(primary);
    for (const f of fallback_voices || []) {
      const id = String(f).toLowerCase();
      if (id && !chain.includes(id)) chain.push(id);
    }

    // Clamp to documented enum (0 quality, 1 low TTFB) — must stay JSON number (i32)
    const optLat =
      Number(optimize_streaming_latency) > 0 || optimize_streaming_latency === '1'
        ? 1
        : 0;
    const speedN = Number(speed);
    const sampleRateN = Number(sample_rate) || 24000;
    const bitRateN = Number(bit_rate) || 128000;

    let lastErr;
    for (const vid of chain) {
      try {
        const res = await this.fetchWithRetry(
          this.url('/tts'),
          {
            method: 'POST',
            headers: this.headersJson,
            body: JSON.stringify({
              text,
              voice_id: vid,
              language,
              speed: Number.isFinite(speedN) ? speedN : 1.0,
              optimize_streaming_latency: optLat,
              text_normalization: text_normalization !== false,
              output_format: {
                codec,
                sample_rate: sampleRateN,
                bit_rate: bitRateN,
              },
            }),
          },
          // don't retry 404 forever — try next voice; keep last-voice retries low for live latency
          { retries: vid === chain[chain.length - 1] ? 1 : 0, retryOn: [429, 500, 502, 503] },
        );
        const ctype = (res.headers.get('content-type') || '').toLowerCase();
        // Default: raw audio bytes. JSON only when with_timestamps (or some proxies).
        if (ctype.includes('application/json')) {
          const data = await res.json();
          const b64 = data?.audio || data?.audio_base64 || '';
          if (!b64) {
            throw new XaiError('TTS JSON response missing audio', res.status, data);
          }
          const binary = atob(String(b64));
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          return {
            buffer: bytes.buffer,
            contentType: data?.content_type || 'audio/mpeg',
            voice_id: vid,
            fellBack: vid !== primary,
          };
        }
        const buf = await res.arrayBuffer();
        if (!buf || buf.byteLength < 16) {
          throw new XaiError('TTS empty audio body', res.status);
        }
        return {
          buffer: buf,
          contentType: res.headers.get('content-type') || 'audio/mpeg',
          voice_id: vid,
          fellBack: vid !== primary,
        };
      } catch (e) {
        lastErr = e;
        // Unknown voice → try next; other errors on last attempt throw
        const status = e?.status;
        if (status === 404 || /unknown voice|voice_id|not found/i.test(String(e?.message || ''))) {
          log.warn(`TTS voice "${vid}" unavailable, trying fallback`);
          continue;
        }
        if (vid !== chain[chain.length - 1] && (status === 400 || status === 422)) {
          log.warn(`TTS voice "${vid}" rejected, trying fallback`, e.message);
          continue;
        }
        throw e;
      }
    }
    throw lastErr || new XaiError('TTS failed for all voices', 0);
  }
}
