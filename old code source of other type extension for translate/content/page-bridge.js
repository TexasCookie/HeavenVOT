/**
 * MAIN-world bridge for VOD extract:
 * - scrape ytInitialPlayerResponse
 * - resolve plain audio URL via Innertube (ANDROID_VR first — bypasses PO-token 403)
 * Posts AETHERVOX_YT_PLAYER / AETHERVOX_YT_AUDIO to isolated content script.
 */
(function () {
  const BRIDGE_VER = 5;
  if (window.__AETHERVOX_PAGE_BRIDGE_VER__ === BRIDGE_VER) return;
  window.__AETHERVOX_PAGE_BRIDGE_VER__ = BRIDGE_VER;
  window.__AETHERVOX_PAGE_BRIDGE__ = true;

  const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
  const PLAYER_URL =
    'https://www.youtube.com/youtubei/v1/player?prettyPrint=false&key=' +
    INNERTUBE_KEY;

  function postTarget() {
    try {
      const o = String(location.origin || '');
      if (!o || o === 'undefined') return 'null';
      return o;
    } catch {
      return 'null';
    }
  }

  function videoIdFromLocation() {
    try {
      const u = new URL(location.href);
      const v = u.searchParams.get('v');
      if (v && /^[\w-]{11}$/.test(v)) return v;
      const m = u.pathname.match(/\/(embed|shorts|live|v)\/([\w-]{11})/);
      if (m) return m[2];
      if (u.hostname === 'youtu.be') {
        const id = u.pathname.split('/').filter(Boolean)[0];
        if (id && /^[\w-]{11}$/.test(id)) return id;
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  function grabPlayerResponse() {
    try {
      if (window.ytInitialPlayerResponse) return window.ytInitialPlayerResponse;
    } catch {
      /* ignore */
    }
    try {
      const scripts = document.querySelectorAll('script');
      for (const s of scripts) {
        const t = s.textContent || '';
        if (!t.includes('ytInitialPlayerResponse')) continue;
        const m = t.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
        if (m) {
          try {
            return JSON.parse(m[1]);
          } catch {
            /* continue */
          }
        }
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  function getVisitorDataFromPage() {
    try {
      if (typeof ytcfg !== 'undefined') {
        const fromGet =
          ytcfg.get?.('VISITOR_DATA') ||
          ytcfg.get?.('INNERTUBE_CONTEXT')?.client?.visitorData ||
          '';
        if (fromGet) return String(fromGet);
        const fromData =
          ytcfg.data_?.VISITOR_DATA ||
          ytcfg.data_?.INNERTUBE_CONTEXT?.client?.visitorData ||
          '';
        if (fromData) return String(fromData);
      }
    } catch {
      /* ignore */
    }
    try {
      const pr = grabPlayerResponse();
      const vd =
        pr?.responseContext?.visitorData ||
        pr?.responseContext?.webResponseContextExtensionData?.ytConfigData
          ?.visitorData ||
        '';
      if (vd) return String(vd);
    } catch {
      /* ignore */
    }
    return '';
  }

  let cachedVisitorData = '';

  /**
   * ANDROID_VR answers LOGIN_REQUIRED ("Sign in to confirm you’re not a bot")
   * without visitorData. Mixing SAPISID cookies with mobile clients also
   * triggers bot-check — always credentials:omit for these clients.
   */
  async function ensureVisitorData() {
    if (cachedVisitorData) return cachedVisitorData;
    // Prefer fresh visitor_id token — page WEB visitorData + ANDROID_VR
    // often yields LOGIN_REQUIRED ("Sign in to confirm you’re not a bot").
    try {
      const res = await fetch(
        'https://www.youtube.com/youtubei/v1/visitor_id?prettyPrint=false&key=' +
          INNERTUBE_KEY,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Goog-Api-Format-Version': '2',
            'X-YouTube-Client-Name': '1',
            'X-YouTube-Client-Version': '2.20240726.00.00',
          },
          body: JSON.stringify({
            context: {
              client: {
                clientName: 'WEB',
                clientVersion: '2.20240726.00.00',
                hl: 'en',
                gl: 'US',
              },
            },
          }),
          credentials: 'omit',
        },
      );
      if (res.ok) {
        const json = await res.json();
        const vd =
          json?.responseContext?.visitorData ||
          json?.visitorData ||
          '';
        if (vd) {
          cachedVisitorData = String(vd);
          return cachedVisitorData;
        }
      }
    } catch {
      /* ignore */
    }
    const fromPage = getVisitorDataFromPage();
    if (fromPage) {
      cachedVisitorData = fromPage;
      return cachedVisitorData;
    }
    return '';
  }

  /** Prefer pure audio/* with plain url — never fall back to muxed video/mp4. */
  function pickAudio(formats) {
    const list = (formats || []).filter((f) => {
      if (!f?.url) return false;
      const mime = String(f.mimeType || '');
      if (mime.startsWith('audio/')) return true;
      if (f.audioQuality && !f.width && !/video\//i.test(mime)) return true;
      return false;
    });
    if (!list.length) return null;
    return list.sort((a, b) => {
      const score = (x) => {
        let s = Number(x.bitrate || x.averageBitrate || 0);
        const mime = String(x.mimeType || '');
        if (mime.startsWith('audio/')) s += 100000;
        if (mime.includes('mp4')) s += 50000;
        return s;
      };
      return score(b) - score(a);
    })[0];
  }

  /**
   * ANDROID_VR first: googlevideo URLs without Proof-of-Origin gate
   * (WEB/ANDROID/IOS plain urls → HTTP 403 from SW/offscreen/page).
   */
  const INNERTUBE_CLIENTS = [
    {
      name: 'ANDROID_VR',
      client: {
        clientName: 'ANDROID_VR',
        clientVersion: '1.65.10',
        deviceMake: 'Oculus',
        deviceModel: 'Quest 3',
        androidSdkVersion: 32,
        osName: 'Android',
        osVersion: '12L',
        platform: 'MOBILE',
        hl: 'en',
        gl: 'US',
        utcOffsetMinutes: 0,
      },
      headers: {
        'User-Agent':
          'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
        'X-YouTube-Client-Name': '28',
        'X-YouTube-Client-Version': '1.65.10',
      },
      userAgent:
        'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    },
    {
      name: 'ANDROID',
      client: {
        clientName: 'ANDROID',
        clientVersion: '20.10.38',
        androidSdkVersion: 34,
        osName: 'Android',
        osVersion: '14',
        platform: 'MOBILE',
        hl: 'en',
        gl: 'US',
        utcOffsetMinutes: 0,
      },
      headers: {
        'User-Agent':
          'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip',
        'X-YouTube-Client-Name': '3',
        'X-YouTube-Client-Version': '20.10.38',
      },
      userAgent:
        'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip',
    },
    {
      name: 'IOS',
      client: {
        clientName: 'IOS',
        clientVersion: '20.10.4',
        deviceMake: 'Apple',
        deviceModel: 'iPhone16,2',
        osName: 'iPhone',
        osVersion: '17.5.1.21F90',
        platform: 'MOBILE',
        hl: 'en',
        gl: 'US',
        utcOffsetMinutes: 0,
      },
      headers: {
        'User-Agent':
          'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X)',
        'X-YouTube-Client-Name': '5',
        'X-YouTube-Client-Version': '20.10.4',
      },
      userAgent:
        'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X)',
    },
    {
      name: 'ANDROID_MUSIC',
      client: {
        clientName: 'ANDROID_MUSIC',
        clientVersion: '7.27.52',
        androidSdkVersion: 34,
        osName: 'Android',
        osVersion: '14',
        platform: 'MOBILE',
        hl: 'en',
        gl: 'US',
        utcOffsetMinutes: 0,
      },
      headers: {
        'User-Agent':
          'com.google.android.apps.youtube.music/7.27.52 (Linux; U; Android 14) gzip',
        'X-YouTube-Client-Name': '21',
        'X-YouTube-Client-Version': '7.27.52',
      },
      userAgent:
        'com.google.android.apps.youtube.music/7.27.52 (Linux; U; Android 14) gzip',
    },
  ];

  async function fetchClientPlayer(videoId, client) {
    const visitorData = await ensureVisitorData();
    const clientCtx = { ...client.client };
    if (visitorData) clientCtx.visitorData = visitorData;
    const body = {
      context: { client: clientCtx },
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
      playbackContext: {
        contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' },
      },
    };
    const res = await fetch(PLAYER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Goog-Api-Format-Version': '2',
        ...(client.headers || {}),
      },
      body: JSON.stringify(body),
      // CRITICAL: omit cookies — SAPISID + ANDROID_* UA → bot LOGIN_REQUIRED
      credentials: 'omit',
    });
    if (!res.ok) throw new Error(client.name + ' HTTP ' + res.status);
    return res.json();
  }

  function streamFromPR(pr) {
    if (!pr) return null;
    const status = pr?.playabilityStatus?.status;
    if (status && status !== 'OK') {
      return {
        ok: false,
        reason: pr?.playabilityStatus?.reason || status,
        status,
      };
    }
    const formats = [
      ...(pr?.streamingData?.adaptiveFormats || []),
      ...(pr?.streamingData?.formats || []),
    ];
    const best = pickAudio(formats);
    if (!best?.url) {
      return { ok: false, reason: 'no plain audio url' };
    }
    const mime = String(best.mimeType || 'audio/mp4').split(';')[0].trim();
    return {
      ok: true,
      streamUrl: best.url,
      mime,
      itag: best.itag,
      bitrate: best.bitrate,
      durationSec: Number(pr?.videoDetails?.lengthSeconds || 0),
      title: pr?.videoDetails?.title || '',
      contentLength: best.contentLength ? Number(best.contentLength) : null,
    };
  }

  async function resolveAudio(hintVideoId) {
    const videoId =
      (hintVideoId && /^[\w-]{11}$/.test(hintVideoId) ? hintVideoId : null) ||
      videoIdFromLocation() ||
      grabPlayerResponse()?.videoDetails?.videoId ||
      null;
    if (!videoId) {
      return {
        ok: false,
        error: 'no video id',
        href: location.href,
        hasVisitor: !!(await ensureVisitorData()),
      };
    }

    // Prefer Innertube clients first — WEB ytInitialPlayerResponse plain urls
    // are PO-token gated (page/SW/offscreen all returned 403 in debug logs).
    const visitorData = await ensureVisitorData();
    const errors = [];
    for (const client of INNERTUBE_CLIENTS) {
      try {
        const pr = await fetchClientPlayer(videoId, client);
        const stream = streamFromPR(pr);
        if (stream?.ok) {
          return {
            ok: true,
            videoId,
            source: client.name + '_page',
            userAgent: client.userAgent || '',
            hasVisitor: !!visitorData,
            ...stream,
            playerResponse: {
              playabilityStatus: pr.playabilityStatus,
              videoDetails: pr.videoDetails,
              streamingData: pr.streamingData,
            },
          };
        }
        errors.push(
          client.name +
            ':' +
            (stream?.reason || stream?.status || 'no url'),
        );
      } catch (e) {
        errors.push(client.name + ':' + String(e?.message || e));
      }
    }

    // Last resort: page WEB PR (often cipher-only or PO-gated)
    const pagePR = grabPlayerResponse();
    const stream = streamFromPR(pagePR);
    if (stream?.ok) {
      return {
        ok: true,
        videoId,
        source: 'page',
        userAgent: navigator.userAgent || '',
        hasVisitor: !!visitorData,
        ...stream,
        playerResponse: pagePR
          ? {
              playabilityStatus: pagePR.playabilityStatus,
              videoDetails: pagePR.videoDetails,
              streamingData: pagePR.streamingData,
            }
          : null,
      };
    }

    return {
      ok: false,
      videoId,
      hasVisitor: !!visitorData,
      error: errors.join(' · ') || stream?.reason || 'all clients failed',
      pageReason: stream?.reason,
    };
  }

  function publishBasic() {
    const pr = grabPlayerResponse();
    const detail = {
      source: 'aethervox-page-bridge',
      href: location.href,
      playerResponse: pr
        ? {
            playabilityStatus: pr.playabilityStatus,
            videoDetails: pr.videoDetails,
            streamingData: pr.streamingData,
          }
        : null,
      videoId:
        (pr && pr.videoDetails && pr.videoDetails.videoId) ||
        videoIdFromLocation(),
    };
    try {
      window.postMessage({ type: 'AETHERVOX_YT_PLAYER', ...detail }, postTarget());
    } catch {
      /* ignore */
    }
  }

  async function publishAudio(hintVideoId) {
    try {
      const audio = await resolveAudio(hintVideoId);
      window.postMessage({ type: 'AETHERVOX_YT_AUDIO', audio }, postTarget());
    } catch (e) {
      window.postMessage(
        {
          type: 'AETHERVOX_YT_AUDIO',
          audio: { ok: false, error: String(e?.message || e) },
        },
        postTarget(),
      );
    }
  }

  function onPageBridgeMessage(ev) {
    if (ev.source !== window) return;
    if (ev.origin && ev.origin !== window.location.origin) return;
    const d = ev?.data;
    if (!d || d.source === 'aethervox-page-bridge') return;
    if (d.type === 'AETHERVOX_YT_RESOLVE') {
      publishBasic();
      publishAudio(d.videoId || null);
    }
  }

  window.__AETHERVOX_PAGE_BRIDGE_HANDLER__ = onPageBridgeMessage;
  if (!window.__AETHERVOX_PAGE_BRIDGE_LISTENING__) {
    window.__AETHERVOX_PAGE_BRIDGE_LISTENING__ = true;
    window.addEventListener('message', (ev) => {
      try {
        window.__AETHERVOX_PAGE_BRIDGE_HANDLER__?.(ev);
      } catch {
        /* ignore */
      }
    });
  }

  // Initial scrape on inject
  try {
    publishBasic();
  } catch {
    /* ignore */
  }
  setTimeout(() => publishAudio(null), 600);
  setTimeout(() => publishAudio(null), 2000);

  if (!window.__AETHERVOX_PAGE_BRIDGE_SPA__) {
    window.__AETHERVOX_PAGE_BRIDGE_SPA__ = true;
    let lastHref = location.href;
    setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        setTimeout(() => {
          try {
            window.postMessage({ type: 'AETHERVOX_YT_RESOLVE' }, postTarget());
          } catch {
            /* ignore */
          }
        }, 500);
      }
    }, 1000);
  }
})();
