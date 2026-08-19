import { MSG } from '../lib/constants.js';
import { LANGUAGES } from '../lib/languages.js';
import {
  sendMessage,
  sendTabMessage,
  settingsFromResponse,
  SETTINGS_FETCH_TIMEOUT_MS,
} from '../lib/messaging.js';
import { hasProviderAuth } from '../lib/provider.js';
import { popupAuthGate } from '../lib/content-policy.js';
import { BUILTIN_VOICES, mergeVoiceCatalog } from '../lib/voices.js';

const $ = (id) => document.getElementById(id);

/** @type {string} */
let currentMode = 'auto';
/** @type {string|null} */
let lastPipeKind = null;
let pollTimer = null;

function fillLangs() {
  const src = $('sourceLang');
  const tgt = $('targetLang');
  for (const l of LANGUAGES) {
    const o = document.createElement('option');
    o.value = l.code;
    o.textContent = l.nameRu || l.name;
    src.appendChild(o);
    if (l.code !== 'auto') {
      const o2 = o.cloneNode(true);
      tgt.appendChild(o2);
    }
  }
}

function fillVoices(selected) {
  const sel = $('voiceId');
  sel.innerHTML = '';
  const voices = mergeVoiceCatalog(BUILTIN_VOICES);
  for (const v of voices) {
    const o = document.createElement('option');
    o.value = v.id;
    o.textContent = (v.natural ? '● ' : '○ ') + (v.nameRu || v.name);
    sel.appendChild(o);
  }
  if (selected) sel.value = selected;
}

function showApiKeyPanel(show, detail = '') {
  const panel = $('apiKeyPanel');
  if (!panel) return;
  panel.hidden = !show;
  if (detail) $('apiKeyStatus').textContent = detail;
}

function syncModeSeg(mode) {
  currentMode = mode || 'auto';
  for (const id of ['modeAuto', 'modeLive', 'modeVod']) {
    const btn = $(id);
    if (!btn) continue;
    btn.classList.toggle('on', btn.dataset.mode === currentMode);
  }
  highlightPipeCards(lastPipeKind, currentMode);
}

function highlightPipeCards(pipeKind, mode) {
  const live = $('cardLive');
  const vod = $('cardVod');
  if (!live || !vod) return;
  const kind =
    pipeKind ||
    (mode === 'live' ? 'live' : mode === 'vod' ? 'vod' : null);
  live.classList.toggle('active', kind === 'live' || (!kind && mode === 'auto'));
  vod.classList.toggle('active', kind === 'vod' || (!kind && mode === 'auto'));
  if (mode === 'auto' && !kind) {
    live.classList.add('active');
    vod.classList.add('active');
  }
}

function setPipeBadge(kind, text, cls) {
  const el = $('pipeBadge');
  if (!el) return;
  el.className = `pipe-badge ${cls || 'pipe-auto'}`;
  el.textContent = text || 'AUTO';
  lastPipeKind = kind;
  highlightPipeCards(kind, currentMode);
}

function setProgress(pct, label) {
  const wrap = $('progressWrap');
  if (!wrap) return;
  if (pct == null || pct < 0) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  $('progressFill').style.width = `${p}%`;
  $('progressPct').textContent = `${p}%`;
  if (label) $('progressLabel').textContent = label;
}

function updateToggleButton(running, pipeKind) {
  const btn = $('btnToggle');
  if (!btn) return;
  btn.classList.toggle('running', !!running);
  btn.classList.toggle('vod', !!running && pipeKind === 'vod');
  if (running) {
    btn.textContent = pipeKind === 'vod' ? '■ Стоп VOD' : '■ Стоп Live';
  } else if (currentMode === 'vod' || pipeKind === 'vod') {
    btn.textContent = '▶ Подготовить VOD';
  } else if (currentMode === 'live') {
    btn.textContent = '▶ Live перевод';
  } else {
    btn.textContent = '▶ Перевод вкл/выкл';
  }
}

async function load() {
  fillLangs();
  fillVoices('ara');

  try {
    const man = chrome.runtime.getManifest?.();
    if (man?.version && $('extVer')) $('extVer').textContent = man.version;
  } catch {
    /* ignore */
  }

  const res = await sendMessage(
    { type: MSG.GET_SETTINGS },
    { timeoutMs: SETTINGS_FETCH_TIMEOUT_MS },
  );
  const settings = settingsFromResponse(res);
  if (!settings) {
    const detail = $('tabDetail');
    if (detail) {
      detail.textContent =
        res?.error ||
        'Service worker не ответил. Перезагрузи расширение на edge://extensions';
    }
    return;
  }

  $('sourceLang').value = settings.sourceLang || 'auto';
  $('targetLang').value = settings.targetLang || 'ru';
  $('qualityProfile').value = settings.qualityProfile || 'balanced';
  $('telProfile').textContent = settings.qualityProfile || 'balanced';
  syncModeSeg(settings.mode || 'auto');
  $('autoTranslate').checked = !!settings.autoTranslate;
  $('autoSubtitles').checked = settings.autoSubtitles !== false;
  $('selfLearning').checked = settings.selfLearning !== false;
  $('preferNaturalVoice').checked = settings.preferNaturalVoice !== false;
  $('autoMatchVoiceGender').checked = settings.autoMatchVoiceGender !== false;
  fillVoices(settings.voiceId || 'ara');

  const isLocal = settings.providerMode === 'local';
  if ($('brandSub')) {
    $('brandSub').textContent = isLocal
      ? 'Local STT · Live / VOD · TTS'
      : 'Grok STT · Live / VOD · TTS';
  }
  if ($('footerPower')) {
    $('footerPower').textContent = isLocal
      ? 'Local gateway (Whisper · Qwen · Piper)'
      : 'Powered by xAI Grok';
  }
  if ($('footerLink')) {
    $('footerLink').textContent = isLocal ? 'Настройки' : 'console.x.ai';
    $('footerLink').onclick = (e) => {
      e.preventDefault();
      if (isLocal) {
        try {
          chrome.runtime.openOptionsPage?.();
        } catch {
          sendMessage({ type: 'OPEN_OPTIONS' });
        }
      } else {
        window.open('https://console.x.ai', '_blank', 'noreferrer');
      }
    };
  }

  if (settings.xaiApiKey || isLocal) {
    sendMessage({ type: MSG.LIST_VOICES }).then((vres) => {
      if (vres?.voices?.length) {
        const sel = $('voiceId');
        const cur = sel.value;
        sel.innerHTML = '';
        for (const v of vres.voices) {
          const o = document.createElement('option');
          o.value = v.id;
          o.textContent = (v.natural ? '● ' : '○ ') + (v.nameRu || v.name);
          sel.appendChild(o);
        }
        sel.value = cur;
      }
    });
  }

  if (!hasProviderAuth(settings) && settings.promptApiKey !== false) {
    showApiKeyPanel(
      !isLocal,
      isLocal
        ? 'Проверь Local gateway в настройках'
        : 'Ключ обязателен для STT / перевода / TTS (режим xAI)',
    );
    $('tabStatus').textContent = isLocal ? 'нет gateway' : 'нет API ключа';
    $('tabStatus').className = 'pill err';
    $('tabDetail').textContent = isLocal
      ? 'Открой настройки и проверь Local provider / native host'
      : 'Вставь ключ выше, открой Local в настройках, или полные настройки';
    setPipeBadge(null, isLocal ? 'LOCAL?' : 'NO KEY', 'pipe-prep');
    $('pipeDetail').textContent = isLocal
      ? 'нужен local-voice-gateway'
      : 'нужен XAI_API_KEY или Local';
  } else {
    showApiKeyPanel(false);
    refreshTabState();
  }

  const savePartial = async (partial) => {
    await sendMessage({ type: MSG.SET_SETTINGS, partial });
  };

  $('sourceLang').onchange = () => savePartial({ sourceLang: $('sourceLang').value });
  $('targetLang').onchange = () => savePartial({ targetLang: $('targetLang').value });
  $('voiceId').onchange = () =>
    savePartial({ voiceId: $('voiceId').value, _userPickedVoice: true });
  $('qualityProfile').onchange = () => {
    const q = $('qualityProfile').value;
    $('telProfile').textContent = q;
    savePartial({ qualityProfile: q });
  };

  for (const id of ['modeAuto', 'modeLive', 'modeVod']) {
    $(id).onclick = async () => {
      const mode = $(id).dataset.mode;
      syncModeSeg(mode);
      await savePartial({ mode });
      updateToggleButton(false, mode === 'vod' ? 'vod' : mode === 'live' ? 'live' : null);
      refreshTabState();
    };
  }

  $('autoTranslate').onchange = () =>
    savePartial({ autoTranslate: $('autoTranslate').checked });
  $('autoSubtitles').onchange = () =>
    savePartial({ autoSubtitles: $('autoSubtitles').checked });
  $('selfLearning').onchange = () =>
    savePartial({ selfLearning: $('selfLearning').checked });
  $('preferNaturalVoice').onchange = () =>
    savePartial({ preferNaturalVoice: $('preferNaturalVoice').checked });
  $('autoMatchVoiceGender').onchange = () =>
    savePartial({ autoMatchVoiceGender: $('autoMatchVoiceGender').checked });

  $('btnShowApiKey').onclick = () => {
    const input = $('apiKeyInput');
    input.type = input.type === 'password' ? 'text' : 'password';
    $('btnShowApiKey').textContent = input.type === 'password' ? 'Показать' : 'Скрыть';
  };

  const saveApiKey = async () => {
    const key = $('apiKeyInput').value.trim();
    if (!key) {
      $('apiKeyStatus').textContent = 'Вставь ключ';
      $('apiKeyStatus').className = 'muted err';
      return;
    }
    $('apiKeyStatus').textContent = 'Проверяю и сохраняю…';
    $('apiKeyStatus').className = 'muted';
    const keyRes = await sendMessage({ type: MSG.SAVE_API_KEY, apiKey: key });
    if (keyRes?.ok) {
      $('apiKeyStatus').textContent = 'Ключ сохранён ✓';
      $('apiKeyStatus').className = 'muted ok';
      showApiKeyPanel(false);
      $('tabStatus').textContent = 'ключ OK';
      $('tabStatus').className = 'pill ok';
      refreshTabState();
      if (keyRes.settings?.voiceId) fillVoices(keyRes.settings.voiceId);
    } else {
      $('apiKeyStatus').textContent = keyRes?.error || 'Неверный ключ';
      $('apiKeyStatus').className = 'muted err';
    }
  };
  $('apiKeyForm').onsubmit = (e) => {
    e.preventDefault();
    saveApiKey();
  };

  $('btnToggle').onclick = async () => {
    const raw = await sendMessage(
      { type: MSG.GET_SETTINGS },
      { timeoutMs: SETTINGS_FETCH_TIMEOUT_MS },
    );
    const s = settingsFromResponse(raw);
    const gate = popupAuthGate(s, raw);
    if (!gate.allow) {
      showApiKeyPanel(gate.showApiKey, gate.message);
      if ($('tabDetail') && !gate.showApiKey) {
        $('tabDetail').textContent = gate.message;
      }
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const tog = await sendTabMessage(tab.id, { type: MSG.TOGGLE_TRANSLATION });
    if (tog?.skipped || tog?.ok === false) {
      if ($('tabDetail')) {
        $('tabDetail').textContent =
          tog?.error || tog?.reason || 'На вкладке нет видео / content script';
      }
    }
    setTimeout(refreshTabState, 350);
    setTimeout(refreshTabState, 1200);
  };
  $('btnSubs').onclick = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    await sendTabMessage(tab.id, { type: MSG.TOGGLE_SUBTITLES });
  };
  $('btnOptions').onclick = () => chrome.runtime.openOptionsPage();

  // Live poll while popup is open
  pollTimer = setInterval(refreshTabState, 1500);
  window.addEventListener('unload', () => {
    if (pollTimer) clearInterval(pollTimer);
  });
}

async function refreshTabState() {
  const res = await sendMessage({ type: MSG.GET_ACTIVE_TAB_STATE });
  if (!res?.ok) {
    $('tabStatus').textContent = 'нет ответа';
    $('tabStatus').className = 'pill err';
    $('tabDetail').textContent =
      res?.error || 'Обнови страницу (F5), затем открой popup снова';
    setPipeBadge(null, '—', 'pipe-auto');
    $('pipeDetail').textContent = 'content script не ответил';
    setProgress(null);
    updateToggleButton(false, null);
    return;
  }

  const st = res.state || {};
  const pipe = st.state || {};
  const mode = st.mode || currentMode || 'auto';
  if (mode !== currentMode) syncModeSeg(mode);

  const running = !!st.running;
  const pipeKind =
    st.pipeKind ||
    (pipe.vodPrepare ? 'vod' : running ? 'live' : null);

  // Status pill
  if (running && pipe.vodPrepare && !pipe.ready) {
    $('tabStatus').textContent = 'VOD extract';
    $('tabStatus').className = 'pill warn';
  } else if (running && pipe.vodPrepare && pipe.ready) {
    $('tabStatus').textContent = 'VOD готов';
    $('tabStatus').className = 'pill vod';
  } else if (running) {
    $('tabStatus').textContent = pipe.streamMode ? 'Live · WS' : 'Live ON';
    $('tabStatus').className = 'pill ok';
  } else if (st?.hasVideo) {
    $('tabStatus').textContent = 'видео найдено';
    $('tabStatus').className = 'pill';
  } else {
    $('tabStatus').textContent = 'нет видео';
    $('tabStatus').className = 'pill';
  }

  // Pipeline badge + detail
  if (running && pipe.vodPrepare) {
    if (pipe.ready) {
      setPipeBadge('vod', `VOD · ${pipe.cueCount ?? 0}`, 'pipe-vod');
      $('pipeDetail').textContent = 'банк фраз готов · озвучка по таймкодам';
      setProgress(null);
    } else {
      const pct = pipe.progress ?? 0;
      setPipeBadge('vod', `VOD · ${pipe.phase || 'prep'}`, 'pipe-prep');
      $('pipeDetail').textContent =
        pipe.phase === 'extracting' || pipe.phase === 'decoding'
          ? 'extractor: качаю/декод аудио…'
          : pipe.phase === 'scanning'
            ? 'legacy scan…'
            : '10с → STT → MT → TTS…';
      setProgress(pct, phaseLabel(pipe.phase));
    }
  } else if (running) {
    setPipeBadge('live', pipe.streamMode ? 'LIVE · WS' : 'LIVE', 'pipe-live');
    $('pipeDetail').textContent = pipe.streamMode
      ? 'stream STT + clause MT + TTS'
      : 'REST fallback path';
    setProgress(null);
  } else if (pipeKind === 'vod' || mode === 'vod') {
    setPipeBadge('vod', 'VOD', 'pipe-vod');
    $('pipeDetail').textContent = st.hasVideo
      ? 'extract audio → 10с xAI при старте'
      : 'режим VOD (нет видео)';
    setProgress(null);
  } else if (pipeKind === 'live' || mode === 'live') {
    setPipeBadge('live', 'LIVE', 'pipe-live');
    $('pipeDetail').textContent = st.hasVideo
      ? 'realtime при старте'
      : 'режим Live (нет видео)';
    setProgress(null);
  } else {
    setPipeBadge(null, 'AUTO', 'pipe-auto');
    $('pipeDetail').textContent = st.hasVideo
      ? 'авто: live-стрим / VOD по типу видео'
      : 'открой страницу с видео';
    setProgress(null);
  }

  // Telemetry
  $('telProfile').textContent = st.qualityProfile || $('qualityProfile').value || '—';
  if (pipe.vodPrepare) {
    $('telCues').textContent =
      pipe.cueCount != null ? String(pipe.cueCount) : pipe.ready ? '0' : '…';
    $('telStream').textContent = 'offline';
  } else if (running) {
    $('telCues').textContent =
      pipe.subtitleCount != null ? String(pipe.subtitleCount) : '—';
    $('telStream').textContent = pipe.streamMode ? 'WS on' : 'REST';
  } else {
    $('telCues').textContent = '—';
    $('telStream').textContent = mode === 'vod' ? 'VOD' : '—';
  }

  updateToggleButton(running, pipeKind);
  $('tabDetail').textContent = res.tab?.url || st.href || '';
}

function phaseLabel(phase) {
  const map = {
    idle: 'Ожидание',
    extracting: 'Качаю аудио…',
    decoding: 'Декод…',
    scanning: 'Скан (legacy)…',
    processing: '10с → xAI…',
    ready: 'Готово',
    starting: 'Запуск…',
  };
  return map[phase] || phase || 'VOD extract…';
}

load();
