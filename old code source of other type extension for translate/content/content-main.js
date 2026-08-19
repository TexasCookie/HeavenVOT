import { DEFAULT_SETTINGS, MSG } from '../lib/constants.js';
import {
  sendMessage,
  settingsFromResponse,
  SETTINGS_FETCH_TIMEOUT_MS,
} from '../lib/messaging.js';
import { log, setDebug } from '../lib/logger.js';
import { hasProviderAuth, isLocalProvider } from '../lib/provider.js';
import { TranslatorPipeline } from '../lib/pipeline/translator-pipeline.js';
import { VodPreparePipeline } from '../lib/pipeline/vod-prepare-pipeline.js';
import { buildVideoContext } from '../lib/pipeline/context-builder.js';
import {
  shouldUseVodPrepare,
  keepForcedVod,
} from '../lib/pipeline/vod-chunk-policy.js';
import { parseYoutubeVideoId } from '../lib/media/audio-extractor.js';
import { isAllowedMediaStreamUrl, isYoutubeHost } from '../lib/media/url-guard.js';
import {
  settingsFromSetResponse,
  childFrameShouldSkipToggle,
  sameDocumentPostTarget,
} from '../lib/content-policy.js';
import { findBestVideo, watchForVideos, getVideoAnchor } from './video-finder.js';
import { OverlayUI } from './overlay-ui.js';

/** Live streams → realtime; YouTube VOD → offline prepare (Yandex-style). */
function useVodPrepare(settings, videoEl, playerResponse = null) {
  if (settings?.mode === 'live') return false;
  if (settings?.mode === 'vod') return true;
  let isLive = false;
  try {
    const ctx = buildVideoContext(videoEl, document, { playerResponse });
    isLive = !!ctx.isLive;
  } catch {
    const d = videoEl?.duration;
    isLive = d === Infinity;
  }
  return shouldUseVodPrepare({
    mode: settings?.mode || 'auto',
    hostname: location.hostname || '',
    pageUrl: location.href || '',
    isLive,
  });
}

// Only one controller per frame
if (!window.__AETHERVOX_MAIN__) {
  window.__AETHERVOX_MAIN__ = true;
  boot().catch((e) => console.error('[AetherVox]', e));
}

async function boot() {
  let bootRes = await sendMessage(
    { type: MSG.GET_SETTINGS },
    { timeoutMs: SETTINGS_FETCH_TIMEOUT_MS },
  );
  let settings = settingsFromResponse(bootRes);
  if (!settings) {
    bootRes = await sendMessage(
      { type: MSG.GET_SETTINGS },
      { timeoutMs: SETTINGS_FETCH_TIMEOUT_MS },
    );
    settings = settingsFromResponse(bootRes) || { ...DEFAULT_SETTINGS };
  }
  setDebug(!!settings?.debugLogs);

  let video = null;
  let ui = null;
  let pipeline = null;
  let subsOn = settings?.autoSubtitles !== false;
  /** Prevent double-start from double-click / hotkey spam */
  let toggleLock = false;
  /** One-shot: Live empty-STT on YouTube VOD → restart as VodPreparePipeline */
  let forceVodOnce = false;
  /** Generation token so a late attach after detach cannot resurrect UI */
  let attachGen = 0;
  /** Video currently being attached (async detach/mount in flight) */
  let attachingTo = null;
  let unwatchVideos = null;
  /** ytInitialPlayerResponse from MAIN world (VOD extract) */
  let ytPlayerResponse = null;
  let ytVideoId = null;
  /** Pre-resolved stream from page-origin innertube (avoids SW 403) */
  let ytResolvedAudio = null;
  /** Last YouTube videoId while VOD was running (SPA restart) */
  let spaVodVideoId = null;

  // Listen for MAIN-world page bridge (same-window only — B32)
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    if (ev.origin && ev.origin !== window.location.origin) return;
    const d = ev?.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'AETHERVOX_YT_PLAYER') {
      if (d.playerResponse) ytPlayerResponse = d.playerResponse;
      if (d.videoId) ytVideoId = d.videoId;
      if (!pipeline?.running) refreshIdlePipelineHint();
    }
    if (d.type === 'AETHERVOX_YT_AUDIO' && d.audio) {
      const url = String(d.audio.streamUrl || d.audio.url || '');
      if (url && !isAllowedMediaStreamUrl(url)) {
        return;
      }
      ytResolvedAudio = d.audio;
      if (d.audio.videoId) ytVideoId = d.audio.videoId;
      if (d.audio.playerResponse) ytPlayerResponse = d.audio.playerResponse;
    }
  });

  injectPageBridge();

  const attach = (v) => {
    if (!v || v === video || v === attachingTo) return;
    const gen = ++attachGen;
    attachingTo = v;
    // Fire-and-forget detach of previous; attach new after previous pipeline stops
    void (async () => {
      await detach({ keepWatch: true });
      if (gen !== attachGen) {
        if (attachingTo === v) attachingTo = null;
        return; // superseded by newer attach
      }
      video = v;
      attachingTo = null;
      const anchor = getVideoAnchor(v) || v.parentElement || document.body;
      ui = new OverlayUI(anchor, {
        onToggle: () => toggleTranslation(),
        onToggleSubs: () => toggleSubtitles(),
        onExport: () => exportSubs(),
        onOpenSettings: () => {
          try {
            chrome.runtime.openOptionsPage();
          } catch {
            sendMessage({ type: 'OPEN_OPTIONS' });
          }
        },
        onLangChange: async ({ sourceLang, targetLang }) => {
          const res = await sendMessage({
            type: MSG.SET_SETTINGS,
            partial: { sourceLang, targetLang },
          });
          settings = settingsFromSetResponse(res, settings);
          if (settings) pipeline?.updateSettings(settings);
          refreshIdlePipelineHint();
        },
        onModeChange: async (mode) => {
          const res = await sendMessage({
            type: MSG.SET_SETTINGS,
            partial: { mode },
          });
          settings = settingsFromSetResponse(res, settings);
          if (settings) pipeline?.updateSettings(settings);
          refreshIdlePipelineHint();
          ui?.toast(
            mode === 'live'
              ? 'Режим: Live realtime'
              : mode === 'vod'
                ? 'Режим: VOD prepare'
                : 'Режим: Авто (live/VOD)',
            'ok',
          );
        },
        onQualityChange: async (qualityProfile) => {
          const res = await sendMessage({
            type: MSG.SET_SETTINGS,
            partial: { qualityProfile },
          });
          settings = settingsFromSetResponse(res, settings);
          if (settings) pipeline?.updateSettings(settings);
        },
        onVolume: async ({ originalVolume, translationVolume }) => {
          const res = await sendMessage({
            type: MSG.SET_SETTINGS,
            partial: { originalVolume, translationVolume },
          });
          settings = settingsFromSetResponse(res, settings);
          if (settings) pipeline?.updateSettings(settings);
          pipeline?.capture?.setOriginalVolume(originalVolume);
        },
        onSaveApiKey: async (key) => {
          if (!key) {
            ui?.setApiKeyStatus('Вставь ключ', false);
            return;
          }
          ui?.setApiKeyStatus('Проверяю…', false);
          const res = await sendMessage({ type: MSG.SAVE_API_KEY, apiKey: key });
          if (res?.ok) {
            settings =
              res.settings || (await sendMessage({ type: MSG.GET_SETTINGS })).settings;
            ui?.setApiKeyStatus('Ключ сохранён ✓', true);
            ui?.hideApiKeyModal();
            ui?.toast('API ключ сохранён', 'ok');
            ui?.setStatus('idle', 'Ключ OK — можно запускать перевод');
            pipeline?.updateSettings(settings);
            refreshIdlePipelineHint();
            if (settings?.autoTranslate) {
              setTimeout(() => toggleTranslation(true), 400);
            }
          } else {
            ui?.setApiKeyStatus(res?.error || 'Неверный ключ', false);
          }
        },
      });
      if (gen !== attachGen) {
        ui?.destroy();
        ui = null;
        if (attachingTo === v) attachingTo = null;
        return;
      }
      ui.applySettings(settings);
      refreshIdlePipelineHint();
      if (!hasProviderAuth(settings)) {
        const local = isLocalProvider(settings);
        ui.setStatus(
          'idle',
          local
            ? 'Нужен Local gateway — открой настройки'
            : 'Нужен XAI_API_KEY — откроется окно ввода',
        );
        if (!local && settings?.promptApiKey !== false) {
          setTimeout(() => ui?.showApiKeyModal('Вставь ключ с console.x.ai'), 600);
        }
      } else {
        const vod = video
          ? useVodPrepare(settings, video, ytPlayerResponse)
          : settings?.mode === 'vod';
        const local = isLocalProvider(settings);
        ui.setStatus(
          'idle',
          vod
            ? settings?.vodProgressive === true
              ? 'Готов · VOD: после 1-го чанка можно Play (остальное догонит)'
              : 'Готов · VOD: пауза до полного банка → Play'
            : local
              ? 'Готов · Local STT→MT→TTS (zero-censorship)'
              : 'Готов · Live stream STT→MT→TTS',
        );
      }

      if (settings?.autoTranslate && hasProviderAuth(settings)) {
        setTimeout(() => {
          if (gen === attachGen) toggleTranslation(true);
        }, 800);
      }
    })();
  };

  const detach = async ({ keepWatch = false } = {}) => {
    if (pipeline) {
      try {
        await pipeline.stop();
      } catch {
        /* ignore */
      }
      pipeline = null;
    }
    ui?.destroy();
    ui = null;
    video = null;
    if (!keepWatch && unwatchVideos) {
      try {
        unwatchVideos();
      } catch {
        /* ignore */
      }
      unwatchVideos = null;
    }
  };

  unwatchVideos = watchForVideos((v) => {
    if (v) attach(v);
    else void detach({ keepWatch: true });
  });

  // initial
  const first = findBestVideo();
  if (first) attach(first);

  // YouTube SPA: refresh live context; restart VOD when videoId changes
  const onSpaNav = () => {
    const nextId =
      parseYoutubeVideoId(location.href) ||
      ytVideoId ||
      null;
    if (pipeline?.running && pipeline?.vodPrepare) {
      if (nextId && spaVodVideoId && nextId !== spaVodVideoId) {
        ytPlayerResponse = null;
        ytResolvedAudio = null;
        ytVideoId = nextId;
        spaVodVideoId = nextId;
        ui?.toast('Новое видео — перезапуск VOD…', 'ok');
        void toggleTranslation(true);
        return;
      }
      if (nextId) spaVodVideoId = nextId;
    }
    if (!pipeline?.running) return;
    try {
      pipeline.refreshContext?.();
    } catch {
      /* ignore */
    }
  };
  window.addEventListener('yt-navigate-finish', onSpaNav);
  window.addEventListener('yt-page-data-updated', onSpaNav);

  function refreshIdlePipelineHint() {
    if (!ui || pipeline?.running) return;
    const vod =
      video && settings
        ? useVodPrepare(settings, video, ytPlayerResponse)
        : settings?.mode === 'vod';
    const kind =
      settings?.mode === 'live'
        ? 'live'
        : settings?.mode === 'vod'
          ? 'vod'
          : vod
            ? 'vod'
            : video
              ? 'live'
              : null;
    ui.setPipelineInfo({
      kind: settings?.mode === 'auto' && !video ? null : kind,
      phase: 'idle',
      label: settings?.mode === 'auto' && !video ? 'AUTO' : undefined,
      meta: vod
        ? 'VOD · пауза до полного банка → Play'
        : 'Live · stream STT + clause MT + TTS · ~1.5–3s',
    });
    ui.setProgress(null);
    ui.setRunning(false);
  }

  async function toggleTranslation(forceOn) {
    if (toggleLock) {
      log.debug('toggle ignored — already in flight');
      return;
    }
    toggleLock = true;
    try {
      if (!video) {
        // Re-scan once — SPA may have just mounted the player
        const v = findBestVideo();
        if (v) attach(v);
        // attach is async; wait briefly for video binding
        for (let i = 0; i < 12 && !video; i++) {
          await new Promise((r) => setTimeout(r, 40));
        }
        if (!video) {
          ui?.toast('Видео не найдено на странице', 'error');
          return;
        }
      }
      // Re-read settings — popup/options may have saved a key while this page was open
      try {
        const fresh = await sendMessage(
          { type: MSG.GET_SETTINGS },
          { timeoutMs: SETTINGS_FETCH_TIMEOUT_MS },
        );
        const nextSettings = settingsFromResponse(fresh);
        if (nextSettings) {
          settings = nextSettings;
          setDebug(!!settings?.debugLogs);
          ui?.applySettings(settings);
        }
      } catch {
        /* keep cached */
      }

      if (!hasProviderAuth(settings)) {
        ui?.toast(
          isLocalProvider(settings)
            ? 'Локальный режим недоступен'
            : 'Нужен xAI API ключ',
          'error',
        );
        ui?.setStatus(
          'error',
          isLocalProvider(settings) ? 'Local gateway' : 'Нет API ключа',
        );
        if (
          !isLocalProvider(settings) &&
          settings?.promptApiKey !== false
        ) {
          ui?.showApiKeyModal('Добавь ключ, чтобы запустить перевод');
        } else {
          try {
            chrome.runtime.openOptionsPage?.();
          } catch {
            sendMessage({ type: 'OPEN_OPTIONS' });
          }
        }
        return;
      }

      // B25: local mode — soft health ping before start so failures aren't silent
      if (isLocalProvider(settings)) {
        try {
          const v = await sendMessage(
            { type: MSG.LOCAL_VALIDATE },
            // Native gateway cold-start can take ≤70s (waitSec:50 + probe).
            { timeoutMs: 90000 },
          );
          // Distinguish transport timeout from a real failed validate.
          if (v?.timeout === true) {
            ui?.toast(
              'Локальный gateway долго стартует — подожди и повтори',
              'warn',
            );
            ui?.setStatus('error', 'Gateway timeout');
            return;
          }
          if (v?.ok === false || v?.checks?.health?.ok === false) {
            const detail =
              v?.checks?.voices?.ok === false
                ? 'voices'
                : v?.checks?.chat?.ok === false
                  ? 'chat/MT'
                  : 'health';
            ui?.toast(
              `Локальный gateway недоступен (${detail}) — запусти tools/local-voice-gateway`,
              'error',
            );
            ui?.setStatus('error', 'Gateway offline');
            return;
          }
        } catch {
          ui?.toast(
            'Не удалось проверить локальный gateway',
            'error',
          );
          ui?.setStatus('error', 'Gateway check failed');
          return;
        }
      }

      const shouldStart = forceOn === true || !pipeline?.running;
      if (!shouldStart) {
        await pipeline.stop();
        pipeline = null;
        ui?.setRunning(false);
        ui?.setProgress(null);
        ui?.setStatus('stopped', 'Перевод остановлен');
        ui?.toast('Перевод выключен', 'ok');
        refreshIdlePipelineHint();
        return;
      }

      // Always tear down previous instance before start (stuck degraded / forceOn / leak).
      if (pipeline) {
        try {
          await pipeline.stop();
        } catch {
          /* ignore */
        }
        pipeline = null;
      }

      // On YouTube auto: wait for playerResponse BEFORE choosing Live vs VOD
      // (live DVR has finite duration — without PR it falsely picks VOD).
      await ensureYtPlayerForAutodetect();
      const forcedVod = !!forceVodOnce;
      let vodMode = forcedVod || useVodPrepare(settings, video, ytPlayerResponse);
      if (forcedVod) {
        forceVodOnce = false;
        vodMode = true;
      }
      // Refresh page bridge + wait briefly for page-origin audio resolve
      if (vodMode) {
        injectPageBridge();
        try {
          await sendMessage({
            type: MSG.ENSURE_YT_CLIENT_UA,
            userAgent:
              'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
          });
        } catch {
          /* ignore */
        }
        try {
          const vid =
            ytVideoId || parseYoutubeVideoId(location.href) || null;
          window.postMessage(
            { type: 'AETHERVOX_YT_RESOLVE', videoId: vid },
            sameDocumentPostTarget(location.origin),
          );
        } catch {
          /* ignore */
        }
        for (let i = 0; i < 35 && !(ytResolvedAudio && ytResolvedAudio.ok); i++) {
          await new Promise((r) => setTimeout(r, 120));
        }
        // Re-check after PR/audio arrived — live may have been misclassified
        const vodMode2 = useVodPrepare(settings, video, ytPlayerResponse);
        vodMode = keepForcedVod(forcedVod, vodMode2);
        if (vodMode) {
          spaVodVideoId =
            ytVideoId ||
            parseYoutubeVideoId(location.href) ||
            null;
        } else {
          spaVodVideoId = null;
        }
      } else {
        spaVodVideoId = null;
      }
      ui?.setPipelineInfo({
        kind: vodMode ? 'vod' : 'live',
        phase: vodMode ? 'extracting' : 'starting',
        streamMode: !vodMode && settings?.streamingPipeline !== false,
        meta: vodMode
          ? 'VOD · extract → 10s chunks → xAI bank'
          : 'Live · stream path',
      });
      ui?.setProgress(vodMode ? 0 : null, vodMode ? 'Качаю аудио…' : undefined);
      ui?.setStatus(
        vodMode ? 'preparing' : 'starting',
        vodMode
          ? 'VOD: extract audio → 10с → xAI (без прогона ролика)…'
          : 'Live: streaming STT → clause MT → native TTS…',
      );
      ui?.toast(
        vodMode ? 'VOD: извлекаю аудио (yt-dlp analog)…' : 'Запуск Live-перевода…',
      );
      pipeline = vodMode
        ? new VodPreparePipeline({
            video,
            settings,
            onEvent: (ev) => handlePipelineEvent(ev),
            onSubtitles: (s) => handleSubtitles(s),
            pageUrl: location.href,
            playerResponse: ytPlayerResponse,
            videoId: ytVideoId || undefined,
            resolvedAudio:
              ytResolvedAudio?.ok
                ? {
                    streamUrl: ytResolvedAudio.streamUrl,
                    mime: ytResolvedAudio.mime,
                    durationSec: ytResolvedAudio.durationSec,
                    title: ytResolvedAudio.title,
                    source: ytResolvedAudio.source,
                    userAgent: ytResolvedAudio.userAgent || '',
                  }
                : null,
          })
        : new TranslatorPipeline({
            video,
            settings,
            onEvent: (ev) => handlePipelineEvent(ev),
            onSubtitles: (s) => handleSubtitles(s),
          });
      try {
        await pipeline.start();
        ui?.setRunning(true);
        if (vodMode) {
          const n = pipeline.cues?.length || 0;
          const st = pipeline.getState?.() || {};
          const progressive = settings?.vodProgressive === true;
          if (pipeline.ready) {
            const full =
              !progressive ||
              (st.phase === 'ready' && (st.progress ?? 0) >= 99);
            ui?.setProgress(
              full ? 100 : st.progress ?? 40,
              full ? 'VOD банк полный' : 'Смотри · банк догоняет…',
            );
            ui?.setPipelineInfo({
              kind: 'vod',
              phase: full ? 'ready' : 'processing',
              ready: true,
              cueCount: n,
              meta: full
                ? `VOD · ${n} фраз · полный банк`
                : `VOD · буфер готов · ${n} фраз · догоняет`,
            });
            ui?.setStatus(
              'running',
              full
                ? `VOD готов · ${n} фраз · можно Play`
                : `VOD: можно смотреть · фраз ${n} · дальше в фоне`,
            );
          } else {
            ui?.setProgress(
              st.progress ?? 15,
              progressive ? 'Жду 1-й чанк…' : 'Готовлю полный банк…',
            );
            ui?.setPipelineInfo({
              kind: 'vod',
              phase: st.phase || 'processing',
              ready: false,
              cueCount: n,
              meta: progressive
                ? 'VOD · жду первый 10с чанк'
                : 'VOD · пауза · полный банк',
            });
            ui?.setStatus(
              'preparing',
              progressive
                ? 'VOD: готовлю 1-й чанк — потом Play'
                : 'VOD: пауза до полного перевода',
            );
          }
        } else if (!vodMode) {
          ui?.setPipelineInfo({
            kind: 'live',
            streamMode: !!pipeline?.getState?.()?.streamMode,
            meta: 'Live · realtime dubbing (стримы)',
          });
        }
      } catch (e) {
        ui?.setRunning(false);
        ui?.setProgress(null);
        ui?.setStatus('error', String(e.message || e));
        ui?.toast(String(e.message || e), 'error');
        try {
          await pipeline?.stop?.();
        } catch {
          /* ignore */
        }
        pipeline = null;
        refreshIdlePipelineHint();
      }
    } finally {
      toggleLock = false;
    }
  }

  function toggleSubtitles() {
    subsOn = !subsOn;
    ui?.setSubsVisible(subsOn);
    ui?.toast(subsOn ? 'Субтитры вкл' : 'Субтитры выкл');
    sendMessage({
      type: MSG.SET_SETTINGS,
      partial: { autoSubtitles: subsOn },
    }).catch(() => {});
  }

  function handleSubtitles(s) {
    if (!subsOn) return;
    if (s.phase === 'source') {
      // Clear previous translation so stale target line doesn't stick under interim STT
      ui?.setSubtitles({
        sourceText: settings?.showOriginalSubs ? s.sourceText : '',
        text: '',
        showOriginal: !!settings?.showOriginalSubs,
        clearMissing: true,
      });
    } else if (s.phase === 'translated') {
      ui?.setSubtitles({
        sourceText: settings?.showOriginalSubs ? s.sourceText : '',
        text: settings?.showTranslatedSubs !== false ? s.text : '',
        showOriginal: !!settings?.showOriginalSubs,
        clearMissing: true,
      });
    }
  }

  function handlePipelineEvent(ev) {
    if (ev.type === 'status') {
      const st = pipeline?.getState?.();
      const isVod = !!st?.vodPrepare || ev.vodPrepare;
      ui?.setStatus(
        ev.status === 'starting' && isVod ? 'preparing' : ev.status,
        statusMessage(ev.status, isVod),
      );
      ui?.setRunning(
        ev.status === 'running' ||
          ev.status === 'degraded' ||
          ev.status === 'starting',
      );
      if (st) applyStateToUi(st);
    }
    if (ev.type === 'started') {
      ui?.toast(ev.message || 'Перевод запущен', ev.vodPrepare ? 'info' : 'ok');
      ui?.setStatus(ev.vodPrepare ? 'preparing' : 'running', ev.message);
      ui?.setPipelineInfo({
        kind: ev.vodPrepare ? 'vod' : 'live',
        phase: ev.vodPrepare ? 'scanning' : 'running',
        streamMode: !!ev.streamMode,
        meta: ev.vodPrepare
          ? 'VOD · extract → 10s → xAI'
          : ev.streamMode
            ? 'Live · STT WS + clause MT + TTS'
            : 'Live · REST fallback',
      });
      if (ev.vodPrepare) ui?.setProgress(0, 'Extract audio…');
      log.info('Pipeline started', {
        streamMode: !!ev.streamMode,
        vodPrepare: !!ev.vodPrepare,
        message: ev.message,
      });
    }
    if (ev.type === 'vod_progress') {
      const pct = ev.pct != null ? Number(ev.pct) : 0;
      const phase = ev.phase || 'processing';
      ui?.setStatus('preparing', ev.message || `VOD ${pct}%`);
      ui?.setProgress(pct, ev.message || phaseLabel(phase));
      ui?.setLatencyLabel(`prep ${pct}%`, pct >= 100 ? 'ok' : 'warn');
      ui?.setPipelineInfo({
        kind: 'vod',
        phase,
        meta: ev.message || `VOD · ${phase} · ${pct}%`,
      });
      ui?.setRunning(true);
    }
    if (ev.type === 'vod_ready') {
      ui?.setRunning(true);
      ui?.setStatus('running', ev.message || 'VOD готов');
      ui?.setProgress(100, 'Готово — можно смотреть');
      ui?.setLatencyLabel(`cues ${ev.cueCount ?? '✓'}`, 'ok');
      ui?.setPipelineInfo({
        kind: 'vod',
        phase: 'ready',
        ready: true,
        cueCount: ev.cueCount,
        meta: `VOD готов · ${ev.cueCount ?? 0} фраз`,
      });
      ui?.toast(ev.message || 'Перевод готов — можно смотреть', 'ok');
      // Hide progress bar after a beat so it doesn't clutter playback
      setTimeout(() => {
        if (pipeline?.ready) ui?.setProgress(null);
      }, 3500);
      // OS toast already sent by pipeline HEALTH_ALERT kind:vod_ready (B31)
    }
    if (ev.type === 'stopped') {
      ui?.setRunning(false);
      ui?.setProgress(null);
      refreshIdlePipelineHint();
    }
    if (ev.type === 'phrase' && ev.latencyMs != null) {
      ui?.setLatency(ev.latencyMs, ev.stages || null, {
        lagShed: !!ev.lagShed,
        qualityProfile: ev.qualityProfile,
        userQualityProfile: ev.userQualityProfile,
        economyMode: ev.economyMode,
        economyFallback: !!ev.economyFallback,
        model: ev.model,
      });
      if (ev.stages?.stream) {
        ui?.setPipelineInfo({
          kind: 'live',
          streamMode: true,
          meta: 'Live · stream STT/MT/TTS',
        });
      }
    }
    if (ev.type === 'health') {
      ui?.toast(ev.message, ev.level === 'error' ? 'error' : 'ok');
      if (ev.message) ui?.setStatus(ev.level === 'error' ? 'degraded' : 'running', ev.message);
      sendMessage({
        type: MSG.HEALTH_ALERT,
        level: ev.level,
        message: ev.message,
      });
    }
    if (ev.type === 'error' || ev.type === 'warn') {
      ui?.toast(ev.message, ev.type === 'error' ? 'error' : 'info');
      if (ev.type === 'error') ui?.setStatus('error', ev.message);
      else if (ev.message) ui?.setStatus('running', ev.message);
      log[ev.type === 'error' ? 'error' : 'warn']('Pipeline', ev.message);
    }
    if (ev.type === 'prefer_vod') {
      if (!forceVodOnce && !(pipeline instanceof VodPreparePipeline)) {
        forceVodOnce = true;
        ui?.toast('YouTube: переключаю на VOD (offline prepare)…', 'info');
        void (async () => {
          try {
            await pipeline?.stop?.();
          } catch {
            /* ignore */
          }
          pipeline = null;
          await toggleTranslation(true);
        })();
      }
    }
    if (ev.type === 'learn') {
      ui?.toast(ev.message || 'Обучение…', 'ok');
    }
    if (ev.type === 'voice_gender') {
      ui?.toast(ev.message || 'Голос подобран по типу автора', 'ok');
      if (ev.voice_id) {
        const typeMark = ev.speakerVoiceType
          ? {
              bass: 'бас',
              baritone: 'баритон',
              tenor: 'тенор',
              alto: 'альт',
              mezzo: 'меццо',
              soprano: 'сопрано',
            }[ev.speakerVoiceType] || ev.speakerVoiceType
          : null;
        const gMark =
          ev.speakerGender === 'female'
            ? '♀'
            : ev.speakerGender === 'male'
              ? '♂'
              : '?';
        const label = typeMark ? `${typeMark} ${gMark}` : gMark;
        ui?.setStatus?.('running', `TTS: ${ev.voice_id} (${label})`);
        ui?.setMeta?.(`TTS ${ev.voice_id} · ${label}`);
      }
    }
  }

  function applyStateToUi(st) {
    if (!st || !ui) return;
    if (st.vodPrepare) {
      ui.setPipelineInfo({
        kind: 'vod',
        phase: st.phase,
        ready: !!st.ready,
        cueCount: st.cueCount,
        meta: st.ready
          ? `VOD · ${st.cueCount || 0} фраз`
          : `VOD · ${st.phase || 'prepare'} · ${st.progress ?? 0}%`,
      });
      if (!st.ready && st.progress != null) {
        ui.setProgress(st.progress, phaseLabel(st.phase));
      }
    } else {
      ui.setPipelineInfo({
        kind: 'live',
        streamMode: !!st.streamMode,
        meta: st.streamMode
          ? 'Live · STT WS + clause MT'
          : 'Live · REST chunks',
      });
    }
  }

  function phaseLabel(phase) {
    const map = {
      idle: 'Ожидание',
      extracting: 'Качаю аудио (extractor)…',
      decoding: 'Декод аудио…',
      scanning: 'Скан (legacy)…',
      processing: '10с → STT → MT → TTS…',
      ready: 'Готово',
      starting: 'Запуск…',
    };
    return map[phase] || phase || 'Подготовка…';
  }

  function injectPageBridge() {
    // Ask SW for MAIN-world executeScript (Trusted Types / CSP safe)
    try {
      sendMessage({ type: MSG.INJECT_PAGE_BRIDGE }).catch(() => {});
    } catch {
      /* ignore */
    }
    // DOM fallback (works on most sites including YouTube)
    try {
      const id = 'aethervox-page-bridge';
      const prev = document.getElementById(id);
      if (prev) prev.remove();
      const s = document.createElement('script');
      s.id = id;
      s.src =
        chrome.runtime.getURL('content/page-bridge.js') +
        '?v=' +
        Date.now();
      s.async = false;
      (document.documentElement || document.head || document.body).appendChild(s);
    } catch (e) {
      log.debug('page bridge inject', e?.message || e);
    }
  }

  /** Wait for ytInitialPlayerResponse so auto Live/VOD is not guessed from duration alone. */
  async function ensureYtPlayerForAutodetect() {
    const host = String(location.hostname || '');
    if (!isYoutubeHost(host)) return ytPlayerResponse;
    if (settings?.mode === 'live' || settings?.mode === 'vod') {
      return ytPlayerResponse;
    }
    injectPageBridge();
    try {
      const vid = ytVideoId || parseYoutubeVideoId(location.href) || null;
      window.postMessage(
        { type: 'AETHERVOX_YT_RESOLVE', videoId: vid },
        sameDocumentPostTarget(location.origin),
      );
    } catch {
      /* ignore */
    }
    for (let i = 0; i < 25 && !ytPlayerResponse; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return ytPlayerResponse;
  }

  function statusMessage(status, isVod = false) {
    const map = {
      idle: 'Ожидание',
      starting: isVod ? 'VOD extract…' : 'Запуск Live…',
      preparing: 'VOD: extract → 10с xAI…',
      running: isVod
        ? 'VOD: озвучка по таймкодам (оригинал muted)'
        : 'Live: stream STT/MT/TTS · цель 1.5–3s first-audio',
      degraded: 'Сбой — авто-восстановление…',
      error: 'Ошибка',
      stopped: 'Остановлен',
      paused: 'Пауза видео — перевод на паузе',
    };
    return map[status] || status;
  }

  function exportSubs() {
    if (!pipeline) {
      ui?.toast('Нет данных субтитров', 'error');
      return;
    }
    const srt = pipeline.exportSubtitles('srt');
    const blob = new Blob([srt], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `aethervox-${Date.now()}.srt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    ui?.toast('SRT сохранён', 'ok');
  }

  async function cycleTargetLang() {
    const fav = settings?.favoriteTargetLangs || ['ru', 'en'];
    const cur = settings?.targetLang || 'ru';
    const idx = Math.max(0, fav.indexOf(cur));
    const next = fav[(idx + 1) % fav.length];
    const res = await sendMessage({
      type: MSG.SET_SETTINGS,
      partial: { targetLang: next },
    });
    settings = settingsFromSetResponse(res, settings);
    if (settings) {
      ui?.applySettings(settings);
      pipeline?.updateSettings(settings);
    }
    ui?.toast(`Язык перевода: ${next}`, 'ok');
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      const type = message?.type;
      // Broadcast commands hit every frame. Only the frame that owns a player
      // should act — otherwise iframe + top both toggle (double pipeline).
      const ownsPlayer = !!video;
      const isTop = (() => {
        try {
          return window === window.top;
        } catch {
          return false;
        }
      })();

      switch (type) {
        case MSG.TOGGLE_TRANSLATION: {
          let topHasVideo = null;
          if (!isTop) {
            try {
              topHasVideo = !!window.top?.document?.querySelector?.('video');
            } catch {
              topHasVideo = null;
            }
          }
          if (
            childFrameShouldSkipToggle({
              isTop,
              ownsPlayer,
              pipelineRunning: !!pipeline?.running,
              topHasVideo,
            })
          ) {
            return { ok: true, skipped: true, reason: 'child-not-owner' };
          }
          if (!ownsPlayer) {
            // Top frame without video: try one re-scan (SPA race)
            if (isTop) {
              const v = findBestVideo();
              if (v) attach(v);
              for (let i = 0; i < 8 && !video; i++) {
                await new Promise((r) => setTimeout(r, 40));
              }
            }
            if (!video) return { ok: true, skipped: true, reason: 'no-video-in-frame' };
          }
          await toggleTranslation();
          return { ok: true };
        }
        case MSG.TOGGLE_SUBTITLES:
          if (!ownsPlayer && !ui) return { ok: true, skipped: true };
          toggleSubtitles();
          return { ok: true };
        case MSG.TOGGLE_ORIGINAL_MUTE: {
          if (!ownsPlayer && !pipeline) return { ok: true, skipped: true };
          const cur = settings?.originalVolume ?? 0.15;
          const next = cur < 0.05 ? 0.15 : 0;
          const volRes = await sendMessage({
            type: MSG.SET_SETTINGS,
            partial: { originalVolume: next },
          });
          settings = settingsFromSetResponse(volRes, settings);
          if (settings) pipeline?.updateSettings(settings);
          pipeline?.capture?.setOriginalVolume(next);
          if (settings) ui?.applySettings(settings);
          ui?.toast(next === 0 ? 'Оригинал заглушен' : 'Оригинал слышен');
          return { ok: true };
        }
        case MSG.CYCLE_TARGET_LANG:
          // Settings are global — only top frame cycles to avoid N× writes
          if (!isTop) return { ok: true, skipped: true };
          await cycleTargetLang();
          return { ok: true };
        case MSG.SETTINGS_CHANGED:
          if (message.settings && typeof message.settings === 'object') {
            settings = message.settings;
            subsOn = settings.autoSubtitles !== false;
            setDebug(!!settings?.debugLogs);
            ui?.applySettings(settings);
            pipeline?.updateSettings(settings);
          }
          if (!pipeline?.running) refreshIdlePipelineHint();
          return { ok: true };
        case MSG.CONTENT_STATE: {
          // Prefer frames that actually have a player so popup state is accurate
          const st = pipeline?.getState?.() || null;
          const vodWould =
            !!video && settings
              ? useVodPrepare(settings, video, ytPlayerResponse)
              : settings?.mode === 'vod';
          return {
            ok: true,
            hasVideo: !!video,
            running: !!pipeline?.running,
            state: st,
            mode: settings?.mode || 'auto',
            qualityProfile: settings?.qualityProfile || 'balanced',
            pipeKind: st?.vodPrepare
              ? 'vod'
              : pipeline?.running
                ? 'live'
                : vodWould
                  ? 'vod'
                  : video
                    ? 'live'
                    : null,
            hasApiKey: hasProviderAuth(settings),
            providerMode: settings?.providerMode || 'local',
            href: location.href,
            frame: isTop ? 'top' : 'child',
            // Higher score helps SW pick the right frame if it ever aggregates
            priority: (video ? 10 : 0) + (pipeline?.running ? 5 : 0) + (isTop ? 1 : 0),
          };
        }
        case MSG.EXPORT_SUBS:
          if (!pipeline) return { ok: true, skipped: true };
          exportSubs();
          return { ok: true };
        default:
          return { ok: false };
      }
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  });

  log.info('Content main ready on', location.hostname || '(empty host)', {
    top: (() => {
      try {
        return window === window.top;
      } catch {
        return false;
      }
    })(),
  });
}
