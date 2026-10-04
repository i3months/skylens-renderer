// T14.2 드레이프 시험: 크기(바이트)·박스 필터·좌표 정합·피복(coverage)·결정성.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  ALIGN_TOLERANCE_PX, DRAPE_MIP_COUNT, TowerAssetError,
} from '../../../contracts/tower_assets/index.mjs';
import * as stubs from '../../../contracts/tower_assets/stubs.mjs';
import {
  buildDrapeTile, measureDrapeAlignment, drapeTileSize, tilePixelToEnu, enuToTilePixel,
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
  // 밉별 최대 특징점 오차(타일 px). 밉이 오를수록 uint8 반올림·흐림으로 조금 커진다.
  assert.deepEqual(errs.map((e) => Math.round(e * 1e4) / 1e4), [0, 0.0014, 0.1768, 0.4419]);
});

test('좌표 정합: measureDrapeAlignment 는 정상 타일에서 1 px 이내, 어긋난 타일은 검출', () => {
  for (let mip = 0; mip < 4; mip++) {
    for (const [tx, ty] of [[0, 0], [-1, -1], [1, 1]]) {
      const m = measureDrapeAlignment(imgA, buildDrapeTile(imgA, tx, ty, mip));
      assert.ok(m.maxMisalignPx <= ALIGN_TOLERANCE_PX, `(${tx},${ty}) mip ${mip}: ${m.maxMisalignPx}`);
      assert.equal(m.maxMisalignPx, 0);
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

const HASHES = ['0fae29d8703f8e5e', '5fdc0825c64459be', '175a0aba3df4db8c', '00fcf0fe71e8140a'];
