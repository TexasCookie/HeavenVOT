/**
 * Find the "main" video on any site (YouTube, Twitch, VK, random players).
 */
export function findBestVideo(root = document) {
  const videos = [...root.querySelectorAll('video')].filter((v) => isUsableVideo(v));
  if (!videos.length) return null;

  const scored = videos.map((v) => ({ v, score: scoreVideo(v) }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0].v;
}

function isUsableVideo(v) {
  if (!v || v.tagName !== 'VIDEO') return false;
  if (v.dataset.aethervoxIgnore === '1') return false;
  // Hidden / zero-size placeholders (pre-roll shells, thumbnail hacks)
  if (v.offsetParent === null && !document.fullscreenElement) {
    const r = v.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
  }
  const rect = v.getBoundingClientRect();
  if (rect.width < 120 || rect.height < 70) return false;
  return true;
}

/** YouTube / common ad containers — never capture ad audio as "main" */
function isLikelyAdVideo(v) {
  if (!v) return false;
  try {
    // YouTube player flags ad mode on the shell, not always on <video>
    const player =
      v.closest('.html5-video-player') ||
      v.closest('#movie_player') ||
      v.closest('.ytp-ad-module') ||
      null;
    if (player) {
      if (
        player.classList.contains('ad-showing') ||
        player.classList.contains('ad-interrupting') ||
        player.querySelector('.ytp-ad-player-overlay, .ytp-ad-text, .video-ads .ad-container')
      ) {
        // During ads the SAME main video element often plays the ad —
        // still return true so score penalizes, but we keep the element
        // so capture continues after the ad ends without re-attach thrash.
        return true;
      }
    }
    if (v.closest('.ad-container, .video-ads, [id*="ad-"], [class*="advert"]')) {
      return true;
    }
    // Separate ad <video> nodes (some players)
    if (/ad|promo|sponsor/i.test(v.id + ' ' + v.className)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function scoreVideo(v) {
  const rect = v.getBoundingClientRect();
  let score = rect.width * rect.height;
  if (!v.paused) score *= 1.4;
  if (v.readyState >= 2) score *= 1.15;
  if (document.fullscreenElement === v) score *= 2;
  // prefer center-ish
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dx = Math.abs(cx - window.innerWidth / 2) / Math.max(1, window.innerWidth);
  const dy = Math.abs(cy - window.innerHeight / 2) / Math.max(1, window.innerHeight);
  score *= 1 - Math.min(0.5, (dx + dy) / 2);
  // youtube main player
  if (v.classList.contains('html5-main-video')) score *= 1.5;
  if (v.closest('#movie_player, .html5-video-player')) score *= 1.25;
  // Twitch main
  if (v.closest('[data-a-target="video-player"]')) score *= 1.3;
  // Deprioritize ads / secondary clips (don't hard-skip — YT reuses main video for ads)
  if (isLikelyAdVideo(v)) score *= 0.35;
  // Tiny picture-in-picture previews
  if (rect.width * rect.height < 40000) score *= 0.5;
  return score;
}

/**
 * Watch for best video changes. Debounced so SPA DOM thrash doesn't
 * tear down the pipeline on every MutationObserver tick.
 * @returns {() => void} cleanup
 */
export function watchForVideos(callback) {
  let last = null;
  let debounceTimer = null;
  let lastCheckAt = 0;

  const apply = (v) => {
    if (v !== last) {
      last = v;
      try {
        callback(v);
      } catch (e) {
        console.error('[AetherVox] watchForVideos callback', e);
      }
    }
  };

  const check = (force = false) => {
    const now = performance.now();
    // Throttle hard polls during heavy DOM mutations
    if (!force && now - lastCheckAt < 200) {
      if (!debounceTimer) {
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          check(true);
        }, 220);
      }
      return;
    }
    lastCheckAt = now;
    apply(findBestVideo());
  };

  check(true);
  const mo = new MutationObserver(() => check(false));
  try {
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch {
    /* ignore */
  }
  const iv = setInterval(() => check(true), 2500);

  // YouTube SPA navigation (does not always remount <video>)
  const onYtNav = () => {
    // Soft delay: player shell rebuilds after navigate
    setTimeout(() => check(true), 400);
    setTimeout(() => check(true), 1600);
  };
  window.addEventListener('yt-navigate-finish', onYtNav);
  window.addEventListener('yt-page-data-updated', onYtNav);
  const onFs = () => check(true);
  document.addEventListener('fullscreenchange', onFs);

  return () => {
    mo.disconnect();
    clearInterval(iv);
    if (debounceTimer) clearTimeout(debounceTimer);
    window.removeEventListener('yt-navigate-finish', onYtNav);
    window.removeEventListener('yt-page-data-updated', onYtNav);
    document.removeEventListener('fullscreenchange', onFs);
  };
}

export function getVideoAnchor(video) {
  if (!video) return null;
  // climb to player shell
  let el = video.parentElement;
  for (let i = 0; i < 8 && el; i++) {
    const style = getComputedStyle(el);
    if (
      style.position === 'relative' ||
      style.position === 'absolute' ||
      el.classList.contains('html5-video-player') ||
      el.id === 'movie_player' ||
      el.classList.contains('video-js') ||
      el.getAttribute('data-a-target') === 'video-player'
    ) {
      return el;
    }
    el = el.parentElement;
  }
  return video.parentElement || video;
}

/** @deprecated use isLikelyAdVideo via score — exported for tests/debug */
export function videoLooksLikeAd(v) {
  return isLikelyAdVideo(v);
}

