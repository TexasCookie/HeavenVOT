/**
 * Grok TTS voice catalog.
 * "Natural / live" voices first — prefer conversational & expressive over robotic defaults.
 * Built-in IDs from xAI docs + expanded set (carina, orion, luna, helix, zagan).
 * Unknown IDs from GET /v1/tts/voices are merged at runtime.
 * Gender + voiceType tags drive auto-match of TTS to original speaker
 * (avoids ♂/♀ mismatch and picks closest register/timbre).
 */

/** @typedef {'female'|'male'|'neutral'} VoiceGender */
/** @typedef {'bass'|'baritone'|'tenor'|'alto'|'mezzo'|'soprano'} VoiceType */
/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   nameRu: string,
 *   tone: string,
 *   natural: boolean,
 *   tier: 'live'|'classic',
 *   gender: VoiceGender,
 *   voiceTypes: VoiceType[],
 * }} VoiceDef
 */

/** @type {VoiceDef[]} */
export const BUILTIN_VOICES = [
  {
    id: 'ara',
    name: 'Ara',
    nameRu: 'Ara — тёплый разговорный ♀ (меццо)',
    tone: 'Warm, conversational — closest to live speech',
    natural: true,
    tier: 'live',
    gender: 'female',
    voiceTypes: ['mezzo', 'alto'],
  },
  {
    id: 'carina',
    name: 'Carina',
    nameRu: 'Carina — мягкий, эмпатичный ♀ (сопрано/меццо)',
    tone: 'Soft, empathetic, soothing',
    natural: true,
    tier: 'live',
    gender: 'female',
    voiceTypes: ['soprano', 'mezzo'],
  },
  {
    id: 'luna',
    name: 'Luna',
    nameRu: 'Luna — спокойный, обучающий ♀ (альт)',
    tone: 'Gentle, patient, nurturing — education',
    natural: true,
    tier: 'live',
    gender: 'female',
    voiceTypes: ['alto', 'mezzo'],
  },
  {
    id: 'orion',
    name: 'Orion',
    nameRu: 'Orion — кинематографичный ♂ (баритон)',
    tone: 'Rich, cinematic narration',
    natural: true,
    tier: 'live',
    gender: 'male',
    voiceTypes: ['baritone', 'bass'],
  },
  {
    id: 'helix',
    name: 'Helix',
    nameRu: 'Helix — динамичный (стримы) ♂ (тенор)',
    tone: 'Bold, dynamic — commentary / podcast',
    natural: true,
    tier: 'live',
    gender: 'male',
    voiceTypes: ['tenor', 'baritone'],
  },
  {
    id: 'zagan',
    name: 'Zagan',
    nameRu: 'Zagan — драматичный ♂ (бас)',
    tone: 'Powerful, dramatic characters / narration',
    natural: true,
    tier: 'live',
    gender: 'male',
    voiceTypes: ['bass', 'baritone'],
  },
  {
    id: 'eve',
    name: 'Eve',
    nameRu: 'Eve — энергичный (классика) ♀ (сопрано)',
    tone: 'Energetic and upbeat',
    natural: false,
    tier: 'classic',
    gender: 'female',
    voiceTypes: ['soprano', 'mezzo'],
  },
  {
    id: 'sal',
    name: 'Sal',
    nameRu: 'Sal — сбалансированный ♂ (баритон/тенор)',
    tone: 'Smooth and balanced',
    natural: false,
    tier: 'classic',
    gender: 'male',
    voiceTypes: ['baritone', 'tenor'],
  },
  {
    id: 'rex',
    name: 'Rex',
    nameRu: 'Rex — чёткий профессиональный ♂ (тенор)',
    tone: 'Clear and professional',
    natural: false,
    tier: 'classic',
    gender: 'male',
    voiceTypes: ['tenor', 'baritone'],
  },
  {
    id: 'leo',
    name: 'Leo',
    nameRu: 'Leo — авторитетный ♂ (бас/баритон)',
    tone: 'Authoritative and strong',
    natural: false,
    tier: 'classic',
    gender: 'male',
    voiceTypes: ['bass', 'baritone'],
  },
];

/** Preferred default: most "live human" conversational voice */
export const DEFAULT_NATURAL_VOICE = 'ara';
/** Safe classic fallback if preferred natural voice 404s */
export const CLASSIC_FALLBACK_VOICE = 'eve';
/** Defaults when matching original speaker gender */
export const DEFAULT_FEMALE_VOICE = 'ara';
export const DEFAULT_MALE_VOICE = 'orion';

/**
 * Best built-in TTS voice for each detected original voice type.
 * Chosen for register/timbre proximity to minimize author mismatch.
 * @type {Record<VoiceType, string>}
 */
export const DEFAULT_VOICE_BY_TYPE = {
  bass: 'zagan',
  baritone: 'orion',
  tenor: 'helix',
  alto: 'luna',
  mezzo: 'ara',
  soprano: 'carina',
};

/** Neighbor types for soft fallback when preferred id unavailable */
const VOICE_TYPE_NEIGHBORS = {
  bass: ['baritone', 'tenor'],
  baritone: ['bass', 'tenor'],
  tenor: ['baritone', 'bass'],
  alto: ['mezzo', 'soprano'],
  mezzo: ['alto', 'soprano'],
  soprano: ['mezzo', 'alto'],
};

const byId = Object.fromEntries(BUILTIN_VOICES.map((v) => [v.id, v]));

export function getVoiceDef(id) {
  const key = String(id || '').toLowerCase();
  return byId[key] || null;
}

export function isNaturalVoice(id) {
  const v = getVoiceDef(id);
  return v ? v.natural : false;
}

export function getVoiceGender(id) {
  const v = getVoiceDef(id);
  return v?.gender || guessGenderFromText(id);
}

/**
 * Infer gender from free-text name/description (API voices).
 * @param {string} text
 * @returns {VoiceGender}
 */
export function guessGenderFromText(text = '') {
  const s = String(text || '').toLowerCase();
  if (
    /♀|female|woman|girl|feminine|soft|empath|nurtur|sooth|gentle|warm\s*and\s*friendly|ara|eve|luna|carina|lumen/.test(
      s,
    )
  ) {
    return 'female';
  }
  if (
    /♂|male|man\b|boy|masculine|authorit|strong|bold|dramatic|cinematic|command|orion|helix|zagan|leo|rex|sal|atlas|castor|naksh/.test(
      s,
    )
  ) {
    return 'male';
  }
  return 'neutral';
}

/**
 * Resolve voice preference: natural-first if enabled, else user pick, with classic fallback chain.
 * @param {{ voiceId?: string, preferNaturalVoice?: boolean }} settings
 * @param {string[]} [availableIds] from API if known
 */
export function resolveVoiceId(settings = {}, availableIds = null) {
  const preferNatural = settings.preferNaturalVoice !== false;
  const user = String(settings.voiceId || DEFAULT_NATURAL_VOICE).toLowerCase();
  const available = availableIds?.length
    ? new Set(availableIds.map((x) => String(x).toLowerCase()))
    : null;

  const ok = (id) => !available || available.has(String(id).toLowerCase());

  // Honor explicit user pick when the voice is available
  if (ok(user)) return user;

  // Missing / unavailable: try live voices first when preferred
  if (preferNatural) {
    for (const v of BUILTIN_VOICES) {
      if (v.tier === 'live' && ok(v.id)) return v.id;
    }
  }

  // Classic robot-neural fallbacks
  for (const id of [CLASSIC_FALLBACK_VOICE, 'sal', 'rex', 'leo', DEFAULT_NATURAL_VOICE]) {
    if (ok(id)) return id;
  }
  return CLASSIC_FALLBACK_VOICE;
}

/**
 * Score how well a catalog voice matches a target voice type (higher = better).
 * @param {VoiceDef} voice
 * @param {VoiceType} voiceType
 */
function scoreVoiceForType(voice, voiceType) {
  if (!voice || !voiceType) return 0;
  const types = voice.voiceTypes || [];
  const primary = types[0];
  if (primary === voiceType) return 100;
  const idx = types.indexOf(voiceType);
  if (idx === 1) return 70;
  if (idx > 1) return 40;
  const neighbors = VOICE_TYPE_NEIGHBORS[voiceType] || [];
  if (primary && neighbors.includes(primary)) return 25;
  if (types.some((t) => neighbors.includes(t))) return 15;
  return 0;
}

/**
 * Pick best catalog voice for voice type (register match), gender-safe.
 * @param {VoiceType} voiceType
 * @param {VoiceGender} gender
 * @param {(id: string) => boolean} ok
 * @param {boolean} preferNatural
 * @returns {string|null}
 */
function pickVoiceForType(voiceType, gender, ok, preferNatural) {
  const hardId = DEFAULT_VOICE_BY_TYPE[voiceType];
  if (hardId && ok(hardId)) {
    const g = getVoiceGender(hardId);
    if (g === gender || g === 'neutral') return hardId;
  }

  const pool = BUILTIN_VOICES.filter((v) => {
    if (v.gender !== gender && v.gender !== 'neutral') return false;
    if (!ok(v.id)) return false;
    if (preferNatural && v.tier !== 'live') return false;
    return true;
  });
  let best = null;
  let bestScore = -1;
  for (const v of pool) {
    let s = scoreVoiceForType(v, voiceType);
    if (v.tier === 'live') s += 5;
    if (s > bestScore) {
      bestScore = s;
      best = v.id;
    }
  }
  if (best && bestScore > 0) return best;

  if (preferNatural) {
    return pickVoiceForType(voiceType, gender, ok, false);
  }

  for (const nb of VOICE_TYPE_NEIGHBORS[voiceType] || []) {
    const id = DEFAULT_VOICE_BY_TYPE[nb];
    if (id && ok(id) && (getVoiceGender(id) === gender || getVoiceGender(id) === 'neutral')) {
      return id;
    }
  }
  return null;
}

/**
 * Pick a TTS voice matching original speaker gender + voice type (session override).
 * Priority:
 *  1) Detected voice type → closest catalog timbre (anti-mismatch register match)
 *  2) User voiceIdFemale / voiceIdMale (gender defaults)
 *  3) Best natural voice of that gender
 * Falls back to resolveVoiceId when gender is unknown/neutral.
 *
 * @param {{
 *   voiceId?: string,
 *   voiceIdFemale?: string,
 *   voiceIdMale?: string,
 *   preferNaturalVoice?: boolean,
 *   autoMatchVoiceGender?: boolean,
 * }} settings
 * @param {VoiceGender|null|undefined} speakerGender
 * @param {string[]} [availableIds]
 * @param {VoiceType|null|undefined} [speakerVoiceType]
 */
export function resolveVoiceForGender(
  settings = {},
  speakerGender = null,
  availableIds = null,
  speakerVoiceType = null,
) {
  const available = availableIds?.length
    ? new Set(availableIds.map((x) => String(x).toLowerCase()))
    : null;
  const ok = (id) => id && (!available || available.has(String(id).toLowerCase()));
  const preferNatural = settings.preferNaturalVoice !== false;

  let gender =
    speakerGender === 'female' || speakerGender === 'male' ? speakerGender : null;

  /** @type {VoiceType|null} */
  let voiceType =
    speakerVoiceType && DEFAULT_VOICE_BY_TYPE[speakerVoiceType]
      ? speakerVoiceType
      : null;

  if (!gender && voiceType) {
    gender = ['bass', 'baritone', 'tenor'].includes(voiceType) ? 'male' : 'female';
  }

  // Never allow type that contradicts gender (anti-mismatch hard guard)
  if (gender && voiceType) {
    const typeGender = ['bass', 'baritone', 'tenor'].includes(voiceType)
      ? 'male'
      : 'female';
    if (typeGender !== gender) voiceType = null;
  }

  if (!gender || settings.autoMatchVoiceGender === false) {
    return resolveVoiceId(settings, availableIds);
  }

  // Voice-type match first (closest register to original author)
  if (voiceType) {
    const typed = pickVoiceForType(voiceType, gender, ok, preferNatural);
    if (typed) return typed;
  }

  const preferred =
    gender === 'female'
      ? String(settings.voiceIdFemale || DEFAULT_FEMALE_VOICE).toLowerCase()
      : String(settings.voiceIdMale || DEFAULT_MALE_VOICE).toLowerCase();

  if (ok(preferred)) {
    const g = getVoiceGender(preferred);
    if (g === gender || g === 'neutral') return preferred;
  }

  if (preferNatural) {
    for (const v of BUILTIN_VOICES) {
      if (v.tier === 'live' && v.gender === gender && ok(v.id)) return v.id;
    }
  }
  for (const v of BUILTIN_VOICES) {
    if (v.gender === gender && ok(v.id)) return v.id;
  }

  const hard = gender === 'female' ? DEFAULT_FEMALE_VOICE : DEFAULT_MALE_VOICE;
  if (ok(hard)) return hard;

  return resolveVoiceId(settings, availableIds);
}

/**
 * Convenience: resolve from full speaker profile { gender, voiceType }.
 * @param {object} settings
 * @param {{ gender?: VoiceGender|null, voiceType?: VoiceType|null }|null} profile
 * @param {string[]} [availableIds]
 */
export function resolveVoiceForSpeaker(settings = {}, profile = null, availableIds = null) {
  if (!profile) return resolveVoiceId(settings, availableIds);
  return resolveVoiceForGender(
    settings,
    profile.gender,
    availableIds,
    profile.voiceType || null,
  );
}

/**
 * Merge API voice list into UI options (preserve built-in metadata).
 * @param {{ voice_id?: string, id?: string, name?: string, description?: string, gender?: string }[]} apiVoices
 */
export function mergeVoiceCatalog(apiVoices = []) {
  const map = new Map(
    BUILTIN_VOICES.map((v) => [v.id, { ...v, voiceTypes: [...(v.voiceTypes || [])] }]),
  );
  for (const raw of apiVoices) {
    const id = String(raw.voice_id || raw.id || '').toLowerCase();
    if (!id) continue;
    if (map.has(id)) {
      const cur = map.get(id);
      if (raw.name) cur.name = raw.name;
      if (raw.gender) {
        const g = String(raw.gender).toLowerCase();
        if (g === 'female' || g === 'male') cur.gender = g;
      }
      if (!cur.voiceTypes?.length) {
        cur.voiceTypes = defaultTypesForGender(cur.gender);
      }
      continue;
    }
    // Unknown from API — treat as live if name hints natural/expressive
    const name = raw.name || id;
    const blob = `${name} ${raw.description || ''} ${raw.gender || ''}`;
    const natural = /natural|expressive|warm|soft|live|human|convers/i.test(blob);
    let gender = 'neutral';
    if (raw.gender) {
      const g = String(raw.gender).toLowerCase();
      if (g === 'female' || g === 'male') gender = g;
    }
    if (gender === 'neutral') gender = guessGenderFromText(blob);
    const mark = gender === 'female' ? ' ♀' : gender === 'male' ? ' ♂' : '';
    map.set(id, {
      id,
      name,
      nameRu: natural ? `${name} — живой (API)${mark}` : `${name} (API)${mark}`,
      tone: raw.description || 'Discovered via TTS voices API',
      natural,
      tier: natural ? 'live' : 'classic',
      gender,
      voiceTypes: defaultTypesForGender(gender),
    });
  }
  // live first, then classic, alpha within
  return [...map.values()].sort((a, b) => {
    if (a.tier !== b.tier) return a.tier === 'live' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Default register tags when API voice has no voiceTypes metadata.
 * @param {VoiceGender|string} gender
 * @returns {VoiceType[]}
 */
function defaultTypesForGender(gender) {
  if (gender === 'female') return ['mezzo', 'alto', 'soprano'];
  if (gender === 'male') return ['baritone', 'tenor', 'bass'];
  return [];
}

/**
 * Light naturalization of TTS text: punctuation / pauses for live feel.
 * Does NOT invent laugh tags (too risky for tutorials). Safe defaults only.
 */
export function naturalizeForTts(text, { expressiveSpeech = true } = {}) {
  let t = String(text || '').trim();
  if (!t || !expressiveSpeech) return t;

  // Normalize whitespace
  t = t.replace(/\s+/g, ' ').trim();

  // Soft pause after sentence-ending before next capital (helps prosody)
  t = t.replace(/([.!?…])\s+(?=[A-ZА-ЯЁ«"])/g, '$1 [pause] ');

  // Em-dash / long dash → brief pause
  t = t.replace(/\s*[—–]\s*/g, ' [pause] ');

  // Avoid stacking pauses
  t = t.replace(/(\[pause\]\s*){2,}/g, '[pause] ');

  // Cap total inline tags so we don't over-tag
  let pauseCount = 0;
  t = t.replace(/\[pause\]/g, () => {
    pauseCount += 1;
    return pauseCount <= 4 ? '[pause]' : '';
  });
  t = t.replace(/\s{2,}/g, ' ').trim();
  return t;
}
