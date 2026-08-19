const HOST_NAME = "com.lvt.host";
const FALLBACK_BASE = "http://127.0.0.1:17890";

const state = {
  nativePort: null,
  httpBase: null,
  activeTabId: null,
  lastError: "host missing",
  backoffMs: 500,
  audioByTab: {},
};

function rememberAudioUrl(tabId, url) {
  if (!tabId || tabId < 0 || !url) return;
  const stripped = String(url)
    .replace(/&range=[^&]*/g, "")
    .replace(/&rn=[^&]*/g, "")
    .replace(/&rbuf=[^&]*/g, "");
  if (!/googlevideo\.com/.test(stripped) || stripped.indexOf("videoplayback") === -1) return;
  const audioLike =
    /[?&]mime=audio/.test(stripped) ||
    /[?&]itag=(139|140|141|249|250|251|599|600)(&|$)/.test(stripped);
  if (audioLike || !state.audioByTab[tabId]) {
    state.audioByTab[tabId] = stripped;
  }
}

if (chrome.webRequest && chrome.webRequest.onBeforeRequest) {
  chrome.webRequest.onBeforeRequest.addListener(
    function (details) {
      rememberAudioUrl(details.tabId, details.url);
    },
    { urls: ["https://*.googlevideo.com/*"] }
  );
}

function setError(message) {
  state.lastError = message;
  chrome.storage.local.set({
    lvtStatus: {
      host: state.httpBase ? "up" : "down",
      error: message,
      tabId: state.activeTabId,
    },
  });
}

function scheduleReconnect() {
  const wait = state.backoffMs;
  state.backoffMs = Math.min(state.backoffMs * 2, 30000);
  setTimeout(connectHost, wait);
}

function probeFallback() {
  fetch(FALLBACK_BASE + "/v1/health")
    .then(function (res) {
      return res.ok ? res.json() : Promise.reject();
    })
    .then(function (body) {
      if (body && body.ok) {
        state.httpBase = FALLBACK_BASE;
        setError("");
      }
    })
    .catch(function () {});
}

function connectHost() {
  probeFallback();
  if (state.nativePort) {
    return;
  }
  try {
    state.nativePort = chrome.runtime.connectNative(HOST_NAME);
  } catch (err) {
    if (!state.httpBase) setError("host missing");
    scheduleReconnect();
    return;
  }
  state.nativePort.onMessage.addListener((msg) => {
    if (msg && msg.type === "ready" && Number.isFinite(msg.port)) {
      state.httpBase = "http://127.0.0.1:" + msg.port;
      state.backoffMs = 500;
      setError("");
    }
  });
  state.nativePort.onDisconnect.addListener(() => {
    state.nativePort = null;
    if (!state.httpBase || state.httpBase.indexOf(":17890") === -1) {
      state.httpBase = null;
      setError("host missing");
      probeFallback();
    }
    scheduleReconnect();
  });
}

function harvestInPage(videoId, targetLang) {
  return (async function () {
    function tracksOf(pr) {
      try {
        if (typeof pr === "string") pr = JSON.parse(pr);
        return ((((pr || {}).captions || {}).playerCaptionsTracklistRenderer || {}).captionTracks) || [];
      } catch (err) {
        return [];
      }
    }
    var player = document.getElementById("movie_player") || document.querySelector(".html5-video-player");
    var pr = null;
    try {
      if (player && player.getPlayerResponse) pr = player.getPlayerResponse();
    } catch (err) {}
    if (!pr) pr = window.ytInitialPlayerResponse || null;
    var tracks = tracksOf(pr);
    var picked = null;
    for (var i = 0; i < tracks.length; i++) {
      var url = tracks[i].baseUrl || "";
      if (!url || /[?&]tlang=/.test(url)) continue;
      picked = tracks[i];
      if ((tracks[i].kind || "") !== "asr") break;
    }
    async function pull(url) {
      var res = await fetch(url, { credentials: "include" });
      return await res.text();
    }
    if (picked && picked.baseUrl) {
      return { text: await pull(picked.baseUrl), language: picked.languageCode || "", via: "player" };
    }
    var langs = ["en", "de", "fr", "es", "it", "pt", "ja"];
    for (var j = 0; j < langs.length; j++) {
      if (langs[j] === targetLang) continue;
      var direct = "https://www.youtube.com/api/timedtext?v=" + videoId + "&lang=" + langs[j] + "&kind=asr";
      try {
        var body = await pull(direct);
        if (body && body.indexOf("<text") !== -1) {
          return { text: body, language: langs[j], via: "timedtext" };
        }
      } catch (err) {}
    }
    return { text: "", language: "", via: "none", trackCount: tracks.length };
  })();
}

async function harvestMedia() {
  var session = {};
  try {
    if (window.__lvtSession && typeof window.__lvtSession.ensure === "function") {
      session = (await window.__lvtSession.ensure()) || {};
    } else if (window.__lvtSession && typeof window.__lvtSession.snapshot === "function") {
      session = window.__lvtSession.snapshot() || {};
    }
  } catch (err) {}
  var player = document.getElementById("movie_player") || document.querySelector(".html5-video-player");
  var pr = null;
  var vid = "";
  try {
    if (player && player.getVideoData) {
      var data = player.getVideoData();
      if (data && data.video_id) vid = data.video_id;
    }
    if (player && player.getPlayerResponse) pr = player.getPlayerResponse();
  } catch (err) {}
  if (!pr) pr = window.ytInitialPlayerResponse || null;
  if (!vid && pr && pr.videoDetails && pr.videoDetails.videoId) vid = pr.videoDetails.videoId;
  var flexy = document.querySelector("ytd-watch-flexy");
  if (!vid && flexy && flexy.getAttribute) vid = flexy.getAttribute("video-id") || "";
  if (!vid) {
    try {
      vid = new URLSearchParams(location.search).get("v") || "";
    } catch (err) {}
  }
  var audioUrl = session.audioUrl || "";
  var urls = [];
  if (session.audioUrls && session.audioUrls.length) urls = session.audioUrls.slice();
  var sd = pr && pr.streamingData;
  var list = [];
  if (sd) list = (sd.adaptiveFormats || []).concat(sd.formats || []);
  var audioItags = { 139: 1, 140: 1, 141: 1, 249: 1, 250: 1, 251: 1, 599: 1, 600: 1 };
  for (var i = 0; i < list.length; i++) {
    var item = list[i] || {};
    var url = item.url || "";
    if (!url) continue;
    var mime = String(item.mimeType || item.mime || "");
    if (mime.indexOf("audio/") !== -1) {
      audioUrl = audioUrl || url;
      if (urls.indexOf(url) === -1) urls.unshift(url);
    } else if (audioItags[String(item.itag || "")]) {
      audioUrl = audioUrl || url;
      if (urls.indexOf(url) === -1) urls.push(url);
    }
  }
  var visitor = session.visitorData || "";
  if (!visitor && pr && pr.responseContext) {
    visitor = pr.responseContext.visitorData || "";
    var groups = pr.responseContext.serviceTrackingParams || [];
    for (var g = 0; !visitor && g < groups.length; g++) {
      var params = (groups[g] && groups[g].params) || [];
      for (var p = 0; p < params.length; p++) {
        var key = String((params[p] && params[p].key) || "");
        if (key === "visitor_data" || key === "visitorData") visitor = String(params[p].value || "");
      }
    }
  }
  var poToken = session.poToken || "";
  if (!poToken) {
    for (var u = 0; u < urls.length; u++) {
      var pot = /[?&]pot=([^&]+)/.exec(urls[u] || "");
      if (pot) {
        try {
          poToken = decodeURIComponent(pot[1]);
        } catch (err) {
          poToken = pot[1];
        }
        break;
      }
    }
  }
  return {
    videoId: vid,
    audioUrl: audioUrl,
    audioUrls: urls,
    visitorData: visitor,
    poToken: poToken,
    clientName: session.clientName || "web",
  };
}

function extPrefix() {
  const worker = (chrome.runtime.getManifest().background || {}).service_worker || "";
  return worker.indexOf("/") !== -1 ? "extension/" : "";
}

function injectYouTubeTab(tabId) {
  if (!tabId || !chrome.scripting) return;
  const prefix = extPrefix();
  chrome.scripting
    .executeScript({
      target: { tabId: tabId },
      world: "MAIN",
      files: [prefix + "session-hook.js"],
    })
    .catch(function () {});
  chrome.scripting
    .executeScript({
      target: { tabId: tabId },
      world: "ISOLATED",
      files: [
        prefix + "policy.js",
        prefix + "mixer.js",
        prefix + "player-button.js",
        prefix + "captions.js",
        prefix + "asr-audio.js",
        prefix + "content.js",
      ],
    })
    .catch(function () {});
}

function injectExistingYouTube() {
  if (!chrome.tabs || !chrome.tabs.query) return;
  chrome.tabs.query({ url: ["https://www.youtube.com/*", "https://youtube.com/*"] }, function (tabs) {
    (tabs || []).forEach(function (tab) {
      if (!tab.id) return;
      chrome.tabs.sendMessage(tab.id, { type: "lvt-ping" }, function () {
        if (chrome.runtime.lastError) injectYouTubeTab(tab.id);
      });
    });
  });
}

chrome.runtime.onInstalled.addListener(function () {
  connectHost();
  injectExistingYouTube();
});
connectHost();
injectExistingYouTube();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "lvt-status") {
    sendResponse({
      httpBase: state.httpBase,
      error: state.lastError,
      activeTabId: state.activeTabId,
    });
    return true;
  }
  if (message.type === "lvt-claim-tab") {
    const tabId = sender.tab && sender.tab.id;
    if (state.activeTabId && tabId && state.activeTabId !== tabId) {
      chrome.tabs.sendMessage(state.activeTabId, { type: "lvt-preempted" }, function () {
        void chrome.runtime.lastError;
      });
    }
    state.activeTabId = tabId;
    sendResponse({ ok: true, httpBase: state.httpBase, error: state.lastError });
    return true;
  }
  if (message.type === "lvt-harvest") {
    const tabId = sender.tab && sender.tab.id;
    if (!tabId || !chrome.scripting) {
      sendResponse({ text: "", language: "", via: "no-scripting" });
      return true;
    }
    chrome.scripting
      .executeScript({
        target: { tabId: tabId },
        world: "MAIN",
        func: harvestInPage,
        args: [message.videoId || "", message.targetLang || "ru"],
      })
      .then(function (results) {
        sendResponse((results && results[0] && results[0].result) || { text: "", via: "empty" });
      })
      .catch(function () {
        sendResponse({ text: "", language: "", via: "error" });
      });
    return true;
  }
  if (message.type === "lvt-media") {
    const tabId = sender.tab && sender.tab.id;
    const intercepted = tabId != null ? state.audioByTab[tabId] || "" : "";
    function potOf(url) {
      const match = /[?&]pot=([^&]+)/.exec(String(url || ""));
      if (!match) return "";
      try {
        return decodeURIComponent(match[1]);
      } catch (err) {
        return match[1];
      }
    }
    if (!tabId || !chrome.scripting) {
      sendResponse({
        videoId: "",
        audioUrl: intercepted,
        audioUrls: intercepted ? [intercepted] : [],
        poToken: potOf(intercepted),
        visitorData: "",
      });
      return true;
    }
    chrome.scripting
      .executeScript({
        target: { tabId: tabId },
        world: "MAIN",
        func: harvestMedia,
      })
      .then(function (results) {
        const harvested = (results && results[0] && results[0].result) || {};
        const urls = [];
        (harvested.audioUrls || []).forEach(function (item) {
          if (item && urls.indexOf(item) === -1) urls.push(item);
        });
        if (intercepted && urls.indexOf(intercepted) === -1) urls.push(intercepted);
        const audioUrl = harvested.audioUrl || intercepted || "";
        sendResponse({
          videoId: harvested.videoId || "",
          audioUrl: audioUrl,
          audioUrls: urls,
          visitorData: harvested.visitorData || "",
          poToken: harvested.poToken || potOf(audioUrl) || potOf(intercepted),
          clientName: harvested.clientName || "web",
        });
      })
      .catch(function () {
        sendResponse({
          videoId: "",
          audioUrl: intercepted,
          audioUrls: intercepted ? [intercepted] : [],
          poToken: potOf(intercepted),
          visitorData: "",
        });
      });
    return true;
  }
  if (message.type === "lvt-fetch-audio") {
    const queued = [];
    if (message.url) queued.push(message.url);
    if (Array.isArray(message.urls)) {
      message.urls.forEach(function (item) {
        if (item && queued.indexOf(item) === -1) queued.push(item);
      });
    }
    if (!state.httpBase || !queued.length) {
      sendResponse({ ok: false, error: "no audio" });
      return true;
    }
    function pull(index) {
      if (index >= queued.length) {
        sendResponse({ ok: false, error: "no audio" });
        return;
      }
      const ac = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = setTimeout(function () {
        if (ac) ac.abort();
      }, 15000);
      fetch(queued[index], {
        credentials: "omit",
        signal: ac ? ac.signal : undefined,
        headers: {
          Referer: "https://www.youtube.com/",
          Origin: "https://www.youtube.com",
        },
      })
        .then(function (res) {
          if (!res.ok) throw new Error("audio http " + res.status);
          return res.arrayBuffer();
        })
        .then(function (buf) {
          return fetch(state.httpBase + "/v1/session/audio-file", {
            method: "POST",
            headers: { "X-Audio-Start": String(message.startAt || 0) },
            body: buf,
          });
        })
        .then(function (res) {
          return res.json().then(function (body) {
            if (!res.ok) throw new Error("host audio");
            sendResponse({ ok: true, body: body });
          });
        })
        .catch(function () {
          pull(index + 1);
        })
        .finally(function () {
          clearTimeout(timer);
        });
    }
    pull(0);
    return true;
  }
  if (message.type === "lvt-yt-cookies") {
    if (!chrome.cookies || !chrome.cookies.getAll) {
      sendResponse({ cookies: [] });
      return true;
    }
    const domains = ["youtube.com", "google.com"];
    let left = domains.length;
    let all = [];
    domains.forEach(function (domain) {
      chrome.cookies.getAll({ domain: domain }, function (list) {
        all = all.concat(list || []);
        left -= 1;
        if (left <= 0) sendResponse({ cookies: all });
      });
    });
    return true;
  }
  if (message.type === "lvt-release-tab") {
    if (sender.tab && sender.tab.id === state.activeTabId) {
      state.activeTabId = null;
    }
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === "lvt-transcribe") {
    if (!state.httpBase) {
      sendResponse({ ok: false, error: "no host" });
      return true;
    }
    const headers = { "X-Audio-Start": String(message.startAt || 0), "Content-Type": "audio/wav" };
    if (message.lang) headers["X-Audio-Lang"] = String(message.lang);
    let body = message.audio;
    if (!body && typeof message.audioB64 === "string" && message.audioB64) {
      const raw = atob(message.audioB64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      body = bytes;
    }
    if (!body) {
      sendResponse({ ok: false, error: "empty_audio" });
      return true;
    }
    fetch(state.httpBase + "/v1/session/transcribe", {
      method: "POST",
      headers: headers,
      body: body,
    })
      .then(function (res) {
        return res.json().then(function (body) {
          sendResponse({ ok: res.ok, body: body });
        });
      })
      .catch(function (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      });
    return true;
  }
  return false;
});
