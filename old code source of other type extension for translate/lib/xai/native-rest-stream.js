/**
 * In-extension streaming TTS via fetch + Authorization.
 *
 * This is the embedded substitute for tools/xai-relay-local.mjs on the TTS path:
 * the service worker CAN set Authorization on fetch (unlike WebSocket), and can
 * surface first-byte latency by reading res.body progressively.
 *
 * Zero external process. Zero Options. Max quality without wss:// handshake auth.
 */

import { log } from '../logger.js';
import { getActiveBaseUrl, resolveXaiUrl } from '../network/router.js';
import { XAI_BASE } from '../constants.js';

/**
 * @param {string} apiKey
 * @param {string} [base]
 */
function ttsUrl(base) {
  const b = String(base || getActiveBaseUrl() || XAI_BASE).replace(/\/+$/, '');
  return resolveXaiUrl(`${b}/tts`, b);
}

/**
 * Progressive REST TTS with Authorization (native SW "relay").
 *
 * @param {{
 *   apiKey: string,
 *   text: string,
 *   voice_id?: string,
 *   language?: string,
 *   speed?: number,
 *   codec?: string,
 *   sample_rate?: number,
 *   bit_rate?: number,
 *   optimize_streaming_latency?: number|string,
 *   text_normalization?: boolean,
 *   baseUrl?: string,
 *   signal?: AbortSignal,
 *   onFirstByte?: (info: { latencyMs: number, byteLength: number }) => void,
 *   onDelta?: (info: { byteLength: number, totalBytes: number }) => void,
 * }} opts
 * @returns {Promise<{
 *   buffer: ArrayBuffer,
 *   contentType: string,
 *   voice_id: string,
 *   firstByteMs: number|null,
 *   totalMs: number,
 *   bytes: number,
 *   mode: 'native-rest-stream',
 * }>}
 */
export async function nativeRestStreamTts(opts) {
  const apiKey = String(opts.apiKey || '').trim();
  if (!apiKey) throw new Error('native REST TTS: no API key');
  const text = String(opts.text || '').trim();
  if (!text) throw new Error('native REST TTS: empty text');

  const voice_id = String(opts.voice_id || 'ara').toLowerCase();
  const language = opts.language || 'ru';
  const codec = opts.codec || 'mp3';
  const optLat =
    opts.optimize_streaming_latency === 0 ||
    opts.optimize_streaming_latency === '0'
      ? 0
      : 1;
  const speedN = Number(opts.speed);
  const sampleRateN = Number(opts.sample_rate) || 24000;
  const bitRateN = Number(opts.bit_rate) || 128000;
  const url = ttsUrl(opts.baseUrl);
  const startedAt = performance.now();

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text,
      voice_id,
      language,
      speed: Number.isFinite(speedN) ? speedN : 1.05,
      optimize_streaming_latency: optLat,
      text_normalization: opts.text_normalization !== false,
      output_format: {
        codec,
        sample_rate: sampleRateN,
        bit_rate: bitRateN,
      },
    }),
    signal: opts.signal,
    cache: 'no-store',
  });

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      /* ignore */
    }
    throw new Error(
      `native REST TTS HTTP ${res.status}${detail ? `: ${detail}` : ''}`,
    );
  }

  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  // JSON envelope (timestamps path) — no progressive bytes
  if (ctype.includes('application/json')) {
    const data = await res.json();
    const b64 = data?.audio || data?.audio_base64 || '';
    if (!b64) throw new Error('native REST TTS JSON missing audio');
    const binary = atob(String(b64));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const firstByteMs = Math.round(performance.now() - startedAt);
    opts.onFirstByte?.({ latencyMs: firstByteMs, byteLength: bytes.byteLength });
    return {
      buffer: bytes.buffer,
      contentType: data?.content_type || 'audio/mpeg',
      voice_id,
      firstByteMs,
      totalMs: firstByteMs,
      bytes: bytes.byteLength,
      mode: 'native-rest-stream',
    };
  }

  // Progressive body read — first chunk ≈ WS first-byte when server streams
  const reader = res.body?.getReader?.();
  if (!reader) {
    const buf = await res.arrayBuffer();
    const firstByteMs = Math.round(performance.now() - startedAt);
    opts.onFirstByte?.({
      latencyMs: firstByteMs,
      byteLength: buf.byteLength,
    });
    return {
      buffer: buf,
      contentType: res.headers.get('content-type') || 'audio/mpeg',
      voice_id,
      firstByteMs,
      totalMs: firstByteMs,
      bytes: buf.byteLength,
      mode: 'native-rest-stream',
    };
  }

  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  /** @type {number|null} */
  let firstByteMs = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    const u8 = value instanceof Uint8Array ? value : new Uint8Array(value);
    chunks.push(u8);
    total += u8.byteLength;
    if (firstByteMs == null) {
      firstByteMs = Math.round(performance.now() - startedAt);
      opts.onFirstByte?.({
        latencyMs: firstByteMs,
        byteLength: u8.byteLength,
      });
    }
    opts.onDelta?.({ byteLength: u8.byteLength, totalBytes: total });
  }

  if (total < 16) throw new Error('native REST TTS empty body');

  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }

  const totalMs = Math.round(performance.now() - startedAt);
  log.debug('native REST stream TTS', {
    bytes: total,
    firstByteMs,
    totalMs,
    voice_id,
  });

  return {
    buffer: out.buffer,
    contentType: res.headers.get('content-type') || 'audio/mpeg',
    voice_id,
    firstByteMs,
    totalMs,
    bytes: total,
    mode: 'native-rest-stream',
  };
}

/**
 * Encode ArrayBuffer → base64 (SW-safe chunking).
 * @param {ArrayBuffer} buffer
 */
export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
