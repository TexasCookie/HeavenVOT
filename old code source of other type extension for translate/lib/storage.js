import { DEFAULT_SETTINGS, STORAGE_KEYS } from './constants.js';
import { DEFAULT_NATURAL_VOICE } from './voices.js';
// DEFAULT_SETTINGS carries voiceIdFemale / voiceIdMale

function normalizeExceptions(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (item && typeof item.word === 'string') return item.word.trim();
      return '';
    })
    .filter(Boolean);
}

export async function getSettings() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const raw = data[STORAGE_KEYS.settings] || {};
  // Migrate old default eve → natural ara when user never customized
  let voiceId = raw.voiceId;
  if (!voiceId) voiceId = DEFAULT_NATURAL_VOICE;
  else if (
    voiceId === 'eve' &&
    raw.preferNaturalVoice !== false &&
    raw._migratedNaturalVoice !== true &&
    raw.voiceId === 'eve' &&
    !raw._userPickedVoice
  ) {
    // keep eve if user explicitly had it saved long ago with other custom fields;
    // only auto-switch when settings look like pure defaults
    const looksDefault =
      !raw.glossary?.length &&
      raw.ttsSpeed == null &&
      raw.qualityProfile == null;
    if (looksDefault) voiceId = DEFAULT_NATURAL_VOICE;
  }

  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    voiceId,
    preferNaturalVoice: raw.preferNaturalVoice !== false,
    autoMatchVoiceGender: raw.autoMatchVoiceGender !== false,
    voiceIdFemale: raw.voiceIdFemale || DEFAULT_SETTINGS.voiceIdFemale,
    voiceIdMale: raw.voiceIdMale || DEFAULT_SETTINGS.voiceIdMale,
    expressiveSpeech: raw.expressiveSpeech !== false,
    selfLearning: raw.selfLearning !== false,
    // Respect DEFAULT_SETTINGS (deepLearning off by default for live latency)
    deepLearning:
      raw.deepLearning != null
        ? !!raw.deepLearning
        : DEFAULT_SETTINGS.deepLearning !== false,
    autoUpdateStaleTranslations: raw.autoUpdateStaleTranslations !== false,
    adaptiveTtsSpeed: raw.adaptiveTtsSpeed !== false,
    continuousDubbing: raw.continuousDubbing !== false,
    tokenEconomyMode: ['glyphpack', 'standard', 'auto'].includes(raw.tokenEconomyMode)
      ? raw.tokenEconomyMode
      : DEFAULT_SETTINGS.tokenEconomyMode || 'standard',
    partialSentenceTts: raw.partialSentenceTts !== false,
    streamingPipeline: raw.streamingPipeline !== false,
    streamingTts: raw.streamingTts !== false,
    partialClauseMt: raw.partialClauseMt !== false,
    promptApiKey:
      raw.promptApiKey != null
        ? !!raw.promptApiKey
        : (raw.providerMode || DEFAULT_SETTINGS.providerMode) !== 'local',
    providerMode: raw.providerMode === 'xai' ? 'xai' : 'local',
    localBaseUrl:
      String(raw.localBaseUrl || DEFAULT_SETTINGS.localBaseUrl || '').replace(
        /\/+$/,
        '',
      ) || DEFAULT_SETTINGS.localBaseUrl,
    lmStudioModel:
      String(raw.lmStudioModel || DEFAULT_SETTINGS.lmStudioModel || 'auto').trim() ||
      'auto',
    lmStudioBaseUrl:
      String(raw.lmStudioBaseUrl || DEFAULT_SETTINGS.lmStudioBaseUrl || '').replace(
        /\/+$/,
        '',
      ) || DEFAULT_SETTINGS.lmStudioBaseUrl,
    // VOD progressive: default OFF (full bank); explicit true = play after first chunk
    vodProgressive: raw.vodProgressive === true,
    vodMuteOriginal: raw.vodMuteOriginal !== false,
    vodPauseOnBufferHole: raw.vodPauseOnBufferHole !== false,
    ttsSpeed:
      raw.ttsSpeed != null
        ? Number(raw.ttsSpeed) || DEFAULT_SETTINGS.ttsSpeed
        : DEFAULT_SETTINGS.ttsSpeed,
    subtitlesStyle: {
      ...DEFAULT_SETTINGS.subtitlesStyle,
      ...(raw.subtitlesStyle || {}),
    },
    favoriteTargetLangs: raw.favoriteTargetLangs || DEFAULT_SETTINGS.favoriteTargetLangs,
    glossary: Array.isArray(raw.glossary) ? raw.glossary : [],
    exceptions: normalizeExceptions(raw.exceptions),
    keyterms: Array.isArray(raw.keyterms) ? raw.keyterms : [],
    networkMode: raw.networkMode || DEFAULT_SETTINGS.networkMode,
    apiRelayBase: raw.apiRelayBase || '',
    apiRelayList: raw.apiRelayList || '',
    proxyType: raw.proxyType || DEFAULT_SETTINGS.proxyType,
    proxyHost: raw.proxyHost || '',
    proxyPort:
      raw.proxyPort != null && raw.proxyPort !== ''
        ? Number(raw.proxyPort) || DEFAULT_SETTINGS.proxyPort
        : DEFAULT_SETTINGS.proxyPort,
    proxyUser: raw.proxyUser || '',
    proxyPass: raw.proxyPass || '',
    proxyList: raw.proxyList || '',
    preferDirectMaxMs:
      raw.preferDirectMaxMs != null
        ? Number(raw.preferDirectMaxMs) || DEFAULT_SETTINGS.preferDirectMaxMs
        : DEFAULT_SETTINGS.preferDirectMaxMs,
  };
}

let _settingsWriteChain = Promise.resolve();

export async function setSettings(partial) {
  const job = _settingsWriteChain.then(() => setSettingsUnlocked(partial));
  _settingsWriteChain = job.catch(() => {});
  return job;
}

async function setSettingsUnlocked(partial) {
  const current = await getSettings();
  const next = {
    ...current,
    ...partial,
    subtitlesStyle: {
      ...current.subtitlesStyle,
      ...(partial.subtitlesStyle || {}),
    },
  };
  if (partial.exceptions !== undefined) {
    next.exceptions = normalizeExceptions(partial.exceptions);
  }
  if (partial.voiceId !== undefined) {
    next._userPickedVoice = true;
    next._migratedNaturalVoice = true;
  }
  if (partial.xaiApiKey !== undefined) {
    next.xaiApiKey = String(partial.xaiApiKey || '').trim();
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
  return next;
}

export function onSettingsChanged(callback) {
  const listener = (changes, area) => {
    if (area !== 'local' || !changes[STORAGE_KEYS.settings]) return;
    callback(changes[STORAGE_KEYS.settings].newValue);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

export async function getCachedVoices() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.availableVoices);
  return data[STORAGE_KEYS.availableVoices] || null;
}

export async function setCachedVoices(voices) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.availableVoices]: {
      voices: voices || [],
      updatedAt: Date.now(),
    },
  });
}
