// F-363 음성 대조: 저대비 블록 + ±2·±3 DN 잡음 + 이동 0 타일에서 잡음 최소를 국소 어긋남(local)으로 보고하지 않는다.
// 도우미(makeImage·boxMean·warpedTile·HASH·TEX_A·LOW·lowContrastImage)는 drape.test.mjs 에서 그대로 복사했다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ALIGN_TOLERANCE_PX, TERRAIN_TILE_SIZE_M, tileBounds } from '../../../contracts/tower_assets/index.mjs';
import { buildDrapeTile, measureDrapeAlignment, drapeTileSize } from './index.mjs';

/** 합성 영상: 각 픽셀 중심 ENU 로 색을 정한다. 행 0 = 북. */
function makeImage(bounds, width, height, colorAt) {
  const rgb = new Uint8Array(width * height * 3);
  const sx = (bounds.maxX - bounds.minX) / width, sy = (bounds.maxY - bounds.minY) / height;
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const [R, G, B] = colorAt(bounds.minX + (c + 0.5) * sx, bounds.maxY - (r + 0.5) * sy, c, r);
      const o = (r * width + c) * 3;
      rgb[o] = R; rgb[o + 1] = G; rgb[o + 2] = B;
    }
  }
  return { width, height, rgb, bounds };
}

/** 원본 영상의 축 정렬 박스 [x0,x1]×[y0,y1](ENU) 면적 가중 평균. 영상 밖에 걸치면 false. */
function boxMean(img, x0, x1, y0, y1, out) {
  const b = img.bounds, sx = (b.maxX - b.minX) / img.width, sy = (b.maxY - b.minY) / img.height;
  const u0 = (x0 - b.minX) / sx, u1 = (x1 - b.minX) / sx, v0 = (b.maxY - y1) / sy, v1 = (b.maxY - y0) / sy;
  if (u0 < 0 || v0 < 0 || u1 > img.width || v1 > img.height) return false;
  out.fill(0);
  let a = 0;
  for (let r = Math.floor(v0); r < Math.ceil(v1); r++) {
    const ly = Math.min(v1, r + 1) - Math.max(v0, r);
    if (ly <= 0) continue;
    for (let c = Math.floor(u0); c < Math.ceil(u1); c++) {
      const lx = Math.min(u1, c + 1) - Math.max(u0, c);
      if (lx <= 0) continue;
      const w = lx * ly, o = (r * img.width + c) * 3;
      for (let k = 0; k < 3; k++) out[k] += img.rgb[o + k] * w;
      a += w;
    }
  }
  for (let k = 0; k < 3; k++) out[k] /= a;
  return true;
}

/**
 * warp 로 내용이 틀어진 드레이프 타일(밉 크기·박스 필터는 buildDrapeTile 과 같음, 픽셀당 4×4 부분 박스로 근사).
 * keep(i, j) 가 false 인 픽셀은 영상 밖처럼 비운다(mask 0). noise > 0 이면 채널마다 결정적 ±noise 균등 잡음(seed 로 정함)을 더한다.
 * coverage.bounds 는 넣지 않는다(피복 범위는 mask 로만 알 수 있다).
 */
function warpedTile(img, tx, ty, mip, warp, { keep = () => true, noise = 0, seed = 12345 } = {}) {
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 2 ** 32; };
  const { width, height } = drapeTileSize(img, mip);
  const tb = tileBounds(tx, ty), pw = TERRAIN_TILE_SIZE_M / width, ph = TERRAIN_TILE_SIZE_M / height, n = 4;
  const rgb = new Uint8Array(width * height * 3), mask = new Uint8Array(width * height);
  const acc = new Float64Array(3), sum = new Float64Array(3);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      sum.fill(0);
      let ok = keep(i, j);
      for (let b = 0; b < n && ok; b++) {
        for (let a = 0; a < n && ok; a++) {
          const q = warp({ x: tb.minX + (i + (a + 0.5) / n) * pw, y: tb.maxY - (j + (b + 0.5) / n) * ph });
          ok = boxMean(img, q.x - pw / n / 2, q.x + pw / n / 2, q.y - ph / n / 2, q.y + ph / n / 2, acc);
          for (let k = 0; k < 3; k++) sum[k] += acc[k];
        }
      }
      if (!ok) continue;
      const o = j * width + i;
      mask[o] = 255;
      for (let k = 0; k < 3; k++) {
        const e = noise ? Math.round((rnd() * 2 - 1) * noise) : 0;
        rgb[o * 3 + k] = Math.max(0, Math.min(255, Math.round(sum[k] / (n * n)) + e));
      }
    }
  }
  return { tx, ty, mip, width, height, rgb, coverage: { mask } };
}

const HASH = (c, r) => (((c * 73856093) ^ (r * 19349663)) >>> 0);
// 영상 A 와 같은 무늬(8 m 바둑판 + 사인 + 해시, 잡음 0)를 픽셀 중심 ENU·번호로.
const TEX_A = (x, y, c, r) => [
  ((Math.floor(x / 8) + Math.floor(y / 8)) & 1) ? 200 : 40, Math.round(128 + 100 * Math.sin(x * 0.07) * Math.cos(y * 0.05)), HASH(c, r) % 256,
];
// 저대비 무늬(잡음 0). c·r 은 0.5 m/px 영상 픽셀 번호(= 밉 0 타일 픽셀).
const LOW = {
  // 사인 진폭 amp DN, R 은 x 주기 48 px, G 는 y 주기 32 px.
  sine: (amp) => (x, y, c, r) => [Math.round(128 + amp * Math.sin((2 * Math.PI * c) / 48)), Math.round(60 + amp * Math.sin((2 * Math.PI * r) / 32)), 60],
  // R·G 채널 ±1 DN 해시 무늬.
  hash1: (x, y, c, r) => [128 + (HASH(c, r) % 3) - 1, 60 + (HASH(r, c) % 3) - 1, 60],
  // 균일 바탕에 R +6 DN 점(밀도 1/32, 위치는 해시 상위 비트 — 하위 비트는 주기 8 무늬).
  dots6: (x, y, c, r) => [(HASH(c, r) >>> 16) % 32 === 0 ? 134 : 128, 60, 60],
  // F-353: R = x 경사 0.15 DN/px + x 36·44 m 의 4.7 DN 세로 경계 둘(블록 안 4.7→9.4 DN), G = y 경사 0.12→0.24 DN/px.
  // y 로 1 px 옮긴 비용 상승은 1/12 이하(수정 전: 블록 제외), 4 px 에서는 뚜렷하다.
  edgeGrad: (x, y, c, r) => [
    Math.round(100 + 0.15 * (c - 180) + (x >= 36 ? 4.7 : 0) + (x >= 44 ? 4.7 : 0)),
    Math.round(60 + 0.12 * (r - 152) + (0.12 * (r - 152) ** 2) / 64), 60,
  ],
  // F-353: 위의 R 만, G 는 균일 → y 축은 어느 거리에서도 평평(한 축만 평평한 블록).
  edgeOnly: (x, y, c, r) => [Math.round(100 + 0.15 * (c - 180) + (x >= 36 ? 4.7 : 0) + (x >= 44 ? 4.7 : 0)), 60, 60],
};
/** 타일 격자와 맞물린 0.5 m/px 영상: x 26..46, y 36..52 m 는 저대비 무늬 low, 그 밖은 영상 A 무늬(잡음 0). */
function lowContrastImage(low) {
  return makeImage({ minX: -64, minY: -64, maxX: 128, maxY: 128 }, 384, 384, (x, y, c, r) => (
    x >= 26 && x < 46 && y >= 36 && y < 52 ? low(x, y, c, r) : TEX_A(x, y, c, r)));
}
/** 밉 0 타일 (0,0) 에서 블록 (i0 64, j0 32)(x 32..40, y 40..48 m) 내용만 동쪽으로 s px(정수) 옮긴 값으로 바꾼다. */

// 시드 k·7919, k = 1..20(drape.test.mjs 의 SEEDS 와 같은 생성식).
const NOISE_SEEDS = Array.from({ length: 20 }, (_, i) => (i + 1) * 7919);

test('F-363 저대비 사인 블록 + ±2·±3 DN 잡음, 이동 0: 시드 20개 모두 local 0·maxMisalignPx < 1', () => {
  // 수정 전(재적합 이상치의 잔차 ≥ 0.5 만으로 local): 사인 2 DN ±3 DN 에서 시드 55433·87109·118785·142542 의 블록 (64,32) 가
  // 거짓 local(142542 는 maxMisalignPx 1.412 — 어긋남이 없는데 정합 ≤ 1 px 실패), 사인 1 DN ±3 DN 에서도 2개.
  const id = (p) => p;
  const bad = [];
  for (const [amp, noises] of [[2, [2, 3]], [1, [2, 3]]]) {
    const img = lowContrastImage(LOW.sine(amp));
    for (const noise of noises) {
      for (const seed of NOISE_SEEDS) {
        const m = measureDrapeAlignment(img, warpedTile(img, 0, 0, 0, id, { noise, seed }));
        assert.equal(m.status, 'measured', `사인 ${amp} DN ±${noise} seed ${seed}: ${m.reason}`);
        const local = m.blocks.filter((b) => b.local).map(({ i0, j0, dx, dy }) => [i0, j0, dx, dy]);
        if (local.length || !(m.maxMisalignPx < ALIGN_TOLERANCE_PX)) bad.push([amp, noise, seed, m.maxMisalignPx, local]);
      }
    }
  }
  assert.deepEqual(bad, []);
});

/** ±amp DN 균등 잡음(128 중심)만 있는 0.5 m/px 영상, 타일 (0,0) 과 맞물림(drape.test.mjs 에서 복사). */
function noiseImage(n, amp, seed) {
  let s = seed;
  const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 2 ** 32; };
  return makeImage({ minX: 0, minY: 0, maxX: 64, maxY: 64 }, n, n, () => [0, 1, 2].map(() => 128 + Math.round((rnd() * 2 - 1) * amp)));
}

test('F-363 ±1 DN 잡음만 있는 128² 영상, 이동 0, 밉 0~2: local 0, 측정되면 maxMisalignPx < 1(측정 불가는 허용)', () => {
  // 감독 재현 입력(seed 7919 밉 2: 보고된 거짓 실패 3.644 px)과 같은 생성식. 무늬가 없어 높은 밉은 비용면이 평평해 측정 불가일 수 있다.
  const img = noiseImage(128, 1, 7919);
  for (let mip = 0; mip <= 2; mip++) {
    for (const tile of [buildDrapeTile(img, 0, 0, mip), warpedTile(img, 0, 0, mip, (p) => p)]) {
      const m = measureDrapeAlignment(img, tile);
      assert.deepEqual(m.blocks.filter((b) => b.local).map(({ i0, j0 }) => [i0, j0]), [], `밉 ${mip}`);
      if (m.status === 'measured') assert.ok(m.maxMisalignPx < ALIGN_TOLERANCE_PX, `밉 ${mip}: ${m.maxMisalignPx}`);
      else assert.ok(Number.isNaN(m.maxMisalignPx), `밉 ${mip}`);
    }
  }
});

test('F-359 검토 #2 음성 대조(짝 검정): 감독 F-363 입력과 사인 2 DN ±3 DN 시드 21~40, 이동 0 — local 0·maxMisalignPx < 1', () => {
  // 잔차 경로의 유의성을 같은 표본 픽셀 짝 검정으로 바꾼 뒤에도 잡음 최소를 국소 어긋남으로 보고하지 않는다.
  const id = (p) => p;
  const runs = [];
  const nimg = noiseImage(128, 3, 104729);
  for (const seed of [7919, 79190]) runs.push([`noiseImage(128,±3,104729) 밉 2 ±1 seed ${seed}`, nimg, warpedTile(nimg, 0, 0, 2, id, { noise: 1, seed })]);
  const s1 = lowContrastImage(LOW.sine(1));
  runs.push(['사인 1 DN 밉 1 ±3 seed 87109', s1, warpedTile(s1, 0, 0, 1, id, { noise: 3, seed: 87109 })]);
  const s2 = lowContrastImage(LOW.sine(2));
  for (let k = 21; k <= 40; k++) runs.push([`사인 2 DN ±3 seed ${k * 7919}`, s2, warpedTile(s2, 0, 0, 0, id, { noise: 3, seed: k * 7919 })]);
  const bad = [];
  for (const [at, img, tile] of runs) {
    const m = measureDrapeAlignment(img, tile);
    const local = m.blocks.filter((b) => b.local).map(({ i0, j0, dx, dy }) => [i0, j0, dx, dy]);
    if (m.status !== 'measured' || local.length || !(m.maxMisalignPx < ALIGN_TOLERANCE_PX)) bad.push([at, m.status, m.maxMisalignPx, local]);
  }
  assert.deepEqual(bad, []);
});
