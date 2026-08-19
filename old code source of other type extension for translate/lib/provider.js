/** True when the extension can call STT/MT/TTS (local gateway or xAI key). */
export function hasProviderAuth(settings) {
  if (!settings) return false;
  if (String(settings.providerMode || '') === 'local') return true;
  return !!String(settings.xaiApiKey || '').trim();
}

/** True when provider is the local zero-censorship gateway. */
export function isLocalProvider(settings) {
  return String(settings?.providerMode || '') === 'local';
}
