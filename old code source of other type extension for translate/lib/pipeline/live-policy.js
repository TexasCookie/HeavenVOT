/**
 * Live REST / health / cache policy (unit-tested, no Chrome).
 */

import { AUDIO } from '../constants.js';

export const LOCAL_INFLIGHT_MS = 100000;
export const LOCAL_STT_MS = 95000;
export const XAI_INFLIGHT_MS = AUDIO.inflightTimeoutMs || 20000;

export function inflightTimeoutForProvider(providerMode) {
  return String(providerMode || '') === 'local' ? LOCAL_INFLIGHT_MS : XAI_INFLIGHT_MS;
}

/**
 * Never clamp local Whisper below LOCAL_STT_MS (lag-shed used to force 14s).
 */
export function sttApiTimeoutMs(providerMode, { hardLag = false, lagShed = false } = {}) {
  const local = String(providerMode || '') === 'local';
  const base = local ? LOCAL_STT_MS : XAI_INFLIGHT_MS;
  if (local) return base;
  if (hardLag) return Math.min(base, 14000);
  if (lagShed) return Math.min(base, 16000);
  return base;
}

/**
 * REST page capture window. Non-YouTube "VOD" still uses TranslatorPipeline —
 * never fall back to the deprecated 10s AUDIO.vodChunkSec.
 */
export function restChunkSec({ isLive = false, profile = 'balanced' } = {}) {
  if (profile === 'max') return isLive ? 1.35 : 2.0;
  if (profile === 'fast') return isLive ? 1.05 : 1.5;
  return isLive ? AUDIO.liveChunkSec || 1.25 : 1.8;
}

export function phraseCacheUsable(hit, currentRevision) {
  if (!hit || !String(hit.target || '').trim()) return false;
  const rev = Number(hit.learningRevision ?? hit.revision);
  const cur = Number(currentRevision) || 0;
  if (Number.isFinite(rev)) return rev === cur;
  return false;
}

export function networkRouteReusable(route) {
  return !!(route && route.ok === true);
}

export function unicodeWordRegExp(word, flags = 'i') {
  const w = String(word || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${w}(?![\\p{L}\\p{N}_])`, flags.includes('u') ? flags : `${flags}u`);
}

/**
 * Live clause gate: never mark inflight before this says dispatch.
 * Backpressure-after-mark left phrases silenced until restart (B84).
 * @param {{ duplicate?: boolean, inflight?: boolean, busy?: number, maxBusy?: number }} s
 * @returns {{ dispatch: boolean, reason: string|null }}
 */
export function clauseShouldDispatch(s = {}) {
  if (s.duplicate || s.inflight) return { dispatch: false, reason: 'dedup' };
  const busy = Number(s.busy) || 0;
  const maxBusy = Number(s.maxBusy);
  const cap = Number.isFinite(maxBusy) && maxBusy > 0 ? maxBusy : 2;
  if (busy >= cap) return { dispatch: false, reason: 'backpressure' };
  return { dispatch: true, reason: null };
}
