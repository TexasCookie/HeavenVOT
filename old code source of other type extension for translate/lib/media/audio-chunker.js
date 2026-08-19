/**
 * Timeline chunk helpers for VOD: fixed windows (default 10s) over PCM @ 16 kHz.
 */

import {
  floatTo16BitPCM,
  downsampleTo16k,
  pcm16ToWavBlob,
  arrayBufferToBase64,
  rmsLevel,
} from '../pcm-utils.js';

export const TARGET_SR = 16000;

/**
 * @param {number} durationSec
 * @param {number} chunkSec
 * @param {number} [overlapSec]
 * @returns {{ index: number, start: number, end: number }[]}
 */
export function planChunks(durationSec, chunkSec = 10, overlapSec = 0) {
  const dur = Math.max(0, Number(durationSec) || 0);
  const step = Math.max(0.5, chunkSec - (overlapSec || 0));
  const win = Math.max(0.5, chunkSec);
  if (dur <= 0) return [];
  const out = [];
  let i = 0;
  for (let start = 0; start < dur - 0.05; start += step) {
    const end = Math.min(dur, start + win);
    out.push({ index: i++, start, end });
    if (end >= dur - 0.02) break;
    // safety
    if (i > 100000) break;
  }
  if (!out.length) {
    out.push({ index: 0, start: 0, end: dur || win });
  }
  return out;
}

/**
 * Slice mono float32 (any rate) → 16k PCM16 for one window.
 * @param {Float32Array} float32 full buffer
 * @param {number} sampleRate
 * @param {number} startSec
 * @param {number} endSec
 */
export function sliceFloatTo16kPcm(float32, sampleRate, startSec, endSec) {
  const sr = sampleRate || TARGET_SR;
  const a = Math.max(0, Math.floor(startSec * sr));
  const b = Math.min(float32.length, Math.ceil(endSec * sr));
  if (b <= a) {
    return { pcm16: new Uint8Array(0), sampleRate: TARGET_SR, float16k: new Float32Array(0) };
  }
  const slice = float32.subarray(a, b);
  const f16 = downsampleTo16k(slice, sr);
  return {
    pcm16: floatTo16BitPCM(f16),
    sampleRate: TARGET_SR,
    float16k: f16,
  };
}

/**
 * @param {Float32Array} float32
 * @param {number} sampleRate
 * @param {{ start: number, end: number, index: number }} plan
 * @param {{ speechRms?: number }} [opts]
 */
export function chunkToWavBase64(float32, sampleRate, plan, opts = {}) {
  const { pcm16, sampleRate: sr, float16k } = sliceFloatTo16kPcm(
    float32,
    sampleRate,
    plan.start,
    plan.end,
  );
  const level = rmsLevel(float16k);
  const speechRms = opts.speechRms ?? 0.008;
  if (!pcm16.byteLength || level < speechRms) {
    return {
      ok: false,
      silent: true,
      level,
      start: plan.start,
      end: plan.end,
      index: plan.index,
    };
  }
  const wav = pcm16ToWavBlob(pcm16, sr);
  // async-free: we need arrayBuffer — use sync path via pcm header already in blob
  // Caller should await wav.arrayBuffer(); here return pcm for SW to wrap
  return {
    ok: true,
    silent: false,
    level,
    start: plan.start,
    end: plan.end,
    index: plan.index,
    pcm16,
    sampleRate: sr,
    /** @deprecated use await buildWavBase64 */
    wavBlob: wav,
  };
}

/**
 * @param {Uint8Array} pcm16
 * @param {number} sampleRate
 */
export async function pcmToWavBase64(pcm16, sampleRate = TARGET_SR) {
  const wav = pcm16ToWavBlob(pcm16, sampleRate);
  const ab = await wav.arrayBuffer();
  return arrayBufferToBase64(ab);
}

/**
 * Mix multi-channel AudioBuffer-like channels to mono Float32Array.
 * @param {Float32Array[]} channels
 * @param {number} length
 */
export function mixToMono(channels, length) {
  if (!channels?.length) return new Float32Array(0);
  if (channels.length === 1) {
    return channels[0].length === length
      ? channels[0]
      : channels[0].slice(0, length);
  }
  const out = new Float32Array(length);
  const n = channels.length;
  for (let i = 0; i < length; i++) {
    let s = 0;
    for (let c = 0; c < n; c++) s += channels[c][i] || 0;
    out[i] = s / n;
  }
  return out;
}

/**
 * Priority score for progressive VOD: lower = process sooner.
 * Prefer playhead..playhead+lookahead, then slightly behind, then far ahead.
 */
export function chunkPriority(chunkStart, playhead, lookaheadSec = 90) {
  const t = playhead || 0;
  const la = lookaheadSec || 90;
  if (chunkStart >= t - 2 && chunkStart <= t + la) {
    return chunkStart - t; // 0..la first
  }
  if (chunkStart < t - 2) {
    return 1000 + (t - chunkStart); // behind
  }
  return 2000 + (chunkStart - t); // far ahead
}
