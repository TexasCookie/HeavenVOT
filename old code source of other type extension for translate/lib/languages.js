/** Language catalog for STT / translation / TTS (xAI-aligned + extras). */

export const LANGUAGES = [
  { code: 'auto', name: 'Auto', nameRu: 'Автоопределение', stt: true, tts: false },
  { code: 'ru', name: 'Russian', nameRu: 'Русский', stt: true, tts: true, ttsCode: 'ru' },
  { code: 'en', name: 'English', nameRu: 'Английский', stt: true, tts: true, ttsCode: 'en' },
  { code: 'uk', name: 'Ukrainian', nameRu: 'Украинский', stt: true, tts: true, ttsCode: 'uk' },
  { code: 'kk', name: 'Kazakh', nameRu: 'Казахский', stt: true, tts: true, ttsCode: 'kk' },
  { code: 'be', name: 'Belarusian', nameRu: 'Белорусский', stt: false, tts: false },
  { code: 'ja', name: 'Japanese', nameRu: 'Японский', stt: true, tts: true, ttsCode: 'ja' },
  { code: 'zh', name: 'Chinese', nameRu: 'Китайский', stt: false, tts: true, ttsCode: 'zh' },
  { code: 'ko', name: 'Korean', nameRu: 'Корейский', stt: true, tts: true, ttsCode: 'ko' },
  { code: 'ar', name: 'Arabic', nameRu: 'Арабский', stt: true, tts: true, ttsCode: 'ar-SA' },
  { code: 'hi', name: 'Hindi', nameRu: 'Хинди', stt: true, tts: true, ttsCode: 'hi' },
  { code: 'th', name: 'Thai', nameRu: 'Тайский', stt: true, tts: false },
  { code: 'vi', name: 'Vietnamese', nameRu: 'Вьетнамский', stt: true, tts: true, ttsCode: 'vi' },
  { code: 'id', name: 'Indonesian', nameRu: 'Индонезийский', stt: true, tts: true, ttsCode: 'id' },
  { code: 'ms', name: 'Malay', nameRu: 'Малайский', stt: true, tts: false },
  { code: 'fil', name: 'Filipino', nameRu: 'Филиппинский', stt: true, tts: false },
  { code: 'tr', name: 'Turkish', nameRu: 'Турецкий', stt: true, tts: true, ttsCode: 'tr' },
  { code: 'fa', name: 'Persian', nameRu: 'Персидский', stt: true, tts: false },
  { code: 'de', name: 'German', nameRu: 'Немецкий', stt: true, tts: true, ttsCode: 'de' },
  { code: 'fr', name: 'French', nameRu: 'Французский', stt: true, tts: true, ttsCode: 'fr' },
  { code: 'es', name: 'Spanish', nameRu: 'Испанский', stt: true, tts: true, ttsCode: 'es-ES' },
  { code: 'it', name: 'Italian', nameRu: 'Итальянский', stt: true, tts: true, ttsCode: 'it' },
  { code: 'pt', name: 'Portuguese', nameRu: 'Португальский', stt: true, tts: true, ttsCode: 'pt-BR' },
  { code: 'pl', name: 'Polish', nameRu: 'Польский', stt: true, tts: false },
  { code: 'cs', name: 'Czech', nameRu: 'Чешский', stt: true, tts: false },
  { code: 'ro', name: 'Romanian', nameRu: 'Румынский', stt: true, tts: false },
  { code: 'nl', name: 'Dutch', nameRu: 'Нидерландский', stt: true, tts: false },
  { code: 'sv', name: 'Swedish', nameRu: 'Шведский', stt: true, tts: false },
  { code: 'da', name: 'Danish', nameRu: 'Датский', stt: true, tts: false },
  { code: 'mk', name: 'Macedonian', nameRu: 'Македонский', stt: true, tts: false },
  { code: 'bn', name: 'Bengali', nameRu: 'Бенгальский', stt: false, tts: true, ttsCode: 'bn' },
];

const byCode = Object.fromEntries(LANGUAGES.map((l) => [l.code, l]));

export function getLang(code) {
  return byCode[code] || { code, name: code, nameRu: code, stt: false, tts: false };
}

export function langLabel(code, locale = 'ru') {
  const l = getLang(code);
  return locale === 'ru' ? l.nameRu || l.name : l.name;
}

export function ttsLanguageCode(targetLang) {
  const l = getLang(targetLang);
  return l.ttsCode || (l.tts ? l.code : 'auto');
}

export function sttLanguageParam(sourceLang) {
  if (!sourceLang || sourceLang === 'auto') return undefined;
  const l = getLang(sourceLang);
  return l.stt ? l.code : undefined;
}

/** Distant language pairs that need extra translation care (word order, honorifics, etc.) */
export const HARD_PAIRS = new Set([
  'ja-ru', 'ja-en', 'zh-ru', 'zh-en', 'ko-ru', 'ko-en',
  'ar-ru', 'ar-en', 'hi-ru', 'th-ru', 'vi-ru', 'fa-ru',
  'ru-ja', 'en-ja', 'ru-zh', 'en-zh', 'ru-ko', 'en-ko',
]);

export function isHardPair(source, target) {
  const s = (source || 'auto').toLowerCase();
  const t = (target || 'ru').toLowerCase();
  if (s === 'auto') {
    // Source unknown: careful prompts only when target is a distant language.
    // (Previously both ternary branches returned true — always-on hard mode.)
    return ['ja', 'zh', 'ko', 'ar', 'hi', 'th', 'vi', 'fa'].includes(t);
  }
  return HARD_PAIRS.has(`${s}-${t}`) || HARD_PAIRS.has(`${t}-${s}`);
}

export const VOICES = [
  { id: 'eve', label: 'Eve (по умолчанию)' },
  { id: 'ara', label: 'Ara' },
  { id: 'leo', label: 'Leo' },
  { id: 'rex', label: 'Rex' },
  { id: 'sal', label: 'Sal' },
];
