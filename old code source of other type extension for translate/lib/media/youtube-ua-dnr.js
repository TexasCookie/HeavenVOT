/**
 * Browser fetch() cannot set User-Agent (forbidden header). ANDROID_VR /
 * ANDROID / IOS Innertube clients then see Chrome UA + mobile clientName →
 * LOGIN_REQUIRED ("Sign in to confirm you’re not a bot") or HTTP 403.
 *
 * declarativeNetRequest can rewrite User-Agent for youtubei + googlevideo.
 */

import { log } from '../logger.js';

/** Avoid collision with ws-auth 91770x */
const RULE_YT_PLAYER_UA = 917801;
const RULE_YT_GOOGLEVVIDEO_UA = 917802;

export const YT_UA_RULE_IDS = [RULE_YT_PLAYER_UA, RULE_YT_GOOGLEVVIDEO_UA];

export const ANDROID_VR_UA =
  'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip';

/**
 * @param {string} userAgent
 * @returns {chrome.declarativeNetRequest.Rule[]}
 */
export function buildYoutubeUaDnrRules(userAgent = ANDROID_VR_UA, opts = {}) {
  const ua = String(userAgent || ANDROID_VR_UA);
  const initiator =
    opts.initiatorDomains ||
    (typeof chrome !== 'undefined' && chrome.runtime?.id
      ? [chrome.runtime.id]
      : null);
  const scope = initiator ? { initiatorDomains: initiator } : {};
  /** @type {chrome.declarativeNetRequest.Rule[]} */
  return [
    {
      id: RULE_YT_PLAYER_UA,
      priority: 200,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'User-Agent', operation: 'set', value: ua },
        ],
      },
      condition: {
        urlFilter: '||youtube.com/youtubei/',
        resourceTypes: ['xmlhttprequest', 'other'],
        ...scope,
      },
    },
    {
      id: RULE_YT_GOOGLEVVIDEO_UA,
      priority: 200,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'User-Agent', operation: 'set', value: ua },
          { header: 'Referer', operation: 'set', value: 'https://www.youtube.com/' },
        ],
      },
      condition: {
        urlFilter: '||googlevideo.com/',
        resourceTypes: ['xmlhttprequest', 'other', 'media'],
        ...scope,
      },
    },
  ];
}

/**
 * Install / refresh session DNR rules for YouTube client UA.
 * @param {string} [userAgent]
 */
export async function ensureYoutubeClientUa(userAgent = ANDROID_VR_UA) {
  if (!chrome?.declarativeNetRequest?.updateSessionRules) {
    return { ok: false, error: 'no declarativeNetRequest' };
  }
  const addRules = buildYoutubeUaDnrRules(userAgent);
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [...YT_UA_RULE_IDS],
      addRules,
    });
    return { ok: true, ruleIds: YT_UA_RULE_IDS };
  } catch (e) {
    log.warn('yt UA DNR', e?.message || e);
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * Best-effort clear (optional — leaving rules is harmless for browsing).
 */
export async function clearYoutubeClientUa() {
  if (!chrome?.declarativeNetRequest?.updateSessionRules) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [...YT_UA_RULE_IDS],
      addRules: [],
    });
  } catch {
    /* ignore */
  }
}
