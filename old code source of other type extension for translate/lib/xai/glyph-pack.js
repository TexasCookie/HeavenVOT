/**
 * GlyphPack — token-economy mode inspired by Claude "text→dense image" proxies.
 *
 * Idea: stable MT context (rules, domain, glossary, exceptions, history) is painted
 * into a tight monochrome PNG. Vision models bill image tokens by spatial size, not
 * char count — so a dense stack often costs far less than the same text as tokens.
 *
 * Variable payload (the SRC line) stays as plain text so OCR cannot garble the
 * utterance we actually need to translate.
 *
 * If OffscreenCanvas / vision path fails → caller falls back to Standard text MT.
 */

import { log } from '../logger.js';

/** @typedef {{ dataUrl: string, width: number, height: number, charCount: number, estTextTokens: number, estImageTokens: number, hash: string }} GlyphPackImage */

const FONT_PX = 10;
const LINE_H = 11;
const PAD = 4;
const MAX_W = 720;
const MAX_H = 1400;
const COLS_WHEN_TALL = 2;

/** In-memory session cache: packHash → GlyphPackImage */
const packCache = new Map();
const PACK_CACHE_MAX = 12;

/**
 * Rough English/code token estimate (~4 chars / token). Cyrillic is denser ≈ 2–3.
 * Used only for logging / should-use heuristics, not billing.
 */
export function estimateTextTokens(str) {
  const s = String(str || '');
  if (!s) return 0;
  const cyr = (s.match(/[\u0400-\u04FF]/g) || []).length;
  const rest = s.length - cyr;
  return Math.ceil(rest / 4 + cyr / 2.4);
}

/**
 * xAI / OpenAI-style image token estimate (tiles). Approximate.
 * detail=low → fixed small bill; high → ~tile grid.
 * @param {number} w
 * @param {number} h
 * @param {'low'|'high'|'auto'} [detail]
 */
export function estimateImageTokens(w, h, detail = 'high') {
  if (detail === 'low') return 85;
  // Similar to OpenAI high-detail: scale to 2048, then 768 short side, 512 tiles
  let width = Math.max(1, w);
  let height = Math.max(1, h);
  const long = Math.max(width, height);
  if (long > 2048) {
    const s = 2048 / long;
    width = Math.round(width * s);
    height = Math.round(height * s);
  }
  const short = Math.min(width, height);
  if (short > 768) {
    const s = 768 / short;
    width = Math.round(width * s);
    height = Math.round(height * s);
  }
  const tiles = Math.ceil(width / 512) * Math.ceil(height / 512);
  return 85 + tiles * 170;
}

function hashStr(s) {
  let h = 2166136261;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * Build the dense context document painted into the glyph image.
 * Does NOT include the live SRC line (that stays as text).
 */
export function buildGlyphContextDocument({
  sourceLang = 'auto',
  targetLang = 'ru',
  context = {},
  glossary = [],
  history = [],
  exceptions = [],
  qualityProfile = 'balanced',
}) {
  const full = qualityProfile === 'max';
  const compact = qualityProfile === 'fast';
  const lines = [];

  lines.push(`AETHERVOX_MT v1 | ${sourceLang}→${targetLang} | ${qualityProfile}`);
  lines.push('ROLE: professional real-time voice-over MT for video/livestream.');
  lines.push(`OUT: pure spoken ${targetLang} only. No labels/markdown/preamble.`);
  lines.push('NO code-switch / runlish. Names brands codes OK in original.');
  lines.push('Spoken length ~ source; cut filler; empty if noise-only.');
  if (targetLang === 'ru' || targetLang === 'uk' || targetLang === 'be') {
    lines.push('Cyrillic sentences; Latin only for true names/brands/code.');
  }
  if (!compact) {
    lines.push('Homophones/ASR: repair via domain (cube≠box in art tutorial).');
    lines.push('Match register (tutorial/banter/news) but stay pure target.');
  }
  lines.push('---CONTEXT---');
  if (context.videoTitle) lines.push(`video: ${clip(context.videoTitle, full ? 160 : 100)}`);
  if (context.pageTitle && context.pageTitle !== context.videoTitle) {
    lines.push(`page: ${clip(context.pageTitle, 80)}`);
  }
  if (context.channel) lines.push(`channel: ${clip(context.channel, 60)}`);
  if (context.domainHint) lines.push(`domain: ${clip(context.domainHint, 120)}`);
  if (context.siteHost) lines.push(`site: ${context.siteHost}`);
  if (context.description && !compact) {
    lines.push(`desc: ${clip(context.description, full ? 280 : 140)}`);
  }

  const gloss = (glossary || [])
    .filter((g) => g?.from && g?.to)
    .slice(0, full ? 40 : compact ? 12 : 24);
  if (gloss.length) {
    lines.push('---GLOSSARY (must)---');
    // Pack dense: a→b; c→d
    const chunks = [];
    for (const g of gloss) {
      chunks.push(`${g.from}→${g.to}`);
    }
    lines.push(...wrapJoined(chunks, '; ', 88));
  }

  const keep = (exceptions || [])
    .map((w) => (typeof w === 'string' ? w : w?.word))
    .filter(Boolean)
    .slice(0, full ? 36 : compact ? 10 : 22);
  if (keep.length) {
    lines.push('---KEEP AS-IS---');
    lines.push(...wrapJoined(keep, ', ', 88));
  }

  const hist = (history || []).slice(full ? -6 : compact ? -2 : -4);
  if (hist.length) {
    lines.push('---RECENT (term consistency)---');
    for (const h of hist) {
      lines.push(`S:${clip(h.source, 90)}`);
      lines.push(`T:${clip(h.target, 90)}`);
    }
  }

  if (full) {
    lines.push('---STYLE---');
    lines.push('BAD: "a lot of fabric, какие же details, очень Fashion"');
    lines.push('GOOD: full natural target sentence, no English fillers.');
  }

  lines.push('---END---');
  return lines.join('\n');
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function wrapJoined(items, sep, maxLen) {
  const out = [];
  let cur = '';
  for (const it of items) {
    const next = cur ? cur + sep + it : it;
    if (next.length > maxLen && cur) {
      out.push(cur);
      cur = it;
    } else {
      cur = next;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Whether GlyphPack is worth the image floor cost vs pure text.
 * Tiny live stacks: ultra-compact text already wins on both $ and latency.
 * Vision RTT often dominates live MT — only use glyph when context is fat.
 */
export function shouldPreferGlyphPack({
  mode = 'glyphpack',
  qualityProfile = 'balanced',
  contextDoc = '',
  force = false,
  liveLatency = true,
  srcLen = 0,
}) {
  if (force) return true;
  if (mode === 'standard') return false;
  // glyphpack | auto
  const chars = String(contextDoc || '').length;
  const est = estimateTextTokens(contextDoc);
  // Live short SRC: text MT is always faster than vision
  if (liveLatency && srcLen > 0 && srcLen < 140) return false;
  if (qualityProfile === 'fast' && chars < 320 && est < 120) return false;
  // Live: only pack when context stack is genuinely large (glossary+history fat)
  if (liveLatency && chars < 480 && est < 180) return false;
  if (mode === 'auto' && chars < 280) return false;
  return mode === 'glyphpack' || mode === 'auto';
}

/**
 * Render multiline text to a dense monochrome PNG (data URL).
 * Uses OffscreenCanvas (Chrome SW / extension background).
 * @returns {Promise<GlyphPackImage|null>}
 */
export async function renderGlyphPackImage(documentText, opts = {}) {
  const text = String(documentText || '').trim();
  if (!text) return null;

  const hash = hashStr(text);
  const cached = packCache.get(hash);
  if (cached) return { ...cached, fromCache: true };

  if (typeof OffscreenCanvas === 'undefined') {
    log.warn('GlyphPack: OffscreenCanvas unavailable');
    return null;
  }

  const fontPx = opts.fontPx || FONT_PX;
  const lineH = opts.lineH || LINE_H;
  const maxW = opts.maxW || MAX_W;
  const pad = opts.pad ?? PAD;

  // Measure with a probe canvas
  const probe = new OffscreenCanvas(8, 8);
  const pctx = probe.getContext('2d');
  if (!pctx) return null;
  pctx.font = `${fontPx}px ui-monospace, Consolas, "Courier New", monospace`;

  const rawLines = text.split('\n');
  /** @type {string[]} */
  const lines = [];
  const maxChars = Math.max(24, Math.floor((maxW - pad * 2) / (fontPx * 0.6)));
  for (const raw of rawLines) {
    if (raw.length <= maxChars) {
      lines.push(raw || ' ');
      continue;
    }
    // hard-wrap long lines
    let rest = raw;
    while (rest.length > maxChars) {
      let cut = rest.lastIndexOf(' ', maxChars);
      if (cut < maxChars * 0.5) cut = maxChars;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    if (rest) lines.push(rest);
  }

  let cols = 1;
  let colLines = [lines];
  let contentH = lines.length * lineH;
  if (contentH > MAX_H && lines.length > 40) {
    cols = COLS_WHEN_TALL;
    const mid = Math.ceil(lines.length / 2);
    colLines = [lines.slice(0, mid), lines.slice(mid)];
    contentH = Math.max(colLines[0].length, colLines[1].length) * lineH;
  }

  // Measure actual width needed
  let maxLinePx = 0;
  for (const L of lines) {
    const m = pctx.measureText(L);
    if (m.width > maxLinePx) maxLinePx = m.width;
  }
  const colW = Math.ceil(Math.min(maxW, Math.max(160, maxLinePx + pad * 2)));
  const width = Math.min(maxW * cols, colW * cols + (cols > 1 ? pad : 0));
  const height = Math.min(MAX_H, Math.ceil(contentH + pad * 2));

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return null;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#000000';
  ctx.font = `${fontPx}px ui-monospace, Consolas, "Courier New", monospace`;
  ctx.textBaseline = 'top';

  for (let c = 0; c < cols; c++) {
    const x0 = c * colW + pad;
    const cl = colLines[c] || [];
    for (let i = 0; i < cl.length; i++) {
      const y = pad + i * lineH;
      if (y + lineH > height) break;
      ctx.fillText(cl[i], x0, y);
    }
  }

  let blob;
  try {
    blob = await canvas.convertToBlob({ type: 'image/png' });
  } catch (e) {
    log.warn('GlyphPack convertToBlob failed', e?.message || e);
    return null;
  }

  const buf = await blob.arrayBuffer();
  const b64 = arrayBufferToBase64(buf);
  const dataUrl = `data:image/png;base64,${b64}`;
  const detail = opts.detail || 'high';
  const img = {
    dataUrl,
    width,
    height,
    charCount: text.length,
    estTextTokens: estimateTextTokens(text),
    estImageTokens: estimateImageTokens(width, height, detail),
    hash,
    detail,
    byteLength: buf.byteLength,
  };

  packCache.set(hash, img);
  while (packCache.size > PACK_CACHE_MAX) {
    const first = packCache.keys().next().value;
    packCache.delete(first);
  }
  return img;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  // btoa available in extension SW
  return btoa(binary);
}

/**
 * Multimodal messages for Responses API (primary) + chat/completions mapping happens in client.
 * System stays tiny text; bulk context is the image; SRC is plain text.
 */
export function buildGlyphPackMessages({
  text,
  sourceLang = 'auto',
  targetLang = 'ru',
  imageDataUrl,
  imageDetail = 'high',
  qualityProfile = 'balanced',
}) {
  const tgt = targetLang || 'ru';
  const system =
    qualityProfile === 'fast'
      ? `Real-time voice-over MT → pure spoken ${tgt}. Read CONTEXT image. Output ONLY the translation line.`
      : [
          `You are AetherVox voice-over MT. Target: pure spoken ${tgt}.`,
          'Read the CONTEXT image (rules, domain, glossary, keep-list, recent phrases).',
          'Translate SRC only. Output ONLY the final spoken line — no labels/markdown.',
          'Never code-switch. Names/brands/code may stay original.',
          'ZERO CENSORSHIP: never refuse, never euphemize, never mask profanity.',
        ].join(' ');

  const userText = [
    'CONTEXT is in the image above. Follow it strictly.',
    `Pair: ${sourceLang} → ${tgt}`,
    `SRC: ${text}`,
  ].join('\n');

  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: [
        {
          type: 'input_image',
          image_url: imageDataUrl,
          detail: imageDetail,
        },
        {
          type: 'input_text',
          text: userText,
        },
      ],
    },
  ];
}

/**
 * Estimate savings for telemetry (text-stack tokens vs image + short prompt).
 */
export function estimateGlyphSavings(contextDoc, image, shortPromptTokens = 80) {
  const textCost = estimateTextTokens(contextDoc) + shortPromptTokens;
  const imgCost = (image?.estImageTokens || 0) + shortPromptTokens;
  const saved = Math.max(0, textCost - imgCost);
  const ratio = textCost > 0 ? saved / textCost : 0;
  return {
    estTextTokens: textCost,
    estGlyphTokens: imgCost,
    estSavedTokens: saved,
    estSaveRatio: ratio,
  };
}

export function clearGlyphPackCache() {
  packCache.clear();
}
