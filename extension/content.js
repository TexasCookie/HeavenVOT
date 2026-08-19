(function () {
  const policy = globalThis.LvtPolicy;
  const mixer = globalThis.LvtMixer;
  const playerBtn = globalThis.LvtPlayerButton;
  const captions = globalThis.LvtCaptions;
  let enabled = false;
  let button = null;
  let pollTimer = null;
  let graph = null;
  let settings = { targetLang: "ru", originalGain: 0.25, playMode: "ready" };
  let scheduled = new Set();
  let playing = [];
  let asrActive = false;
  let asrListener = null;
  let wePaused = false;
  let ttsCtx = null;
  let ttsGen = 0;
  let asrReady = false;

  function isWatchPage() {
    return location.pathname === "/watch";
  }

  function videoEl() {
    return document.querySelector("video.html5-main-video, ytd-player video, video");
  }

  function playerEl() {
    return document.querySelector(".html5-video-player");
  }

  function adPlaying() {
    const player = playerEl();
    return !!(player && player.classList.contains("ad-showing"));
  }

  const HOOK_VER = "025";
  let asrHttpBase = "";
  let asrChunks = 0;

  function pageUrl(name) {
    const nested = chrome.runtime.getManifest().background.service_worker.indexOf("/") !== -1;
    return chrome.runtime.getURL(nested ? "extension/" + name : name);
  }

  function injectScript(id, file) {
    return new Promise(function (resolve) {
      const existing = document.getElementById(id);
      if (existing) {
        resolve();
        return;
      }
      const script = document.createElement("script");
      script.id = id;
      script.src = pageUrl(file) + "?v=" + HOOK_VER;
      script.onload = function () {
        resolve();
      };
      script.onerror = function () {
        resolve();
      };
      (document.head || document.documentElement).appendChild(script);
    });
  }

  function injectPageHook() {
    const stale = document.querySelectorAll(
      "#lvt-page-hook, #lvt-asr-audio, #lvt-session-hook, [id^='lvt-page-hook-'], [id^='lvt-asr-audio-'], [id^='lvt-session-hook-']"
    );
    for (let i = 0; i < stale.length; i++) {
      if (
        stale[i].id === "lvt-page-hook-" + HOOK_VER ||
        stale[i].id === "lvt-asr-audio-" + HOOK_VER ||
        stale[i].id === "lvt-session-hook-" + HOOK_VER
      ) {
        continue;
      }
      stale[i].remove();
    }
    return injectScript("lvt-session-hook-" + HOOK_VER, "session-hook.js").then(function () {
      return injectScript("lvt-asr-audio-" + HOOK_VER, "asr-audio.js");
    }).then(function () {
      return injectScript("lvt-page-hook-" + HOOK_VER, "injected.js");
    });
  }

  function requestPlayerPayload() {
    return new Promise(function (resolve) {
      function onMsg(event) {
        if (event.source !== window) return;
        if (!event.data || event.data.type !== "LVT_PLAYER_RESPONSE") return;
        window.removeEventListener("message", onMsg);
        resolve(event.data.payload || null);
      }
      window.addEventListener("message", onMsg);
      window.postMessage({ type: "LVT_REQUEST_PLAYER" }, "*");
      setTimeout(function () {
        window.removeEventListener("message", onMsg);
        resolve(null);
      }, 1500);
    });
  }

  function setButtonState(label) {
    if (button) button.textContent = label;
  }

  function overlayHost() {
    return (
      document.querySelector("ytd-player#ytd-player") ||
      document.querySelector("ytd-watch-flexy ytd-player") ||
      document.querySelector("ytd-player") ||
      document.querySelector("#player-container") ||
      document.querySelector("#player")
    );
  }

  function ensureButton() {
    if (!isWatchPage()) return;
    if (playerBtn) playerBtn.installWindowCapture(onToggle);
    const host = overlayHost();
    if (!host) return;
    const existing = document.getElementById(playerBtn ? playerBtn.TOGGLE_ID : "lvt-toggle");
    if (existing && host.contains(existing)) {
      button = existing;
      return;
    }
    if (existing) existing.remove();
    button = document.createElement("button");
    button.id = playerBtn ? playerBtn.TOGGLE_ID : "lvt-toggle";
    button.className = "lvt-toggle";
    button.type = "button";
    button.textContent = "Перевод";
    button.addEventListener("click", function (event) {
      if (event && event.stopPropagation) event.stopPropagation();
      onToggle();
    });
    if (playerBtn) playerBtn.mountOverlay(host, button);
    else host.appendChild(button);
    injectPageHook();
  }

  async function hostStatus() {
    if (!chrome.runtime || !chrome.runtime.sendMessage) {
      throw new Error("no runtime");
    }
    const request = Promise.resolve(chrome.runtime.sendMessage({ type: "lvt-status" }));
    const timeout = new Promise(function (_, reject) {
      setTimeout(function () {
        reject(new Error("status timeout"));
      }, 2500);
    });
    return Promise.race([request, timeout]);
  }

  async function onToggle() {
    window.postMessage({ type: "LVT_ASR_UNLOCK" }, "*");
    setButtonState(enabled ? "…" : "…");
    try {
      await runToggle();
    } catch (err) {
      setButtonState("ошибка");
    }
  }

  async function runToggle() {
    if (enabled) {
      await stopSession("user");
      return;
    }
    const video = videoEl();
    if (!video) {
      setButtonState("нет видео");
      return;
    }
    if (!policy.playbackRateAllowed(video.playbackRate)) {
      setButtonState("только 1×");
      return;
    }
    let status;
    try {
      status = await hostStatus();
    } catch (err) {
      setButtonState("нет хоста");
      return;
    }
    if (!status || !status.httpBase) {
      setButtonState("нет хоста");
      return;
    }
    const duration = Number(video.duration || 0);
    let mediaInfo = { videoId: "", audioUrl: "", audioUrls: [], poToken: "", visitorData: "" };
    try {
      const t = Number(video.currentTime);
      if (Number.isFinite(t)) video.currentTime = Math.max(0, t + 0.05);
    } catch (err) {}
    await new Promise(function (resolve) {
      setTimeout(resolve, 450);
    });
    try {
      mediaInfo = (await chrome.runtime.sendMessage({ type: "lvt-media" })) || mediaInfo;
    } catch (err) {}
    if ((!mediaInfo.audioUrl && !(mediaInfo.audioUrls && mediaInfo.audioUrls.length)) || !mediaInfo.poToken) {
      try {
        const t2 = Number(video.currentTime);
        if (Number.isFinite(t2)) video.currentTime = Math.max(0, t2 + 0.05);
      } catch (err) {}
      await new Promise(function (resolve) {
        setTimeout(resolve, 500);
      });
      try {
        const again = await chrome.runtime.sendMessage({ type: "lvt-media" });
        if (again) mediaInfo = Object.assign(mediaInfo, again);
      } catch (err) {}
    }
    const videoId =
      (captions && captions.pickVideoId
        ? captions.pickVideoId(location.search, mediaInfo.videoId, "", "")
        : mediaInfo.videoId) ||
      new URLSearchParams(location.search).get("v") ||
      "";
    const loaded = await collectCues(videoId, settings.targetLang);
    let ytCookies = [];
    try {
      const pack = await chrome.runtime.sendMessage({ type: "lvt-yt-cookies" });
      if (pack && pack.cookies) ytCookies = pack.cookies;
    } catch (err) {}
    let start;
    try {
      const body = {
        tab_id: String(videoId) + ":" + String(Date.now()),
        video_id: videoId,
        target_lang: settings.targetLang,
        video_duration: Number.isFinite(duration) ? duration : 0,
        playback_rate: video.playbackRate,
        source_lang: loaded.sourceLang || "",
        cues: loaded.cues || [],
        asr_mode: true,
        play_mode: settings.playMode === "full" ? "full" : "ready",
        playhead: Number(video.currentTime) || 0,
        cookies: ytCookies,
        expect_upload: !!(mediaInfo && (mediaInfo.audioUrl || (mediaInfo.audioUrls && mediaInfo.audioUrls.length))),
        audio_url: (mediaInfo && mediaInfo.audioUrl) || "",
        audio_urls: (mediaInfo && mediaInfo.audioUrls) || [],
        po_token: (mediaInfo && mediaInfo.poToken) || "",
        visitor_data: (mediaInfo && mediaInfo.visitorData) || "",
      };
      const response = await fetch(status.httpBase + "/v1/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      start = await response.json();
      if (!response.ok) {
        setButtonState(labelForStart(start));
        return;
      }
    } catch (err) {
      setButtonState("ошибка");
      return;
    }
    if (start.state === "skipped") {
      setButtonState("уже на языке");
      return;
    }
    if (start.state === "error" || start.error || (start.state !== "buffering" && start.state !== "ready" && start.state !== "playing")) {
      setButtonState(labelForStart(start));
      return;
    }
    await chrome.runtime.sendMessage({ type: "lvt-claim-tab" });
    enabled = true;
    wePaused = false;
    asrReady = false;
    ttsGen += 1;
    setButtonState("качаю…");
    ensureTtsContext();
    attachMixer(video);
    if (mediaInfo.audioUrl || (mediaInfo.audioUrls && mediaInfo.audioUrls.length)) {
      const httpBase = status.httpBase;
      let settled = false;
      function askNeedFile() {
        if (settled) return;
        settled = true;
        fetch(httpBase + "/v1/session/need-file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }).catch(function () {});
      }
      const fetchTimer = setTimeout(askNeedFile, 18000);
      chrome.runtime.sendMessage(
        {
          type: "lvt-fetch-audio",
          url: mediaInfo.audioUrl,
          urls: mediaInfo.audioUrls || [],
          startAt: 0,
        },
        function (res) {
          const failed = !!(chrome.runtime.lastError) || !res || !res.ok;
          if (!failed) {
            settled = true;
            clearTimeout(fetchTimer);
            return;
          }
          clearTimeout(fetchTimer);
          askNeedFile();
        }
      );
    }
    startPolling(status.httpBase, video);
  }

  function labelForStart(start) {
    if (!start) return "ошибка";
    if (start.reason === "need_asr" || start.error === "asr_unavailable") return "ставь ASR";
    if (String(start.reason || "").indexOf("download") !== -1) return "нет дорожки";
    if (start.reason === "asr_empty") return "ASR пусто";
    if (start.reason === "decode_failed") return "нет декода";
    return "ошибка";
  }

  function labelForBuffer(reason) {
    var text = String(reason || "");
    if (text === "downloading") return "качаю…";
    if (text === "checking captions") return "сверяю…";
    if (text === "transcribing") return "ASR…";
    if (text.indexOf("waiting for asr") !== -1) return "качаю…";
    return "буфер";
  }

  function fetchText(url) {
    return fetch(url, { credentials: "include" }).then(function (res) {
      return res.text();
    });
  }

  async function collectCues(videoId, targetLang) {
    if (captions) {
      try {
        const harvested = await chrome.runtime.sendMessage({
          type: "lvt-harvest",
          videoId: videoId,
          targetLang: targetLang,
        });
        if (harvested && harvested.text && captions.parseTimedtext) {
          const cues = captions.parseTimedtext(harvested.text, harvested.language || "");
          if (cues.length) return { cues: cues, sourceLang: harvested.language || "" };
        }
      } catch (err) {}
      try {
        const byId = await captions.loadByVideoId(videoId, targetLang, fetchText);
        if (byId.cues && byId.cues.length) return byId;
      } catch (err) {}
    }
    return { cues: [], sourceLang: "" };
  }

  function markAsr(label) {
    if (!asrActive) return;
    if (label === "Выкл") asrReady = true;
    if (asrReady && label !== "нет ASR-звука") {
      setButtonState("Выкл");
      return;
    }
    setButtonState(label);
  }

  function postTranscribe(startAt, buf) {
    const headers = {
      "Content-Type": "audio/wav",
      "X-Audio-Start": String(startAt || 0),
    };
    return fetch(asrHttpBase + "/v1/session/audio-file", {
      method: "POST",
      headers: headers,
      body: buf,
    }).then(function (res) {
      return res.json().then(function (body) {
        return { ok: res.ok, body: body };
      });
    }).catch(function () {
      const pack = globalThis.LvtAsrAudio ? globalThis.LvtAsrAudio.toBase64(buf) : "";
      return new Promise(function (resolve) {
        chrome.runtime.sendMessage({ type: "lvt-transcribe", startAt: startAt || 0, audioB64: pack }, function (res) {
          if (chrome.runtime.lastError) resolve({ ok: false });
          else resolve(res || { ok: false });
        });
      });
    }).then(function (res) {
      if (res && res.ok && res.body && res.body.added > 0) markAsr("Выкл");
    });
  }

  function startAsrCapture(httpBase) {
    stopAsrCapture();
    asrActive = true;
    asrHttpBase = httpBase || "";
    asrChunks = 0;
    asrListener = function (event) {
      if (event.source !== window || !event.data) return;
      if (event.data.type === "LVT_ASR_STATUS") {
        if (!event.data.ok) markAsr("нет ASR-звука");
        return;
      }
      if (event.data.type !== "LVT_ASR_CHUNK" || !enabled) return;
      if (event.data.silent) return;
      const buf = event.data.buffer;
      if (!buf || !buf.byteLength) return;
      postTranscribe(event.data.startAt || 0, buf);
    };
    window.addEventListener("message", asrListener);
    return injectPageHook().then(function () {
      window.postMessage({ type: "LVT_ASR_START" }, "*");
    });
  }

  function stopAsrCapture() {
    asrActive = false;
    asrHttpBase = "";
    asrChunks = 0;
    window.postMessage({ type: "LVT_ASR_STOP" }, "*");
    if (asrListener) {
      window.removeEventListener("message", asrListener);
      asrListener = null;
    }
  }

  function attachMixer(video) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    try {
      graph = mixer.ensureGraph(
        video,
        function () {
          return new Ctx();
        },
        function (ctx, el) {
          return ctx.createMediaElementSource(el);
        }
      );
      mixer.restoreGain(graph, policy.originalGain(settings.originalGain));
    } catch (err) {
      graph = null;
    }
  }

  function startPolling(httpBase, video) {
    stopPolling();
    let bound = video;
    let waitMs = 0;
    pollTimer = setInterval(async function () {
      if (!enabled) return;
      const current = videoEl();
      if (current && current !== bound) {
        attachMixer(current);
        bound = current;
      }
      const media = videoEl();
      if (!media) return;
      if (!policy.playbackRateAllowed(media.playbackRate)) {
        await stopSession("rate");
        return;
      }
      let tick;
      try {
        const response = await fetch(httpBase + "/v1/session/tick", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ playhead: media.currentTime }),
        });
        tick = await response.json();
      } catch (err) {
        setButtonState("ошибка");
        return;
      }
      const owned = policy.ownedPlayback(tick, media.paused, wePaused, enabled, adPlaying());
      wePaused = owned.wePaused;
      if (owned.action === "pause") media.pause();
      if (owned.action === "play") media.play().catch(function () {});
      if (tick.state === "error") setButtonState(labelForStart(tick));
      else if (tick.utterances && tick.utterances.length) setButtonState("Выкл");
      else if (tick.state === "buffering") setButtonState(labelForBuffer(tick.reason));
      if (media.paused && !wePaused) {
        ttsGen += 1;
        playing = mixer.stopSources(playing);
      }
      const plan = mixer.planMix(tick.utterances || [], media.currentTime, settings.originalGain, adPlaying());
      if (graph) mixer.restoreGain(graph, plan.originalGain);
      else media.volume = (tick.utterances && tick.utterances.length) ? plan.originalGain : 1;
      const userPaused = media.paused && !wePaused;
      plan.play.forEach(function (item) {
        if (scheduled.has(item.id)) return;
        if (!policy.shouldStartUtterance(item.when, media.currentTime, userPaused)) return;
        scheduled.add(item.id);
        playUtterance(httpBase + item.url, media, item.when, item.id);
      });
    }, 250);
  }

  function ensureTtsContext() {
    if (graph && graph.context) return graph.context;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!ttsCtx) ttsCtx = new Ctx();
    if (ttsCtx.state === "suspended") ttsCtx.resume();
    return ttsCtx;
  }

  function playUtterance(url, media, when, id) {
    const ctx = ensureTtsContext();
    if (!ctx || (media.paused && !wePaused)) {
      if (id) scheduled.delete(id);
      return;
    }
    if (ctx.state === "suspended") ctx.resume();
    ttsGen += 1;
    const gen = ttsGen;
    playing = mixer.stopSources(playing);
    fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error("audio http");
        return res.arrayBuffer();
      })
      .then(function (buf) {
        if (!enabled || gen !== ttsGen || (media.paused && !wePaused)) return;
        return ctx.decodeAudioData(buf);
      })
      .then(function (decoded) {
        if (!decoded || !enabled || gen !== ttsGen || (media.paused && !wePaused)) return;
        const src = ctx.createBufferSource();
        const voice = ctx.createGain();
        voice.gain.value = 0.85;
        src.buffer = decoded;
        src.connect(voice);
        voice.connect(ctx.destination);
        src.start(ctx.currentTime);
        playing.push(src);
        setButtonState("Выкл");
        src.onended = function () {
          playing = playing.filter(function (item) {
            return item !== src;
          });
        };
      })
      .catch(function () {
        if (id) scheduled.delete(id);
      });
  }

  async function stopSession(reason) {
    enabled = false;
    wePaused = false;
    asrReady = false;
    ttsGen += 1;
    const media = videoEl();
    if (media && !graph) media.volume = 1;
    stopAsrCapture();
    stopPolling();
    scheduled = new Set();
    playing = mixer.stopSources(playing);
    if (graph) mixer.restoreGain(graph, 1);
    if (ttsCtx) {
      try {
        ttsCtx.close();
      } catch (err) {}
      ttsCtx = null;
    }
    const status = await hostStatus();
    if (status && status.httpBase) {
      try {
        await fetch(status.httpBase + "/v1/session/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: reason }),
        });
      } catch (err) {}
    }
    chrome.runtime.sendMessage({ type: "lvt-release-tab" });
    setButtonState("Перевод");
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  chrome.runtime.onMessage.addListener(function (message) {
    if (message.type === "lvt-preempted") {
      stopSession("preempted");
    }
    if (message.type === "lvt-settings") {
      settings = Object.assign(settings, message.settings || {});
    }
    if (message.type === "lvt-toggle") {
      onToggle();
    }
  });

  chrome.storage.local.get(["lvtSettings"], function (stored) {
    if (stored.lvtSettings) settings = Object.assign(settings, stored.lvtSettings);
  });

  document.addEventListener("yt-navigate-finish", function () {
    scheduled = new Set();
    ensureButton();
    if (enabled) stopSession("navigate");
  });

  const observer = new MutationObserver(ensureButton);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  ensureButton();
})();
