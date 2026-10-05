// F-393 ①: 배제 못 한 이동량을 재지 않은 local 블록은 unexcludedSummary 가 미측정(unmeasuredLocalBlocks)으로 센다.
// unexcludedPx 를 대입하는 곳은 짝 검정 경로(t > DRAPE_PAIRED_K 의 걷기 값, t === null 의 NaN)뿐이고, 첫 settle 의 local 과
// 재적합 이상치의 `out !== false` local 은 대입하지 않아 undefined 다. 이전 집계는 undefined 를 미측정으로도 상한으로도 세지 않아
// 측정된 타일의 unmeasuredLocalBlocks 가 늘 0 이었다(호출부 t === null 은 공개 입력으로 도달하지 않음, decisions/0044 T15.1 결정).
// 결정(decisions/0044 T15.R3 결정): 수가 아닌 local 은 '쟀다' 고 보지 않는다 — 모르면 통과가 아니다.
// 끝에서 끝까지 사례: 영상 서쪽 끝이 타일 (0,0) 서쪽 끝(x = 0)과 같고 타일 내용이 x 로 16 % 늘어난 밉 2 타일(32 px, 블록 4 px)에서
// 서쪽 끝 블록 (0,12) 하나만 제자리 내용이다. 그 블록의 아핀 예측 이동량은 약 −0.16·28 m / 2 m = −2.24 px 라 블록 표본 4열 중
// 3열 이상이 영상 밖으로 나가 표본 수가 minN(16 / 2 = 8) 미만 → settle 의 search 가 예측 근처를 못 재고(null) `out !== false` 경로의
// local 이 된다. 수정 전 집계로는 이 타일의 unmeasuredLocalBlocks 가 0 이다.
// 도우미(makeImage·boxMean·warpedTile·HASH·TEX_A)는 drape_unmeasured.test.mjs 의 것을 잡음 없이 줄여 옮겼다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ALIGN_TOLERANCE_PX, TERRAIN_TILE_SIZE_M, tileBounds } from '../../../contracts/tower_assets/index.mjs';
import { isDrapeAligned } from '../../../contracts/controlview/index.mjs';
import { measureDrapeAlignment, drapeTileSize, buildDrapeTile, unexcludedSummary } from './index.mjs';

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

/** warp 로 내용이 틀어진 드레이프 타일(잡음 없음, 픽셀당 4×4 부분 박스). 원본이 영상 밖에 걸친 픽셀은 mask 0. */
function warpedTile(img, tx, ty, mip, warp) {
  const { width, height } = drapeTileSize(img, mip);
  const tb = tileBounds(tx, ty), pw = TERRAIN_TILE_SIZE_M / width, ph = TERRAIN_TILE_SIZE_M / height, n = 4;
  const rgb = new Uint8Array(width * height * 3), mask = new Uint8Array(width * height);
  const acc = new Float64Array(3), sum = new Float64Array(3);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      sum.fill(0);
      let ok = true;
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
      for (let k = 0; k < 3; k++) rgb[o * 3 + k] = Math.max(0, Math.min(255, Math.round(sum[k] / (n * n))));
    }
  }
  return { tx, ty, mip, width, height, rgb, coverage: { mask } };
}

const HASH = (c, r) => (((c * 73856093) ^ (r * 19349663)) >>> 0);
// 8 m 바둑판 + 사인 + 해시 무늬(잡음 0).
const TEX_A = (x, y, c, r) => [
  ((Math.floor(x / 8) + Math.floor(y / 8)) & 1) ? 200 : 40, Math.round(128 + 100 * Math.sin(x * 0.07) * Math.cos(y * 0.05)), HASH(c, r) % 256,
];

test('집계: unexcludedPx 가 없는 local 블록 하나 → unmeasuredLocalBlocks 1, 상한 0', () => {
  assert.deepEqual(unexcludedSummary([{ local: true }]), { unexcludedMaxPx: 0, unmeasuredLocalBlocks: 1 });
});

test('집계: 수인 local 블록은 상한에 반영하고 미측정으로 세지 않는다(0 은 잰 결과)', () => {
  assert.deepEqual(
    unexcludedSummary([{ local: true, unexcludedPx: 1.25 }, { local: true, unexcludedPx: 0.5 }, { local: true, unexcludedPx: 0 }]),
    { unexcludedMaxPx: 1.25, unmeasuredLocalBlocks: 0 },
  );
});

test('집계: NaN 은 미측정이고 상한을 오염시키지 않는다', () => {
  assert.deepEqual(unexcludedSummary([{ local: true, unexcludedPx: NaN }]), { unexcludedMaxPx: 0, unmeasuredLocalBlocks: 1 });
  assert.deepEqual(
    unexcludedSummary([{ local: true, unexcludedPx: NaN }, { local: true, unexcludedPx: 0.75 }]),
    { unexcludedMaxPx: 0.75, unmeasuredLocalBlocks: 1 },
  );
});

test('집계: 수가 아닌 값(null·문자열)도 미측정 — 강제 변환하지 않는다', () => {
  assert.deepEqual(
    unexcludedSummary([{ local: true, unexcludedPx: null }, { local: true, unexcludedPx: '1.5' }, { local: true, unexcludedPx: 0.25 }]),
    { unexcludedMaxPx: 0.25, unmeasuredLocalBlocks: 2 },
  );
});

test('집계: local 이 아닌 블록은 값과 무관하게 무시한다', () => {
  assert.deepEqual(
    unexcludedSummary([{ local: false }, { local: false, undecided: true, unexcludedPx: NaN }, { local: false, unexcludedPx: 3 }, {}]),
    { unexcludedMaxPx: 0, unmeasuredLocalBlocks: 0 },
  );
  assert.deepEqual(unexcludedSummary([]), { unexcludedMaxPx: 0, unmeasuredLocalBlocks: 0 });
});

// 끝에서 끝까지: 영상 x 0..128 m(타일 (0,0) 서쪽 끝에서 시작), y −64..128 m, 0.5 m/px.
const EDGE_IMG = makeImage({ minX: 0, minY: -64, maxX: 128, maxY: 128 }, 256, 384, TEX_A);
for (const k of [0.16, 0.2]) {
  test(`공개 API: 축척 x ${1 + k} 밉 2 타일의 서쪽 끝 제자리 블록 (0,12) — 예측 근처를 못 잰 local 이 unmeasuredLocalBlocks 1 을 만든다`, () => {
    const mip = 2;
    const { width } = drapeTileSize(EDGE_IMG, mip);
    assert.equal(width, 32);
    const pw = TERRAIN_TILE_SIZE_M / width;
    // 블록 (0,12): 픽셀 i 0..3, j 12..15 는 제자리, 나머지는 타일 중심(x 32 m) 기준 x 로 1 + k 배.
    const warp = (p) => {
      const i = p.x / pw, j = (TERRAIN_TILE_SIZE_M - p.y) / pw;
      if (i < 4 && j >= 12 && j < 16) return p;
      return { x: 32 + (p.x - 32) * (1 + k), y: p.y };
    };
    const m = measureDrapeAlignment(EDGE_IMG, warpedTile(EDGE_IMG, 0, 0, mip, warp));
    assert.equal(m.status, 'measured', m.reason);
    const local = m.blocks.filter((b) => b.local);
    assert.deepEqual(local.map(({ i0, j0 }) => [i0, j0]), [[0, 12]]);
    const b = local[0];
    // 제자리 블록: 자기 최소 0, 표본 16 개 모두 잼. 짝 검정을 하지 않았다(pairedT NaN).
    assert.deepEqual([b.dx, b.dy, b.n], [0, 0, 16]);
    assert.ok(Number.isNaN(b.pairedT), `pairedT ${b.pairedT}`);
    // 전제: 그 블록의 아핀 예측 x 이동량이 −2 px 보다 작다 → 4열 중 3열 이상이 영상 밖, 표본 ≤ 4 < minN 8 → 예측 근처를 못 잰다.
    const a = m.affine, di = 2 - width / 2, dj = 14 - width / 2;
    const px = a.ax + a.kxx * di + a.kxy * dj;
    assert.ok(px < -2, `예측 dx ${px}`);
    // 이 블록은 배제 못 한 이동량을 재지 않았다 → 미측정 1(수정 전 집계는 0).
    assert.equal(m.unmeasuredLocalBlocks, 1);
    assert.equal(m.unexcludedMaxPx, 0);
    // 축척만으로도 모서리 변위 k·32 m / 2 m = 2.56 px(k 0.16) 이상이라 정합 허용(1 px) 밖이다.
    assert.ok(m.maxMisalignPx > ALIGN_TOLERANCE_PX, `maxMisalignPx ${m.maxMisalignPx}`);
  });
}

test('공개 API: 첫 settle 경로 local(무늬 영상의 블록 하나를 정수 3 px 옮김)도 unmeasuredLocalBlocks 1', () => {
  // 타일 (0,0) 밉 0(128 px, 블록 16 px)의 블록 (64,32) 내용을 x 로 3 px 옮긴다(drape.test.mjs shiftBlock 과 같은 방식).
  const img = makeImage({ minX: -64, minY: -64, maxX: 128, maxY: 128 }, 384, 384, TEX_A);
  const t = buildDrapeTile(img, 0, 0, 0);
  for (let j = 32; j < 48; j++) for (let i = 64; i < 80; i++) t.rgb.copyWithin((j * 128 + i) * 3, (j * 128 + i + 3) * 3, (j * 128 + i + 4) * 3);
  const m = measureDrapeAlignment(img, t);
  assert.equal(m.status, 'measured', m.reason);
  assert.deepEqual(m.blocks.filter((b) => b.local).map(({ i0, j0, dx, dy }) => [i0, j0, dx, dy]), [[64, 32, 3, 0]]);
  assert.equal(m.unmeasuredLocalBlocks, 1);
  assert.equal(m.unexcludedMaxPx, 0);
  assert.equal(m.localMaxPx, 3);
});

test('집계: 음수·null·문자열 unexcludedPx 도 잰 크기가 아니다 → unmeasuredLocalBlocks 로 센다, 상한은 그대로 (F-397 ②)', () => {
  assert.deepEqual(unexcludedSummary([{ local: true, unexcludedPx: -1 }]), { unexcludedMaxPx: 0, unmeasuredLocalBlocks: 1 });
  assert.deepEqual(unexcludedSummary([{ local: true, unexcludedPx: null }]), { unexcludedMaxPx: 0, unmeasuredLocalBlocks: 1 });
  assert.deepEqual(unexcludedSummary([{ local: true, unexcludedPx: '2' }]), { unexcludedMaxPx: 0, unmeasuredLocalBlocks: 1 });
  assert.deepEqual(unexcludedSummary([{ local: true, unexcludedPx: -0.5 }, { local: true, unexcludedPx: 0.5 }]), { unexcludedMaxPx: 0.5, unmeasuredLocalBlocks: 1 });
});

test('공개 API: maxMisalignPx ≤ 1 이면서 unmeasuredLocalBlocks ≥ 1 인 출력은 isDrapeAligned 가 거짓 (F-397 ④)', () => {
  // 첫 settle 경로 local: 블록 (64,32) 를 x 로 정수 1 px 만 옮긴다 → 자기 최소 1 px(localMaxPx 1)이라 maxMisalignPx 가 허용 1 px 이하인데,
  // 이 local 은 배제 못 한 이동량을 재지 않아(unmeasuredLocalBlocks 1) 상한이 아니다. 통과로 세면 안 된다.
  const img = makeImage({ minX: -64, minY: -64, maxX: 128, maxY: 128 }, 384, 384, TEX_A);
  const t = buildDrapeTile(img, 0, 0, 0);
  for (let j = 32; j < 48; j++) for (let i = 64; i < 80; i++) t.rgb.copyWithin((j * 128 + i) * 3, (j * 128 + i + 1) * 3, (j * 128 + i + 2) * 3);
  const m = measureDrapeAlignment(img, t);
  assert.equal(m.status, 'measured', m.reason);
  assert.deepEqual(m.blocks.filter((b) => b.local).map(({ i0, j0, dx, dy }) => [i0, j0, dx, dy]), [[64, 32, 1, 0]]);
  assert.ok(m.maxMisalignPx <= ALIGN_TOLERANCE_PX, `maxMisalignPx ${m.maxMisalignPx}`);
  assert.equal(m.unmeasuredLocalBlocks, 1);
  assert.equal(isDrapeAligned(m, ALIGN_TOLERANCE_PX), false);
  // 같은 출력에서 미측정 수만 0 으로 바꾸면 통과 — 거짓의 원인이 미측정 수임을 가른다.
  assert.equal(isDrapeAligned({ ...m, unmeasuredLocalBlocks: 0 }, ALIGN_TOLERANCE_PX), true);
});
