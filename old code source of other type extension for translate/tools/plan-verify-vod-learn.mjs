/**
 * Plan verify: VOD full-bank + local self-learn + GUI sync.
 * Each analysis point must pass 3 consecutive times in one process.
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_SETTINGS } from '../lib/constants.js';
import { shouldUseVodPrepare } from '../lib/pipeline/vod-chunk-policy.js';
import {
  applyLearningPayload,
  EMPTY_LEARNING,
  parseLearnJson,
  buildLearnMessages,
} from '../lib/learning.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RUNS = 3;

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/** @type {Record<string, () => { ok: boolean, detail?: string }>} */
const CHECKS = {
  A_defaultProgressiveOff: () => ({
    ok: DEFAULT_SETTINGS.vodProgressive === false,
    detail: `default=${DEFAULT_SETTINGS.vodProgressive}`,
  }),
  A_storageOptIn: () => {
    const s = read('lib/storage.js');
    return {
      ok: s.includes('raw.vodProgressive === true'),
      detail: 'storage explicit true only',
    };
  },
  A_isProgressiveOptIn: () => {
    const v = read('lib/pipeline/vod-prepare-pipeline.js');
    return {
      ok:
        v.includes('vodProgressive === true') &&
        v.includes('#armHoldPlay(true)'),
      detail: 'holdPlay + progressive opt-in',
    };
  },
  B_twitchLiveNotVod: () => ({
    ok: !shouldUseVodPrepare({
      mode: 'auto',
      hostname: 'www.twitch.tv',
      isLive: true,
    }),
  }),
  B_ytVod: () => ({
    ok: shouldUseVodPrepare({
      mode: 'auto',
      hostname: 'www.youtube.com',
      isLive: false,
    }),
  }),
  B_ytLiveNotVod: () => ({
    ok: !shouldUseVodPrepare({
      mode: 'auto',
      hostname: 'www.youtube.com',
      isLive: true,
    }),
  }),
  B_forcedLive: () => ({
    ok: !shouldUseVodPrepare({
      mode: 'live',
      hostname: 'www.youtube.com',
      isLive: false,
    }),
  }),
  B_streamGatedLiveOnly: () => {
    const tp = read('lib/pipeline/translator-pipeline.js');
    const gated =
      (tp.includes('if (!this.#isLive()) return false') ||
        (tp.includes('const live = this.#isLive()') &&
          tp.includes('if (!live)'))) &&
      tp.includes('#wantStreaming()');
    const isLiveStrict =
      tp.includes("this.settings.mode === 'vod') return false") ||
      tp.includes("mode === 'vod') return false");
    return { ok: gated && isLiveStrict, detail: `gated=${gated} strict=${isLiveStrict}` };
  },
  C_applyLocalSource: () => {
    const payload = parseLearnJson(
      '{"terms":[{"from":"a","to":"b"}],"exceptions":["X"],"wrong":false,"better":""}',
    );
    const r = applyLearningPayload(EMPTY_LEARNING(), payload, { source: 'local' });
    const ok =
      r.changed === true &&
      r.learning.terms.some((t) => t.source === 'local');
    return { ok, detail: `changed=${r.changed} source=${r.learning.terms[0]?.source}` };
  },
  C_learnMessages: () => {
    const msgs = buildLearnMessages({
      sourceText: 'hi',
      translated: 'привет',
      targetLang: 'ru',
    });
    return { ok: msgs.length === 2 };
  },
  C_swLocalLearn: () => {
    const sw = read('background/service-worker.js');
    return {
      ok:
        sw.includes("learnSource = isLocal ? 'local' : 'grok'") &&
        sw.includes('lmStudioModel'),
      detail: 'XAI_LEARN_PASS local path',
    };
  },
  D_vodLearnWired: () => {
    const v = read('lib/pipeline/vod-prepare-pipeline.js');
    return {
      ok:
        v.includes('#learnAfterCue') &&
        v.includes('MSG.LEARN_PHRASE') &&
        v.includes('MSG.XAI_LEARN_PASS') &&
        v.includes('void this.#learnAfterCue'),
      detail: 'fire-and-forget after cue',
    };
  },
  E_overlayLocalFirst: () => {
    const o = read('content/overlay-ui.js');
    return {
      ok:
        o.includes('Local STT · MT · TTS') &&
        o.includes('только стримы') &&
        o.includes('полный банк'),
      detail: 'overlay titles/meta',
    };
  },
  E_contentFullBank: () => {
    const c = read('content/content-main.js');
    return {
      ok:
        c.includes('пауза до полного банка') &&
        !c.includes('VOD · 1-й чанк → Play · банк догоняет'),
      detail: 'idle meta full-bank',
    };
  },
  E_popupVerFooter: () => {
    const h = read('popup/popup.html');
    const j = read('popup/popup.js');
    return {
      ok:
        h.includes(JSON.parse(read('manifest.json')).version) &&
        !h.includes('id="extVer">1.8<') &&
        j.includes('Local gateway') &&
        h.includes('Пауза · полный банк'),
    };
  },
  E_optionsToggle: () => {
    const o = read('options/options.html');
    const j = read('options/options.js');
    return {
      ok:
        o.includes('id="vodProgressive"') &&
        o.includes('Deep-learn (LLM review)') &&
        j.includes('vodProgressive'),
    };
  },
};

let allGreen = true;
for (const [id, fn] of Object.entries(CHECKS)) {
  let passes = 0;
  let lastDetail = '';
  for (let i = 1; i <= RUNS; i++) {
    let ok = false;
    let detail = '';
    try {
      const r = fn();
      ok = !!r.ok;
      detail = r.detail || '';
    } catch (e) {
      ok = false;
      detail = String(e?.message || e);
    }
    lastDetail = detail;
    if (ok) passes += 1;
    else {
      allGreen = false;
      console.log(`FAIL ${id} run ${i}/3 ${detail}`);
      break;
    }
  }
  if (passes === RUNS) {
    console.log(`PASS ${id} 3/3 ${lastDetail}`);
  } else {
    console.log(`FAIL ${id} ${passes}/3 — restart cycle required`);
  }
}

if (!allGreen) {
  console.error('\n=== PLAN VERIFY RED — restart full cycle ===');
  process.exit(1);
}
console.log('\n=== PLAN VERIFY GREEN — all points 3/3 ===');
process.exit(0);
