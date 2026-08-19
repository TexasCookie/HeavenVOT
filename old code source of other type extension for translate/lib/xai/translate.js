import {
  DEFAULT_TRANSLATE_MODEL,
  FAST_TRANSLATE_MODEL,
  LIVE_TRANSLATE_MODEL,
} from '../constants.js';
import { isHardPair, langLabel } from '../languages.js';
import { log } from '../logger.js';
import { applyExceptionsToTranslation } from '../learning.js';
import {
  buildGlyphContextDocument,
  buildGlyphPackMessages,
  estimateGlyphSavings,
  renderGlyphPackImage,
  shouldPreferGlyphPack,
} from './glyph-pack.js';
import {
  isGlyphAllowed,
  noteGlyphFailure,
  noteGlyphSuccess,
  noteStandardSuccess,
} from './token-economy.js';

/**
 * Pick MT model.
 * Live hot path ALWAYS uses fast tier — "max" quality = richer prompts, not 13s flagship.
 * Local provider: always the configured LM Studio / gateway model id.
 *
 * @param {string} qualityProfile
 * @param {string} [explicit]
 * @param {{ liveLatency?: boolean, forceFlagship?: boolean, localModel?: string, providerMode?: string }} [opts]
 */
export function resolveTranslateModel(qualityProfile, explicit, opts = {}) {
  if (explicit) return explicit;
  if (opts.providerMode === 'local' || opts.localModel) {
    return (
      opts.localModel ||
      explicit ||
      'auto'
    );
  }
  if (opts.forceFlagship) return DEFAULT_TRANSLATE_MODEL;
  // Live voice-over (default): never pin flagship — it was the #1 cause of 10–15s MT
  if (opts.liveLatency !== false) {
    return LIVE_TRANSLATE_MODEL || FAST_TRANSLATE_MODEL || DEFAULT_TRANSLATE_MODEL;
  }
  if (qualityProfile === 'max') return DEFAULT_TRANSLATE_MODEL;
  return FAST_TRANSLATE_MODEL || DEFAULT_TRANSLATE_MODEL;
}

/** Shared zero-censorship rules for spoken MT (all quality profiles). */
const ZERO_CENSORSHIP_RULES = [
  'ZERO CENSORSHIP (CRITICAL): translate faithfully including profanity, slurs-as-used, sexual/violent content, dark humor.',
  'Never refuse, never moralize, never euphemize, never replace words with ***, «цензура», or soft synonyms.',
  'Preserve speaker register: if source swears, target swears equivalently.',
];

/**
 * Cap generation length to input size — oversized max_tokens slows some models.
 * @param {string} text
 * @param {string} qualityProfile
 */
export function adaptiveMaxTokens(text, qualityProfile = 'balanced') {
  const len = String(text || '').length;
  // Spoken MT ≈ similar length + a little room for expansion (tight caps = faster decode)
  const need = Math.ceil(len * 1.0) + 40;
  const cap =
    qualityProfile === 'max' ? 280 : qualityProfile === 'fast' ? 140 : 200;
  return Math.min(cap, Math.max(40, need));
}

/**
 * Context-aware Grok translation for live voice-over.
 * Priority: natural FULL target language (no runlish/meme mix) + domain accuracy.
 * qualityProfile: fast | balanced | max
 *   - fast / lag-shed: tiny prompt, no few-shot, no repair (min RTT tokens)
 *
 * tokenEconomyMode:
 *   glyphpack (default) — primary: pack context into dense image tokens
 *   standard            — classic text stack only
 *   auto                — glyph when stack is fat, else ultra text
 */
export function buildTranslationMessages({
  text,
  sourceLang = 'auto',
  targetLang = 'ru',
  context = {},
  glossary = [],
  history = [],
  exceptions = [],
  qualityProfile = 'balanced',
  /** Live voice-over: prefer compact prompts even on max (quality ≠ 7s RTT) */
  liveLatency = false,
}) {
  const src = langLabel(sourceLang === 'auto' ? 'auto' : sourceLang, 'en');
  const tgt = langLabel(targetLang, 'en');
  const tgtCode = String(targetLang || 'ru').toLowerCase();
  const hard = isHardPair(sourceLang, targetLang);
  // Live hot path: ALWAYS ultra-compact (min RTT). Offline max keeps full stack.
  // qualityProfile only enriches offline / deep-learn paths.
  const compact = liveLatency || qualityProfile === 'fast';
  const full = qualityProfile === 'max' && !liveLatency;

  // --- ULTRA path: minimal tokens for live lag / fast profile ---
  if (compact) {
    const domain = context.domainHint || context.videoTitle || context.pageTitle || '';
    const gloss = (glossary || [])
      .filter((g) => g?.from && g?.to)
      .slice(0, 12)
      .map((g) => `${g.from}→${g.to}`)
      .join('; ');
    const keep = (exceptions || [])
      .map((w) => (typeof w === 'string' ? w : w?.word))
      .filter(Boolean)
      .slice(0, 10)
      .join(', ');
    const hist = (history || [])
      .slice(-2)
      .map((h) => `${h.source} ⇒ ${h.target}`)
      .join(' | ');

    const system = [
      `Real-time voice-over MT: ${src} → pure spoken ${tgt} only.`,
      'No code-switch, no English content words (names/brands/code OK).',
      'Spoken, short, natural. Output ONLY the line — no labels/markdown.',
      ...ZERO_CENSORSHIP_RULES,
      tgtCode === 'ru' || tgtCode === 'uk' || tgtCode === 'be'
        ? 'Cyrillic sentences; Latin only for true names/brands.'
        : '',
    ]
      .filter(Boolean)
      .join(' ');

    const userParts = [];
    if (domain) userParts.push(`Topic: ${String(domain).slice(0, 120)}`);
    if (gloss) userParts.push(`Glossary: ${gloss}`);
    if (keep) userParts.push(`Keep: ${keep}`);
    if (hist) userParts.push(`Recent: ${hist}`);
    userParts.push(`SRC: ${text}`);
    return [
      { role: 'system', content: system },
      { role: 'user', content: userParts.join('\n') },
    ];
  }

  const contextLines = [];
  if (context.pageTitle) contextLines.push(`Page title: ${context.pageTitle}`);
  if (context.videoTitle) contextLines.push(`Video title: ${context.videoTitle}`);
  if (context.channel) contextLines.push(`Channel/author: ${context.channel}`);
  if (context.description) {
    contextLines.push(
      `Description (truncated): ${String(context.description).slice(0, full ? 400 : 220)}`,
    );
  }
  if (context.domainHint) contextLines.push(`Detected domain/topic: ${context.domainHint}`);
  if (context.siteHost) contextLines.push(`Site: ${context.siteHost}`);

  const glossaryLines = (glossary || [])
    .filter((g) => g?.from && g?.to)
    .slice(0, full ? 48 : 28)
    .map((g) => `- "${g.from}" → "${g.to}"${g.note ? ` (${g.note})` : ''}`);

  const exceptionLines = (exceptions || [])
    .map((w) => (typeof w === 'string' ? w : w?.word))
    .filter(Boolean)
    .slice(0, full ? 40 : 24)
    .map((w) => `- "${w}" (keep as-is, do not translate)`);

  const historyBlock = (history || [])
    .slice(full ? -6 : -4)
    .map((h, i) => `${i + 1}. SRC: ${h.source}\n   TGT: ${h.target}`)
    .join('\n');

  // Anti-"fashion consultant meme" rules: mixed EN/RU is the classic failure mode
  const purityRules = [
    'LANGUAGE PURITY (CRITICAL — this is for spoken dubbing, not subtitles-with-English):',
    `1. Output MUST be entirely in ${tgt}. One language only.`,
    '2. FORBIDDEN: code-switching / runlish / half-English half-target sentences.',
    '   BAD (never do this): "a lot of fabric, какие же там details, очень Fashion"',
    '   BAD: "look, это very important detail про marketing"',
    `   GOOD: full natural ${tgt} sentence with real words of that language.`,
    '3. Translate ordinary content words (fabric, details, fashion, actually, basically, vibe, skills, features…).',
    '   Do NOT leave English filler or everyday nouns untranslated "for style".',
    '4. Keep in original spelling ONLY: proper names, brands, product codes, URLs, code identifiers, math notation,',
    '   and loanwords that are already fully established in the target (rare). Prefer a natural target equivalent when one exists.',
    '5. Sound like a professional voice-over / dubbing artist: fluent, idiomatic, spoken — not a dictionary calque,',
    '   not a tourist, not a luxury-store consultant mangling two languages.',
    '6. Homophones & ASR errors: repair using video context/domain (e.g. art tutorial "cube/sphere/pyramid" stay geometric).',
    '7. Match register (tutorial / banter / news) but always stay pure target language.',
    '8. Spoken length: roughly similar duration; cut filler; do not pad; no quotes/preamble/alternatives.',
    '9. Never invent facts. Empty/noise/filler-only input → empty string.',
    '10. Numbers, units, lists: keep structure. Follow glossary + DO-NOT-TRANSLATE + recent phrases for consistency.',
    ...ZERO_CENSORSHIP_RULES.map((r, i) => `${11 + i}. ${r}`),
  ];

  if (tgtCode === 'ru' || tgtCode === 'uk' || tgtCode === 'be') {
    purityRules.push(
      '14. For Russian/Ukrainian/Belarusian: write complete Cyrillic sentences. Latin only for true names/brands/code.',
      '    Prefer живая разговорная норма, not канцелярит and not англицизмы ради стиля.',
    );
  }

  if (hard) {
    purityRules.push(
      '15. HARD language pair: natural target word order, particles/honorifics as needed; no European calques.',
    );
  }

  const system = [
    'You are AetherVox, a professional real-time voice-over translator for video and livestreams.',
    `Translate spoken transcript from ${src} into natural spoken ${tgt}.`,
    '',
    ...purityRules,
    '',
    'OUTPUT: only the final voice-over line(s). No labels, no markdown, no explanations.',
  ].join('\n');

  const userParts = [];
  if (contextLines.length) {
    userParts.push('CONTEXT (disambiguate only; do not translate this block):');
    userParts.push(contextLines.join('\n'));
    userParts.push('');
  }
  if (glossaryLines.length) {
    userParts.push('GLOSSARY (must follow):');
    userParts.push(glossaryLines.join('\n'));
    userParts.push('');
  }
  if (exceptionLines.length) {
    userParts.push('DO-NOT-TRANSLATE / EXCEPTIONS:');
    userParts.push(exceptionLines.join('\n'));
    userParts.push('');
  }
  if (historyBlock) {
    userParts.push('RECENT PHRASES (term consistency):');
    userParts.push(historyBlock);
    userParts.push('');
  }

  // One compact few-shot on max (was 2× — extra tokens with little quality gain)
  if (full && (tgtCode === 'ru' || tgtCode === 'uk')) {
    userParts.push('STYLE: pure target only — never "a lot of fabric, какие details, Fashion".');
    userParts.push(
      'GOOD ex: "Здесь очень много ткани, и детали очень модные."',
    );
    userParts.push('');
  }

  userParts.push('TRANSCRIPT TO TRANSLATE:');
  userParts.push(text);

  return [
    { role: 'system', content: system },
    { role: 'user', content: userParts.join('\n') },
  ];
}

/** Lightweight domain hints from title/description — boosts MT quality without extra model calls */
export function detectDomainHint(context = {}) {
  const blob = [
    context.videoTitle,
    context.pageTitle,
    context.description,
    context.channel,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const rules = [
    {
      hint: 'digital art / drawing fundamentals / 3D forms (cube sphere pyramid cylinder cone)',
      keys: ['draw', 'sketch', 'art tutorial', 'рисован', 'figur', 'perspective', '3d form', 'anatomy', 'painting', 'цифров', 'скетч'],
    },
    {
      hint: 'programming / software engineering',
      keys: ['javascript', 'python', 'coding', 'api', 'github', 'программ', 'react', 'linux', 'docker'],
    },
    {
      hint: 'gaming livestream',
      keys: ['gameplay', 'let\'s play', 'стрим', 'speedrun', 'boss fight', 'minecraft', 'dota', 'cs2'],
    },
    {
      hint: 'science / math / physics lecture',
      keys: ['theorem', 'physics', 'chemistry', 'математик', 'уравнен', 'quantum', 'biology'],
    },
    {
      hint: 'cooking / recipe',
      keys: ['recipe', 'cook', 'kitchen', 'рецепт', 'ингредиент', 'bake'],
    },
    {
      hint: 'music theory / performance',
      keys: ['chord', 'guitar', 'piano', 'аккорд', 'music theory', 'bpm'],
    },
    {
      hint: 'fashion / design / luxury retail',
      keys: ['fashion', 'outfit', 'fabric', 'runway', 'haute', 'мода', 'ткан', 'коллекц'],
    },
    {
      hint: 'anime / Japanese media commentary',
      keys: ['anime', 'manga', 'отаку', 'сезон аниме', 'ваифу'],
    },
    {
      hint: 'finance / crypto markets',
      keys: ['bitcoin', 'trading', 'stocks', 'крипт', 'forex', 'nasdaq'],
    },
  ];

  for (const r of rules) {
    if (r.keys.some((k) => blob.includes(k))) return r.hint;
  }
  return '';
}

/**
 * Detect broken code-switch output (e.g. mixed EN content words into RU dubbing).
 * Used only as a soft signal for optional repair — not a hard fail.
 */
export function looksLikeBrokenCodeSwitch(sourceText, translated, targetLang = 'ru') {
  const tgt = String(targetLang || 'ru').toLowerCase();
  const cyrTargets = new Set(['ru', 'uk', 'be', 'bg', 'sr', 'mk']);
  if (!cyrTargets.has(tgt)) return false;
  const src = String(sourceText || '');
  const out = String(translated || '');
  if (out.length < 8) return false;

  const latinWords = out.match(/\b[A-Za-z]{3,}\b/g) || [];
  if (latinWords.length < 2) return false;

  // Ignore likely proper nouns / brands (Capitalized single tokens) if few
  const lowerCommon = latinWords.filter((w) => {
    const lw = w.toLowerCase();
    // common English content words that should have been translated
    return /^(a|the|of|and|or|to|in|on|for|with|this|that|very|lot|lots|much|many|some|any|just|really|actually|basically|super|fashion|details?|fabric|style|look|looks|cool|nice|good|bad|new|old|feature|features|workflow|marketing|vibe|skills?|content|video|stream)$/i.test(
      lw,
    ) || (w === w.toLowerCase() && w.length >= 4);
  });

  if (lowerCommon.length < 2) return false;

  // Source was mostly English and output still has many Latin tokens
  const srcLatin = (src.match(/\b[A-Za-z]{3,}\b/g) || []).length;
  const outLatinRatio = latinWords.length / Math.max(1, (out.match(/\S+/g) || []).length);
  return srcLatin >= 2 && outLatinRatio >= 0.22;
}

function postProcessTranslation(cleaned, out, exceptions, targetLang, qualityProfile, client, max_tokens) {
  // Strip accidental wrappers
  let result = out
    .replace(/^["«]|["»]$/g, '')
    .replace(/^(перевод|translation|voice[- ]?over)\s*:\s*/i, '')
    .trim();

  const exWords = (exceptions || [])
    .map((w) => (typeof w === 'string' ? w : w?.word))
    .filter(Boolean);
  const applied = applyExceptionsToTranslation(cleaned, result, exWords);
  result = applied.text;

  return { result, applied };
}

/**
 * Optional second MT pass for code-switch. NEVER on live hot path (doubles RTT).
 * Offline max / explicit allowRepair only; always uses FAST model.
 */
async function maybeRepair(
  client,
  cleaned,
  result,
  targetLang,
  max_tokens,
  { liveLatency = true } = {},
) {
  if (liveLatency) return result; // live: one shot only
  if (!looksLikeBrokenCodeSwitch(cleaned, result, targetLang)) {
    return result;
  }
  try {
    log.info('code-switch detected, repair pass');
    const repairMessages = [
      {
        role: 'system',
        content: [
          `You fix bad voice-over translations into pure ${langLabel(targetLang, 'en')}.`,
          'Rewrite the DRAFT so it is 100% target language, natural spoken dubbing.',
          'No English content words unless true names/brands/code. Output ONLY the fixed line.',
          ...ZERO_CENSORSHIP_RULES,
        ].join(' '),
      },
      {
        role: 'user',
        content: [
          `SOURCE: ${cleaned}`,
          `BAD DRAFT: ${result}`,
          'FIXED:',
        ].join('\n'),
      },
    ];
    const repaired = await client.chatCompletion({
      messages: repairMessages,
      model: FAST_TRANSLATE_MODEL || DEFAULT_TRANSLATE_MODEL,
      temperature: 0.1,
      max_tokens: Math.min(max_tokens, 220),
      liveLatency: true,
    });
    const fixed = String(repaired.text || '')
      .replace(/^["«]|["»]$/g, '')
      .replace(/^(fixed|исправл\w*|перевод)\s*:\s*/i, '')
      .trim();
    if (fixed && !looksLikeBrokenCodeSwitch(cleaned, fixed, targetLang)) {
      return fixed;
    }
    if (fixed && fixed.length > 3) {
      const a = (result.match(/\b[A-Za-z]{3,}\b/g) || []).length;
      const b = (fixed.match(/\b[A-Za-z]{3,}\b/g) || []).length;
      if (b < a) return fixed;
    }
  } catch (e) {
    log.debug('repair pass failed', e?.message || e);
  }
  return result;
}

/**
 * Standard (text-token) MT path — optimized classic prompts.
 */
async function translateStandard(client, params, { fromFallback = false } = {}) {
  const {
    text: cleaned,
    sourceLang,
    targetLang,
    context: ctx,
    glossary,
    history,
    exceptions = [],
    model: modelOverride,
    qualityProfile = 'balanced',
    liveLatency = true,
    allowRepair = false,
    providerMode = 'xai',
    localModel = '',
  } = params;

  const model = resolveTranslateModel(qualityProfile, modelOverride, {
    liveLatency,
    providerMode,
    localModel,
  });
  const temperature =
    qualityProfile === 'max' ? 0.12 : qualityProfile === 'fast' ? 0.2 : 0.15;
  const max_tokens = adaptiveMaxTokens(cleaned, qualityProfile);

  // Live: compact prompts always (max quality ≠ fat system prompt on hot path)
  const messages = buildTranslationMessages({
    text: cleaned,
    sourceLang,
    targetLang,
    context: ctx,
    glossary: liveLatency
      ? (glossary || []).slice(0, qualityProfile === 'fast' ? 8 : 16)
      : glossary,
    history: liveLatency
      ? (history || []).slice(qualityProfile === 'fast' ? -1 : -3)
      : history,
    exceptions: liveLatency
      ? (exceptions || []).slice(0, qualityProfile === 'fast' ? 8 : 16)
      : exceptions,
    qualityProfile,
    liveLatency,
  });

  let usedModel = model;
  let out = '';
  try {
    const r = await client.chatCompletion({
      messages,
      model,
      temperature,
      max_tokens,
      liveLatency,
    });
    out = r.text;
  } catch (e) {
    // Live: do NOT chain-fallback to flagship (another 10s). One retry on same fast model only if not live.
    if (!liveLatency && model !== DEFAULT_TRANSLATE_MODEL) {
      log.warn('MT model failed, fallback', model, e?.message || e);
      usedModel = DEFAULT_TRANSLATE_MODEL;
      const r = await client.chatCompletion({
        messages,
        model: usedModel,
        temperature,
        max_tokens,
        liveLatency: false,
      });
      out = r.text;
    } else {
      throw e;
    }
  }

  let { result, applied } = postProcessTranslation(
    cleaned,
    out,
    exceptions,
    targetLang,
    qualityProfile,
    client,
    max_tokens,
  );

  if (allowRepair && qualityProfile === 'max' && !liveLatency) {
    result = await maybeRepair(client, cleaned, result, targetLang, max_tokens, {
      liveLatency: false,
    });
  }

  noteStandardSuccess(fromFallback);
  log.debug(
    'translate:standard',
    usedModel,
    `q=${qualityProfile}`,
    cleaned.slice(0, 80),
    '→',
    result.slice(0, 80),
  );

  return {
    text: result,
    repairedSource: cleaned,
    domainHint: ctx.domainHint,
    exceptionsApplied: applied.applied,
    model: usedModel,
    economyMode: 'standard',
    economyFallback: fromFallback,
  };
}

/**
 * GlyphPack MT path — context stack as dense PNG (primary economy mode).
 */
async function translateGlyphPack(client, params) {
  const {
    text: cleaned,
    sourceLang,
    targetLang,
    context: ctx,
    glossary,
    history,
    exceptions = [],
    model: modelOverride,
    qualityProfile = 'balanced',
    liveLatency = true,
    allowRepair = false,
    providerMode = 'xai',
    localModel = '',
  } = params;

  const contextDoc = buildGlyphContextDocument({
    sourceLang,
    targetLang,
    context: ctx,
    glossary,
    history,
    exceptions,
    qualityProfile,
  });

  // Live: detail=low = fixed ~85 image tokens + much faster vision path.
  // Offline max may use high for denser OCR of fat glossaries.
  const detail = liveLatency || qualityProfile === 'fast' ? 'low' : 'high';
  const image = await renderGlyphPackImage(contextDoc, { detail });
  if (!image?.dataUrl) {
    throw new Error('GlyphPack render failed (no canvas/image)');
  }

  const savings = estimateGlyphSavings(contextDoc, image);
  const messages = buildGlyphPackMessages({
    text: cleaned,
    sourceLang,
    targetLang,
    imageDataUrl: image.dataUrl,
    imageDetail: detail,
    qualityProfile,
  });

  const model = resolveTranslateModel(qualityProfile, modelOverride, {
    liveLatency,
    providerMode,
    localModel,
  });
  const temperature =
    qualityProfile === 'max' ? 0.12 : qualityProfile === 'fast' ? 0.2 : 0.15;
  const max_tokens = adaptiveMaxTokens(cleaned, qualityProfile);

  let usedModel = model;
  let out = '';
  try {
    const r = await client.chatCompletion({
      messages,
      model,
      temperature,
      max_tokens,
      liveLatency,
    });
    out = r.text;
  } catch (e) {
    // Live: fail fast → outer standard fallback (don't chain flagship vision)
    if (!liveLatency && model !== DEFAULT_TRANSLATE_MODEL) {
      log.warn('GlyphPack model failed, try flagship', model, e?.message || e);
      usedModel = DEFAULT_TRANSLATE_MODEL;
      const r = await client.chatCompletion({
        messages,
        model: usedModel,
        temperature,
        max_tokens,
        liveLatency: false,
      });
      out = r.text;
    } else {
      throw e;
    }
  }

  if (!String(out || '').trim()) {
    throw new Error('GlyphPack empty response');
  }

  let { result, applied } = postProcessTranslation(
    cleaned,
    out,
    exceptions,
    targetLang,
    qualityProfile,
    client,
    max_tokens,
  );

  // Soft quality gate: if vision OCR mangled into junk code-switch, throw → standard
  if (
    qualityProfile !== 'fast' &&
    looksLikeBrokenCodeSwitch(cleaned, result, targetLang) &&
    result.length < cleaned.length * 0.35
  ) {
    throw new Error('GlyphPack quality gate (broken/short)');
  }

  if (allowRepair && qualityProfile === 'max' && !liveLatency) {
    result = await maybeRepair(client, cleaned, result, targetLang, max_tokens, {
      liveLatency: false,
    });
  }

  noteGlyphSuccess(savings.estSavedTokens);
  log.debug(
    'translate:glyphpack',
    usedModel,
    `detail=${detail}`,
    `~save ${savings.estSavedTokens} tok`,
    `${image.width}x${image.height}`,
    cleaned.slice(0, 60),
    '→',
    result.slice(0, 60),
  );

  return {
    text: result,
    repairedSource: cleaned,
    domainHint: ctx.domainHint,
    exceptionsApplied: applied.applied,
    model: usedModel,
    economyMode: 'glyphpack',
    economyFallback: false,
    economy: {
      ...savings,
      imageW: image.width,
      imageH: image.height,
      imageBytes: image.byteLength,
      packHash: image.hash,
      fromCache: !!image.fromCache,
      detail,
    },
  };
}

export async function translateWithGrok(client, params) {
  const {
    text,
    sourceLang,
    targetLang,
    context,
    glossary,
    history,
    exceptions = [],
    model: modelOverride,
    qualityProfile = 'balanced',
    tokenEconomyMode = 'glyphpack',
    /** Live voice-over: default true — min RTT, no flagship/repair chains */
    liveLatency = true,
    allowRepair = false,
    providerMode = 'xai',
    localModel = '',
  } = params;

  const cleaned = String(text || '').trim();
  if (!cleaned) {
    return {
      text: '',
      repairedSource: cleaned,
      economyMode: 'none',
    };
  }

  const ctx = { ...(context || {}) };
  if (!ctx.domainHint) ctx.domainHint = detectDomainHint(ctx);

  let mode = String(tokenEconomyMode || 'standard').toLowerCase();
  // Live hot path: never glyph vision (extra RTT + image tokens). Offline only.
  // Local text models: never glyph (no reliable vision path).
  if (liveLatency || providerMode === 'local') {
    mode = 'standard';
  }

  const shared = {
    text: cleaned,
    sourceLang,
    targetLang,
    context: ctx,
    glossary,
    history,
    exceptions,
    model: modelOverride,
    qualityProfile,
    liveLatency,
    allowRepair: allowRepair && !liveLatency,
    providerMode,
    localModel,
  };

  // Build context doc once for shouldPrefer heuristic
  const contextDoc = buildGlyphContextDocument({
    sourceLang,
    targetLang,
    context: ctx,
    glossary,
    history,
    exceptions,
    qualityProfile,
  });

  const tryGlyph =
    isGlyphAllowed(mode) &&
    shouldPreferGlyphPack({
      mode,
      qualityProfile,
      contextDoc,
      liveLatency,
      srcLen: cleaned.length,
    });

  if (tryGlyph) {
    try {
      return await translateGlyphPack(client, shared);
    } catch (e) {
      noteGlyphFailure(e);
      log.warn('GlyphPack → standard fallback', e?.message || e);
      // fall through — one standard pass only
    }
  }

  // Standard path (primary when mode=standard, or fallback / tiny-stack auto)
  return translateStandard(client, shared, {
    fromFallback: tryGlyph,
  });
}
