// F-390 ⑥: 짝 검정 경로에서 예측 위치를 잴 수 없는(t === null) local 블록은 unexcludedPx 를 0('이동 없음')이 아니라 NaN 으로 두고,
// 그런 블록 수를 출력 필드 unmeasuredLocalBlocks 로 드러낸다. NaN 은 unexcludedMaxPx·maxMisalignPx 상한을 오염시키지 않는다.
// 호출부 t === null 은 공개 API 로 도달하지 않는다(decisions/0044 T15.1): 예측 위치 표본이 minN 미만인 블록은 그 전에 settle 의 search 가
// null 을 내 짝 검정 경로가 아니라 `out !== false` 경로로 가고, 그 local 은 unexcludedPx 를 대입받지 않는다(F-393 ①: 집계가 미측정으로 센다,
// 끝에서 끝까지 사례는 drape_unmeasured_summary.test.mjs). 그래서 여기서는 집계(unexcludedSummary)를 직접 시험하고, 실제 측정 출력에서는
// 필드가 있고 NaN 이 상한을 오염시키지 않는지, 측정 불가 출력에서는 NaN 인지 본다.
// 도우미(makeImage·boxMean·warpedTile·HASH·TEX_A·LOW·lowContrastImage)는 drape_farown.test.mjs 에서 그대로 복사했다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ALIGN_TOLERANCE_PX, TERRAIN_TILE_SIZE_M, tileBounds } from '../../../contracts/tower_assets/index.mjs';
import { measureDrapeAlignment, drapeTileSize, unexcludedSummary } from './index.mjs';

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
 * sameNoise 면 픽셀마다 잡음 하나를 세 채널에 똑같이 더한다(채널 상관 잡음, F-376).
 * coverage.bounds 는 넣지 않는다(피복 범위는 mask 로만 알 수 있다).
 */
function warpedTile(img, tx, ty, mip, warp, { keep = () => true, noise = 0, seed = 12345, sameNoise = false } = {}) {
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
      const e0 = sameNoise && noise ? Math.round((rnd() * 2 - 1) * noise) : 0;
      for (let k = 0; k < 3; k++) {
        const e = sameNoise ? e0 : noise ? Math.round((rnd() * 2 - 1) * noise) : 0;
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


test('F-390 집계: unexcludedPx NaN·없음 인 local 블록은 수만 세고 상한은 오염시키지 않는다', () => {
  const blocks = [
    { local: true, unexcludedPx: NaN },
    { local: true, unexcludedPx: NaN },
    { local: true, unexcludedPx: 1.25 },
    { local: true, unexcludedPx: 0.5 },
    { local: true }, // settle 경로 local: unexcludedPx 없음 → 미측정으로 센다(F-393 ①, 결정 0044 T15.R3)
    { local: false, undecided: true, unexcludedPx: NaN }, // local 이 아니면 세지 않는다
  ];
  const s = unexcludedSummary(blocks);
  assert.equal(s.unmeasuredLocalBlocks, 3);
  assert.equal(s.unexcludedMaxPx, 1.25);
  assert.ok(Number.isFinite(s.unexcludedMaxPx));
});

test('F-390 집계: NaN 블록뿐이면 상한 0(NaN 아님), 수는 그대로', () => {
  const s = unexcludedSummary([{ local: true, unexcludedPx: NaN }]);
  assert.equal(s.unmeasuredLocalBlocks, 1);
  assert.equal(s.unexcludedMaxPx, 0);
});

test('F-390 집계: 0 은 잰 결과(이동 없음)라 unmeasured 로 세지 않는다', () => {
  const s = unexcludedSummary([{ local: true, unexcludedPx: 0 }, { local: true, unexcludedPx: 0.75 }]);
  assert.equal(s.unmeasuredLocalBlocks, 0);
  assert.equal(s.unexcludedMaxPx, 0.75);
});

test('F-390 출력: 측정된 타일은 unmeasuredLocalBlocks 를 정수로 낸다(이 입력엔 배제 못 한 이동량을 재지 않은 local 블록이 없음 → 0)', () => {
  const img = lowContrastImage(LOW.sine(2.5));
  const g = -0.375, e = -1.125;
  const warp = (p) => ({ x: p.x + (p.x >= 32 && p.x < 40 && p.y >= 40 && p.y < 48 ? g + e : g) * 0.5, y: p.y });
  const m = measureDrapeAlignment(img, warpedTile(img, 0, 0, 0, warp, { noise: 2, seed: 2142545 }));
  assert.equal(m.status, 'measured');
  assert.ok('unmeasuredLocalBlocks' in m);
  assert.equal(m.unmeasuredLocalBlocks, 0);
  assert.ok(Number.isFinite(m.maxMisalignPx) && Number.isFinite(m.unexcludedMaxPx));
});

test('F-390 출력: 측정 불가 타일은 unmeasuredLocalBlocks 도 NaN', () => {
  const img = makeImage({ minX: -64, minY: -64, maxX: 128, maxY: 128 }, 384, 384, () => [128, 128, 128]);
  const m = measureDrapeAlignment(img, warpedTile(img, 0, 0, 0, (p) => p));
  assert.equal(m.status, 'unmeasurable');
  assert.ok(Number.isNaN(m.unmeasuredLocalBlocks));
});
