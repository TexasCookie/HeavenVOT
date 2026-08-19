/**
 * Native in-extension streaming STT (no WebSocket, no external relay).
 *
 * Service worker CAN set Authorization on fetch. This class receives real-time
 * PCM frames (same path as WS), runs energy/VAD endpointing, and POSTs short
 * speech segments to POST /v1/stt — full xAI transcription quality, not a
 * simulation. Interim-style events are emitted per finalized speech segment.
 *
 * True bidirectional WS interim_results still require ephemeral protocol or
 * relay; this is the zero-config full-quality native path when WS is unavailable.
 */

import { log } from '../logger.js';
import { getActiveBaseUrl, resolveXaiUrl } from '../network/router.js';
import { XAI_BASE } from '../constants.js';

const SR = 16000;
/** Min speech before we allow silence to flush (seconds) */
const MIN_SPEECH_SEC = 0.45;
/** Max continuous speech buffer before forced flush (seconds) */
const MAX_UTT_SEC = 2.2;
/** Silence after speech to cut utterance (seconds) */
const SILENCE_SEC = 0.28;
/** RMS speech gate — YouTube WebAudio taps are often quieter than mic */
const SPEECH_RMS = 0.007;
/** Max concurrent STT POSTs */
const MAX_INFLIGHT = 2;

/**
 * @param {ArrayBuffer|Uint8Array} pcm16le mono s16le
 * @param {number} sampleRate
 */
function pcm16ToWav(pcm16le, sampleRate = SR) {
  const pcm =
    pcm16le instanceof Uint8Array
      ? pcm16le
      : new Uint8Array(pcm16le.buffer || pcm16le, pcm16le.byteOffset || 0, pcm16le.byteLength || pcm16le.length);
  const dataLen = pcm.byteLength;
  const buf = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buf);
  const w = (o, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  w(36, 'data');
  view.setUint32(40, dataLen, true);
  new Uint8Array(buf, 44).set(pcm);
  return buf;
}

function rmsPcm16(u8) {
  if (!u8?.byteLength) return 0;
  const n = u8.byteLength >> 1;
  if (!n) return 0;
  const view = new DataView(u8.buffer, u8.byteOffset, n * 2);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = view.getInt16(i * 2, true) / 0x8000;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

function concatU8(chunks) {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * @typedef {{
 *   onPartial?: (ev: object) => void,
 *   onError?: (err: Error) => void,
 * }} NativeSttHandlers
 */

export class NativeSttStreamSession {
  /**
   * @param {NativeSttHandlers} [handlers]
   */
  constructor(handlers = {}) {
    this.onPartial = handlers.onPartial || (() => {});
    this.onError = handlers.onError || (() => {});
    this.ready = false;
    this._apiKey = '';
    this._baseUrl = '';
    this._language = '';
    this._keyterms = [];
    this._chunks = [];
    this._samples = 0;
    this._speechSamples = 0;
    this._silentSamples = 0;
    this._inSpeech = false;
    this._mediaStart = 0;
    this._mediaEnd = 0;
    this._inflight = 0;
    this._queue = [];
    this._closed = false;
    this._uttId = 0;
    this._mode = 'native-rest-stream';
    this._sttAborts = new Set();
  }

  get connected() {
    return this.ready && !this._closed;
  }

  /**
   * @param {{
   *   apiKey: string,
   *   baseUrl?: string,
   *   language?: string,
   *   keyterms?: string[],
   * }} opts
   */
  async open(opts = {}) {
    this._apiKey = String(opts.apiKey || '').trim();
    if (!this._apiKey) throw new Error('native STT stream: no API key');
    this._baseUrl = String(opts.baseUrl || getActiveBaseUrl() || XAI_BASE).replace(
      /\/+$/,
      '',
    );
    this._language = opts.language ? String(opts.language) : '';
    this._keyterms = Array.isArray(opts.keyterms) ? opts.keyterms.slice(0, 40) : [];
    this._closed = false;
    this.ready = true;
    this._chunks = [];
    this._samples = 0;
    this._speechSamples = 0;
    this._silentSamples = 0;
    this._inSpeech = false;
    log.info('native STT stream ready (SW fetch+VAD, full /v1/stt quality)');
  }

  /**
   * @param {ArrayBuffer|Uint8Array} pcm
   * @param {{ mediaTime?: number, duration?: number }} [meta]
   */
  sendPcm(pcm, meta = {}) {
    if (!this.ready || this._closed) return false;
    let u8;
    if (pcm instanceof Uint8Array) {
      u8 = pcm;
    } else if (pcm instanceof ArrayBuffer) {
      u8 = new Uint8Array(pcm);
    } else if (pcm?.buffer) {
      u8 = new Uint8Array(pcm.buffer, pcm.byteOffset || 0, pcm.byteLength);
    } else {
      return false;
    }
    if (!u8.byteLength) return false;

    const samples = u8.byteLength >> 1;
    const level = rmsPcm16(u8);
    const mediaTime =
      typeof meta.mediaTime === 'number' ? meta.mediaTime : this._mediaEnd;
    const duration =
      typeof meta.duration === 'number' ? meta.duration : samples / SR;

    if (!this._inSpeech && level >= SPEECH_RMS) {
      this._inSpeech = true;
      this._mediaStart = Math.max(0, mediaTime - duration);
      this._speechSamples = 0;
      this._silentSamples = 0;
    }

    if (this._inSpeech || level >= SPEECH_RMS * 0.85) {
      this._chunks.push(u8.slice());
      this._samples += samples;
      this._mediaEnd = mediaTime;
      if (level >= SPEECH_RMS) {
        this._speechSamples += samples;
        this._silentSamples = 0;
      } else {
        this._silentSamples += samples;
      }
    }

    const speechSec = this._speechSamples / SR;
    const silentSec = this._silentSamples / SR;
    const totalSec = this._samples / SR;

    const shouldFlush =
      this._inSpeech &&
      ((speechSec >= MIN_SPEECH_SEC && silentSec >= SILENCE_SEC) ||
        totalSec >= MAX_UTT_SEC);

    if (shouldFlush) {
      this.#flushUtterance(false);
    }
    return true;
  }

  finalize() {
    if (this._inSpeech && this._samples > SR * 0.25) {
      this.#flushUtterance(true);
    }
  }

  close() {
    this._closed = true;
    this.ready = false;
    this._chunks = [];
    this._samples = 0;
    this._queue = [];
    try {
      this._sttAbort?.abort?.();
    } catch {
      /* ignore */
    }
    this._sttAbort = null;
    for (const ac of this._sttAborts || []) {
      try {
        ac.abort();
      } catch {
        /* ignore */
      }
    }
    this._sttAborts = new Set();
  }

  #flushUtterance(force) {
    if (!this._chunks.length) {
      this._resetBuf();
      return;
    }
    const pcm = concatU8(this._chunks);
    const start = this._mediaStart;
    const end = this._mediaEnd || start + pcm.byteLength / 2 / SR;
    const speechSec = this._speechSamples / SR;
    this._resetBuf();

    if (!force && speechSec < MIN_SPEECH_SEC * 0.7) return;
    if (rmsPcm16(pcm) < SPEECH_RMS * 0.7) return;

    this._queue.push({ pcm, start, end, id: `nstt_${++this._uttId}` });
    this.#pump();
  }

  _resetBuf() {
    this._chunks = [];
    this._samples = 0;
    this._speechSamples = 0;
    this._silentSamples = 0;
    this._inSpeech = false;
  }

  async #pump() {
    while (
      this._queue.length &&
      this._inflight < MAX_INFLIGHT &&
      !this._closed
    ) {
      const job = this._queue.shift();
      this._inflight += 1;
      this.#transcribe(job)
        .catch((e) => {
          log.warn('native STT segment failed', e?.message || e);
          this.onError(e instanceof Error ? e : new Error(String(e)));
        })
        .finally(() => {
          this._inflight -= 1;
          this.#pump();
        });
    }
  }

  /**
   * @param {{ pcm: Uint8Array, start: number, end: number, id: string }} job
   */
  async #transcribe(job) {
    const wav = pcm16ToWav(job.pcm, SR);
    const url = resolveXaiUrl(`${this._baseUrl}/stt`, this._baseUrl);
    const form = new FormData();
    if (this._language) {
      form.append('language', this._language);
      form.append('format', 'true');
    }
    form.append('vad_threshold', '0.08');
    for (const t of this._keyterms) {
      if (t) form.append('keyterm', String(t).slice(0, 50));
    }
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'seg.wav');

    const t0 = performance.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 45000);
    this._sttAbort = ac;
    if (!this._sttAborts) this._sttAborts = new Set();
    this._sttAborts.add(ac);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this._apiKey}` },
        body: form,
        cache: 'no-store',
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
      this._sttAborts.delete(ac);
      if (this._sttAbort === ac) this._sttAbort = null;
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 160);
      throw new Error(`native STT HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    const data = await res.json();
    const text = String(
      data?.text ||
        data?.transcript ||
        data?.channel?.alternatives?.[0]?.transcript ||
        '',
    ).trim();
    const latencyMs = Math.round(performance.now() - t0);

    if (!text || text.length < 2) {
      log.debug('native STT empty segment', { latencyMs, sec: (job.end - job.start).toFixed(2) });
      return;
    }
    if (this._closed) return;

    // Same event shape as StreamingSttSession partial finals for clause path
    this.onPartial({
      type: 'transcript.partial',
      text,
      transcript: text,
      is_final: true,
      speech_final: true,
      mediaStart: job.start,
      mediaEnd: job.end,
      start: job.start,
      end: job.end,
      latencyMs,
      mode: this._mode,
      words: data?.words || [],
      id: job.id,
    });
  }
}
