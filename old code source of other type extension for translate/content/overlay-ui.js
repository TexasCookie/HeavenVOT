import { LANGUAGES } from '../lib/languages.js';

/**
 * On-player overlay for AetherVox.
 * Surfaces Live vs VOD prepare, progress, latency stages, and quick controls.
 */
export class OverlayUI {
  /**
   * @param {HTMLElement} anchor
   * @param {object} handlers
   */
  constructor(anchor, handlers = {}) {
    this.anchor = anchor;
    this.handlers = handlers;
    this.root = null;
    this.subsVisible = true;
    this.panelOpen = false;
    this._toastTimer = null;
    /** @type {'auto'|'live'|'vod'} */
    this._modeSetting = 'auto';
    /** @type {'live'|'vod'|null} effective path while running / preview */
    this._pipeKind = null;
    this._running = false;
    this.mount();
  }

  mount() {
    this._anchorPosPrev = null;
    if (getComputedStyle(this.anchor).position === 'static') {
      this._anchorPosPrev = this.anchor.style.position;
      this.anchor.style.position = 'relative';
    }

    const existing = this.anchor.querySelector('#aethervox-root');
    if (existing) existing.remove();

    const root = document.createElement('div');
    root.id = 'aethervox-root';
    root.innerHTML = `
      <div class="av-toast" data-el="toast"></div>
      <button class="av-fab" type="button" title="AetherVox" data-el="fab">
        <span class="av-fab-mark">AV</span>
        <span class="av-fab-ring" data-el="fabRing"></span>
      </button>
      <div class="av-panel" data-el="panel">
        <div class="av-head">
          <div class="av-brand">
            <span class="av-mark">AV</span>
            <div class="av-brand-text">
              <div class="av-title-row">
                <span class="av-title">AetherVox</span>
                <span class="av-ver" data-el="extVer">1.9.11</span>
              </div>
              <div class="av-chips">
                <span class="av-pipe-badge av-pipe-auto" data-el="pipeBadge" title="Пайплайн">AUTO</span>
                <span class="av-badge" data-el="badge">idle</span>
              </div>
            </div>
          </div>
          <span class="av-latency" data-el="latency" title=""></span>
        </div>

        <div class="av-progress" data-el="progressWrap" hidden>
          <div class="av-progress-track">
            <div class="av-progress-fill" data-el="progressFill"></div>
          </div>
          <div class="av-progress-meta">
            <span data-el="progressLabel">Подготовка VOD…</span>
            <span class="av-progress-pct" data-el="progressPct">0%</span>
          </div>
        </div>

        <div class="av-seg" role="group" aria-label="Режим пайплайна">
          <button type="button" class="av-seg-btn" data-mode="auto" data-el="modeAuto" title="Стрим → Live realtime, обычное видео → VOD полный банк">Авто</button>
          <button type="button" class="av-seg-btn" data-mode="live" data-el="modeLive" title="Realtime STT→MT→TTS — только стримы">Live</button>
          <button type="button" class="av-seg-btn" data-mode="vod" data-el="modeVod" title="Пауза → полный банк фраз → Play (как Yandex VOT)">VOD</button>
        </div>

        <div class="av-row av-langs">
          <label class="av-label">Откуда
            <select data-el="sourceLang"></select>
          </label>
          <label class="av-label">Куда
            <select data-el="targetLang"></select>
          </label>
        </div>

        <div class="av-row">
          <label class="av-label">Качество
            <select data-el="qualityProfile">
              <option value="fast">Fast — мин. задержка</option>
              <option value="balanced" selected>Balanced — live + чистота</option>
              <option value="max">Max — смысл (медленнее)</option>
            </select>
          </label>
        </div>

        <div class="av-row av-actions">
          <button class="av-btn primary" type="button" data-el="toggle">▶ Перевод</button>
          <button class="av-btn" type="button" data-el="subs">Субтитры</button>
        </div>

        <div class="av-row av-vols">
          <label class="av-label">Оригинал <span class="av-vol-val" data-el="origVolVal">15%</span>
            <input type="range" min="0" max="100" value="15" data-el="origVol" />
          </label>
          <label class="av-label">Перевод <span class="av-vol-val" data-el="trVolVal">100%</span>
            <input type="range" min="0" max="100" value="100" data-el="trVol" />
          </label>
        </div>

        <div class="av-row av-actions-secondary">
          <button class="av-btn ghost" type="button" data-el="export">SRT</button>
          <button class="av-btn ghost" type="button" data-el="settings">Настройки</button>
        </div>

        <div class="av-meta" data-el="metaLine">Local STT · MT · TTS</div>
        <div class="av-status" data-el="status">Нажми «Перевод». Local gateway или ключ xAI в настройках.</div>
      </div>
      <div class="av-subs" data-el="subsBox">
        <div class="av-line src" data-el="subSrc" style="display:none"></div>
        <div class="av-line" data-el="subTr" style="display:none"></div>
      </div>
      <div class="av-modal" data-el="apiModal" hidden>
        <div class="av-modal-card" data-el="apiModalCard">
          <div class="av-modal-title">AetherVox · API ключ xAI</div>
          <p class="av-modal-help">
            Облачный режим: ключ с console.x.ai. В Local provider ключ не нужен.
          </p>
          <form data-el="apiKeyForm" class="av-api-form" autocomplete="off">
            <label class="av-label">XAI_API_KEY
              <input type="password" data-el="apiKeyInput" name="xaiApiKey" placeholder="xai-..." autocomplete="off" />
            </label>
            <div class="av-row">
              <button class="av-btn primary" type="submit" data-el="apiKeySave">Сохранить</button>
              <button class="av-btn" type="button" data-el="apiKeyCancel">Позже</button>
            </div>
            <div class="av-modal-status" data-el="apiKeyStatus"></div>
          </form>
        </div>
      </div>
    `;

    this.anchor.appendChild(root);
    this.root = root;
    this.els = {};
    root.querySelectorAll('[data-el]').forEach((el) => {
      this.els[el.getAttribute('data-el')] = el;
    });

    this.#fillLangs();
    this.#bind();
    this.#syncModeSeg();
    try {
      const ver = chrome?.runtime?.getManifest?.()?.version;
      if (ver && this.els.extVer) this.els.extVer.textContent = ver;
    } catch {
      /* ignore */
    }
  }

  #fillLangs() {
    const src = this.els.sourceLang;
    const tgt = this.els.targetLang;
    src.innerHTML = '';
    tgt.innerHTML = '';
    for (const l of LANGUAGES) {
      const o1 = document.createElement('option');
      o1.value = l.code;
      o1.textContent = l.nameRu || l.name;
      src.appendChild(o1);
      if (l.code !== 'auto') {
        const o2 = document.createElement('option');
        o2.value = l.code;
        o2.textContent = l.nameRu || l.name;
        tgt.appendChild(o2);
      }
    }
  }

  #bind() {
    this.els.fab.addEventListener('click', (e) => {
      e.stopPropagation();
      this.panelOpen = !this.panelOpen;
      this.els.panel.classList.toggle('av-open', this.panelOpen);
    });
    this.els.toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handlers.onToggle?.();
    });
    this.els.subs.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handlers.onToggleSubs?.();
    });
    this.els.export.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handlers.onExport?.();
    });
    this.els.settings.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handlers.onOpenSettings?.();
    });
    this.els.sourceLang.addEventListener('change', () => {
      this.handlers.onLangChange?.({
        sourceLang: this.els.sourceLang.value,
        targetLang: this.els.targetLang.value,
      });
    });
    this.els.targetLang.addEventListener('change', () => {
      this.handlers.onLangChange?.({
        sourceLang: this.els.sourceLang.value,
        targetLang: this.els.targetLang.value,
      });
    });
    this.els.qualityProfile?.addEventListener('change', () => {
      this.handlers.onQualityChange?.(this.els.qualityProfile.value);
    });
    const emitVol = () => {
      const ov = Number(this.els.origVol.value);
      const tv = Number(this.els.trVol.value);
      if (this.els.origVolVal) this.els.origVolVal.textContent = `${ov}%`;
      if (this.els.trVolVal) this.els.trVolVal.textContent = `${tv}%`;
      this.handlers.onVolume?.({
        originalVolume: ov / 100,
        translationVolume: tv / 100,
      });
    };
    this.els.origVol.addEventListener('input', emitVol);
    this.els.trVol.addEventListener('input', emitVol);

    for (const btn of [this.els.modeAuto, this.els.modeLive, this.els.modeVod]) {
      btn?.addEventListener('click', (e) => {
        e.stopPropagation();
        const mode = btn.getAttribute('data-mode');
        if (!mode || mode === this._modeSetting) return;
        this._modeSetting = /** @type {'auto'|'live'|'vod'} */ (mode);
        this.#syncModeSeg();
        this.#previewPipeFromSetting();
        this.handlers.onModeChange?.(mode);
      });
    }

    this.els.apiKeyForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const key = this.els.apiKeyInput?.value?.trim() || '';
      this.handlers.onSaveApiKey?.(key);
    });
    this.els.apiKeyCancel?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.hideApiKeyModal();
    });
    this.els.apiModal?.addEventListener('click', (e) => {
      if (e.target === this.els.apiModal) this.hideApiKeyModal();
    });
    this.els.apiModalCard?.addEventListener('click', (e) => e.stopPropagation());
  }

  #syncModeSeg() {
    for (const btn of [this.els.modeAuto, this.els.modeLive, this.els.modeVod]) {
      if (!btn) continue;
      const on = btn.getAttribute('data-mode') === this._modeSetting;
      btn.classList.toggle('av-on', on);
    }
  }

  #previewPipeFromSetting() {
    if (this._running) return;
    if (this._modeSetting === 'live') {
      this.setPipelineInfo({ kind: 'live', phase: 'idle' });
    } else if (this._modeSetting === 'vod') {
      this.setPipelineInfo({ kind: 'vod', phase: 'idle' });
    }
    // auto: keep current badge until content refreshIdlePipelineHint resolves live/vod
  }

  showApiKeyModal(message = '') {
    if (!this.els.apiModal) return;
    this.els.apiModal.hidden = false;
    this.els.apiKeyStatus.textContent = message || '';
    this.els.apiKeyStatus.className = 'av-modal-status';
    setTimeout(() => this.els.apiKeyInput?.focus(), 50);
  }

  hideApiKeyModal() {
    if (!this.els.apiModal) return;
    this.els.apiModal.hidden = true;
  }

  setApiKeyStatus(text, ok = false) {
    if (!this.els.apiKeyStatus) return;
    this.els.apiKeyStatus.textContent = text || '';
    this.els.apiKeyStatus.className = `av-modal-status ${ok ? 'ok' : text ? 'err' : ''}`;
  }

  applySettings(settings) {
    if (!settings) return;
    this.els.sourceLang.value = settings.sourceLang || 'auto';
    this.els.targetLang.value = settings.targetLang || 'ru';
    if (this.els.qualityProfile) {
      this.els.qualityProfile.value = settings.qualityProfile || 'balanced';
    }
    this._modeSetting = settings.mode || 'auto';
    this._providerMode = settings.providerMode || 'local';
    this.#syncModeSeg();
    if (!this._running) {
      this.#previewPipeFromSetting();
      if (this.els.metaLine && !this._pipeKind) {
        this.els.metaLine.textContent =
          this._providerMode === 'local'
            ? 'Local STT · MT · TTS'
            : 'Grok STT · MT · TTS';
      }
      if (this.els.status && !this._running) {
        const idle = this.els.status.textContent || '';
        if (/ключ xAI|Local gateway или ключ/i.test(idle) || idle.includes('Нажми')) {
          this.els.status.textContent =
            this._providerMode === 'local'
              ? 'Нажми «Перевод». Local gateway в настройках / native host.'
              : 'Нажми «Перевод». Нужен ключ xAI в настройках.';
        }
      }
    }

    const ov = Math.round((settings.originalVolume ?? 0.15) * 100);
    const tv = Math.round((settings.translationVolume ?? 1) * 100);
    this.els.origVol.value = ov;
    this.els.trVol.value = tv;
    if (this.els.origVolVal) this.els.origVolVal.textContent = `${ov}%`;
    if (this.els.trVolVal) this.els.trVolVal.textContent = `${tv}%`;
    this.subsVisible = settings.autoSubtitles !== false;
    this.root.style.display = settings.showOverlayButton === false ? 'none' : '';
    const st = settings.subtitlesStyle || {};
    if (this.els.subTr) {
      this.els.subTr.style.fontSize = `${st.fontSize || 18}px`;
      this.els.subTr.style.fontFamily = st.fontFamily || 'Segoe UI, system-ui, sans-serif';
      this.els.subTr.style.color = st.color || '#fff';
      this.els.subTr.style.background = st.background || 'rgba(0,0,0,0.62)';
    }
  }

  /**
   * Show which pipeline is active / will be used.
   * @param {{
   *   kind?: 'live'|'vod'|null,
   *   phase?: string,
   *   label?: string,
   *   streamMode?: boolean,
   *   ready?: boolean,
   *   cueCount?: number,
   *   meta?: string,
   * }} info
   */
  setPipelineInfo(info = {}) {
    const kind = info.kind === undefined ? this._pipeKind : info.kind;
    this._pipeKind = kind;

    const badge = this.els.pipeBadge;
    if (!badge) return;

    badge.classList.remove('av-pipe-live', 'av-pipe-vod', 'av-pipe-auto', 'av-pipe-prep');
    let text = info.label || 'AUTO';
    let cls = 'av-pipe-auto';

    if (kind === 'live') {
      text = info.streamMode ? 'LIVE · WS' : 'LIVE';
      cls = 'av-pipe-live';
    } else if (kind === 'vod') {
      if (info.ready) {
        text = info.cueCount != null ? `VOD · ${info.cueCount}` : 'VOD · OK';
        cls = 'av-pipe-vod';
      } else if (info.phase && info.phase !== 'idle' && info.phase !== 'ready') {
        text = `VOD · ${info.phase}`;
        cls = 'av-pipe-prep';
      } else {
        text = 'VOD';
        cls = 'av-pipe-vod';
      }
    } else if (info.label) {
      text = info.label;
    }

    badge.textContent = text;
    badge.classList.add(cls);
    badge.title =
      kind === 'live'
        ? 'Realtime только для стримов: streaming STT → clause MT → TTS'
        : kind === 'vod'
          ? 'VOD: пауза → полный банк фраз → Play по таймкодам'
          : 'Авто: live-стрим → Live, обычное видео → VOD полный банк';

    if (info.meta && this.els.metaLine) {
      this.els.metaLine.textContent = info.meta;
    }

    this.els.fab?.classList.toggle('av-pipe-live', kind === 'live' && this._running);
    this.els.fab?.classList.toggle('av-pipe-vod', kind === 'vod' && this._running);
  }

  /**
   * VOD prepare progress bar (0–100). Hide with null / negative.
   * @param {number|null} pct
   * @param {string} [label]
   */
  setProgress(pct, label) {
    const wrap = this.els.progressWrap;
    if (!wrap) return;
    if (pct == null || pct < 0) {
      wrap.hidden = true;
      this.els.fab?.classList.remove('av-preparing');
      return;
    }
    wrap.hidden = false;
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    if (this.els.progressFill) this.els.progressFill.style.width = `${p}%`;
    if (this.els.progressPct) this.els.progressPct.textContent = `${p}%`;
    if (label && this.els.progressLabel) this.els.progressLabel.textContent = label;
    this.els.fab?.classList.toggle('av-preparing', p < 100);
    if (p >= 100) {
      // Keep bar briefly visible at 100% then caller may hide
      this.els.fab?.classList.remove('av-preparing');
    }
  }

  setMeta(text) {
    if (this.els.metaLine && text != null) this.els.metaLine.textContent = text;
  }

  setRunning(running) {
    this._running = !!running;
    const kind = this._pipeKind;
    let label = '▶ Перевод';
    if (running) {
      label = '■ Стоп';
    } else if (kind === 'vod' || this._modeSetting === 'vod') {
      label = '▶ Подготовить VOD';
    } else if (kind === 'live' || this._modeSetting === 'live') {
      label = '▶ Live перевод';
    }
    this.els.toggle.textContent = label;
    this.els.fab.classList.toggle('av-active', !!running);
    if (!running) {
      this.els.fab.classList.remove('av-preparing', 'av-pipe-live', 'av-pipe-vod');
    }
  }

  setStatus(status, message) {
    const map = {
      idle: ['idle', ''],
      starting: ['starting', 'warn'],
      running: ['running', 'ok'],
      degraded: ['degraded', 'warn'],
      error: ['error', 'err'],
      stopped: ['stopped', ''],
      paused: ['paused', 'warn'],
      preparing: ['prepare', 'warn'],
    };
    const [label, cls] = map[status] || [status, ''];
    this.els.badge.textContent = label;
    this.els.badge.className = `av-badge ${cls}`;
    this.els.fab.classList.toggle('av-degraded', status === 'degraded' || status === 'preparing' || status === 'starting');
    this.els.fab.classList.toggle('av-error', status === 'error');
    if (message) this.els.status.textContent = message;
  }

  /**
   * @param {number|null} ms total end-to-end
   * @param {{ stt?: number, mt?: number, tts?: number, cached?: boolean }|null} [stages]
   * @param {{ lagShed?: boolean, qualityProfile?: string, userQualityProfile?: string, model?: string }|null} [meta]
   */
  setLatency(ms, stages = null, meta = null) {
    if (ms == null) {
      // allow external prep labels via latency el without clearing if progress active
      if (!this.els.progressWrap || this.els.progressWrap.hidden) {
        this.els.latency.textContent = '';
        this.els.latency.title = '';
      }
      return;
    }
    const parts = [`${ms}ms`];
    if (stages && (stages.stt != null || stages.mt != null || stages.tts != null)) {
      const bits = [];
      if (stages.stt != null) bits.push(`S${stages.stt}`);
      if (stages.mt != null) bits.push(stages.cached ? `M${stages.mt}¢` : `M${stages.mt}`);
      if (stages.tts != null) bits.push(`T${stages.tts}`);
      if (bits.length) parts.push(bits.join('/'));
    }
    if (meta?.lagShed) parts.push('⚡');
    if (meta?.economyMode === 'glyphpack') parts.push('gp');
    else if (meta?.economyMode === 'standard' && meta?.economyFallback) parts.push('std↓');
    else if (meta?.economyMode === 'standard') parts.push('std');
    this.els.latency.textContent = parts.join(' ');
    const userQ = meta?.userQualityProfile || meta?.qualityProfile;
    const effQ = meta?.qualityProfile;
    const profileLabel =
      userQ && effQ && userQ !== effQ
        ? `profile ${userQ}→${effQ} (lag)`
        : userQ
          ? `profile ${userQ}`
          : effQ
            ? `profile ${effQ}`
            : '';
    this.els.latency.title = [
      `E2E ${ms} ms (STT→MT→TTS)`,
      stages?.stt != null ? `STT ${stages.stt} ms` : '',
      stages?.mt != null
        ? `MT ${stages.mt} ms${stages.cached ? ' (cache)' : ''}`
        : '',
      stages?.tts != null ? `TTS ${stages.tts} ms` : '',
      stages?.partialUnits > 1 ? `partial TTS ×${stages.partialUnits}` : '',
      stages?.stream ? 'stream' : '',
      stages?.clause ? 'clause MT' : '',
      stages?.ttsFirstByte != null ? `TTS1st ${stages.ttsFirstByte} ms` : '',
      profileLabel,
      meta?.model ? `model ${meta.model}` : '',
      meta?.economyMode
        ? `MT economy: ${meta.economyMode}${meta.economyFallback ? ' (fallback)' : ''}`
        : '',
      meta?.lagShed ? 'lag-shed ON' : '',
    ]
      .filter(Boolean)
      .join(' · ');
    this.els.latency.dataset.level =
      ms < 3000 ? 'ok' : ms < 5500 ? 'warn' : 'bad';
  }

  /** Direct latency label (e.g. VOD prep %) without E2E ms */
  setLatencyLabel(text, level = '') {
    if (!this.els.latency) return;
    this.els.latency.textContent = text || '';
    this.els.latency.dataset.level = level || '';
    this.els.latency.title = text || '';
  }

  toast(message, level = 'info') {
    const el = this.els.toast;
    el.textContent = message;
    el.className = `av-toast av-show ${level === 'error' ? 'err' : level === 'ok' ? 'ok' : ''}`;
    clearTimeout(this._toastTimer);
    const ms = level === 'error' ? 7000 : level === 'ok' ? 2800 : 4200;
    this._toastTimer = setTimeout(() => {
      el.classList.remove('av-show');
    }, ms);
  }

  /**
   * @param {{
   *   sourceText?: string,
   *   text?: string,
   *   showOriginal?: boolean,
   *   clearMissing?: boolean,
   * }} opts
   */
  setSubtitles({ sourceText, text, showOriginal, clearMissing = false }) {
    if (!this.subsVisible) {
      this.els.subSrc.style.display = 'none';
      this.els.subTr.style.display = 'none';
      return;
    }
    if (showOriginal && sourceText) {
      this.els.subSrc.style.display = 'inline-block';
      this.els.subSrc.textContent = sourceText;
    } else if (clearMissing || !showOriginal) {
      this.els.subSrc.style.display = 'none';
      if (clearMissing) this.els.subSrc.textContent = '';
    }
    if (text) {
      this.els.subTr.style.display = 'inline-block';
      this.els.subTr.textContent = text;
    } else if (clearMissing) {
      this.els.subTr.style.display = 'none';
      this.els.subTr.textContent = '';
    }
  }

  clearSubtitles() {
    this.els.subSrc.style.display = 'none';
    this.els.subTr.style.display = 'none';
    this.els.subSrc.textContent = '';
    this.els.subTr.textContent = '';
  }

  setSubsVisible(v) {
    this.subsVisible = v;
    if (!v) this.clearSubtitles();
  }

  destroy() {
    if (this._toastTimer) {
      clearTimeout(this._toastTimer);
      this._toastTimer = null;
    }
    this.root?.remove();
    this.root = null;
    this.els = {};
    if (this.anchor && this._anchorPosPrev !== null && this._anchorPosPrev !== undefined) {
      try {
        this.anchor.style.position = this._anchorPosPrev;
      } catch {
        /* ignore */
      }
    }
    this._anchorPosPrev = null;
  }
}
