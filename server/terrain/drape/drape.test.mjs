// T14.2 드레이프 시험: 크기(바이트)·박스 필터·좌표 정합·피복(coverage)·결정성.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  ALIGN_TOLERANCE_PX, DRAPE_MIP_COUNT, TowerAssetError, TERRAIN_TILE_SIZE_M, tileBounds,
} from '../../../contracts/tower_assets/index.mjs';
import * as stubs from '../../../contracts/tower_assets/stubs.mjs';
import {
  buildDrapeTile, measureDrapeAlignment, drapeTileSize, tilePixelToEnu, enuToTilePixel, MAX_DRAPE_TILE_PX,
  ALIGN_BLOCKS_PER_SIDE, ALIGN_MIN_BLOCK_PX, drapeTableBuildCount,
} from './index.mjs';

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

// 영상 A: 0.5 m/px, 타일 격자와 반 픽셀(0.25 m) 어긋남. 8 m 격자 무늬 + 완만한 물결 + 픽셀 잡음(주기성 깨기).
const A_BOUNDS = { minX: -64.25, minY: -64.25, maxX: 127.75, maxY: 127.75 };
const imgA = makeImage(A_BOUNDS, 384, 384, (x, y, c, r) => [
  ((Math.floor(x / 8) + Math.floor(y / 8)) & 1) ? 200 : 40,
  Math.round(128 + 100 * Math.sin(x * 0.07) * Math.cos(y * 0.05)),
  (((c * 73856093) ^ (r * 19349663)) >>> 0) % 256,
]);

// 영상 F: 검은 바탕에 2×2 픽셀(1 m²) 흰 특징점. 중심 ENU 는 픽셀 모서리 교점.
const FEATURES = [[150, 200], [200, 240], [240, 170], [180, 150]]; // [열, 행] 왼쪽 위 픽셀
const featureEnu = FEATURES.map(([c, r]) => ({ x: A_BOUNDS.minX + (c + 1) * 0.5, y: A_BOUNDS.maxY - (r + 1) * 0.5 }));
const featSet = new Set();
for (const [c, r] of FEATURES) for (const [dc, dr] of [[0, 0], [1, 0], [0, 1], [1, 1]]) featSet.add(`${c + dc},${r + dr}`);
const imgF = makeImage(A_BOUNDS, 384, 384, (x, y, c, r) => (featSet.has(`${c},${r}`) ? [255, 255, 255] : [0, 0, 0]));

// 영상 B: 1 m/px, x 32..96 만 덮음 → 타일 (0,0) 은 서쪽 절반이 영상 밖.
const B_BOUNDS = { minX: 32, minY: -64, maxX: 96, maxY: 128 };
const imgB = makeImage(B_BOUNDS, 64, 192, (x, y) => [Math.floor(x) & 255, Math.floor(y + 64) & 255, 77]);

// 영상 C: 타일 (0,0) 과 정확히 맞물린 0.5 m/px 영상(박스 필터 검산용).
const imgC = makeImage({ minX: 0, minY: 0, maxX: 64, maxY: 64 }, 128, 128, (x, y, c, r) => [
  (c * 7 + r * 3) & 255, ((c * c + r) * 13) & 255, (c ^ r) & 255,
]);

test('stubs 서명대로 export', () => {
  // 계약 스텁과 같은 이름, 서명 (image, tx, ty, mip) / (image, tile).
  assert.equal(typeof stubs.buildDrapeTile, 'function');
  assert.equal(typeof stubs.measureDrapeAlignment, 'function');
  assert.equal(buildDrapeTile.length, 4);
  assert.equal(measureDrapeAlignment.length, 2);
  assert.equal(DRAPE_MIP_COUNT, 4);
});

test('단계별 크기·바이트(리터럴)', () => {
  const sizesA = [0, 1, 2, 3].map((m) => buildDrapeTile(imgA, 0, 0, m)).map((t) => [t.width, t.height, t.rgb.byteLength]);
  // 0.5 m/px → 64 m = 128 px, 이후 절반: 128²·3, 64²·3, 32²·3, 16²·3.
  assert.deepEqual(sizesA, [[128, 128, 49152], [64, 64, 12288], [32, 32, 3072], [16, 16, 768]]);
  const sizesB = [0, 1, 2, 3].map((m) => buildDrapeTile(imgB, 1, 0, m)).map((t) => [t.width, t.height, t.rgb.byteLength]);
  // 1 m/px → 64, 32, 16, 8 px.
  assert.deepEqual(sizesB, [[64, 64, 12288], [32, 32, 3072], [16, 16, 768], [8, 8, 192]]);
  assert.deepEqual(drapeTileSize(imgA, 3), { width: 16, height: 16 });
  const t = buildDrapeTile(imgA, 0, 0, 2);
  assert.deepEqual([t.tx, t.ty, t.mip], [0, 0, 2]);
  assert.equal(t.coverage.mask.byteLength, 1024);
});

test('박스 필터: 맞물린 영상에서 밉 k 픽셀 = 원본 2^k 블록 평균 반올림', () => {
  for (let mip = 0; mip < 4; mip++) {
    const t = buildDrapeTile(imgC, 0, 0, mip);
    const blk = 2 ** mip;
    for (let j = 0; j < t.height; j++) {
      for (let i = 0; i < t.width; i++) {
        for (let k = 0; k < 3; k++) {
          let s = 0;
          for (let r = j * blk; r < (j + 1) * blk; r++) for (let c = i * blk; c < (i + 1) * blk; c++) s += imgC.rgb[(r * 128 + c) * 3 + k];
          assert.equal(t.rgb[(j * t.width + i) * 3 + k], Math.round(s / (blk * blk)), `mip ${mip} (${i},${j}) ch ${k}`);
        }
      }
    }
    assert.equal(t.coverage.complete, true);
    assert.equal(t.coverage.fraction, 1);
  }
});

test('행은 북 → 남: 첫 행은 타일 북쪽 가장자리', () => {
  // 영상 B 의 G 채널 = floor(y + 64). 타일 (1,0) 첫 행(북, y 63..64) 은 127, 마지막 행(y 0..1) 은 64.
  const t = buildDrapeTile(imgB, 1, 0, 0);
  assert.equal(t.rgb[1], 127);
  assert.equal(t.rgb[((t.height - 1) * t.width) * 3 + 1], 64);
  // 픽셀 ↔ ENU 왕복.
  const p = tilePixelToEnu(t, 10.5, 20.5);
  assert.deepEqual(p, { x: 74.5, y: 43.5 });
  assert.deepEqual(enuToTilePixel(t, p.x, p.y), { i: 10.5, j: 20.5 });
});

test('좌표 정합: 특징점 무게중심이 원본 ENU 와 1 px 이내 (밉 0..3)', () => {
  const errs = [];
  for (let mip = 0; mip < 4; mip++) {
    const t = buildDrapeTile(imgF, 0, 0, mip);
    const pxM = 64 / t.width;
    let worst = 0;
    for (const f of featureEnu) {
      // 특징점 근방(±12 m) 의 최댓값 픽셀을 찾고, 그 주변 ±2 px 무게중심.
      const e = enuToTilePixel(t, f.x, f.y);
      const R = Math.ceil(12 / pxM);
      let bi = -1, bj = -1, bv = -1;
      for (let j = Math.max(0, Math.floor(e.j) - R); j <= Math.min(t.height - 1, Math.floor(e.j) + R); j++) {
        for (let i = Math.max(0, Math.floor(e.i) - R); i <= Math.min(t.width - 1, Math.floor(e.i) + R); i++) {
          const v = t.rgb[(j * t.width + i) * 3];
          if (v > bv) { bv = v; bi = i; bj = j; }
        }
      }
      assert.ok(bv > 0, '특징점이 보여야 한다');
      let sw = 0, si = 0, sj = 0;
      for (let j = Math.max(0, bj - 2); j <= Math.min(t.height - 1, bj + 2); j++) {
        for (let i = Math.max(0, bi - 2); i <= Math.min(t.width - 1, bi + 2); i++) {
          const v = t.rgb[(j * t.width + i) * 3];
          sw += v; si += v * (i + 0.5); sj += v * (j + 0.5);
        }
      }
      const c = tilePixelToEnu(t, si / sw, sj / sw);
      worst = Math.max(worst, Math.hypot(c.x - f.x, c.y - f.y) / pxM);
    }
    errs.push(worst);
    assert.ok(worst <= ALIGN_TOLERANCE_PX, `mip ${mip} 특징점 오차 ${worst} px`);
  }
  // 실측 고정(회귀용): 밉별 최대 특징점 오차(타일 px). 밉이 오를수록 uint8 반올림·흐림으로 조금 커진다.
  assert.deepEqual(errs.map((e) => Math.round(e * 1e4) / 1e4), [0, 0.0014, 0.1768, 0.4419]);
});

test('좌표 정합: measureDrapeAlignment 는 정상 타일에서 1 px 이내, 어긋난 타일은 검출', () => {
  for (let mip = 0; mip < 4; mip++) {
    for (const [tx, ty] of [[0, 0], [-1, -1], [1, 1]]) {
      const m = measureDrapeAlignment(imgA, buildDrapeTile(imgA, tx, ty, mip));
      assert.ok(m.maxMisalignPx <= ALIGN_TOLERANCE_PX, `(${tx},${ty}) mip ${mip}: ${m.maxMisalignPx}`);
      assert.equal(m.status, 'measured');
      assert.equal(m.maxMisalignPx, 0);
      assert.deepEqual([m.edgeMaxPx, m.blockMaxPx, m.scaleX, m.scaleY, m.rotationRad], [0, 0, 0, 0, 0]);
      assert.ok(m.rms < 0.6, `rms ${m.rms}`);
    }
  }
  // 영상 범위를 동쪽으로 1 m 잘못 둔 채 만든 타일 → 0.5 m/px 밉 0 에서 2 px 어긋남.
  const wrong = { ...imgA, bounds: { ...A_BOUNDS, minX: A_BOUNDS.minX + 1, maxX: A_BOUNDS.maxX + 1 } };
  const m0 = measureDrapeAlignment(imgA, buildDrapeTile(wrong, 0, 0, 0));
  assert.deepEqual([m0.dxPx, m0.dyPx, m0.maxMisalignPx], [-2, 0, 2]);
  assert.ok(m0.maxMisalignPx > ALIGN_TOLERANCE_PX);
  // 행을 남 → 북으로 뒤집은 타일은 rms 가 크게 나빠진다.
  const t = buildDrapeTile(imgA, 0, 0, 0);
  const flipped = { ...t, rgb: new Uint8Array(t.rgb.length) };
  for (let j = 0; j < t.height; j++) flipped.rgb.set(t.rgb.subarray(j * t.width * 3, (j + 1) * t.width * 3), (t.height - 1 - j) * t.width * 3);
  assert.ok(measureDrapeAlignment(imgA, flipped).rms > 20);
});

/** 영상 bounds 를 영상 중심 기준으로 f 만큼 늘린 영상(내용은 그대로) → 그 영상으로 만든 타일은 축척이 1+f 배 틀린다. */
function scaledImage(img, f) {
  const b = img.bounds;
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const hx = (b.maxX - b.minX) / 2 * (1 + f), hy = (b.maxY - b.minY) / 2 * (1 + f);
  return { ...img, bounds: { minX: cx - hx, maxX: cx + hx, minY: cy - hy, maxY: cy + hy } };
}

test('좌표 정합: 축척 오류(전역 이동 0) 타일을 블록 이동량·가장자리 변위로 검출', () => {
  // 영상 A 중심 (31.75, 31.75). 타일 (1,0) 의 ENU 는 중심에서 x 32.25..96.25 m, y −31.75..32.25 m 떨어져 있다.
  // 축척 f 의 실제 변위(타일 px, 0.5 m/px) = f·거리/0.5: 2% → x 1.29..3.85 px, 4% → x 2.57..7.70 px.
  const fx2 = 0.02 * 96.25 / 0.5, fy2 = 0.02 * 32.25 / 0.5;
  assert.ok(Math.hypot(fx2, fy2) >= 2); // 해석값: 모서리 실제 변위 4.06 px
  const m2 = measureDrapeAlignment(imgA, buildDrapeTile(scaledImage(imgA, 0.02), 1, 0, 0));
  assert.ok(m2.maxMisalignPx >= 2, `2%: ${m2.maxMisalignPx}`);
  assert.ok(m2.maxMisalignPx > ALIGN_TOLERANCE_PX);
  assert.ok(m2.scaleX < 0 && m2.scaleY < 0, `축척 기울기 ${m2.scaleX}, ${m2.scaleY}`);
  const m4 = measureDrapeAlignment(imgA, buildDrapeTile(scaledImage(imgA, 0.04), 1, 0, 0));
  assert.ok(m4.maxMisalignPx >= 4, `4%: ${m4.maxMisalignPx}`);
  assert.ok(m4.maxMisalignPx > m2.maxMisalignPx);
  // 중심과 거의 겹친 타일 (0,0): 2% 의 모서리 실제 변위 = hypot(0.02·32.25/0.5, 0.02·32.25/0.5) ≈ 1.82 px → 1 px 초과로 실패.
  const c2 = measureDrapeAlignment(imgA, buildDrapeTile(scaledImage(imgA, 0.02), 0, 0, 0));
  assert.ok(c2.maxMisalignPx > ALIGN_TOLERANCE_PX, `(0,0) 2%: ${c2.maxMisalignPx}`);
  // 전역 이동량은 축척 오류를 거의 못 본다(중심 근처 타일에서 0 근처) — 블록 측정이 필요한 이유.
  assert.ok(Math.hypot(c2.dxPx, c2.dyPx) < ALIGN_TOLERANCE_PX, `전역 ${c2.dxPx}, ${c2.dyPx}`);
  // 블록 수: 128 px 타일을 축마다 8개로 → 16 px 블록 8×8. 16 px 타일(밉 3)은 4 px 블록 4×4(블록 한 변 ∝ 타일 크기).
  assert.equal(ALIGN_BLOCKS_PER_SIDE, 8);
  assert.equal(c2.blocks.length, ALIGN_BLOCKS_PER_SIDE ** 2);
  assert.deepEqual(c2.blockPx, { width: 16, height: 16 });
  const c3 = measureDrapeAlignment(imgA, buildDrapeTile(imgA, 0, 0, 3));
  assert.deepEqual([c3.blockPx, c3.blocks.length], [{ width: ALIGN_MIN_BLOCK_PX, height: ALIGN_MIN_BLOCK_PX }, 16]);
  // 정상 타일은 블록·가장자리 모두 0.
  const ok = measureDrapeAlignment(imgA, buildDrapeTile(imgA, 1, 0, 0));
  assert.deepEqual([ok.maxMisalignPx, ok.blockMaxPx, ok.edgeMaxPx], [0, 0, 0]);
});

// ── F-317: 완전 아핀(회전·축척) 정합 모형 ──
// 영상 A 중심(31.75, 31.75) 기준 왜곡. warp(p) = 타일 ENU 점 p 에 실제로 담긴 원본 영상 점.
const A_CENTER = { x: 31.75, y: 31.75 };
const rotationWarp = (deg) => {
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  return (p) => ({
    x: A_CENTER.x + c * (p.x - A_CENTER.x) - s * (p.y - A_CENTER.y),
    y: A_CENTER.y + s * (p.x - A_CENTER.x) + c * (p.y - A_CENTER.y),
  });
};
// scaledImage(img, f) 로 만든 타일의 내용: 원본 점 = 중심 + (p − 중심)/(1+f).
const scaleWarp = (f) => (p) => ({ x: A_CENTER.x + (p.x - A_CENTER.x) / (1 + f), y: A_CENTER.y + (p.y - A_CENTER.y) / (1 + f) });

/** 해석값: 타일 네 모서리(타일 가장자리 꼭짓점)의 실제 변위 최댓값(타일 px). */
function trueCornerPx(tile, warp) {
  const tb = tileBounds(tile.tx, tile.ty), pw = TERRAIN_TILE_SIZE_M / tile.width;
  let m = 0;
  for (const x of [tb.minX, tb.maxX]) {
    for (const y of [tb.minY, tb.maxY]) { const q = warp({ x, y }); m = Math.max(m, Math.hypot(q.x - x, q.y - y) / pw); }
  }
  return m;
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
 * keep(i, j) 가 false 인 픽셀은 영상 밖처럼 비운다(mask 0). noise > 0 이면 채널마다 결정적 ±noise 균등 잡음을 더한다.
 */
function warpedTile(img, tx, ty, mip, warp, { keep = () => true, noise = 0 } = {}) {
  let seed = 12345;
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

test('F-317 회전: 1° 타일 (1,1) 밉 0~2 는 실제 > 1 px → 보고 > 1 px, 해석값 ±0.15 px, 회전 sin θ ±0.002', () => {
  const deg = 1, warp = rotationWarp(deg);
  const got = [];
  for (let mip = 0; mip <= 2; mip++) {
    const t = warpedTile(imgA, 1, 1, mip, warp);
    const truth = trueCornerPx(t, warp);
    const m = measureDrapeAlignment(imgA, t);
    got.push([mip, truth, m.maxMisalignPx]);
    assert.equal(m.status, 'measured');
    assert.ok(truth > ALIGN_TOLERANCE_PX, `mip ${mip} 실제 ${truth}`);
    assert.ok(m.maxMisalignPx > ALIGN_TOLERANCE_PX, `mip ${mip}: 보고 ${m.maxMisalignPx} (실제 ${truth})`);
    assert.ok(Math.abs(m.edgeMaxPx - truth) <= 0.15, `mip ${mip}: edge ${m.edgeMaxPx} vs 해석 ${truth}`);
    assert.ok(Math.abs(m.maxMisalignPx - truth) <= 0.15, `mip ${mip}: max ${m.maxMisalignPx} vs 해석 ${truth}`);
    // 순수 회전: kxy = sin θ, kyx = −sin θ, 축척 0.
    assert.ok(Math.abs(m.rotationRad - Math.sin((deg * Math.PI) / 180)) <= 0.002, `mip ${mip} 회전 ${m.rotationRad}`);
    assert.ok(Math.abs(m.scaleX) <= 0.002 && Math.abs(m.scaleY) <= 0.002, `mip ${mip} 축척 ${m.scaleX}, ${m.scaleY}`);
  }
  // 해석값(타일 px): 모서리 (128,128) 의 중심 거리 √2·96.25 m × 2 sin 0.5° ≈ 2.376 m → 0.5·2^mip m/px 로 나눔(4.751, 2.376, 1.188).
  const chord = Math.SQRT2 * (128 - A_CENTER.x) * 2 * Math.sin((deg * Math.PI) / 360);
  for (const [mip, t] of got) assert.ok(Math.abs(t - chord / (0.5 * 2 ** mip)) < 1e-9, `mip ${mip} 해석 ${t}`);
});

test('F-317 회전: 0.5° 타일 (0,0) 밉 0 은 실제 0.80 px → 과대 보고 없이 ≤ 실제 + 0.3 px(거짓 실패 없음)', () => {
  const warp = rotationWarp(0.5);
  const t = warpedTile(imgA, 0, 0, 0, warp);
  const truth = trueCornerPx(t, warp);
  // 해석값: 가장 먼 모서리 (64,64) 의 중심 거리 √2·32.25 m × 2 sin 0.25° / 0.5 m/px ≈ 0.796 px.
  assert.ok(Math.abs(truth - Math.SQRT2 * (64 - A_CENTER.x) * 2 * Math.sin(Math.PI / 720) / 0.5) < 1e-9, `해석 ${truth}`);
  const m = measureDrapeAlignment(imgA, t);
  assert.equal(m.status, 'measured');
  assert.ok(m.maxMisalignPx <= truth + 0.3, `보고 ${m.maxMisalignPx} > 실제 ${truth} + 0.3`);
  assert.ok(Math.abs(m.maxMisalignPx - truth) <= 0.15, `보고 ${m.maxMisalignPx} vs 해석 ${truth}`);
  assert.ok(m.maxMisalignPx <= ALIGN_TOLERANCE_PX);
});

test('F-317 축척: 해석값 scale = −f/(1+f) ±0.002, edgeMaxPx ±0.15, 4% 타일 (-1,-1) 밉 3 은 > 1 px', () => {
  for (const f of [0.02, 0.04]) {
    const warp = scaleWarp(f);
    const t = buildDrapeTile(scaledImage(imgA, f), 1, 0, 0);
    const m = measureDrapeAlignment(imgA, t);
    const truth = trueCornerPx(t, warp);
    assert.equal(m.status, 'measured');
    assert.ok(Math.abs(m.scaleX + f / (1 + f)) <= 0.002, `${f}: scaleX ${m.scaleX} vs ${-f / (1 + f)}`);
    assert.ok(Math.abs(m.scaleY + f / (1 + f)) <= 0.002, `${f}: scaleY ${m.scaleY} vs ${-f / (1 + f)}`);
    assert.ok(Math.abs(m.rotationRad) <= 0.002, `${f}: 회전 ${m.rotationRad}`);
    assert.ok(Math.abs(m.edgeMaxPx - truth) <= 0.15, `${f}: edge ${m.edgeMaxPx} vs 해석 ${truth}`);
    assert.ok(Math.abs(m.maxMisalignPx - truth) <= 0.15, `${f}: max ${m.maxMisalignPx} vs 해석 ${truth}`);
  }
  // 밉 3: 4% 타일 (-1,-1) 은 15 px(4.27 m/px), 블록 5 px 3×3. 실제 모서리 변위 1.22 px.
  const warp = scaleWarp(0.04);
  const t3 = buildDrapeTile(scaledImage(imgA, 0.04), -1, -1, 3);
  const truth3 = trueCornerPx(t3, warp);
  assert.ok(truth3 > ALIGN_TOLERANCE_PX, `해석 ${truth3}`);
  const m3 = measureDrapeAlignment(imgA, t3);
  assert.equal(m3.status, 'measured');
  assert.ok(m3.maxMisalignPx > ALIGN_TOLERANCE_PX, `밉 3: 보고 ${m3.maxMisalignPx} (실제 ${truth3})`);
  assert.ok(Math.abs(m3.maxMisalignPx - truth3) <= 0.15, `밉 3: ${m3.maxMisalignPx} vs 해석 ${truth3}`);
  assert.ok(m3.scaleX < 0 && m3.scaleY < 0);
});

test('F-317 측정 불가: 블록이 아핀 하한 미만이면 0 이 아니라 status unmeasurable·NaN', () => {
  // 16 m/px 영상 → 밉 0 타일 4 px → 블록 1개.
  const coarse = makeImage({ minX: 0, minY: 0, maxX: 64, maxY: 64 }, 4, 4, (x, y, c, r) => [c * 60, r * 60, (c * r * 37) & 255]);
  const m = measureDrapeAlignment(coarse, buildDrapeTile(coarse, 0, 0, 0));
  assert.equal(m.status, 'unmeasurable');
  assert.ok(Number.isNaN(m.maxMisalignPx) && Number.isNaN(m.edgeMaxPx) && Number.isNaN(m.scaleX));
  assert.equal(m.maxMisalignPx <= ALIGN_TOLERANCE_PX, false); // 허용 판정을 통과하지 못한다.
  assert.match(m.reason, /블록/);
  // 서쪽 절반이 영상 밖인 8 px 타일(영상 B 밉 3): 피복된 블록이 한 열(2개)뿐 → 측정 불가.
  const half = measureDrapeAlignment(imgB, buildDrapeTile(imgB, 0, 0, 3));
  assert.equal(half.status, 'unmeasurable');
  assert.equal(half.blocks.length, 2);
  // 완전 피복 8 px 타일(1 m/px 영상 밉 3)은 블록 2×2 로 잰다.
  const img1 = makeImage({ minX: 0, minY: 0, maxX: 64, maxY: 64 }, 64, 64, (x, y, c, r) => [
    (c * 7 + r * 3) & 255, ((c * c + r) * 13) & 255, (c ^ r) & 255,
  ]);
  const full = measureDrapeAlignment(img1, buildDrapeTile(img1, 0, 0, 3));
  assert.deepEqual([full.status, full.blocks.length, full.maxMisalignPx], ['measured', 4, 0]);
});

// ── F-323: 여분 없는 아핀 적합·모서리 외삽·평평한 비용면 ──
// 타일 (0,0) 밉 1 = 64 px, 8 px 블록 8×8. 남동 모서리 L 자 3블록만 피복 / 남동 3×3 블록 피복.
const SE3 = (i, j) => (i >= 48 && j >= 56) || (i >= 56 && j >= 48);
const SE9 = (i, j) => i >= 40 && j >= 40;

test('F-323 모서리만 피복: 블록 3개 정확 적합은 측정 불가, 6개 이상이면 보고 ≤ 실제 + 0.3 px', () => {
  const warp = rotationWarp(0.3);
  const t3 = warpedTile(imgA, 0, 0, 1, warp, { keep: SE3 });
  const truth = trueCornerPx(t3, warp);
  // 해석값: 가장 먼 모서리 (64,64) 의 중심 거리 √2·32.25 m × 2 sin 0.15° / 1 m/px ≈ 0.239 px.
  assert.ok(Math.abs(truth - Math.SQRT2 * (64 - A_CENTER.x) * 2 * Math.sin((0.15 * Math.PI) / 180)) < 1e-9, `해석 ${truth}`);
  const m3 = measureDrapeAlignment(imgA, t3);
  assert.equal(m3.blocks.length, 3);
  assert.equal(m3.status, 'unmeasurable'); // 수정 전: measured, 정확 적합 외삽으로 부풀린 값
  assert.ok(Number.isNaN(m3.maxMisalignPx));
  assert.match(m3.reason, /블록 3개/);
  const t9 = warpedTile(imgA, 0, 0, 1, warp, { keep: SE9 });
  const m9 = measureDrapeAlignment(imgA, t9);
  assert.deepEqual([m9.status, m9.blocks.length], ['measured', 9]);
  assert.ok(m9.maxMisalignPx <= truth + 0.3, `보고 ${m9.maxMisalignPx} > 실제 ${truth} + 0.3`);
});

test('F-323 ±20 잡음(왜곡 없음): 완전 피복 보고 < 0.3 px, 3블록 피복은 측정 불가', () => {
  const id = (p) => p;
  const full = measureDrapeAlignment(imgA, warpedTile(imgA, 0, 0, 1, id, { noise: 20 }));
  assert.equal(full.status, 'measured');
  assert.ok(full.maxMisalignPx < 0.3, `완전 피복 ${full.maxMisalignPx}`);
  const se9 = measureDrapeAlignment(imgA, warpedTile(imgA, 0, 0, 1, id, { keep: SE9, noise: 20 }));
  assert.equal(se9.status, 'measured');
  assert.ok(se9.maxMisalignPx < 0.3, `3×3 피복 ${se9.maxMisalignPx}`);
  const se3 = measureDrapeAlignment(imgA, warpedTile(imgA, 0, 0, 1, id, { keep: SE3, noise: 20 }));
  assert.ok(se3.status === 'unmeasurable' || se3.maxMisalignPx < 0.3, `3블록 ${se3.status} ${se3.maxMisalignPx}`);
  assert.equal(se3.status, 'unmeasurable');
});

test('F-323 평평한 비용면: 균일한 색·한 방향 줄무늬 영상은 0 px 가 아니라 측정 불가', () => {
  const uni = makeImage({ minX: 0, minY: 0, maxX: 64, maxY: 64 }, 128, 128, () => [90, 120, 30]);
  const mu = measureDrapeAlignment(uni, buildDrapeTile(uni, 0, 0, 0));
  assert.equal(mu.status, 'unmeasurable');
  assert.ok(Number.isNaN(mu.maxMisalignPx));
  assert.match(mu.reason, /평평/);
  // x 로만 변하는 줄무늬: y 이동량을 구별할 수 없다.
  const stripes = makeImage({ minX: 0, minY: 0, maxX: 64, maxY: 64 }, 128, 128, (x, y, c) => [(c * 37) & 255, (c * c) & 255, 50]);
  const ms = measureDrapeAlignment(stripes, buildDrapeTile(stripes, 0, 0, 0));
  assert.equal(ms.status, 'unmeasurable');
});

test('F-319 ⑤ 성능: 누적 합 표는 영상당 1회, 1024² 타일 측정은 수 초 안', () => {
  const N = 1024;
  const big = makeImage({ minX: 0, minY: 0, maxX: 64, maxY: 64 }, N, N, (x, y, c, r) => [
    ((c >> 4) + (r >> 4)) & 1 ? 200 : 40, 128 + Math.round(100 * Math.sin(c * 0.05) * Math.cos(r * 0.037)),
    (((c * 73856093) ^ (r * 19349663)) >>> 0) % 256,
  ]);
  const t0 = buildDrapeTile(big, 0, 0, 0);
  assert.equal(t0.width, 1024);
  const before = drapeTableBuildCount();
  const start = performance.now();
  const m = measureDrapeAlignment(big, t0);
  const ms = performance.now() - start;
  assert.ok(ms < 5000, `1024² 측정 ${ms.toFixed(0)} ms`);
  assert.deepEqual([m.status, m.maxMisalignPx], ['measured', 0]);
  // 같은 영상(및 bounds 만 바꾼 사본)으로 다시 재도 표를 다시 만들지 않는다.
  measureDrapeAlignment(big, buildDrapeTile(big, 0, 0, 2));
  measureDrapeAlignment({ ...big, bounds: { ...big.bounds } }, t0);
  assert.equal(drapeTableBuildCount() - before, 1);
  // rgb 를 고치면 낡은 표를 쓰지 않고 다시 만든다.
  big.rgb[0] ^= 0xff;
  measureDrapeAlignment(big, buildDrapeTile(big, 0, 0, 3));
  assert.equal(drapeTableBuildCount() - before, 2);
});

test('F-319 ⑥ 겹친 폭이 1e-300 m 처럼 사실상 0 인 빈 타일은 오류', () => {
  // 영상 x 범위 [-64, 1e-300] 은 타일 (0,0) 과 bounds 상으로만 닿고 원본 칸과 양의 면적으로 겹치지 않는다.
  const touching = makeImage({ minX: -64, minY: 0, maxX: 1e-300, maxY: 64 }, 64, 64, () => [9, 9, 9]);
  assert.throws(() => buildDrapeTile(touching, 0, 0, 0), TowerAssetError);
  assert.throws(() => buildDrapeTile(touching, 0, 0, 3), TowerAssetError);
});

test('입력 검증: 타일 한 변 픽셀 상한, tile.tx/ty NaN', () => {
  // 10×10 영상이 0.01 m 범위를 덮으면 밉 0 한 변 = 64000 px → 상한 초과 오류(메모리 폭주 대신).
  const tiny = makeImage({ minX: 0, minY: 0, maxX: 0.01, maxY: 0.01 }, 10, 10, () => [1, 2, 3]);
  assert.throws(() => drapeTileSize(tiny, 0), TowerAssetError);
  assert.throws(() => buildDrapeTile(tiny, 0, 0, 3), TowerAssetError);
  assert.equal(MAX_DRAPE_TILE_PX, 4096);
  // 상한 경계: 64 / 4096 m/px 는 통과.
  const edge = { width: 1, height: 1, rgb: new Uint8Array(3), bounds: { minX: 0, minY: 0, maxX: 64 / 4096, maxY: 64 / 4096 } };
  assert.deepEqual(drapeTileSize(edge, 0), { width: 4096, height: 4096 });
  const t = buildDrapeTile(imgA, 0, 0, 3);
  for (const bad of [{ ...t, tx: NaN }, { ...t, ty: NaN }, { ...t, tx: 0.5 }, { ...t, tx: undefined }]) {
    assert.throws(() => measureDrapeAlignment(imgA, bad), TowerAssetError);
    assert.throws(() => tilePixelToEnu(bad, 0, 0), TowerAssetError);
    assert.throws(() => enuToTilePixel(bad, 0, 0), TowerAssetError);
  }
});

test('영상 밖: 부분 피복은 coverage 로 명시, 밖은 0 으로 두고 꾸미지 않음, 전부 밖이면 오류', () => {
  const t = buildDrapeTile(imgB, 0, 0, 0);
  assert.equal(t.coverage.complete, false);
  assert.equal(t.coverage.fraction, 0.5);
  assert.deepEqual(t.coverage.bounds, { minX: 32, minY: 0, maxX: 64, maxY: 64 });
  for (let j = 0; j < t.height; j++) {
    for (let i = 0; i < t.width; i++) {
      const o = j * t.width + i;
      if (i < 32) {
        assert.equal(t.coverage.mask[o], 0);
        assert.deepEqual([...t.rgb.subarray(o * 3, o * 3 + 3)], [0, 0, 0]);
      } else {
        assert.equal(t.coverage.mask[o], 255);
        assert.equal(t.rgb[o * 3 + 2], 77);
      }
    }
  }
  // 밉 3 (8 m px): 열 0..3 밖, 4..7 안.
  const t3 = buildDrapeTile(imgB, 0, 0, 3);
  assert.deepEqual([...t3.coverage.mask.subarray(0, 8)], [0, 0, 0, 0, 255, 255, 255, 255]);
  assert.equal(t3.coverage.fraction, 0.5);

  // 영상 A 의 타일 (1,1): 동·북 가장자리 0.25 m 가 영상 밖 → 가장자리 픽셀 반 피복, 모서리 1/4.
  const a = buildDrapeTile(imgA, 1, 1, 0);
  assert.equal(a.coverage.fraction, (63.75 / 64) ** 2);
  assert.equal(a.coverage.fraction, 0.9922027587890625);
  assert.equal(a.coverage.mask[0], 128); // 북쪽 첫 행 = 반 피복
  assert.equal(a.coverage.mask[127], 64); // 북동 모서리 = 1/4
  assert.equal(a.coverage.mask[128 * 127 + 127], 128); // 남동 = 동쪽 반 피복
  assert.equal(a.coverage.mask[128 * 127], 255);
  const a3 = buildDrapeTile(imgA, 1, 1, 3);
  assert.equal(a3.coverage.mask[16 * 15 + 15], 239); // 3.75/4 피복 → round(255·0.9375)
  assert.equal(a3.coverage.fraction, 0.9922027587890625);

  assert.throws(() => buildDrapeTile(imgB, 2, 0, 0), TowerAssetError);
  assert.throws(() => buildDrapeTile(imgA, 0, 2, 0), TowerAssetError);
  assert.throws(() => buildDrapeTile(imgA, 0, 0, 4), TowerAssetError);
  assert.throws(() => buildDrapeTile(imgA, 0, 0, -1), TowerAssetError);
  assert.throws(() => buildDrapeTile(imgA, 0.5, 0, 0), TowerAssetError);
  assert.throws(() => buildDrapeTile({ ...imgA, rgb: new Uint8Array(3) }, 0, 0, 0), TowerAssetError);
  assert.throws(() => buildDrapeTile({ ...imgA, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 1 } }, 0, 0, 0), TowerAssetError);
});

test('결정적: 같은 입력 → 같은 바이트', () => {
  const h = (m) => {
    const t = buildDrapeTile(imgA, 0, 0, m);
    return createHash('sha256').update(t.rgb).update(t.coverage.mask).digest('hex').slice(0, 16);
  };
  const first = [0, 1, 2, 3].map(h);
  assert.deepEqual([0, 1, 2, 3].map(h), first);
  assert.deepEqual(first, HASHES);
});

// 실측 고정(회귀용): 밉 0..3 의 rgb+mask sha256 앞 16자.
const HASHES = ['0fae29d8703f8e5e', '5fdc0825c64459be', '175a0aba3df4db8c', '00fcf0fe71e8140a'];
