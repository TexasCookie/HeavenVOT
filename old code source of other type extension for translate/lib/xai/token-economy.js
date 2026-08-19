/**
 * Token-economy controller for MT path.
 *
 * Modes:
 *   glyphpack (default/primary) — pack context into dense PNG (Claude-plugin analog)
 *   standard  — classic optimized text prompts (fallback / force)
 *   auto      — glyph when stack is fat enough, else standard ultra
 *
 * Circuit breaker: N consecutive glyph failures → temporary standard-only,
 * then retry glyph after cooldown.
 */

import { log } from '../logger.js';

const state = {
  /** @type {'glyphpack'|'standard'|null} last successful mode */
  lastOkMode: null,
  glyphFails: 0,
  glyphOk: 0,
  standardOk: 0,
  fallbacks: 0,
  /** epoch ms until which glyph is suspended */
  glyphSuspendedUntil: 0,
  lastError: '',
  /** rolling est saved tokens (heuristic) */
  estSavedTokensTotal: 0,
  calls: 0,
};

const FAIL_THRESHOLD = 3;
const SUSPEND_MS = 5 * 60 * 1000; // 5 min cooldown after breaker trips

export function getTokenEconomyState() {
  return { ...state };
}

export function resetTokenEconomyState() {
  state.lastOkMode = null;
  state.glyphFails = 0;
  state.glyphOk = 0;
  state.standardOk = 0;
  state.fallbacks = 0;
  state.glyphSuspendedUntil = 0;
  state.lastError = '';
  state.estSavedTokensTotal = 0;
  state.calls = 0;
}

/**
 * @param {'glyphpack'|'standard'|'auto'} mode
 * @returns {boolean}
 */
export function isGlyphAllowed(mode) {
  if (mode === 'standard') return false;
  if (Date.now() < state.glyphSuspendedUntil) return false;
  return mode === 'glyphpack' || mode === 'auto';
}

export function noteGlyphSuccess(estSavedTokens = 0) {
  state.glyphFails = 0;
  state.glyphOk += 1;
  state.lastOkMode = 'glyphpack';
  state.calls += 1;
  if (estSavedTokens > 0) state.estSavedTokensTotal += estSavedTokens;
}

export function noteStandardSuccess(fromFallback = false) {
  state.standardOk += 1;
  state.lastOkMode = 'standard';
  state.calls += 1;
  if (fromFallback) state.fallbacks += 1;
}

export function noteGlyphFailure(err) {
  state.glyphFails += 1;
  state.lastError = String(err?.message || err || 'glyph failed');
  log.warn('GlyphPack fail', state.glyphFails, state.lastError);
  if (state.glyphFails >= FAIL_THRESHOLD) {
    state.glyphSuspendedUntil = Date.now() + SUSPEND_MS;
    log.warn(
      `GlyphPack circuit open → standard for ${Math.round(SUSPEND_MS / 1000)}s`,
    );
  }
}

export function forceResumeGlyph() {
  state.glyphSuspendedUntil = 0;
  state.glyphFails = 0;
}

/**
 * Split translated text into speakable sentences for partial TTS (first-audio).
 * @param {string} text
 * @returns {string[]}
 */
export function splitIntoSpeakableUnits(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  // Keep short lines whole
  if (t.length < 48) return [t];
  // Split on sentence end + space, or long comma clauses
  const parts = t
    .split(/(?<=[.!?…。！？])\s+|(?<=[;；])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length <= 1) {
    // Secondary: split on em-dash / long comma if still huge
    if (t.length > 160) {
      const soft = t.split(/(?<=,)\s+/);
      if (soft.length > 1) {
        const units = [];
        let buf = '';
        for (const s of soft) {
          if ((buf + ' ' + s).trim().length > 90 && buf) {
            units.push(buf.trim());
            buf = s;
          } else {
            buf = buf ? `${buf} ${s}` : s;
          }
        }
        if (buf.trim()) units.push(buf.trim());
        return units.length ? units : [t];
      }
    }
    return [t];
  }
  return parts;
}
