import { MSG } from '../lib/constants.js';
import { LANGUAGES } from '../lib/languages.js';
import {
  sendMessage,
  settingsFromResponse,
  SETTINGS_FETCH_TIMEOUT_MS,
} from '../lib/messaging.js';
import { BUILTIN_VOICES, mergeVoiceCatalog } from '../lib/voices.js';

const $ = (id) => document.getElementById(id);

function fillLangs() {
  for (const l of LANGUAGES) {
    const o = document.createElement('option');
    o.value = l.code;
    o.textContent = `${l.nameRu || l.name} (${l.code})`;
    $('sourceLang').appendChild(o);
    if (l.code !== 'auto') {
      $('targetLang').appendChild(o.cloneNode(true));
    }
  }
}

/**
 * @param {HTMLSelectElement} sel
 * @param {import('../lib/voices.js').VoiceDef[]} voices
 * @param {string} [selected]
 * @param {'all'|'female'|'male'} [genderFilter]
 */
function fillOneVoiceSelect(sel, voices, selected, genderFilter = 'all') {
  if (!sel) return;
  sel.innerHTML = '';
  let groupLive = document.createElement('optgroup');
  groupLive.label = 'Живые / natural';
  let groupClassic = document.createElement('optgroup');
  groupClassic.label = 'Классические neural';
  for (const v of voices) {
    if (genderFilter === 'female' && v.gender && v.gender !== 'female' && v.gender !== 'neutral') {
      continue;
    }
    if (genderFilter === 'male' && v.gender && v.gender !== 'male' && v.gender !== 'neutral') {
      continue;
    }
    const o = document.createElement('option');
    o.value = v.id;
    o.textContent = v.nameRu || v.name || v.id;
    o.title = v.tone || '';
    if (v.tier === 'live' || v.natural) groupLive.appendChild(o);
    else groupClassic.appendChild(o);
  }
  if (groupLive.children.length) sel.appendChild(groupLive);
  if (groupClassic.children.length) sel.appendChild(groupClassic);
  if (selected) sel.value = selected;
  if (selected && sel.value !== selected) {
    const o = document.createElement('option');
    o.value = selected;
    o.textContent = `${selected} (custom)`;
    sel.appendChild(o);
    sel.value = selected;
  }
}

function fillVoices(list, selected, selectedFemale, selectedMale) {
  const voices = list?.length ? list : mergeVoiceCatalog([]);
  fillOneVoiceSelect($('voiceId'), voices, selected, 'all');
  fillOneVoiceSelect($('voiceIdFemale'), voices, selectedFemale || 'ara', 'female');
  fillOneVoiceSelect($('voiceIdMale'), voices, selectedMale || 'orion', 'male');
}

function parseGlossary(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.split(/\s*=\s*|\s*→\s*|\s*->\s*/);
      if (m.length < 2) return null;
      return { from: m[0].trim(), to: m.slice(1).join('=').trim() };
    })
    .filter(Boolean);
}

function glossaryToText(list) {
  return (list || []).map((g) => `${g.from} = ${g.to}`).join('\n');
}

function parseExceptions(text) {
  return String(text || '')
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function exceptionsToText(list) {
  return (list || [])
    .map((w) => (typeof w === 'string' ? w : w?.word))
    .filter(Boolean)
    .join(', ');
}

async function refreshVoicesList(selected, selectedFemale, selectedMale) {
  $('voicesStatus').textContent = 'Загрузка голосов…';
  const res = await sendMessage({ type: MSG.LIST_VOICES });
  const voices = res?.voices || mergeVoiceCatalog(BUILTIN_VOICES);
  const fem = selectedFemale || $('voiceIdFemale')?.value || 'ara';
  const male = selectedMale || $('voiceIdMale')?.value || 'orion';
  fillVoices(voices, selected, fem, male);

  let status;
  if (res?.offline && !res?.partial) {
    status = `Голосов: ${voices.length} · ${res.notice || 'шлюз офлайн'}`;
  } else if (!res?.partial) {
    status = `Голосов: ${voices.length}`;
  } else {
    let err = String(res?.error || 'нет ключа');
    if (/failed to fetch|fetch failed|networkerror|load failed/i.test(err)) {
      err = 'сеть недоступна — VPN/relay или local-voice-gateway';
    }
    status = res?.offline
      ? `Локальный каталог (${voices.length}) · ${err}`
      : `Локальный каталог (${voices.length}), API: ${err}`;
  }
  if (/Failed to fetch/i.test(status)) {
    status = `Голосов: ${voices.length} · шлюз офлайн`;
  }
  $('voicesStatus').textContent = status;
  return voices;
}

async function load() {
  fillLangs();
  try {
    const man = chrome.runtime.getManifest?.();
    if (man?.version && $('extVer')) $('extVer').textContent = `v${man.version}`;
  } catch {
    /* ignore */
  }
  const settings = settingsFromResponse(
    await sendMessage(
      { type: MSG.GET_SETTINGS },
      { timeoutMs: SETTINGS_FETCH_TIMEOUT_MS },
    ),
  );
  if (!settings) return;

  $('xaiApiKey').value = settings.xaiApiKey || '';
  if ($('providerMode')) {
    $('providerMode').value = settings.providerMode === 'xai' ? 'xai' : 'local';
  }
  if ($('localBaseUrl')) {
    $('localBaseUrl').value = settings.localBaseUrl || 'http://127.0.0.1:8788/v1';
  }
  if ($('lmStudioModel')) {
    $('lmStudioModel').value = settings.lmStudioModel || 'auto';
  }
  if ($('lmStudioBaseUrl')) {
    $('lmStudioBaseUrl').value =
      settings.lmStudioBaseUrl || 'http://127.0.0.1:1234/v1';
  }
  $('sourceLang').value = settings.sourceLang || 'auto';
  $('targetLang').value = settings.targetLang || 'ru';
  await refreshVoicesList(
    settings.voiceId || 'ara',
    settings.voiceIdFemale || 'ara',
    settings.voiceIdMale || 'orion',
  );
  $('preferNaturalVoice').checked = settings.preferNaturalVoice !== false;
  $('autoMatchVoiceGender').checked = settings.autoMatchVoiceGender !== false;
  $('expressiveSpeech').checked = settings.expressiveSpeech !== false;
  $('ttsSpeed').value = settings.ttsSpeed ?? 1.05;
  $('ttsSpeedVal').textContent = String(settings.ttsSpeed ?? 1.05);
  $('adaptiveTtsSpeed').checked = settings.adaptiveTtsSpeed !== false;
  $('continuousDubbing').checked = settings.continuousDubbing !== false;
  $('qualityProfile').value = settings.qualityProfile || 'balanced';
  $('mode').value = settings.mode || 'auto';
  $('tokenEconomyMode').value = settings.tokenEconomyMode || 'standard';
  $('contextAware').checked = settings.contextAware !== false;
  $('domainHints').checked = settings.domainHints !== false;
  $('skipIfSourceIsTarget').checked = settings.skipIfSourceIsTarget !== false;
  if ($('partialSentenceTts')) {
    $('partialSentenceTts').checked = settings.partialSentenceTts !== false;
  }
  if ($('streamingPipeline')) {
    $('streamingPipeline').checked = settings.streamingPipeline !== false;
  }
  if ($('streamingTts')) {
    $('streamingTts').checked = settings.streamingTts !== false;
  }
  if ($('partialClauseMt')) {
    $('partialClauseMt').checked = settings.partialClauseMt !== false;
  }
  $('originalVolume').value = Math.round((settings.originalVolume ?? 0.15) * 100);
  $('originalVolumeVal').textContent = `${$('originalVolume').value}%`;
  $('translationVolume').value = Math.round((settings.translationVolume ?? 1) * 100);
  $('translationVolumeVal').textContent = `${$('translationVolume').value}%`;
  $('duckOriginal').checked = settings.duckOriginal !== false;
  $('showOriginalSubs').checked = settings.showOriginalSubs !== false;
  $('showTranslatedSubs').checked = settings.showTranslatedSubs !== false;
  $('autoTranslate').checked = !!settings.autoTranslate;
  $('autoSubtitles').checked = settings.autoSubtitles !== false;
  $('showOverlayButton').checked = settings.showOverlayButton !== false;
  $('keyterms').value = (settings.keyterms || []).join(', ');
  $('glossary').value = glossaryToText(settings.glossary);
  $('exceptions').value = exceptionsToText(settings.exceptions);
  $('selfLearning').checked = settings.selfLearning !== false;
  $('deepLearning').checked = !!settings.deepLearning;
  if ($('vodProgressive')) {
    $('vodProgressive').checked = settings.vodProgressive === true;
  }
  $('autoUpdateStaleTranslations').checked =
    settings.autoUpdateStaleTranslations !== false;
  $('promptApiKey').checked = settings.promptApiKey !== false;
  $('notifyOnError').checked = settings.notifyOnError !== false;
  $('notifyOnRecover').checked = settings.notifyOnRecover !== false;
  $('debugLogs').checked = !!settings.debugLogs;

  $('networkMode').value = settings.networkMode || 'auto';
  $('preferDirectMaxMs').value = settings.preferDirectMaxMs ?? 900;
  $('apiRelayBase').value = settings.apiRelayBase || '';
  $('apiRelayList').value = settings.apiRelayList || '';
  $('proxyType').value = settings.proxyType || 'socks5';
  $('proxyHost').value = settings.proxyHost || '';
  $('proxyPort').value = settings.proxyPort ?? 1080;
  $('proxyUser').value = settings.proxyUser || '';
  $('proxyPass').value = settings.proxyPass || '';
  $('proxyList').value = settings.proxyList || '';
  updateNetworkStatusUi(null);

  if (!settings.xaiApiKey && settings.providerMode === 'xai') {
    (document.getElementById('sec-key') || $('apiKeyCard'))?.classList.add('highlight');
    $('keyStatus').textContent = 'Ключ не задан — вставь и сохрани';
    $('keyStatus').className = 'muted err';
  }

  $('ttsSpeed').oninput = () => {
    $('ttsSpeedVal').textContent = $('ttsSpeed').value;
  };
  $('originalVolume').oninput = () => {
    $('originalVolumeVal').textContent = `${$('originalVolume').value}%`;
  };
  $('translationVolume').oninput = () => {
    $('translationVolumeVal').textContent = `${$('translationVolume').value}%`;
  };

  $('btnShowKey').onclick = () => {
    const input = $('xaiApiKey');
    input.type = input.type === 'password' ? 'text' : 'password';
    $('btnShowKey').textContent = input.type === 'password' ? 'Показать' : 'Скрыть';
  };

  $('btnValidateLocal')?.addEventListener('click', async () => {
    const st = $('localStatus');
    if (st) {
      st.textContent = 'Проверяю / автозапуск шлюза…';
      st.className = 'muted';
    }
    // Persist local fields first
    await sendMessage({
      type: MSG.SET_SETTINGS,
      partial: {
        providerMode: $('providerMode')?.value || 'local',
        localBaseUrl: $('localBaseUrl')?.value?.trim() || '',
        lmStudioModel: $('lmStudioModel')?.value?.trim() || '',
        lmStudioBaseUrl: $('lmStudioBaseUrl')?.value?.trim() || '',
      },
    });
    const res = await sendMessage({ type: MSG.LOCAL_VALIDATE });
    if (!st) return;
    if (res?.ok) {
      const chat = res.checks?.chat?.text || '';
      const boot = res.ensured?.started ? ' · шлюз поднят' : '';
      st.textContent = `OK · MT: ${chat.slice(0, 80) || 'ok'}${
        res.checks?.chat?.censored ? ' · WARN censor?' : ''
      }${boot}`;
      st.className = res.checks?.chat?.censored ? 'muted err' : 'muted ok';
      await refreshVoicesList($('voiceId').value);
    } else {
      const raw =
        res?.error ||
        res?.checks?.health?.error ||
        res?.checks?.voices?.error ||
        res?.checks?.chat?.error ||
        '';
      const mapped = /failed to fetch|fetch failed/i.test(raw)
        ? 'шлюз недоступен (127.0.0.1:8788)'
        : raw;
      if (res?.ensured?.needInstall || /native host|not found|не установлен/i.test(String(mapped))) {
        const id = res?.extensionId || chrome.runtime?.id || 'YOUR_EXT_ID';
        st.textContent = `Нужен автозапуск (один раз): install-native-host.ps1 -ExtensionId ${id}`;
        if ($('localInstallHint')) {
          $('localInstallHint').hidden = false;
          $('localInstallHint').textContent =
            `powershell -ExecutionPolicy Bypass -File tools/local-voice-gateway/install-native-host.ps1 -ExtensionId ${id}`;
        }
      } else {
        st.textContent =
          mapped ||
          'Шлюз недоступен — запусти tools/local-voice-gateway или поставь автозапуск';
      }
      st.className = 'muted err';
    }
  });

  $('btnInstallGateway')?.addEventListener('click', async () => {
    const id = chrome.runtime.id;
    const cmd = `powershell -ExecutionPolicy Bypass -File tools/local-voice-gateway/install-native-host.ps1 -ExtensionId ${id}`;
    try {
      await navigator.clipboard.writeText(cmd);
      if ($('localStatus')) {
        $('localStatus').textContent = 'Команда скопирована — вставь в PowerShell из корня репо';
        $('localStatus').className = 'muted ok';
      }
    } catch {
      if ($('localStatus')) {
        $('localStatus').textContent = cmd;
        $('localStatus').className = 'muted';
      }
    }
    if ($('localInstallHint')) {
      $('localInstallHint').hidden = false;
      $('localInstallHint').textContent = cmd;
    }
  });

  $('btnValidate').onclick = async () => {
    $('keyStatus').textContent = 'Проверяю…';
    $('keyStatus').className = 'muted';
    const res = await sendMessage({
      type: MSG.XAI_VALIDATE_KEY,
      apiKey: $('xaiApiKey').value.trim(),
    });
    if (res?.ok) {
      $('keyStatus').textContent = `OK · голосов: ${(res.voices || []).length || 'есть'}`;
      $('keyStatus').className = 'muted ok';
      await refreshVoicesList($('voiceId').value);
    } else {
      $('keyStatus').textContent = res?.error || 'Ошибка';
      $('keyStatus').className = 'muted err';
    }
  };

  const saveApiKey = async () => {
    $('keyStatus').textContent = 'Сохраняю…';
    const res = await sendMessage({
      type: MSG.SAVE_API_KEY,
      apiKey: $('xaiApiKey').value.trim(),
    });
    if (res?.ok) {
      $('keyStatus').textContent = 'Ключ сохранён и проверен';
      $('keyStatus').className = 'muted ok';
      document.getElementById('sec-key')?.classList.remove('highlight');
      await refreshVoicesList(res.settings?.voiceId || $('voiceId').value);
    } else {
      $('keyStatus').textContent = res?.error || 'Ошибка';
      $('keyStatus').className = 'muted err';
    }
  };
  $('apiKeyForm').onsubmit = (e) => {
    e.preventDefault();
    saveApiKey();
  };

  $('btnRefreshVoices').onclick = () => refreshVoicesList($('voiceId').value);

  $('btnNetworkProbe').onclick = async () => {
    $('networkStatus').textContent = 'Меряю RTT (direct / relay / proxy)…';
    $('networkStatus').className = 'muted';
    // persist fields first so probe uses current form values
    await saveNetworkPartial();
    const res = await sendMessage({ type: MSG.NETWORK_PROBE });
    updateNetworkStatusUi(res);
  };

  $('btnNetworkClear').onclick = async () => {
    const res = await sendMessage({ type: MSG.NETWORK_APPLY, clearOnly: true });
    $('networkStatus').textContent = res?.ok
      ? 'PAC сброшен — браузер снова на системном VPN/прокси (YouTube и всё остальное не трогали)'
      : res?.error || 'Сброс';
    $('networkStatus').className = res?.ok ? 'muted ok' : 'muted err';
  };

  $('btnLearningStats').onclick = async () => {
    const res = await sendMessage({ type: MSG.GET_LEARNING });
    const L = res?.learning;
    if (!L) {
      $('learningStatus').textContent = 'Нет данных';
      return;
    }
    $('learningStatus').textContent = `rev ${L.revision || 0} · терминов ${
      L.terms?.length || 0
    } · исключений ${L.exceptions?.length || 0} · фраз ${L.phrases?.length || 0} · re-MT ${
      L.stats?.retranslations || 0
    }`;
    // merge learned exceptions into textarea if empty-ish
    if (L.exceptions?.length) {
      const cur = new Set(parseExceptions($('exceptions').value).map((x) => x.toLowerCase()));
      const extra = L.exceptions.map((e) => e.word).filter((w) => w && !cur.has(w.toLowerCase()));
      if (extra.length) {
        const base = $('exceptions').value.trim();
        $('exceptions').value = [base, extra.join(', ')].filter(Boolean).join(', ');
      }
    }
  };

  $('btnResetLearning').onclick = async () => {
    if (!confirm('Сбросить всю память самообучения?')) return;
    await sendMessage({ type: MSG.RESET_LEARNING });
    $('learningStatus').textContent = 'Память очищена';
  };

  $('btnEconomyStats')?.addEventListener('click', async () => {
    const res = await sendMessage({ type: MSG.TOKEN_ECONOMY_STATS });
    const s = res?.stats;
    if (!s) {
      $('economyStatus').textContent = 'Нет данных';
      return;
    }
    const susp =
      s.glyphSuspendedUntil && s.glyphSuspendedUntil > Date.now()
        ? ` · circuit ${Math.ceil((s.glyphSuspendedUntil - Date.now()) / 1000)}s`
        : '';
    $('economyStatus').textContent = `calls ${s.calls} · glyph ${s.glyphOk} · std ${s.standardOk} · fb ${s.fallbacks} · ~save ${s.estSavedTokensTotal} tok${susp}`;
    $('economyStatus').className = 'muted ok';
  });

  $('btnEconomyReset')?.addEventListener('click', async () => {
    const res = await sendMessage({
      type: MSG.TOKEN_ECONOMY_RESET,
      resumeGlyph: true,
    });
    const s = res?.stats;
    $('economyStatus').textContent = s
      ? 'Сброшено, GlyphPack снова активен'
      : 'Сброшено';
    $('economyStatus').className = 'muted ok';
  });

  $('btnSave').onclick = async () => {
    const partial = {
      xaiApiKey: $('xaiApiKey').value.trim(),
      providerMode: $('providerMode')?.value === 'xai' ? 'xai' : 'local',
      localBaseUrl: $('localBaseUrl')?.value?.trim() || 'http://127.0.0.1:8788/v1',
      lmStudioModel: $('lmStudioModel')?.value?.trim() || 'auto',
      lmStudioBaseUrl:
        $('lmStudioBaseUrl')?.value?.trim() || 'http://127.0.0.1:1234/v1',
      promptApiKey:
        $('providerMode')?.value === 'xai'
          ? $('promptApiKey')?.checked !== false
          : false,
      sourceLang: $('sourceLang').value,
      targetLang: $('targetLang').value,
      voiceId: $('voiceId').value,
      preferNaturalVoice: $('preferNaturalVoice').checked,
      autoMatchVoiceGender: $('autoMatchVoiceGender').checked,
      voiceIdFemale: $('voiceIdFemale')?.value || 'ara',
      voiceIdMale: $('voiceIdMale')?.value || 'orion',
      expressiveSpeech: $('expressiveSpeech').checked,
      ttsSpeed: Number($('ttsSpeed').value),
      adaptiveTtsSpeed: $('adaptiveTtsSpeed').checked,
      continuousDubbing: $('continuousDubbing').checked,
      qualityProfile: $('qualityProfile').value,
      mode: $('mode').value,
      tokenEconomyMode: $('tokenEconomyMode')?.value || 'standard',
      partialSentenceTts: $('partialSentenceTts')
        ? $('partialSentenceTts').checked
        : true,
      streamingPipeline: $('streamingPipeline')
        ? $('streamingPipeline').checked
        : true,
      streamingTts: $('streamingTts') ? $('streamingTts').checked : true,
      partialClauseMt: $('partialClauseMt')
        ? $('partialClauseMt').checked
        : true,
      contextAware: $('contextAware').checked,
      domainHints: $('domainHints').checked,
      skipIfSourceIsTarget: $('skipIfSourceIsTarget').checked,
      originalVolume: Number($('originalVolume').value) / 100,
      translationVolume: Number($('translationVolume').value) / 100,
      duckOriginal: $('duckOriginal').checked,
      showOriginalSubs: $('showOriginalSubs').checked,
      showTranslatedSubs: $('showTranslatedSubs').checked,
      autoTranslate: $('autoTranslate').checked,
      autoSubtitles: $('autoSubtitles').checked,
      showOverlayButton: $('showOverlayButton').checked,
      keyterms: $('keyterms')
        .value.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      glossary: parseGlossary($('glossary').value),
      exceptions: parseExceptions($('exceptions').value),
      selfLearning: $('selfLearning').checked,
      deepLearning: $('deepLearning').checked,
      vodProgressive: $('vodProgressive')
        ? $('vodProgressive').checked
        : false,
      autoUpdateStaleTranslations: $('autoUpdateStaleTranslations').checked,
      promptApiKey: $('promptApiKey').checked,
      notifyOnError: $('notifyOnError').checked,
      notifyOnRecover: $('notifyOnRecover').checked,
      debugLogs: $('debugLogs').checked,
      ...collectNetworkPartial(),
      _userPickedVoice: true,
    };
    const res = await sendMessage({ type: MSG.SET_SETTINGS, partial });
    $('saveStatus').textContent = res?.ok ? 'Сохранено' : res?.error || 'Ошибка';
    $('saveStatus').className = res?.ok ? 'muted ok' : 'muted err';
    if (res?.network) updateNetworkStatusUi({ route: res.network, ok: res.network.ok });
  };

  // show current route if any
  sendMessage({ type: MSG.NETWORK_STATUS }).then((res) => {
    if (res?.route || res?.status) updateNetworkStatusUi(res);
  });
}

function collectNetworkPartial() {
  return {
    networkMode: $('networkMode').value || 'auto',
    preferDirectMaxMs: Number($('preferDirectMaxMs').value) || 900,
    apiRelayBase: $('apiRelayBase').value.trim(),
    apiRelayList: $('apiRelayList').value,
    proxyType: $('proxyType').value || 'socks5',
    proxyHost: $('proxyHost').value.trim(),
    proxyPort: Number($('proxyPort').value) || 1080,
    proxyUser: $('proxyUser').value,
    proxyPass: $('proxyPass').value,
    proxyList: $('proxyList').value,
  };
}

async function saveNetworkPartial() {
  return sendMessage({ type: MSG.SET_SETTINGS, partial: collectNetworkPartial() });
}

function updateNetworkStatusUi(res) {
  const el = $('networkStatus');
  if (!el) return;
  if (!res) {
    el.textContent = 'Нажми «Проверить пинг», чтобы выбрать самый быстрый путь';
    el.className = 'muted';
    return;
  }
  const route = res.route || res.status?.cache || null;
  if (!route && res.error) {
    el.textContent = res.error;
    el.className = 'muted err';
    return;
  }
  if (!route) {
    el.textContent = 'Маршрут ещё не выбран';
    el.className = 'muted';
    return;
  }
  const rtt = route.rtt != null && route.rtt >= 0 ? `${route.rtt} ms` : 'n/a';
  const bits = [
    route.ok === false ? '⚠' : '✓',
    route.kind || '?',
    route.label || route.baseUrl || '',
    `RTT ${rtt}`,
  ];
  if (route.proxy) {
    bits.push(`${route.proxy.scheme}://${route.proxy.host}:${route.proxy.port}`);
  }
  if (Array.isArray(route.results)) {
    const okN = route.results.filter((r) => r.ok).length;
    bits.push(`ок ${okN}/${route.results.length}`);
  }
  if (route.error) bits.push(route.error);
  el.textContent = bits.filter(Boolean).join(' · ');
  el.className = route.ok === false ? 'muted err' : 'muted ok';
}

load();
