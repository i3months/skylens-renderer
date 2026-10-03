// T07.11 시험: holes 장면에서 LOD(부분집합) 후에도 빈자리가 메워지지 않는다.
//
// 조건과 이론 (값은 이론으로 먼저 정했고 사후 조정하지 않는다):
//  - 카메라: 땅(y=0)을 높이 H=200 m 에서 수직으로 내려다본다. fx=fy=200 이므로 1 픽셀 = 1 m, 영상 220x220 (땅 200 m 가 200 픽셀, 둘레 10 픽셀 여백).
//  - 점 400000 개(밀도 10 점/m²). 점 원판 반지름 R = 2 m (pointSizeM=4 → 반경 px = fx·4/(2·200) = 2).
//    칸 한 변 e = 0.5 m, 칸당 첫 점만 남긴다.
//  - 같은 칸의 점끼리 수평 거리 <= e√2 ≈ 0.707 m 이므로 대표점은 원래 점에서 <= 0.707 m 어긋난다.
//  - (가) 땅 픽셀(중심이 빈자리 밖, 땅 범위 안): 원본이 칠했다면 LOD 도 칠한다. 중심 g 의 반지름 R−e√2 ≈ 1.29 m 안에
//        땅 쪽 점이 있으면(밀도 10 점/m² 이므로 반원 안에도 기댓값 ≈ 52 점) 그 칸 대표점이 g 를 R 안에 둔다.
//  - (나) 빈자리 깊은 곳(경계에서 R+e√2 ≈ 2.71 m 보다 먼 곳): 어떤 점의 원판도 닿지 못하므로 둘 다 빈다.
//  - (다) 그 사이 띠에서만 비교가 갈릴 수 있다: 원본/LOD 도달 거리가 R±e√2 라 폭 2·e√2 의 띠, 면적 <= 둘레·2·0.707 m².
//        빈자리 한 변 <= 30 m → 둘레 <= 120 m, 6곳 <= 720 m. 영상 면적 220² = 48400 픽셀.
//        허용 = 720·2·0.707/48400 = 0.02104 → 올림한 리터럴 0.022.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyRatioPreserved } from './index.mjs';
import { generate } from '../../../fixtures/scenes/holes/index.mjs';
import { renderPoints } from '../../raster_ref/zbuffer/index.mjs';
import { buildHierarchy, selectLevels, materialize } from '../select/index.mjs';
import { selectWithBudget } from '../budget/index.mjs';
import { progressiveChunks, applyChunks } from '../progressive/index.mjs';
import { NOT_DRAWN } from '../../../contracts/lod/index.mjs';

const H = 200, W = 220, R_M = 2, E = 0.5, N = 400000;
const TOL = 0.022;
const OPTS = { pointSizeM: 2 * R_M, tolerance: TOL };
// 월드 (x, y, z) → 카메라: xc = x, yc = z, zc = H − y (아래를 봄). 행렬식 +1.
const camera = { width: W, height: W, K: { fx: 200, fy: 200, cx: 110, cy: 110 }, R: [1, 0, 0, 0, 0, 1, 0, -1, 0], t: [0, 0, H] };

// 시험용 간단 LOD: 칸(한 변 E)당 첫 점만 남기는 부분집합.
function firstPerCell(cloud, e) {
  const seen = new Set();
  const keep = [];
  const p = cloud.positions;
  for (let i = 0; i < cloud.count; i++) {
    const key = `${Math.floor(p[3 * i] / e)},${Math.floor(p[3 * i + 1] / e)},${Math.floor(p[3 * i + 2] / e)}`;
    if (!seen.has(key)) { seen.add(key); keep.push(i); }
  }
  return subset(cloud, keep);
}
function subset(cloud, idx) {
  const m = idx.length;
  const out = { format: 1, count: m, positions: new Float32Array(3 * m), normals: new Float32Array(3 * m), colors: new Uint8Array(3 * m) };
  idx.forEach((s, k) => {
    out.positions.set(cloud.positions.subarray(3 * s, 3 * s + 3), 3 * k);
    out.normals.set(cloud.normals.subarray(3 * s, 3 * s + 3), 3 * k);
    out.colors.set(cloud.colors.subarray(3 * s, 3 * s + 3), 3 * k);
  });
  return out;
}
// 빈자리 안이면 가장자리까지 거리(양수 또는 0), 어느 빈자리에도 안 들면 -Infinity.
function holeDepth(holes, x, z) {
  let best = -Infinity;
  for (const h of holes) {
    const dx = Math.min(x - h.min[0], h.max[0] - x), dz = Math.min(z - h.min[1], h.max[1] - z);
    if (dx >= 0 && dz >= 0) best = Math.max(best, Math.min(dx, dz));
  }
  return best;
}

for (const seed of [1, 2, 3]) {
  test(`holes seed ${seed}: LOD 후 빈 픽셀 비율 보존, 픽셀 단위 성질`, () => {
    const s = generate({ seed, count: N });
    const lodCloud = firstPerCell(s.cloud, E);
    assert.ok(lodCloud.count < s.cloud.count / 2, 'LOD 가 점을 충분히 줄여야 시험이 의미 있음');
    const r = emptyRatioPreserved(s.cloud, lodCloud, camera, OPTS);
    assert.equal(r.equal, true, JSON.stringify(r));
    assert.equal(r.filled, 0, JSON.stringify(r)); // 부분집합 LOD 는 원본이 비운 픽셀을 칠하지 못한다
    assert.equal(r.noFill, true);
    assert.ok(r.original > 0.14); // 둘레 여백 중 원판이 못 닿는 고리만으로 (220²−204²)/220² ≈ 0.14, 빈자리가 더해짐

    const a = renderPoints(camera, s.cloud, { pointSizeM: 2 * R_M });
    const b = renderPoints(camera, lodCloud, { pointSizeM: 2 * R_M });
    let groundViolations = 0, deepHoleFilled = 0, groundSeen = 0, deepSeen = 0;
    for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
      const x = i + 0.5 - 110, z = j + 0.5 - 110; // 픽셀 중심의 땅 좌표(1 픽셀 = 1 m)
      const px = j * W + i;
      const inField = Math.abs(x) <= 100 && Math.abs(z) <= 100;
      const d = holeDepth(s.truth.holes, x, z);
      if (inField && d === -Infinity) { // 땅 픽셀
        groundSeen++;
        if (a.index[px] !== -1 && b.index[px] === -1) groundViolations++;
      }
      if (d > R_M + E * Math.SQRT2) { // 빈자리 깊은 곳
        deepSeen++;
        if (a.index[px] !== -1 || b.index[px] !== -1) deepHoleFilled++;
      }
    }
    assert.ok(groundSeen > 20000 && deepSeen > 500);
    assert.equal(groundViolations, 0);
    assert.equal(deepHoleFilled, 0);
  });
}

test('음성: 빈자리에 점을 더하는 가짜 LOD 는 equal=false', () => {
  const s = generate({ seed: 1, count: N });
  const lodCloud = firstPerCell(s.cloud, E);
  // 가짜: 모든 빈자리를 1 m 간격 점으로 메운다.
  const extra = [];
  for (const h of s.truth.holes) for (let x = h.min[0] + 0.5; x < h.max[0]; x++) for (let z = h.min[1] + 0.5; z < h.max[1]; z++) extra.push(x, 0, z);
  const n = lodCloud.count, m = extra.length / 3;
  const fake = { format: 1, count: n + m, positions: new Float32Array(3 * (n + m)), normals: new Float32Array(3 * (n + m)), colors: new Uint8Array(3 * (n + m)) };
  fake.positions.set(lodCloud.positions); fake.positions.set(extra, 3 * n);
  fake.normals.set(lodCloud.normals); fake.colors.set(lodCloud.colors);
  const r = emptyRatioPreserved(s.cloud, fake, camera, OPTS);
  assert.equal(r.equal, false, JSON.stringify(r));
  assert.ok(r.original - r.lod > TOL);
  assert.ok(r.filled > 0 && r.noFill === false, JSON.stringify(r));
});

// 빈자리 k 곳(앞에서부터)만 1 m 간격 점으로 메운 가짜 LOD.
function fakeFill(s, lodCloud, k) {
  const extra = [];
  for (const h of s.truth.holes.slice(0, k)) for (let x = h.min[0] + 0.5; x < h.max[0]; x++) for (let z = h.min[1] + 0.5; z < h.max[1]; z++) extra.push(x, 0, z);
  const n = lodCloud.count, m = extra.length / 3;
  const fake = { format: 1, count: n + m, positions: new Float32Array(3 * (n + m)), normals: new Float32Array(3 * (n + m)), colors: new Uint8Array(3 * (n + m)) };
  fake.positions.set(lodCloud.positions); fake.positions.set(extra, 3 * n);
  fake.normals.set(lodCloud.normals); fake.colors.set(lodCloud.colors);
  return fake;
}

test('음성: 빈자리 한 곳만 메운 가짜 LOD 는 filled > 0 (빈 비율 차가 허용 이내여도 잡는다)', () => {
  const s = generate({ seed: 1, count: N });
  assert.ok(s.truth.holes.length >= 2);
  const lodCloud = firstPerCell(s.cloud, E);
  assert.equal(emptyRatioPreserved(s.cloud, lodCloud, camera, OPTS).filled, 0);
  const r = emptyRatioPreserved(s.cloud, fakeFill(s, lodCloud, 1), camera, OPTS);
  assert.ok(r.filled > 0, JSON.stringify(r));
  assert.equal(r.noFill, false);
  // 한 곳 정도는 기존 비율 허용(0.022)에 가려질 수 있음 — 그래서 filled 로 판정한다.
  assert.ok(r.original - r.lod <= TOL, JSON.stringify(r));
});

// 실제 산출물 세 경로: 같은 holes 장면·카메라에서 filled 0.
// 계층: edge0M E, 단계 4(칸 0.5·1·2·4 m), τ 2 px. 카메라 거리 200 m, fx 200 → 단계 l 의 칸이 화면에서 e/1 px 이므로
// 단계 2(2 m = 2 px)까지 거친 단계가 실제로 선택된다(아래 단언으로 확인).
const REAL = { edge0M: E, levelCount: 4, maxLeafPoints: 2048 };
const TAU = 2;
for (const seed of [1, 2]) {
  const s = generate({ seed, count: N });
  const hier = buildHierarchy(s.cloud, REAL);
  const check = (name, cloud) => {
    const r = emptyRatioPreserved(s.cloud, cloud, camera, OPTS);
    assert.equal(r.filled, 0, `${name}: ${JSON.stringify(r)}`);
    assert.equal(r.noFill, true);
    assert.ok(r.original > 0.14, name);
  };
  test(`holes seed ${seed}: buildHierarchy+selectLevels+materialize 산출물 filled 0`, () => {
    const sel = selectLevels(hier, camera, { thresholdPx: TAU });
    const cloud = materialize(hier, sel);
    assert.ok(cloud.count < s.cloud.count / 2, `거친 단계가 쓰여야 의미 있음: ${cloud.count}`);
    assert.ok(sel.leafLevel.some((l) => l !== NOT_DRAWN && l >= 1));
    check('select', cloud);
  });
  test(`holes seed ${seed}: selectWithBudget 산출물 filled 0`, () => {
    for (const budgetPoints of [60000, 5000]) {
      const sel = selectWithBudget(hier, camera, { budgetPoints, thresholdPx: TAU });
      assert.ok(sel.pointCount > 0 && sel.pointCount <= budgetPoints);
      check(`budget ${budgetPoints}`, materialize(hier, sel));
    }
  });
  test(`holes seed ${seed}: progressive applyChunks 산출물 filled 0`, () => {
    const ch = progressiveChunks(hier, camera, { thresholdPx: TAU });
    assert.ok(ch.length > 2);
    for (const k of [1, Math.ceil(ch.length / 2), ch.length]) {
      const cloud = applyChunks(hier, ch, k);
      assert.ok(cloud.count > 0);
      check(`progressive k=${k}`, cloud);
    }
  });
}

test('점 수 정의: count 가 positions.length/3 과 다르면 명시 오류, 기본 허용 0', () => {
  const s = generate({ seed: 1, count: 2000 });
  const bad = { ...s.cloud, count: s.cloud.count + 1 };
  assert.throws(() => emptyRatioPreserved(s.cloud, bad, camera), /lod:.*count/);
  assert.throws(() => emptyRatioPreserved(bad, s.cloud, camera), /lod:.*count/);
  const same = emptyRatioPreserved(s.cloud, s.cloud, camera, { pointSizeM: 1 });
  assert.equal(same.original, same.lod);
  assert.equal(same.equal, true);
  const dropped = subset(s.cloud, [0]);
  assert.equal(emptyRatioPreserved(s.cloud, dropped, camera, { pointSizeM: 1 }).equal, false);
  assert.throws(() => emptyRatioPreserved(s.cloud, s.cloud, camera, { tolerance: -1 }), /lod:/);
});
