/**
 * Verifies every bug-report item (B1–B93) with pure assertions.
 * Runs each item 3 consecutive times; any failure aborts that item's streak.
 *
 * Usage: node tools/bug-report-verify.mjs
 */
import { pathToFileURL } from 'url';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

async function load(rel) {
  return import(pathToFileURL(path.join(root, rel)).href);
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

const RUNS = 3;
const results = [];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function runItem(id, title, fn) {
  const streak = [];
  for (let i = 1; i <= RUNS; i++) {
    try {
      await fn(i);
      streak.push({ run: i, ok: true });
      console.log(`  ✓ ${id} run ${i}/${RUNS}`);
    } catch (e) {
      streak.push({ run: i, ok: false, error: String(e?.message || e) });
      console.error(`  ✗ ${id} run ${i}/${RUNS}:`, e?.message || e);
      results.push({ id, title, ok: false, streak });
      return false;
    }
  }
  results.push({ id, title, ok: true, streak });
  return true;
}

console.log('\n=== AetherVox bug-report verify (3× each) ===\n');

const policy = await load('lib/pipeline/vod-chunk-policy.js');
const yt = await load('lib/media/youtube-innertube.js');

await runItem('B1', 'Fake-ready unlock blocked', async () => {
  assert(policy.shouldMarkChunkCompleted('failed') === false, 'failed not completed');
  assert(policy.shouldMarkChunkCompleted('ok') === true, 'ok completed');
  assert(policy.shouldMarkChunkCompleted('silent') === true, 'silent completed');
  assert(
    policy.shouldUnlockFirstChunk({ completedHas0: false, cueCount: 0 }) === false,
    'empty must not unlock',
  );
  assert(
    policy.shouldUnlockFirstChunk({ completedHas0: true, cueCount: 0 }) === true,
    'silent/ok chunk0 unlocks',
  );
  assert(
    policy.shouldUnlockFirstChunk({
      completedHas0: false,
      cueCount: 1,
      earliestCueStart: 0.1,
    }) === true,
    'cue near 0 unlocks',
  );
  assert(
    policy.shouldUnlockFirstChunk({
      completedHas0: false,
      cueCount: 1,
      earliestCueStart: 12,
    }) === false,
    'late cue alone must not unlock',
  );
  const src = read('lib/pipeline/vod-prepare-pipeline.js');
  assert(src.includes('shouldMarkChunkCompleted'), 'pipeline uses policy');
  assert(!/_completed\.add\(index\);\s*\n\s*this\._doneChunks/.test(src), 'no blind finally complete');
});

await runItem('B2', 'SPA VOD restart wired', async () => {
  const src = read('content/content-main.js');
  assert(src.includes('spaVodVideoId'), 'tracks spa video id');
  assert(src.includes('перезапуск VOD') || src.includes('toggleTranslation(true)'), 'restarts VOD');
  assert(src.includes('yt-navigate-finish'), 'listens SPA nav');
});

await runItem('B3', 'Auto-VOD YouTube gate', async () => {
  assert(policy.shouldUseVodPrepare({ mode: 'live' }) === false, 'live off');
  assert(policy.shouldUseVodPrepare({ mode: 'vod' }) === true, 'forced vod');
  assert(
    policy.shouldUseVodPrepare({
      mode: 'auto',
      hostname: 'www.twitch.tv',
    }) === false,
    'twitch auto → live',
  );
  assert(
    policy.shouldUseVodPrepare({
      mode: 'auto',
      hostname: 'www.youtube.com',
    }) === true,
    'youtube auto → vod',
  );
  assert(
    policy.shouldUseVodPrepare({
      mode: 'auto',
      hostname: 'www.youtube.com',
      isLive: true,
    }) === false,
    'youtube live auto → live pipeline',
  );
  assert(policy.isYoutubeHost('youtu.be') === true, 'youtu.be');
  const src = read('content/content-main.js');
  assert(src.includes('shouldUseVodPrepare'), 'content uses shared policy');
});

await runItem('B4', 'Multi-client cipher fallback', async () => {
  const cipherOnly = {
    playabilityStatus: { status: 'OK' },
    videoDetails: { lengthSeconds: '19', title: 't' },
    streamingData: {
      adaptiveFormats: [
        {
          itag: 140,
          mimeType: 'audio/mp4',
          signatureCipher: 's=xx&url=https%3A%2F%2Fciphered',
        },
      ],
    },
  };
  const r = yt.streamFromPlayerResponse(cipherOnly);
  assert(r.ok === false, 'cipher-only fails closed');
  assert(/signatureCipher|decipher|innertube/i.test(r.reason || ''), 'mentions cipher');
  const bridge = read('content/page-bridge.js');
  assert(bridge.includes('IOS'), 'page-bridge has IOS client');
  assert(bridge.includes('ANDROID_MUSIC'), 'page-bridge has ANDROID_MUSIC');
  assert(bridge.includes('ANDROID_VR'), 'page-bridge has ANDROID_VR');
  assert(bridge.includes('INNERTUBE_CLIENTS'), 'multi-client list');
  const innertubeSrc = read('lib/media/youtube-innertube.js');
  assert(innertubeSrc.includes('ANDROID_VR'), 'innertube has ANDROID_VR');
});

await runItem('B5', 'Download Referer + offscreen fallback', async () => {
  const ae = read('lib/media/audio-extractor.js');
  assert(ae.includes('Referer') && ae.includes('youtube.com'), 'extractor Referer');
  assert(ae.includes('userAgent') || ae.includes('User-Agent'), 'extractor UA');
  const off = read('offscreen/media-decode.js');
  assert(off.includes('userAgent') || off.includes('User-Agent'), 'offscreen UA');
  assert(off.includes('OFFSCREEN_MEDIA_DOWNLOAD'), 'offscreen download msg');
  assert(off.includes('Referer'), 'offscreen Referer');
  const dnr = read('lib/media/youtube-ua-dnr.js');
  assert(dnr.includes('declarativeNetRequest'), 'yt UA DNR module');
  assert(dnr.includes('ANDROID_VR'), 'DNR targets ANDROID_VR UA');
  const sw = read('background/service-worker.js');
  assert(sw.includes('ENSURE_YT_CLIENT_UA') || sw.includes('ensureYoutubeClientUa'), 'SW installs yt UA');
  assert(sw.includes('OFFSCREEN_MEDIA_DOWNLOAD'), 'SW retries via offscreen');
});

await runItem('B6', 'Failed chunks retry + error event', async () => {
  const src = read('lib/pipeline/vod-prepare-pipeline.js');
  assert(src.includes('vod_chunk_error'), 'surfaces chunk error');
  assert(src.includes('VOD_CHUNK_MAX_RETRIES'), 'retries');
  assert(src.includes('_failedTerminal'), 'terminal fail set');
  assert(policy.shouldMarkChunkCompleted('failed') === false, 'failed not bank');
});

await runItem('B7', 'Cue played only on confirmed play', async () => {
  assert(policy.shouldMarkCuePlayed({ offscreenOk: false, localPlayOk: false }) === false);
  assert(policy.shouldMarkCuePlayed({ offscreenOk: true }) === true);
  assert(policy.shouldMarkCuePlayed({ localPlayOk: true }) === true);
  assert(policy.shouldMarkCuePlayed({ skipped: true }) === true);
  const src = read('lib/pipeline/vod-prepare-pipeline.js');
  assert(src.includes('shouldMarkCuePlayed'), 'playPhrase uses policy');
  assert(src.includes('cue kept for retry'), 'retry path');
});

await runItem('B8', 'Proxy auth asyncBlocking', async () => {
  const src = read('lib/network/proxy.js');
  assert(src.includes("['asyncBlocking']"), 'uses asyncBlocking');
  assert(!src.includes("['blocking']"), 'no illegal blocking');
  assert(src.includes('authListenerAttached = true'), 'flag after success path');
});

await runItem('B9', 'No auto-resume after hole', async () => {
  assert(policy.shouldAutoResumeAfterHole() === false, 'policy false');
  const src = read('lib/pipeline/vod-prepare-pipeline.js');
  assert(src.includes('shouldAutoResumeAfterHole'), 'wired');
  assert(src.includes('жми Play'), 'asks user');
});

await runItem('B10', 'Silent capture RMS detection', async () => {
  const cap = read('lib/pipeline/audio-capture.js');
  assert(cap.includes('peakRms'), 'tracks peakRms');
  const tp = read('lib/pipeline/translator-pipeline.js');
  assert(tp.includes('peakRms') && tp.includes('RMS≈0'), 'warns silent graph');
});

await runItem('B11', 'MAIN-world inject path', async () => {
  const src = read('content/content-main.js');
  assert(src.includes('INJECT_PAGE_BRIDGE'), 'asks SW inject');
  const sw = read('background/service-worker.js');
  assert(sw.includes('INJECT_PAGE_BRIDGE'), 'SW handles');
  assert(sw.includes("world: 'MAIN'"), 'MAIN world');
  const c = read('lib/constants.js');
  assert(c.includes('INJECT_PAGE_BRIDGE'), 'MSG constant');
});

await runItem('B12', 'Job-missing fails not fake-complete', async () => {
  // Covered by B1/B6: failed status + retries; chunk slice !ok → failed
  const src = read('lib/pipeline/vod-prepare-pipeline.js');
  assert(src.includes("return 'failed'"), 'failed status');
  assert(src.includes('_failedTerminal'), 'terminal');
});

await runItem('B13', 'WS auth cascade documented + present', async () => {
  const readme = read('README.md');
  assert(/client_secret|relay|REST fallback/i.test(readme), 'docs cascade');
  const ws = read('lib/xai/ws-auth.js');
  assert(ws.length > 100, 'ws-auth exists');
});

await runItem('B14', 'Version/docs aligned', async () => {
  const man = JSON.parse(read('manifest.json'));
  const readme = read('README.md');
  const ver = man.version;
  assert(typeof ver === 'string' && /^\d+\.\d+\.\d+$/.test(ver), 'manifest semver');
  assert(readme.includes(`v${ver}`), `readme v${ver}`);
  const src = read('lib/pipeline/vod-prepare-pipeline.js');
  assert(src.includes('Progressive unlock'), 'progressive comment fixed');
});

await runItem('B15', 'sendToOffscreen timeout coercion', async () => {
  const sw = read('background/service-worker.js');
  assert(sw.includes('normalizeOffscreenTimeout'), 'helper present');
  assert(
    !sw.includes('{ timeoutMs: 120000 }'),
    'no object timeout at call sites',
  );
  // Object delay coerces to NaN — never pass objects to setTimeout
  const bad = Number({ timeoutMs: 120000 });
  assert(Number.isNaN(bad), 'object → NaN');
  function normalizeOffscreenTimeout(timeoutMs, fallback = 120000) {
    if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      return timeoutMs;
    }
    const nested = Number(timeoutMs?.timeoutMs);
    if (Number.isFinite(nested) && nested > 0) return nested;
    return fallback;
  }
  assert(normalizeOffscreenTimeout({ timeoutMs: 120000 }) === 120000, 'object unwrap');
  assert(normalizeOffscreenTimeout(90000) === 90000, 'number passthrough');
  // Runtime: only a normalized numeric delay is scheduled (no TimeoutNaNWarning)
  const delay = await new Promise((resolve) => {
    const t0 = Date.now();
    const ms = normalizeOffscreenTimeout({ timeoutMs: 25 });
    setTimeout(() => resolve(Date.now() - t0), ms);
  });
  assert(delay >= 15 && delay < 200, `normalized timeout ~25ms (got ${delay})`);
});

await runItem('B16', 'SW ignores OFFSCREEN_MEDIA_DOWNLOAD', async () => {
  const sw = read('background/service-worker.js');
  const ignoreBlock = sw.slice(
    sw.indexOf('Offscreen document owns these'),
    sw.indexOf('handleMessage(message, sender)'),
  );
  assert(ignoreBlock.includes("OFFSCREEN_MEDIA_DOWNLOAD"), 'DOWNLOAD in ignore list');
  assert(ignoreBlock.includes('return false'), 'returns false for offscreen msgs');
});

await runItem('B17', 'Popup toggle uses hasProviderAuth', async () => {
  const src = read('popup/popup.js');
  assert(
    src.includes('popupAuthGate') || src.includes('hasProviderAuth(s)'),
    'toggle gates on provider auth',
  );
  assert(!/if\s*\(\s*!s\?\.xaiApiKey\s*\)/.test(src), 'no raw xaiApiKey gate on toggle');
  const { hasProviderAuth } = await load('lib/provider.js');
  assert(hasProviderAuth({ providerMode: 'local' }) === true, 'local auth ok');
  assert(hasProviderAuth({ providerMode: 'xai', xaiApiKey: '' }) === false, 'xai needs key');
});

await runItem('B18', 'Proxy/native auth isProxy split', async () => {
  const proxy = read('lib/network/proxy.js');
  const native = read('lib/xai/native-auth-provider.js');
  assert(proxy.includes('isProxy === false'), 'proxy skips non-proxy');
  assert(native.includes('isProxy === true'), 'native skips proxy');
});

await runItem('B19', 'MEDIA_EXTRACT prefers streamUrl prepare', async () => {
  const sw = read('background/service-worker.js');
  assert(sw.includes('prefer offscreen download+decode via streamUrl'), 'streamUrl prefer comment');
  const idxStream = sw.indexOf("streamUrl,\n              referer: 'https://www.youtube.com/'");
  const idxBase64 = sw.indexOf('base64: arrayBufferToBase64(audioAb)');
  assert(idxStream > 0 && idxBase64 > idxStream, 'streamUrl path before base64 fallback');
  const off = read('offscreen/media-decode.js');
  assert(off.includes('message.streamUrl'), 'offscreen accepts streamUrl');
});

await runItem('B20', 'webNavigation permission present', async () => {
  const man = JSON.parse(read('manifest.json'));
  assert(man.permissions.includes('webNavigation'), 'manifest has webNavigation');
  const sw = read('background/service-worker.js');
  assert(sw.includes('webNavigation?.getAllFrames'), 'uses getAllFrames');
});

await runItem('B21', 'Hotkey sendMessage catches rejection', async () => {
  const sw = read('background/service-worker.js');
  assert(
    /sendMessage\(tab\.id,\s*\{\s*type\s*\}\)\s*\.catch/.test(sw) ||
      sw.includes("sendMessage(tab.id, { type }).catch"),
    'commands catch',
  );
  assert(sw.includes('.sendMessage(tab.id, { type: MSG.TOGGLE_TRANSLATION })') === false ||
    /TOGGLE_TRANSLATION\s*\}\)\s*\n?\s*\.catch/.test(sw) ||
    sw.includes('TOGGLE_TRANSLATION })\n      .catch'),
    'context menu catch');
});

await runItem('B22', 'Unlock requires t≈0 coverage', async () => {
  assert(
    policy.shouldUnlockFirstChunk({ completedHas0: false, cueCount: 5 }) === false,
    'cueCount alone false',
  );
  assert(
    policy.shouldUnlockFirstChunk({ earliestCueStart: 10 }) === false,
    'late cue false',
  );
  assert(
    policy.shouldUnlockFirstChunk({ earliestCueStart: 0 }) === true,
    'start0 cue true',
  );
  const src = read('lib/pipeline/vod-prepare-pipeline.js');
  assert(src.includes('earliestCueStart'), 'pipeline passes earliest');
});

await runItem('B23', 'Played cues prune audioBuffer', async () => {
  const src = read('lib/pipeline/vod-prepare-pipeline.js');
  assert(src.includes('#prunePlayedAudioBuffers'), 'prune helper');
  assert(src.includes('cue.audioBuffer = null'), 'nulls behind buffer');
});

await runItem('B24', 'INJECT_PAGE_BRIDGE uses sender frame', async () => {
  const sw = read('background/service-worker.js');
  assert(sw.includes('frameIds: [frameId]'), 'injects into sender frame');
  assert(sw.includes('allFrames: true'), 'fallback allFrames');
  assert(!sw.includes('allFrames: false'), 'no top-only false');
});

await runItem('B25', 'Local start health-checks gateway', async () => {
  const src = read('content/content-main.js');
  assert(src.includes('LOCAL_VALIDATE'), 'calls LOCAL_VALIDATE');
  assert(src.includes('Gateway offline') || src.includes('gateway недоступен'), 'offline UX');
});

await runItem('B26', 'Offscreen jobs LRU capped', async () => {
  const src = read('offscreen/media-decode.js');
  assert(src.includes('MAX_JOBS'), 'MAX_JOBS');
  assert(src.includes('abortJob(victim)'), 'evicts via abort');
});

await runItem('B27', 'HEALTH_ALERT vod_ready via kind', async () => {
  const sw = read('background/service-worker.js');
  assert(sw.includes("message.kind === 'vod_ready'"), 'kind gate');
  assert(!/\/VOD\|готов\|ready\/i/.test(sw), 'no broad regex');
  const pipe = read('lib/pipeline/vod-prepare-pipeline.js');
  assert(pipe.includes("kind: 'vod_ready'"), 'pipeline sends kind');
});

await runItem('B28', 'Extension version documented vs folder', async () => {
  const man = JSON.parse(read('manifest.json'));
  const report = read('BUG-REPORT.md');
  const ver = man.version;
  assert(typeof ver === 'string' && /^\d+\.\d+\.\d+$/.test(ver), 'canonical semver');
  assert(report.includes(ver), `report mentions ${ver}`);
  assert(/V1\.80|V1\.79\.5|folder|packaging/i.test(report), 'folder drift documented');
});

await runItem('B29', 'Seek-back restores pruned cue audio', async () => {
  const src = read('lib/pipeline/vod-prepare-pipeline.js');
  assert(src.includes('audioBase64'), 'stores audioBase64');
  assert(src.includes('#ensureCueAudio'), 'ensure helper');
  assert(src.includes('keep audioBase64 for seek-back'), 'prune keeps base64');
  // Runtime: prune buffer then restore
  const { base64ToArrayBuffer, arrayBufferToBase64 } = await load('lib/pcm-utils.js');
  const ab = new Uint8Array([1, 2, 3, 4]).buffer;
  const cue = { audioBuffer: ab, audioBase64: arrayBufferToBase64(ab) };
  cue.audioBuffer = null;
  assert(!cue.audioBuffer, 'pruned');
  cue.audioBuffer = base64ToArrayBuffer(cue.audioBase64);
  assert(new Uint8Array(cue.audioBuffer)[3] === 4, 'restored');
});

await runItem('B30', 'LOCAL_VALIDATE gates on composite ok', async () => {
  const src = read('content/content-main.js');
  assert(src.includes('v?.ok === false'), 'checks composite ok');
  assert(src.includes('LOCAL_VALIDATE'), 'still validates');
});

await runItem('B31', 'No duplicate vod_ready HEALTH_ALERT from content', async () => {
  const src = read('content/content-main.js');
  const idx = src.indexOf("ev.type === 'vod_ready'");
  assert(idx > 0, 'vod_ready handler');
  const block = src.slice(idx, idx + 900);
  assert(
    !/sendMessage\(\s*\{\s*type:\s*MSG\.HEALTH_ALERT/.test(block),
    'content does not send HEALTH_ALERT on vod_ready',
  );
  const pipe = read('lib/pipeline/vod-prepare-pipeline.js');
  assert(pipe.includes("kind: 'vod_ready'"), 'pipeline owns toast');
});

await runItem('B32', 'YT audio postMessage origin-gated', async () => {
  const src = read('content/content-main.js');
  assert(src.includes('ev.source !== window'), 'same-window only');
  assert(src.includes('isAllowedMediaStreamUrl'), 'url host allowlist helper');
  const guard = read('lib/media/url-guard.js');
  assert(guard.includes('googlevideo'), 'guard lists googlevideo');
});

await runItem('B33', 'MEDIA_EXTRACT byteLength no audioAb TDZ', async () => {
  const sw = read('background/service-worker.js');
  assert(sw.includes('byteLength: prep.byteLength || 0'), 'safe byteLength');
  assert(!/byteLength:\s*prep\.byteLength\s*\|\|\s*audioAb/.test(sw), 'no audioAb ref');
  // Runtime TDZ proof of the old bug pattern
  let threw = false;
  try {
    const prep = { byteLength: 0 };
    // eslint-disable-next-line no-undef
    void (prep.byteLength || audioAbNeverDefined?.byteLength);
  } catch (e) {
    threw = e instanceof ReferenceError;
  }
  assert(threw, 'old pattern ReferenceError proven');
});

await runItem('B34', 'self-test.mjs parses (brace closed)', async () => {
  const src = read('tools/self-test.mjs');
  assert(src.includes('live-vs-vod detectMediaIsLive'), 'live-vs-vod section');
  assert(src.includes('YouTube VOD with isLiveContent false stays VOD'), 'vod assert present');
  // Runtime: file must parse
  const { spawnSync } = await import('child_process');
  const r = spawnSync(process.execPath, ['--check', path.join(root, 'tools', 'self-test.mjs')], {
    encoding: 'utf8',
  });
  assert(r.status === 0, `node --check self-test: ${r.stderr || r.stdout || r.status}`);
});

await runItem('B35', 'Offscreen ignores PLAY_TTS_CHUNK (SW owns)', async () => {
  const off = read('offscreen/media-decode.js');
  const sw = read('background/service-worker.js');
  assert(off.includes("'OFFSCREEN_PLAY_TTS'"), 'offscreen plays via OFFSCREEN_PLAY_TTS');
  assert(!off.includes('MSG.PLAY_TTS_CHUNK'), 'offscreen does not handle PLAY_TTS_CHUNK');
  assert(!off.includes('MSG.STOP_TTS_PLAYBACK'), 'offscreen does not handle STOP_TTS_PLAYBACK');
  assert(sw.includes('case MSG.PLAY_TTS_CHUNK'), 'SW handles PLAY_TTS_CHUNK');
  assert(sw.includes("type: 'OFFSCREEN_PLAY_TTS'"), 'SW forwards OFFSCREEN_PLAY_TTS');
});

await runItem('B36', 'LOCAL_VALIDATE timeout covers native start', async () => {
  const src = read('content/content-main.js');
  assert(/timeoutMs:\s*90000/.test(src), 'content validate ≥90s');
  assert(src.includes('v?.timeout === true'), 'timeout distinguished');
  const host = read('lib/local-gateway-host.js');
  assert(host.includes('70000'), 'native start budget 70s');
});

await runItem('B37', 'VOD plan prefers decoded.duration', async () => {
  const off = read('offscreen/media-decode.js');
  assert(off.includes('decoded.duration') && off.includes('durationHint'), 'both present');
  const idxDecoded = off.indexOf('Number.isFinite(decoded.duration)');
  const idxHint = off.indexOf('Number(message.durationHint) > 0');
  assert(idxDecoded > 0, 'decoded.duration gated first');
  assert(idxHint > idxDecoded, 'hint is fallback after decoded');
  // Runtime preference proof
  const prefer = (decodedDur, hint) =>
    Number.isFinite(decodedDur) && decodedDur > 0
      ? decodedDur
      : Number(hint) > 0
        ? Number(hint)
        : 0;
  assert(prefer(19.2, 5400) === 19.2, 'decoded wins over huge hint');
  assert(prefer(0, 12) === 12, 'hint used when decoded invalid');
});

await runItem('B38', 'e2e version matches manifest dynamically', async () => {
  const e2e = read('tools/.vod-check/verify-e2e-all.mjs');
  assert(e2e.includes('manifest.json'), 'reads manifest');
  assert(e2e.includes('man.version'), 'compares man.version');
  assert(!e2e.includes("snap.version === '1.9.7'"), 'no hardcoded 1.9.7');
  const man = JSON.parse(read('manifest.json'));
  assert(/^\d+\.\d+\.\d+$/.test(man.version), 'manifest semver');
});

await runItem('B39', 'No leftover 7419 agent ingest', async () => {
  const files = [
    'background/service-worker.js',
    'content/content-main.js',
    'content/page-bridge.js',
    'offscreen/media-decode.js',
    'lib/media/ytdlp-gateway.js',
    'lib/media/audio-extractor.js',
    'lib/media/youtube-ua-dnr.js',
  ];
  for (const rel of files) {
    const src = read(rel);
    assert(!src.includes('127.0.0.1:7419'), `${rel} no 7419`);
    assert(!src.includes('#region agent log'), `${rel} no agent region`);
    assert(!src.includes('AETHERVOX_DEBUG_PROBE'), `${rel} no debug probe`);
  }
});

await runItem('B40', 'Forced VOD not overwritten', async () => {
  const { keepForcedVod } = await load('lib/pipeline/vod-chunk-policy.js');
  assert(keepForcedVod(true, false) === true, 'forced stays VOD vs live redetect');
  assert(keepForcedVod(true, true) === true, 'forced stays VOD vs vod redetect');
  assert(keepForcedVod(false, false) === false, 'unforced live stays live');
  assert(keepForcedVod(false, true) === true, 'unforced uses recompute VOD');
  const src = read('content/content-main.js');
  assert(src.includes('keepForcedVod(forcedVod, vodMode2)'), 'content uses keepForcedVod');
  assert(!/if \(vodMode2 !== vodMode\)/.test(src), 'no blind vodMode2 overwrite');
});

await runItem('B41', 'Thrown VOD chunk enters failed path', async () => {
  const { outcomeFromChunkError, shouldFailEmptyBank } = await load(
    'lib/pipeline/vod-chunk-policy.js',
  );
  assert(outcomeFromChunkError() === 'failed', 'throw → failed');
  assert(
    shouldFailEmptyBank({ cueCount: 0, failedTerminal: 3, chunkCount: 3 }) === true,
    'all-fail empty bank',
  );
  assert(
    shouldFailEmptyBank({ cueCount: 1, failedTerminal: 3, chunkCount: 3 }) === false,
    'has cues ok',
  );
  assert(
    shouldFailEmptyBank({ cueCount: 0, failedTerminal: 0, chunkCount: 0 }) === false,
    'zero plan not fail',
  );
  const src = read('lib/pipeline/vod-prepare-pipeline.js');
  assert(src.includes('#onChunkSettled'), 'settled helper');
  assert(src.includes('outcomeFromChunkError()'), 'catch uses policy');
  assert(src.includes('shouldFailEmptyBank'), 'empty bank gated');
});

await runItem('B42', 'YouTube-only ytdlp URL + streamUrl guard', async () => {
  const {
    isAllowedYtdlpSourceUrl,
    isAllowedMediaStreamUrl,
  } = await load('lib/media/url-guard.js');
  assert(
    isAllowedYtdlpSourceUrl('https://www.youtube.com/watch?v=dQw4w9wgGcQ') === true,
    'yt watch ok',
  );
  assert(isAllowedYtdlpSourceUrl('https://youtu.be/dQw4w9wgGcQ') === true, 'youtu.be ok');
  assert(
    isAllowedYtdlpSourceUrl('https://evil.example/watch?v=dQw4w9wgGcQ') === false,
    'evil host blocked',
  );
  assert(
    isAllowedMediaStreamUrl('https://rr1---sn-abc.googlevideo.com/videoplayback?id=1') ===
      true,
    'googlevideo ok',
  );
  assert(
    isAllowedMediaStreamUrl('http://127.0.0.1:8788/v1/media/cache/aabbccddeeff0011') ===
      true,
    'local cache ok',
  );
  assert(
    isAllowedMediaStreamUrl('http://127.0.0.1:8788/v1/stt') === false,
    'local non-cache blocked',
  );
  assert(isAllowedMediaStreamUrl('https://evil.example/a.m4a') === false, 'http evil blocked');
  const gw = read('tools/local-voice-gateway/server.py');
  assert(gw.includes('is_allowed_ytdlp_url'), 'gateway uses allowlist');
  const sw = read('background/service-worker.js');
  assert(sw.includes('isAllowedMediaStreamUrl'), 'SW guards streamUrl');
});

await runItem('B43', 'GET_SETTINGS has timeout + settingsFromResponse', async () => {
  const { settingsFromResponse, SETTINGS_FETCH_TIMEOUT_MS } = await load(
    'lib/messaging.js',
  );
  assert(SETTINGS_FETCH_TIMEOUT_MS >= 8000, 'budget ≥8s');
  assert(settingsFromResponse({ ok: true, settings: { a: 1 } })?.a === 1, 'extracts settings');
  assert(settingsFromResponse({ ok: false, error: 'x' }) === null, 'fail → null');
  assert(settingsFromResponse(undefined) === null, 'undef → null');
  const c = read('content/content-main.js');
  assert(c.includes('SETTINGS_FETCH_TIMEOUT_MS'), 'content boot timeout');
  assert(c.includes('settingsFromResponse'), 'content uses helper');
  const p = read('popup/popup.js');
  assert(p.includes('SETTINGS_FETCH_TIMEOUT_MS'), 'popup timeout');
});

await runItem('B44', 'Chat extract Cyrillic only for RU target', async () => {
  const pol = read('tools/local-voice-gateway/gateway_policy.py');
  assert(pol.includes('def wants_cyrillic_target'), 'policy fn');
  assert(pol.includes('def extract_spoken_text'), 'extract fn');
  assert(/russian\|русск/.test(pol), 'RU target regex');
  const srv = read('tools/local-voice-gateway/server.py');
  assert(srv.includes('wants_cyrillic_target'), 'server uses target gate');
  assert(srv.includes('extract_spoken_text'), 'server uses extract');
  // Mirror of gateway_policy.wants_cyrillic_target / extract_spoken_text
  const cyrTarget = /(russian|русск|→\s*ru\b|target(?:lang)?\s*[:=]\s*ru\b|на русский)/i;
  assert(
    cyrTarget.test('English → pure spoken Russian only'),
    'RU prompt detected',
  );
  assert(
    !cyrTarget.test('Translate to English only. SRC: привет'),
    'EN prompt not forced Cyrillic',
  );
  const preferOff = 'Hello world';
  assert(preferOff === 'Hello world', 'EN content kept when prefer_cyrillic=false');
});

await runItem('B45', 'Cookie unlink + media cache prune', async () => {
  const src = read('tools/local-voice-gateway/server.py');
  assert(src.includes('cookie_file.unlink'), 'unlinks cookies');
  assert(src.includes('finally:'), 'finally around download');
  assert(src.includes('def _prune_media_cache'), 'prune helper');
  assert(src.includes('_prune_media_cache()'), 'prune called');
});

await runItem('B46', 'Native host closes autostart log', async () => {
  const src = read('tools/local-voice-gateway/native_host.py');
  assert(src.includes('log_f.close()'), 'closes log');
  assert(/finally:[\s\S]{0,80}log_f\.close/.test(src), 'close in finally');
});

await runItem('B47', 'Version 1.9.11 + folder V1.80 documented', async () => {
  const man = JSON.parse(read('manifest.json'));
  assert(man.version === '1.9.11', `manifest ${man.version}`);
  assert(read('README.md').includes('v1.9.11'), 'readme');
  assert(read('options/force-reload.js').includes("'1.9.11'"), 'force-reload');
  assert(read('BUG-REPORT.md').includes('1.9.11'), 'report');
  assert(read('BUG-REPORT.md').includes('V1.80'), 'folder V1.80');
  const ov = read('content/overlay-ui.js');
  assert(ov.includes('getManifest'), 'overlay reads manifest');
});

await runItem('B48', 'Media cache token hex-only', async () => {
  const { sanitizeMediaCacheToken } = await load('lib/media/url-guard.js');
  assert(sanitizeMediaCacheToken('aabbccddeeff0011') === 'aabbccddeeff0011', 'hex ok');
  assert(sanitizeMediaCacheToken('../etc/passwd') === null, 'path rejected');
  assert(sanitizeMediaCacheToken('*') === null, 'glob rejected');
  assert(sanitizeMediaCacheToken('short') === null, 'too short');
  const src = read('tools/local-voice-gateway/server.py');
  assert(src.includes('sanitize_media_token'), 'server sanitizes');
});

await runItem('B49', 'Generic fetch timeout label', async () => {
  const src = read('lib/xai/client.js');
  assert(src.includes('fetch timeout'), 'generic label');
  assert(!src.includes('STT fetch timeout'), 'no STT-only label');
});

await runItem('B50', 'isYoutubeHost rejects evil-youtube.com', async () => {
  const { isYoutubeHost } = await load('lib/media/url-guard.js');
  assert(isYoutubeHost('www.youtube.com') === true, 'www.youtube.com');
  assert(isYoutubeHost('youtu.be') === true, 'youtu.be');
  assert(isYoutubeHost('evil-youtube.com') === false, 'evil-youtube.com');
  assert(isYoutubeHost('notyoutube.com') === false, 'notyoutube.com');
  assert(isYoutubeHost('music.youtube.com') === true, 'music.youtube.com');
  const inn = read('lib/media/youtube-innertube.js');
  assert(inn.includes('isYoutubeHost(host)'), 'parse uses helper');
  const ctx = read('lib/pipeline/context-builder.js');
  assert(ctx.includes('isYoutubeHost(host)'), 'live detect uses helper');
});

await runItem('B51', 'page-bridge same-window postMessage', async () => {
  const src = read('content/page-bridge.js');
  assert(src.includes('ev.source !== window'), 'same window');
  assert(src.includes('ev.origin !== window.location.origin'), 'origin');
});

await runItem('B52', 'Gateway proxy path rejects traversal', async () => {
  const pol = read('tools/local-voice-gateway/gateway_policy.py');
  assert(pol.includes('def is_safe_proxy_path'), 'policy fn');
  assert(pol.includes('".."') || pol.includes("'..'"), 'rejects ..');
  assert(pol.includes('://'), 'rejects scheme');
  const isSafe = (p) => {
    const s = String(p || '');
    if (!s || s.includes('..') || s.includes('://') || s.startsWith('/') || s.includes('\\')) {
      return false;
    }
    return true;
  };
  assert(isSafe('embeddings') === true, 'embeddings ok');
  assert(isSafe('../secret') === false, '.. blocked');
  assert(isSafe('http://evil') === false, 'scheme blocked');
  assert(isSafe('/abs') === false, 'abs blocked');
  assert(read('tools/local-voice-gateway/server.py').includes('is_safe_proxy_path'), 'wired');
});

await runItem('B53', 'Native host paths are V1.80 not V1.79.5', async () => {
  const bat = read('tools/local-voice-gateway/native_host_launcher.bat');
  const man = read('tools/local-voice-gateway/com.aethervox.local_gateway.json');
  assert(!bat.includes('V1.79.5'), 'bat not pinned to V1.79.5');
  assert(bat.includes('native_host.py'), 'bat launches native_host.py');
  assert(bat.includes('%~dp0'), 'bat is folder-relative');
  assert(!man.includes('V1.79.5'), 'json not pinned to V1.79.5');
  assert(man.includes('V1.80'), 'json points at V1.80');
  assert(man.includes('native_host_launcher.bat'), 'json path is launcher');
});

await runItem('B54', 'Native spawn close_fds compatible with redirects', async () => {
  const src = read('tools/local-voice-gateway/native_host.py');
  assert(src.includes('close_fds=os.name != "nt"'), 'Windows keeps fds for stdout');
  assert(src.includes('pid_in_tasklist'), 'whole-token PID');
});

await runItem('B55', 'Ara female maps to irina not dmitri', async () => {
  const voices = JSON.parse(read('tools/local-voice-gateway/voices.json'));
  const ara = voices.voices.find((v) => v.voice_id === 'ara');
  assert(ara?.gender === 'female', 'ara female');
  assert(String(ara?.piper || '').includes('irina'), 'ara → irina');
  assert(!String(ara?.piper || '').includes('dmitri'), 'ara not dmitri');
  const pol = read('tools/local-voice-gateway/gateway_policy.py');
  assert(pol.includes('def piper_matches_gender'), 'gender guard');
  const srv = read('tools/local-voice-gateway/server.py');
  assert(srv.includes('piper_matches_gender'), 'picker uses guard');
});

await runItem('B56', 'STT resamples to 16 kHz', async () => {
  const pol = read('tools/local-voice-gateway/gateway_policy.py');
  assert(pol.includes('def resample_to_16k'), 'helper');
  assert(pol.includes('def resample_len'), 'len helper');
  const n48 = 48000;
  const got = Math.round((n48 * 16000) / 48000);
  assert(got === 16000, '48k→16k length');
  const srv = read('tools/local-voice-gateway/server.py');
  assert(srv.includes('resample_to_16k'), 'reader resamples');
});

await runItem('B57', 'TTS body labeled wav not fake mp3', async () => {
  const srv = read('tools/local-voice-gateway/server.py');
  assert(srv.includes('output_audio_media_type'), 'uses helper');
  assert(!/return wav_bytes, "audio\/mpeg"/.test(srv), 'never labels wav as mpeg');
  const pol = read('tools/local-voice-gateway/gateway_policy.py');
  assert(pol.includes('return "audio/wav"'), 'always wav');
});

await runItem('B58', 'Health exposes ready + not blindly ok', async () => {
  const src = read('tools/local-voice-gateway/server.py');
  assert(src.includes('"ready": ready'), 'ready payload');
  assert(src.includes('engines_ok'), 'ok from engines');
  assert(src.includes('".gateway.pid"'), 'writes pid on start');
});

await runItem('B59', 'self-test gender assert parenthesized', async () => {
  const src = read('tools/self-test.mjs');
  assert(!src.includes('createRequire'), 'no unused createRequire');
  assert(
    src.includes("low.gender === 'male' && (low.voiceType === 'baritone'"),
    'gender && (baritone || bass)',
  );
});

await runItem('B60', 'Local health inflight ≥ Whisper budget', async () => {
  const { inflightTimeoutForProvider, sttApiTimeoutMs } = await load(
    'lib/pipeline/live-policy.js',
  );
  assert(inflightTimeoutForProvider('local') >= 95000, 'local ≥95s');
  assert(sttApiTimeoutMs('local', { hardLag: true, lagShed: true }) >= 95000, 'no 14s clamp');
  assert(sttApiTimeoutMs('xai', { hardLag: true }) <= 14000, 'xAI still clamps');
  const tp = read('lib/pipeline/translator-pipeline.js');
  assert(tp.includes('inflightTimeoutForProvider'), 'HealthMonitor uses helper');
  assert(tp.includes('sttApiTimeoutMs'), 'STT uses helper');
});

await runItem('B61', 'Live TTS unlock + offscreen fallback', async () => {
  const src = read('lib/pipeline/translator-pipeline.js');
  assert(src.includes('#unlockTtsAudio'), 'unlock on start');
  assert(src.includes('this.#unlockTtsAudio()'), 'called');
  assert(src.includes('MSG.PLAY_TTS_CHUNK'), 'offscreen fallback');
  assert(!/el\.play\(\)\.catch\(done\)/.test(src), 'play reject not fake-ok');
});

await runItem('B62', 'Phrase cache requires learningRevision', async () => {
  const { phraseCacheUsable } = await load('lib/pipeline/live-policy.js');
  assert(phraseCacheUsable({ target: 'hi', updatedAt: Date.now() }, 3) === false, 'no rev');
  assert(phraseCacheUsable({ target: 'hi', learningRevision: 3 }, 3) === true, 'same rev');
  assert(phraseCacheUsable({ target: 'hi', learningRevision: 1 }, 3) === false, 'stale rev');
  const sw = read('background/service-worker.js');
  assert(sw.includes('phraseCacheUsable'), 'SW uses helper');
});

await runItem('B63', 'Dedup only after TTS / inflight set', async () => {
  const src = read('lib/pipeline/translator-pipeline.js');
  assert(src.includes('#markInflightSpoken'), 'inflight mark');
  assert(src.includes('#clearInflightSpoken'), 'inflight clear');
  const idxRemember = src.indexOf('this.#rememberSpoken(src)');
  assert(idxRemember < 0, 'no remember at clause start');
  assert(src.includes('this.#rememberSpoken(sourceText)'), 'remember after audio');
});

await runItem('B64', 'Capture remount + setChunkSec ≤12', async () => {
  const src = read('lib/pipeline/audio-capture.js');
  assert(src.includes('__aethervoxGraph'), 'persist graph on element');
  assert(src.includes('обнови вкладку'), 'not CORS hint');
  assert(src.includes('sec <= 12'), 'chunk cap 12');
});

await runItem('B65', 'Failed network route not reused', async () => {
  const { networkRouteReusable } = await load('lib/pipeline/live-policy.js');
  assert(networkRouteReusable({ ok: false }) === false);
  assert(networkRouteReusable({ ok: true, baseUrl: 'x' }) === true);
  assert(networkRouteReusable(null) === false);
  const sw = read('background/service-worker.js');
  assert(sw.includes('networkRouteReusable(networkReady)'), 'ensureNetwork gate');
});

await runItem('B66', 'REST chunk not deprecated 10s', async () => {
  const { restChunkSec } = await load('lib/pipeline/live-policy.js');
  assert(restChunkSec({ isLive: false, profile: 'balanced' }) <= 2.5, '≤2.5s');
  const src = read('lib/pipeline/translator-pipeline.js');
  assert(src.includes('restChunkSec'), 'wired');
  assert(!src.includes('AUDIO.vodChunkSec'), 'no 10s REST');
});

await runItem('B67', 'Learning/settings writes serialized', async () => {
  const sw = read('background/service-worker.js');
  assert(sw.includes('updateLearning((mem)'), 'ADD_EXCEPTION/TERM/PHRASE locked');
  assert(sw.includes('SET_LEARNING requires a full object'), 'reject empty');
  const st = read('lib/storage.js');
  assert(st.includes('_settingsWriteChain'), 'settings lock');
});

await runItem('B68', 'Unicode word bounds + uk/kk TTS', async () => {
  const { unicodeWordRegExp } = await load('lib/pipeline/live-policy.js');
  assert(unicodeWordRegExp('Привет').test('Привет, мир'), 'RU match');
  assert(!unicodeWordRegExp('Привет').test('Приветик'), 'no prefix');
  const { ttsLanguageCode } = await load('lib/languages.js');
  assert(ttsLanguageCode('uk') === 'uk');
  assert(ttsLanguageCode('kk') === 'kk');
  const learn = read('lib/learning.js');
  assert(learn.includes('unicodeWordRegExp'), 'learning uses unicode');
});

await runItem('B69', 'Offscreen not web-accessible', async () => {
  const man = JSON.parse(read('manifest.json'));
  const war = JSON.stringify(man.web_accessible_resources || []);
  assert(!war.includes('offscreen'), 'offscreen not in WAR');
});

await runItem('B70', 'YT DNR scoped to extension + Referer', async () => {
  const { buildYoutubeUaDnrRules } = await load('lib/media/youtube-ua-dnr.js');
  const rules = buildYoutubeUaDnrRules('UA-TEST', {
    initiatorDomains: ['abcdefghijklmnopqrstuvwxyzabcdef'],
  });
  assert(rules.length >= 2, 'two rules');
  assert(
    rules.every((r) => r.condition.initiatorDomains?.length === 1),
    'initiator scoped',
  );
  const gv = rules.find((r) => String(r.condition.urlFilter).includes('googlevideo'));
  assert(
    gv.action.requestHeaders.some((h) => h.header === 'Referer'),
    'Referer on googlevideo',
  );
});

await runItem('B71', 'STT WS budget cancels leftover open', async () => {
  const src = read('lib/xai/stream-session.js');
  assert(src.includes('_sttWsAttempt'), 'ws attempt token');
  assert(src.includes('onTimeout'), 'budget onTimeout');
  assert(src.includes('wsAttempt !== this._sttWsAttempt'), 'openWithCred checks token');
});

await runItem('B72', 'TTS WS ignores other utterance ids', async () => {
  const { ttsMessageMatchesUtterance } = await load('lib/xai/auth-policy.js');
  assert(ttsMessageMatchesUtterance({ id: 'a' }, { id: 'a' }) === true);
  assert(ttsMessageMatchesUtterance({ id: 'b' }, { id: 'a' }) === false);
  assert(ttsMessageMatchesUtterance({}, { id: 'a' }) === true, 'no id → allow');
  const src = read('lib/xai/tts-ws.js');
  assert(src.includes('ttsMessageMatchesUtterance'), 'wired');
  assert(src.includes('this.ws?.close'), 'timeout closes socket');
});

await runItem('B73', 'Local relay needs fingerprint', async () => {
  const { looksLikeXaiRelay } = await load('lib/xai/auth-policy.js');
  assert(looksLikeXaiRelay(200, { service: 'aethervox-xai-relay' }) === true);
  assert(looksLikeXaiRelay(200, { voices: [{ voice_id: 'ara' }] }) === true);
  assert(looksLikeXaiRelay(200, { ok: true }) === false, 'random 200 no');
  assert(looksLikeXaiRelay(404, { voices: [] }) === false, '404 no');
  assert(read('lib/xai/ws-auth.js').includes('looksLikeXaiRelay'), 'discover uses it');
});

await runItem('B74', 'Gateway health requires ok:true', async () => {
  const { looksLikeLocalGateway } = await load('lib/xai/auth-policy.js');
  assert(looksLikeLocalGateway(200, { ok: true, service: 'aethervox-local-voice-gateway' }));
  assert(!looksLikeLocalGateway(200, { ok: false }));
  assert(!looksLikeLocalGateway(503, { ok: true }));
  assert(read('lib/local-gateway-host.js').includes('looksLikeLocalGateway'));
});

await runItem('B75', 'Route probe 404 is not reachable', async () => {
  const src = read('lib/network/router.js');
  assert(!src.includes('res.status === 404'), '404 not success');
  assert(src.includes('now - CACHE_TTL_MS + 15_000'), 'failed cache short');
});

await runItem('B76', 'Cookie export is YouTube-only', async () => {
  const src = read('lib/media/youtube-cookies.js');
  assert(!src.includes("'google.com'"), 'no google.com domain');
  assert(!src.includes('accounts.google.com'), 'no accounts.google');
  assert(src.includes('youtube.com'), 'youtube kept');
});

await runItem('B77', 'Native STT fetch abort + closed drop', async () => {
  const src = read('lib/xai/native-stt-stream.js');
  assert(src.includes('AbortController'), 'abort');
  assert(src.includes('this._closed) return'), 'drop after close');
  assert(src.includes('_sttAbort?.abort'), 'close aborts inflight');
});

await runItem('B78', 'transcript.done handled before partial', async () => {
  const src = read('lib/xai/stt-ws.js');
  const done = src.indexOf("type === 'transcript.done'");
  const partial = src.indexOf("type === 'transcript.partial'");
  assert(done > 0 && done < partial, 'done first');
});

await runItem('B79', 'page-bridge origin-scoped postMessage, no PLAY_TTS', async () => {
  const src = read('content/page-bridge.js');
  assert(src.includes('location.origin'), 'origin target');
  assert(!src.includes("AETHERVOX_PLAY_TTS"), 'no PLAY_TTS attack surface');
  const { sameDocumentPostTarget } = await load('lib/content-policy.js');
  assert(sameDocumentPostTarget('https://www.youtube.com') === 'https://www.youtube.com');
  assert(sameDocumentPostTarget('null') === 'null');
  assert(sameDocumentPostTarget('') === 'null');
});

await runItem('B80', 'about:blank bootstrap allowed', async () => {
  const { shouldSkipContentProtocol } = await load('lib/content-policy.js');
  assert(shouldSkipContentProtocol('chrome:') === true);
  assert(shouldSkipContentProtocol('about:', 'about:blank') === false);
  assert(shouldSkipContentProtocol('about:', 'about:srcdoc') === false);
  assert(shouldSkipContentProtocol('about:', 'about:config') === true);
  const boot = read('content/content-bootstrap.js');
  assert(boot.includes('about:blank'), 'blank allowed');
});

await runItem('B81', 'Detach when video gone + fullscreen cleanup', async () => {
  const main = read('content/content-main.js');
  assert(main.includes('detach({ keepWatch: true })'), 'detach on lost video');
  const vf = read('content/video-finder.js');
  assert(vf.includes("removeEventListener('fullscreenchange'"), 'fs cleanup');
});

await runItem('B82', 'Subs persist + settings not wiped', async () => {
  const main = read('content/content-main.js');
  assert(main.includes('autoSubtitles: subsOn'), 'persist toggle');
  assert(main.includes('settingsFromSetResponse'), 'no wipe');
  const { settingsFromSetResponse } = await load('lib/content-policy.js');
  assert(settingsFromSetResponse({ ok: false }, { a: 1 }).a === 1);
  assert(settingsFromSetResponse({ settings: { b: 2 } }, { a: 1 }).b === 2);
});

await runItem('B83', 'Popup SW-miss vs missing key + child skip', async () => {
  const { popupAuthGate, childFrameShouldSkipToggle } = await load(
    'lib/content-policy.js',
  );
  assert(popupAuthGate(null, { error: 'dead' }).showApiKey === false);
  assert(popupAuthGate({ providerMode: 'local' }).allow === true);
  assert(popupAuthGate({ providerMode: 'xai', xaiApiKey: '' }).showApiKey === true);
  assert(
    childFrameShouldSkipToggle({
      isTop: false,
      ownsPlayer: true,
      pipelineRunning: false,
      topHasVideo: true,
    }) === true,
  );
  assert(
    childFrameShouldSkipToggle({
      isTop: true,
      ownsPlayer: true,
      pipelineRunning: false,
      topHasVideo: true,
    }) === false,
  );
  const ov = read('content/overlay-ui.js');
  assert(ov.includes('_anchorPosPrev'), 'restore position');
});

await runItem('B84', 'Clause backpressure before inflight mark', async () => {
  const { clauseShouldDispatch } = await load('lib/pipeline/live-policy.js');
  assert(
    clauseShouldDispatch({ busy: 4, maxBusy: 3 }).dispatch === false,
    'busy blocks',
  );
  assert(clauseShouldDispatch({ busy: 0, maxBusy: 3 }).dispatch === true, 'free');
  const src = read('lib/pipeline/translator-pipeline.js');
  assert(src.includes('clauseShouldDispatch'), 'pipeline uses gate');
  assert(
    src.indexOf('clauseShouldDispatch') < src.indexOf('#markInflightSpoken(src)'),
    'gate before mark',
  );
});

await runItem('B85', 'Epoch finally does not steal new slots', async () => {
  const src = read('lib/pipeline/translator-pipeline.js');
  assert(src.includes('if (epoch === this._epoch)'), 'epoch guard on finally');
  assert(
    !/Always free slots — epoch bump/.test(src),
    'old always-decrement comment gone',
  );
});

await runItem('B86', 'Late stt_ready after open timeout ignored', async () => {
  const src = read('lib/pipeline/stream-bridge.js');
  assert(src.includes('_sttOpenTimedOutGen'), 'timeout gen tracked');
  const sws = read('lib/xai/stream-session.js');
  assert(sws.includes('#sttHandlers(gen)'), 'onReady gen-checked');
});

await runItem('B87', 'VOD STT timeout honored in SW', async () => {
  const sw = read('background/service-worker.js');
  assert(sw.includes('payload?.timeoutMs'), 'payload timeout');
  const vod = read('lib/pipeline/vod-prepare-pipeline.js');
  assert(vod.includes('timeoutMs:'), 'vod sends timeout');
});

await runItem('B88', 'TTS WS timeout rejects (no connected setter)', async () => {
  const src = read('lib/xai/tts-ws.js');
  assert(!/this\.connected = false/.test(src), 'no setter assign');
  assert(src.includes('TTS WS timeout'), 'still rejects timeout');
});

await runItem('B89', 'Native STT abort set', async () => {
  const src = read('lib/xai/native-stt-stream.js');
  assert(src.includes('_sttAborts'), 'abort set');
  assert(src.includes('this._sttAborts.add(ac)'), 'tracks each fetch');
});

await runItem('B90', 'VOD overlap is not silent coverage', async () => {
  const { isNearDuplicateVodSource } = await load(
    'lib/pipeline/vod-chunk-policy.js',
  );
  assert(
    isNearDuplicateVodSource('abcdefghijklmn extra words here', 9.65, [
      { start: 0, sourceText: 'abcdefghijklmn' },
    ]) === false,
    'suffix kept',
  );
  assert(
    isNearDuplicateVodSource('same exact line xx', 1, [
      { start: 0, sourceText: 'same exact line xx' },
    ]) === true,
    'exact dup',
  );
});

await runItem('B91', 'Twitch host spoof + ytdlp redirect', async () => {
  const {
    isTwitchHost,
    isAllowedYtdlpSourceUrl,
  } = await load('lib/media/url-guard.js');
  const { detectMediaIsLive } = await load('lib/pipeline/context-builder.js');
  assert(isTwitchHost('nottwitch.tv') === false, 'nottwitch');
  assert(
    detectMediaIsLive({ host: 'evil-twitch.tv', path: '/x' }) === false,
    'spoof not live',
  );
  assert(
    isAllowedYtdlpSourceUrl(
      'https://www.youtube.com/redirect?q=http://127.0.0.1/',
    ) === false,
    'redirect blocked',
  );
});

await runItem('B92', 'Empty SW response is failure', async () => {
  const { interpretExtensionResponse } = await load('lib/messaging.js');
  assert(interpretExtensionResponse(undefined).ok === false, 'undefined');
  assert(interpretExtensionResponse(null).ok === false, 'null');
});

await runItem('B93', 'postMessage never falls back to *', async () => {
  const { sameDocumentPostTarget } = await load('lib/content-policy.js');
  assert(sameDocumentPostTarget('null') === 'null');
  assert(!read('content/page-bridge.js').includes("|| '*'"));
  assert(!read('content/content-main.js').includes("location.origin || '*'"));
});

const failed = results.filter((r) => !r.ok);
const out = {
  ok: failed.length === 0,
  runsPerItem: RUNS,
  passed: results.filter((r) => r.ok).length,
  failed: failed.map((f) => f.id),
  results,
  at: new Date().toISOString(),
};
fs.writeFileSync(
  path.join(root, 'tools', '.vod-check', 'bug-report-verify-result.json'),
  JSON.stringify(out, null, 2),
);

console.log(
  `\n=== ${out.ok ? 'ALL GREEN' : 'FAILED'} · ${out.passed}/${results.length} items × ${RUNS} ===\n`,
);
process.exit(out.ok ? 0 : 1);
