/**
 * Partial MT by clauses — peel complete clauses from streaming STT text
 * so MT/TTS can start before the full utterance ends.
 */

/**
 * Extract newly completed clauses from cumulative utterance text.
 *
 * @param {string} fullText - latest STT transcript for current utterance
 * @param {number} consumedChars - how many chars already sent to MT
 * @param {{
 *   minClauseChars?: number,
 *   forceAll?: boolean,
 *   minWordsForce?: number,
 *   softWindowChars?: number,
 *   softWindowWords?: number,
 * }} [opts]
 * @returns {{ clauses: string[], consumedChars: number, remainder: string }}
 */
export function peelReadyClauses(fullText, consumedChars = 0, opts = {}) {
  const full = String(fullText || '').replace(/\s+/g, ' ').trim();
  if (!full) {
    return { clauses: [], consumedChars: 0, remainder: '' };
  }

  const minClause = opts.minClauseChars ?? 12;
  const forceAll = !!opts.forceAll;
  const minWordsForce = opts.minWordsForce ?? 5;
  const softWindowChars = opts.softWindowChars ?? 72;
  const softWindowWords = opts.softWindowWords ?? 12;

  // Work on the unconsumed tail, but keep char offsets against `full`
  // by re-deriving from full with a sliding consumed pointer.
  let consumed = Math.max(0, Math.min(consumedChars, full.length));
  // Streaming STT often revises earlier words (interim → final).
  // The old check `full.startsWith(full.slice(0, consumed))` is a tautology and
  // never detected revisions — clauses could be lost or double-spoken.
  // Heuristic: if consumed is large but full text shrank a lot, or the char at
  // the cut no longer looks like a word boundary continuation, soft-reset.
  if (consumed > 0) {
    if (full.length + 8 < consumedChars) {
      // Transcript got shorter than what we already peeled — full rewrite
      consumed = 0;
    } else if (consumed < full.length) {
      // Mid-word cut after revision → back up to previous whitespace
      const ch = full[consumed];
      const prev = full[consumed - 1];
      if (ch && prev && /\S/.test(ch) && /\S/.test(prev)) {
        const back = full.lastIndexOf(' ', consumed - 1);
        consumed = back >= 0 ? back + 1 : 0;
      }
    }
  }

  const clauses = [];
  let rest = full.slice(consumed).trimStart();
  // Adjust consumed to skip whitespace we trimmed
  consumed = full.length - rest.length;

  if (forceAll) {
    if (rest.trim().length >= 2) {
      clauses.push(rest.trim());
      return { clauses, consumedChars: full.length, remainder: '' };
    }
    return { clauses: [], consumedChars: consumed, remainder: rest };
  }

  // Primary: sentence / strong clause enders
  // Secondary: comma / semicolon after enough content (CJK-aware)
  const strongRe = /[.!?…。！？]+(?:["'»”’)\]]*)?(?=\s|$)/;
  const softRe = /[,;:，；、](?:["'»”’)\]]*)?(?=\s|$)/;

  while (rest.length >= minClause) {
    const strong = strongRe.exec(rest);
    const soft = softRe.exec(rest);

    let cut = -1;
    if (strong && strong.index != null) {
      cut = strong.index + strong[0].length;
    }
    // Soft only if clause is long enough / has enough words
    if (soft && soft.index != null) {
      const softCut = soft.index + soft[0].length;
      const piece = rest.slice(0, softCut).trim();
      const words = piece.split(/\s+/).filter(Boolean).length;
      if (
        piece.length >= Math.max(minClause, 28) ||
        words >= minWordsForce
      ) {
        if (cut < 0 || softCut < cut) cut = softCut;
      }
    }

    if (cut < 0) break;

    const clause = rest.slice(0, cut).trim();
    if (clause.length >= 2) {
      clauses.push(clause);
    }
    rest = rest.slice(cut).trimStart();
    consumed = full.length - rest.length;
  }

  // Aggressive: long remainder without punctuation but many words
  // (speaker never pauses) — peel a soft word-window once for first-audio
  if (!clauses.length && rest.length >= softWindowChars) {
    const words = rest.split(/\s+/).filter(Boolean);
    if (words.length >= softWindowWords) {
      // take first ~8–10 words as provisional clause (fewer on first-audio)
      const takeMin = Math.max(5, Math.min(7, softWindowWords - 2));
      const takeMax = Math.max(takeMin + 1, Math.min(10, softWindowWords));
      const n = Math.min(
        takeMax,
        Math.max(takeMin, Math.floor(words.length * 0.55)),
      );
      const clause = words.slice(0, n).join(' ').trim();
      if (clause.length >= minClause) {
        clauses.push(clause);
        rest = words.slice(n).join(' ').trim();
        // Map consumed by finding clause end in full from previous consumed
        const idx = full.indexOf(clause, Math.max(0, consumedChars - 4));
        if (idx >= 0) {
          consumed = idx + clause.length;
          // skip trailing space
          while (consumed < full.length && /\s/.test(full[consumed])) {
            consumed += 1;
          }
        } else {
          consumed = full.length - rest.length;
        }
      }
    }
  }

  return {
    clauses,
    consumedChars: consumed,
    remainder: rest.trim(),
  };
}

/**
 * Whether interim text is "clause-ready" enough to risk partial MT.
 * @param {string} text
 */
export function looksClauseReady(text) {
  const t = String(text || '').trim();
  if (t.length < 12) return false;
  if (/[.!?…。！？]["'»”’)\]]*\s*$/.test(t)) return true;
  if (/[,;:，；、]["'»”’)\]]*\s*$/.test(t) && t.length >= 28) return true;
  const words = t.split(/\s+/).filter(Boolean).length;
  return words >= 12 && t.length >= 72;
}
