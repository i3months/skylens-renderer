// 드레이프 apply 성능 시험(F-403 ③). 1280×720 연직 장면, 모든 화소가 타일에 적중한다.
// 비교 대상: 같은 입력으로 화소마다 pixelToEnu → store.lookup → sampleDrape → shadeRatio/applyRatio 를 부르는 기존 느린 경로(이 파일 안 참조).
// 각 경로를 데우고 여러 번 재 최솟값(ms)을 쓴다. 두 값과 비율을 출력한다.
// 단언: 새 경로 ≤ 참조의 1/3(여유 있는 기준) 그리고 색 바이트 동일. 기준을 측정에 맞춰 낮추지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createDrapeLayer } from './index.mjs';
import { createDrapeStore } from './store.mjs';
import { pixelToEnu } from './unproject.mjs';
import { sampleDrape } from './sample.mjs';
import { shadeRatio, applyRatio } from './shade.mjs';
import { TERRAIN_DEFAULTS } from '../../../contracts/controlview/terrain.mjs';
import { mulberry32 } from '../terrain/fixtures.mjs';

const W = 1280, H = 720;
const MAX_RATIO = 1 / 3;
const RUNS = 5;

/** 연직 카메라: 높이 200 m, f = 1000 → 지면 ±128 m × ±72 m(타일 [-128, 128]² 안). */
function makeScene() {
  const camera = { width: W, height: H, K: { fx: 1000, fy: 1000, cx: W / 2, cy: H / 2 }, R: [1, 0, 0, 0, -1, 0, 0, 0, -1], t: [0, 0, 200] };
  const n = W * H;
  const rnd = mulberry32(42);
  const color = new Uint8Array(3 * n);
  for (let k = 0; k < color.length; k++) color[k] = Math.floor(rnd() * 256);
  const depth = new Float32Array(n).fill(200);
  const index = new Int32Array(n);
  for (let p = 0; p < n; p++) index[p] = p;
  const terrain = { width: W, height: H, color, depth, index };
  const tiles = [];
  for (let ty = -2; ty <= 1; ty++) {
    for (let tx = -2; tx <= 1; tx++) {
      const w = 256, h = 256;
      const rgb = new Uint8Array(3 * w * h);
      for (let k = 0; k < rgb.length; k++) rgb[k] = Math.floor(rnd() * 256);
      const mask = new Uint8Array(w * h).fill(255);
      tiles.push({ tx, ty, mip: 0, width: w, height: h, rgb, coverage: { mask } });
    }
  }
  return { camera, terrain, tiles };
}

/** 기존 느린 경로(색만). */
function referenceApply(store, camera, terrain, baseRgb) {
  const { width, height } = camera;
  const out = terrain.color.slice();
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const p = j * width + i;
      const d = terrain.depth[p];
      if (!(Number.isFinite(d) && d > 0)) continue;
      const { x, y } = pixelToEnu(camera, i, j, d);
      const tile = store.lookup(x, y);
      if (!tile) continue;
      const rgb = sampleDrape(tile, x, y);
      if (!rgb) continue;
      const c = applyRatio(rgb, shadeRatio([terrain.color[3 * p], terrain.color[3 * p + 1], terrain.color[3 * p + 2]], baseRgb));
      out[3 * p] = c[0]; out[3 * p + 1] = c[1]; out[3 * p + 2] = c[2];
    }
  }
  return out;
}

function bestMs(fn) {
  fn(); // 데우기
  let best = Infinity;
  let last;
  for (let r = 0; r < RUNS; r++) {
    const t0 = performance.now();
    last = fn();
    best = Math.min(best, performance.now() - t0);
  }
  return { ms: best, last };
}

test('apply 1280×720 전 화소 적중: 새 경로 ≤ 기존 경로의 1/3', () => {
  const { camera, terrain, tiles } = makeScene();
  const layer = createDrapeLayer();
  layer.accept(0, tiles);
  const store = createDrapeStore();
  store.accept(0, tiles);
  const baseRgb = TERRAIN_DEFAULTS.baseRgb;

  const ref = bestMs(() => referenceApply(store, camera, terrain, baseRgb));
  const neu = bestMs(() => layer.apply(camera, terrain).color);

  // 모든 화소가 적중했는지(장면이 의도대로인지)와 결과 동일성.
  let hit = 0;
  for (let p = 0; p < W * H; p++) {
    const { x, y } = pixelToEnu(camera, p % W, Math.floor(p / W), 200);
    if (store.lookup(x, y)) hit++;
  }
  assert.equal(hit, W * H);
  let diff = 0;
  for (let k = 0; k < neu.last.length; k++) if (neu.last[k] !== ref.last[k]) diff++;
  assert.equal(diff, 0);

  const ratio = neu.ms / ref.ms;
  console.log(`drape perf ${W}x${H}: 참조 ${ref.ms.toFixed(1)} ms, 새 경로 ${neu.ms.toFixed(1)} ms, 비율 ${ratio.toFixed(3)} (1/${(1 / ratio).toFixed(1)})`);
  assert.ok(ratio <= MAX_RATIO, `비율 ${ratio.toFixed(3)} > ${MAX_RATIO.toFixed(3)}`);
});
