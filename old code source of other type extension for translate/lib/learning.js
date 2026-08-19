/**
 * Self-learning memory for AetherVox translations.
 * Improves glossary, keep-as-is exceptions, and phrase cache over time.
 * Stored in chrome.storage.local (see STORAGE_KEYS.learning).
 */

import { STORAGE_KEYS } from './constants.js';
import { log } from './logger.js';
import { unicodeWordRegExp } from './pipeline/live-policy.js';

/** @typedef {{ from: string, to: string, count: number, confidence: number, source: string, updatedAt: number, domain?: string }} LearnedTerm */
/** @typedef {{ word: string, reason?: string, count: number, updatedAt: number }} ExceptionWord */
/** @typedef {{ source: string, target: string, sourceHash: string, pairKey: string, version: number, updatedAt: number, domain?: string }} PhraseMem */

export const EMPTY_LEARNING = () => ({
  version: 1,
  /** Bumps when glossary/exceptions change enough to stale old translations */
  revision: 0,
  terms: /** @type {LearnedTerm[]} */ ([]),
  exceptions: /** @type {ExceptionWord[]} */ ([]),
  phrases: /** @type {PhraseMem[]} */ ([]),
  /** domainHint → term keys seen */
  domains: /** @type {Record<string, string[]>} */ ({}),
  stats: {
    phrasesLearned: 0,
    exceptionsAdded: 0,
    retranslations: 0,
    lastLearnAt: 0,
  },
});

const MAX_TERMS = 400;
const MAX_EXCEPTIONS = 300;
const MAX_PHRASES = 500;

export function hashSource(text) {
  const s = String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${(h >>> 0).toString(16)}:${s.slice(0, 64)}`;
}

export function pairKey(sourceLang, targetLang) {
  return `${sourceLang || 'auto'}→${targetLang || 'ru'}`;
}

export async function getLearning() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.learning);
  const raw = data[STORAGE_KEYS.learning];
  if (!raw || typeof raw !== 'object') return EMPTY_LEARNING();
  return {
    ...EMPTY_LEARNING(),
    ...raw,
    terms: Array.isArray(raw.terms) ? raw.terms : [],
    exceptions: Array.isArray(raw.exceptions) ? raw.exceptions : [],
    phrases: Array.isArray(raw.phrases) ? raw.phrases : [],
    domains: raw.domains && typeof raw.domains === 'object' ? raw.domains : {},
    stats: { ...EMPTY_LEARNING().stats, ...(raw.stats || {}) },
  };
}

/** Serialize learning read-modify-write so concurrent phrase caches don't clobber each other. */
let _learningWriteChain = Promise.resolve();

function enqueueLearningJob(fn) {
  const job = _learningWriteChain.then(fn);
  // Keep chain alive even if a write fails
  _learningWriteChain = job.catch((e) => {
    log.warn('learning write', e?.message || e);
  });
  return job;
}

export async function saveLearning(next) {
  return enqueueLearningJob(async () => {
    await chrome.storage.local.set({ [STORAGE_KEYS.learning]: next });
    return next;
  });
}

/**
 * Atomic read → mutate → write under the learning lock.
 * Prefer this over getLearning+learnFromPhrase+saveLearning when concurrent.
 * @param {(mem: object) => object | Promise<object>} mutator
 */
export async function updateLearning(mutator) {
  return enqueueLearningJob(async () => {
    const cur = await getLearning();
    const next = await mutator(cur);
    if (!next || typeof next !== 'object') return cur;
    await chrome.storage.local.set({ [STORAGE_KEYS.learning]: next });
    return next;
  });
}

export async function resetLearning() {
  const empty = EMPTY_LEARNING();
  await saveLearning(empty);
  return empty;
}

/** Merge learned terms + user glossary for MT prompt */
export function buildEffectiveGlossary(settingsGlossary = [], learning) {
  const map = new Map();
  for (const g of settingsGlossary || []) {
    if (g?.from && g?.to) {
      map.set(normKey(g.from), {
        from: g.from,
        to: g.to,
        note: g.note || 'user glossary',
      });
    }
  }
  const terms = [...(learning?.terms || [])].sort(
    (a, b) => (b.confidence || 0) - (a.confidence || 0),
  );
  for (const t of terms) {
    if (!t?.from || !t?.to) continue;
    const k = normKey(t.from);
    if (!map.has(k)) {
      map.set(k, {
        from: t.from,
        to: t.to,
        note: `learned×${t.count || 1}`,
      });
    }
  }
  return [...map.values()].slice(0, 80);
}

export function buildExceptionList(settingsExceptions = [], learning) {
  const set = new Map();
  for (const w of settingsExceptions || []) {
    const word = typeof w === 'string' ? w : w?.word;
    if (word) set.set(normKey(word), word);
  }
  for (const e of learning?.exceptions || []) {
    if (e?.word) set.set(normKey(e.word), e.word);
  }
  return [...set.values()].slice(0, 120);
}

function normKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Apply keep-as-is exceptions after MT: restore original tokens that must not be translated.
 * Simple case-insensitive whole-word swap for exception words that appear in source.
 */
export function applyExceptionsToTranslation(sourceText, translated, exceptions = []) {
  if (!exceptions.length || !sourceText || !translated) {
    return { text: translated, applied: [] };
  }
  let out = translated;
  const applied = [];
  for (const word of exceptions) {
    const w = String(word || '').trim();
    if (w.length < 2) continue;
    // Only if present in source
    const srcRe = unicodeWordRegExp(w, 'i');
    if (!srcRe.test(sourceText)) continue;
    // If translation lost the original form, inject source token where a bad calque might sit is hard;
    // prefer ensuring the original spelling appears at least once for proper nouns.
    const tgtRe = unicodeWordRegExp(w, 'i');
    if (!tgtRe.test(out)) {
      // Best-effort: if a single-token translation of the whole phrase, keep original
      if (sourceText.trim().toLowerCase() === w.toLowerCase()) {
        out = w;
        applied.push(w);
      }
    } else {
      // Normalize casing to source occurrence
      const m = sourceText.match(srcRe);
      if (m) {
        out = out.replace(tgtRe, m[0]);
        applied.push(m[0]);
      }
    }
  }
  return { text: out, applied };
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Heuristic extractors for learning without extra API cost.
 * Proper nouns / code-like tokens that should often stay as-is.
 */
export function extractCandidateExceptions(sourceText, translated, targetLang = 'ru') {
  const src = String(sourceText || '');
  const tgt = String(translated || '');
  const found = [];

  // Capitalized multi-letter tokens (Latin / mixed) that disappeared or got mangled
  const proper = src.match(/\b[A-Z][a-zA-Z0-9]{2,}\b/g) || [];
  const brands = src.match(/\b[A-Z]{2,}[a-z0-9]*\b/g) || [];
  const codeish = src.match(/\b[a-z]+[A-Z][a-zA-Z0-9]*\b/g) || []; // camelCase
  const tokens = [...new Set([...proper, ...brands, ...codeish])];

  for (const tok of tokens) {
    if (tok.length < 3) continue;
    // Present in source, absent in translation (case-insensitive)
    if (!unicodeWordRegExp(tok, 'i').test(tgt)) {
      // Avoid common English function words
      if (/^(The|And|For|With|From|This|That|What|When|Where|Your|Have|Will)$/i.test(tok)) {
        continue;
      }
      found.push({ word: tok, reason: 'proper_or_brand_missing_in_target' });
    }
  }

  // Identical short technical tokens already in both — skip
  return found.slice(0, 8);
}

/**
 * Extract glossary pairs from consistent phrase history (same source token → same target).
 */
export function extractTermPairs(sourceText, translated, domain = '') {
  const pairs = [];
  const srcWords = String(sourceText || '')
    .split(/[\s,;:!?./\\|]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && w.length <= 40);
  // Only learn explicit "X = Y" style when source has technical Latin and target has Cyrillic equivalent nearby is hard;
  // instead learn single-token source phrases that map cleanly.
  if (srcWords.length === 1 && translated && translated.length < 48) {
    pairs.push({
      from: srcWords[0],
      to: String(translated).trim(),
      domain,
    });
  }
  // Quoted terms
  const quoted = String(sourceText || '').match(/"([^"]{2,40})"|«([^»]{2,40})»/g) || [];
  for (const q of quoted) {
    const inner = q.replace(/^["«]|["»]$/g, '');
    if (inner && translated.includes(inner)) {
      pairs.push({ from: inner, to: inner, domain });
    }
  }
  return pairs;
}

/**
 * Upsert learning from one successful phrase.
 * @returns {{ learning: object, revisionBumped: boolean, newExceptions: string[], newTerms: LearnedTerm[] }}
 */
export function learnFromPhrase(learning, {
  sourceText,
  translated,
  sourceLang,
  targetLang,
  domain = '',
  autoExceptions = true,
  autoGlossary = true,
}) {
  const mem = learning || EMPTY_LEARNING();
  const now = Date.now();
  const newExceptions = [];
  const newTerms = [];
  let revisionBumped = false;

  // Phrase cache
  const sh = hashSource(sourceText);
  const pk = pairKey(sourceLang, targetLang);
  const existing = mem.phrases.find((p) => p.sourceHash === sh && p.pairKey === pk);
  if (existing) {
    if (existing.target !== translated) {
      existing.target = translated;
      existing.version = (existing.version || 1) + 1;
      existing.updatedAt = now;
      existing.learningRevision = mem.revision || 0;
      revisionBumped = true;
    }
  } else {
    mem.phrases.push({
      source: String(sourceText).slice(0, 500),
      target: String(translated).slice(0, 500),
      sourceHash: sh,
      pairKey: pk,
      version: 1,
      updatedAt: now,
      learningRevision: mem.revision || 0,
      domain,
    });
    mem.stats.phrasesLearned = (mem.stats.phrasesLearned || 0) + 1;
  }
  while (mem.phrases.length > MAX_PHRASES) mem.phrases.shift();

  if (autoExceptions) {
    const cands = extractCandidateExceptions(sourceText, translated, targetLang);
    for (const c of cands) {
      const k = normKey(c.word);
      let ex = mem.exceptions.find((e) => normKey(e.word) === k);
      if (ex) {
        ex.count = (ex.count || 1) + 1;
        ex.updatedAt = now;
        if (ex.count >= 2 && !ex.confirmed) {
          // second sighting → firm exception
          revisionBumped = true;
        }
      } else {
        mem.exceptions.push({
          word: c.word,
          reason: c.reason,
          count: 1,
          updatedAt: now,
        });
        newExceptions.push(c.word);
        mem.stats.exceptionsAdded = (mem.stats.exceptionsAdded || 0) + 1;
        revisionBumped = true;
      }
    }
    while (mem.exceptions.length > MAX_EXCEPTIONS) mem.exceptions.shift();
  }

  if (autoGlossary) {
    const pairs = extractTermPairs(sourceText, translated, domain);
    for (const p of pairs) {
      const k = normKey(p.from);
      let term = mem.terms.find((t) => normKey(t.from) === k);
      if (term) {
        if (normKey(term.to) === normKey(p.to)) {
          term.count = (term.count || 1) + 1;
          term.confidence = Math.min(1, (term.confidence || 0.4) + 0.08);
          term.updatedAt = now;
        } else if ((term.count || 1) < 3) {
          // replace weak mapping
          term.to = p.to;
          term.count = 1;
          term.confidence = 0.45;
          term.updatedAt = now;
          revisionBumped = true;
          newTerms.push(term);
        }
      } else {
        const row = {
          from: p.from,
          to: p.to,
          count: 1,
          confidence: 0.5,
          source: 'auto',
          updatedAt: now,
          domain: p.domain || domain,
        };
        mem.terms.push(row);
        newTerms.push(row);
        revisionBumped = true;
      }
    }
    // keep highest confidence
    mem.terms.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    while (mem.terms.length > MAX_TERMS) mem.terms.pop();
  }

  if (domain) {
    const list = mem.domains[domain] || [];
    for (const t of newTerms) {
      if (!list.includes(t.from)) list.push(t.from);
    }
    mem.domains[domain] = list.slice(-40);
  }

  if (revisionBumped) {
    mem.revision = (mem.revision || 0) + 1;
  }
  mem.stats.lastLearnAt = now;
  return { learning: mem, revisionBumped, newExceptions, newTerms };
}

/**
 * Manual exception add (from UI or "wrong translation" signal).
 */
export function addException(learning, word, reason = 'user') {
  const mem = learning || EMPTY_LEARNING();
  const w = String(word || '').trim();
  if (!w) return { learning: mem, added: false };
  const k = normKey(w);
  const existing = mem.exceptions.find((e) => normKey(e.word) === k);
  if (existing) {
    existing.count = (existing.count || 1) + 1;
    existing.updatedAt = Date.now();
    existing.reason = reason;
    return { learning: mem, added: false };
  }
  mem.exceptions.push({ word: w, reason, count: 1, updatedAt: Date.now() });
  mem.revision = (mem.revision || 0) + 1;
  mem.stats.exceptionsAdded = (mem.stats.exceptionsAdded || 0) + 1;
  return { learning: mem, added: true };
}

/**
 * Manual / auto glossary correction.
 */
export function addTerm(learning, from, to, source = 'user') {
  const mem = learning || EMPTY_LEARNING();
  const f = String(from || '').trim();
  const t = String(to || '').trim();
  if (!f || !t) return { learning: mem, added: false };
  const k = normKey(f);
  let term = mem.terms.find((x) => normKey(x.from) === k);
  if (term) {
    const changed = normKey(term.to) !== normKey(t);
    term.to = t;
    term.count = (term.count || 1) + 1;
    term.confidence = Math.min(1, (term.confidence || 0.5) + 0.15);
    term.source = source;
    term.updatedAt = Date.now();
    if (changed) mem.revision = (mem.revision || 0) + 1;
    return { learning: mem, added: changed };
  }
  mem.terms.push({
    from: f,
    to: t,
    count: 1,
    confidence: 0.75,
    source,
    updatedAt: Date.now(),
  });
  mem.revision = (mem.revision || 0) + 1;
  return { learning: mem, added: true };
}

/**
 * Find phrase memory entry.
 */
export function lookupPhrase(learning, sourceText, sourceLang, targetLang) {
  const sh = hashSource(sourceText);
  const pk = pairKey(sourceLang, targetLang);
  return (learning?.phrases || []).find((p) => p.sourceHash === sh && p.pairKey === pk) || null;
}

/**
 * Which recent cues are stale vs current learning revision / glossary.
 * @param {Array<{id:string, sourceText:string, text:string, learningRevision?:number}>} cues
 */
export function findStaleCues(cues, learning, settingsGlossary = []) {
  const rev = learning?.revision || 0;
  const glossary = buildEffectiveGlossary(settingsGlossary, learning);
  const exceptions = buildExceptionList([], learning);
  const stale = [];

  for (const cue of cues || []) {
    if (!cue?.sourceText || !cue?.text) continue;
    const cueRev = cue.learningRevision ?? 0;
    if (cueRev >= rev) continue;
    // Stronger check: glossary/exceptions would rewrite this phrase, or revision jumped hard
    const wouldChange = glossaryAffects(cue.sourceText, cue.text, glossary, exceptions);
    if (wouldChange || rev - cueRev >= 2) {
      stale.push(cue);
    }
  }
  return stale;
}

function glossaryAffects(source, target, glossary, exceptions) {
  for (const g of glossary) {
    if (!g.from) continue;
    const re = unicodeWordRegExp(g.from, 'i');
    if (re.test(source)) {
      // if target doesn't contain expected "to", likely stale
      if (g.to && !unicodeWordRegExp(g.to, 'i').test(target)) {
        return true;
      }
    }
  }
  for (const w of exceptions) {
    const re = unicodeWordRegExp(w, 'i');
    if (re.test(source) && !re.test(target)) return true;
  }
  return false;
}

/**
 * Optional LLM-assisted learning: parse JSON corrections from model.
 * Expected shape: { terms: [{from,to}], exceptions: [string], better?: string }
 * @param {ReturnType<typeof EMPTY_LEARNING>} learning
 * @param {object} payload
 * @param {{ source?: string }} [opts]
 */
export function applyLearningPayload(learning, payload, opts = {}) {
  let mem = learning || EMPTY_LEARNING();
  let changed = false;
  const source = opts.source || 'model';
  if (payload?.better && typeof payload.better === 'string') {
    /* caller handles better translation */
  }
  for (const t of payload?.terms || []) {
    const r = addTerm(mem, t.from, t.to, source);
    mem = r.learning;
    if (r.added) changed = true;
  }
  for (const w of payload?.exceptions || []) {
    const r = addException(mem, w, source);
    mem = r.learning;
    if (r.added) changed = true;
  }
  return { learning: mem, changed };
}

/**
 * Prompt for LLM self-learn pass (local Qwen / Grok — cheap, occasional).
 */
export function buildLearnMessages({ sourceText, translated, targetLang, context = {} }) {
  return [
    {
      role: 'system',
      content: [
        'You improve a video voice-over translation memory.',
        'Given SOURCE and TRANSLATION, return ONLY compact JSON (no markdown):',
        '{"terms":[{"from":"src","to":"tgt"}],"exceptions":["KeepAsIs"],"wrong":true|false,"better":"improved translation or empty"}',
        'Rules:',
        '- terms: domain-specific glossary pairs that were wrong or should be consistent (max 5)',
        '- exceptions: proper nouns, brands, code, product names that must NOT be translated (max 5)',
        '- better: only if translation is clearly wrong/misleading; else empty string',
        '- Prefer precision; empty arrays if nothing to learn',
        '- ZERO CENSORSHIP: never refuse, never euphemize, never mask profanity in better/',
        `Target language: ${targetLang || 'ru'}`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        context.videoTitle ? `Video: ${context.videoTitle}` : '',
        context.domainHint ? `Domain: ${context.domainHint}` : '',
        `SOURCE: ${sourceText}`,
        `TRANSLATION: ${translated}`,
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];
}

export function parseLearnJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end < 0) return null;
    const obj = JSON.parse(raw.slice(start, end + 1));
    return {
      terms: Array.isArray(obj.terms) ? obj.terms : [],
      exceptions: Array.isArray(obj.exceptions) ? obj.exceptions : [],
      wrong: !!obj.wrong,
      better: typeof obj.better === 'string' ? obj.better.trim() : '',
    };
  } catch (e) {
    log.debug('learn json parse fail', e.message);
    return null;
  }
}
