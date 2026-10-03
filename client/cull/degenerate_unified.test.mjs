// F-120: 퇴화 시점 판정 통일. 같은 퇴화 카메라 목록에서 frustum/priority/client/degenerate 의 모든 공개 함수가 같은 판정(빈 결과)을 낸다.
// 그리고 정상 카메라(큰 해상도 포함)는 모든 경로에서 퇴화가 아니다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../../fixtures/scenes/flat_boxes/index.mjs';
import { viewpointToCamera } from '../../tools/render_views/index.mjs';
import { buildHierarchy } from '../../server/lod/hierarchy/index.mjs';
import { isDegenerateView } from '../../server/cull/degenerate/index.mjs';
import { frustumCull, isDegenerateViewLocal } from '../../server/cull/frustum/index.mjs';
import { leafPriority, orderChunks } from '../../server/cull/priority/index.mjs';
import { backfaceCull, leafNormalCones } from '../../server/cull/backface/index.mjs';
import { occlusionCull, buildDepthPyramid } from '../../server/cull/occlusion/index.mjs';
import { distanceCull } from '../../server/cull/distance/index.mjs';
import { predictiveMask } from '../../server/cull/predict/index.mjs';
import { cullAndSelectDefault } from '../../server/cull/combine/index.mjs';
import { clientFrustumCull, leafBoxesOf, isDegenerateViewClient } from './index.mjs';

const { cloud } = generate({ seed: 1, count: 3000 });
const hier = buildHierarchy(cloud, { edge0M: 0.5, levelCount: 3, maxLeafPoints: 256 });
const boxes = leafBoxesOf(hier.octree);
const good = (over = {}) => ({ ...viewpointToCamera({ eye: [0, 120, 140], target: [0, 5, 0], up: [0, 1, 0], fov_y_deg: 50, width: 64, height: 48 }), ...over });
const base = good();
const withK = (k, over = {}) => ({ ...base, K: { ...base.K, ...k }, ...over });

const DEGENERATE = {
  'width 1 + fx 1e7 (시야각 < 1e-6)': withK({ fx: 1e7 }, { width: 1 }),
  'height 1 + fy 1e7': withK({ fy: 1e7 }, { height: 1 }),
  'R = 2I': good({ R: [2, 0, 0, 0, 2, 0, 0, 0, 2] }),
  'reflection R (det -1)': good({ R: [-1, 0, 0, 0, 1, 0, 0, 0, 1] }),
  'R = 0': good({ R: new Array(9).fill(0) }),
  'resolution 2e9': good({ width: 2e9, height: 2e9 }),
  'resolution 2e9 x 1': good({ width: 2e9, height: 1 }),
  'NaN t': good({ t: [NaN, 0, 0] }),
  '8193x8193 (픽셀 수 > 2^26)': good({ width: 8193, height: 8193 }),
  'near-zero fov (fx 1e8, width 64)': withK({ fx: 1e8 }),
  'fx 0': withK({ fx: 0 }),
};

const all = (cam) => ({
  degenerate: isDegenerateView(cam),
  local: isDegenerateViewLocal(cam),
  client: isDegenerateViewClient(cam),
});

for (const [name, cam] of Object.entries(DEGENERATE)) {
  test(`F-120 퇴화 통일: ${name} -> 모든 공개 함수가 같은 판정(빈 결과, 던지지 않음)`, () => {
    assert.deepEqual(all(cam), { degenerate: true, local: true, client: true });
    const n = hier.octree.leafCount;
    assert.equal(frustumCull(hier, cam).length, n);
    assert.ok(frustumCull(hier, cam).every((v) => v === 0));
    assert.ok(frustumCull(hier, cam, { pointSizeM: 0.1 }).every((v) => v === 0));
    assert.ok(clientFrustumCull(boxes, cam).every((v) => v === 0));
    assert.ok(clientFrustumCull(boxes, cam, { pointSizeM: 0.1 }).every((v) => v === 0));
    const score = leafPriority(hier, cam);
    assert.equal(score.length, n);
    assert.ok(score.every((v) => v === 0));
    assert.equal(orderChunks(hier, cam, new Uint8Array(n).fill(1)).length, 0);
  });
}

test('F-120 정상 카메라(큰 해상도 포함)는 모든 판정에서 퇴화가 아니고 같은 마스크를 낸다', () => {
  for (const cam of [good(), good({ width: 4000, height: 3000, K: { ...base.K, fx: base.K.fx * 60, fy: base.K.fy * 60, cx: 2000, cy: 1500 } })]) {
    assert.deepEqual(all(cam), { degenerate: false, local: false, client: false });
    assert.deepEqual([...clientFrustumCull(boxes, cam, { pointSizeM: 0.2 })], [...frustumCull(hier, cam, { pointSizeM: 0.2 })]);
  }
});

// 모든 공개 함수가 같은 판정을 내는지: 퇴화면 빈 결과, 아니면 던지지 않는다.
const cones = leafNormalCones(hier);
const n = hier.octree.leafCount;
const allOnes = new Uint8Array(n).fill(1);
const isZero = (m) => m.length === n && m.every((v) => v === 0);
const STAGES = {
  frustumCull: (cam) => isZero(frustumCull(hier, cam, { pointSizeM: 0.1 })),
  clientFrustumCull: (cam) => clientFrustumCull(boxes, cam, { pointSizeM: 0.1 }).every((v) => v === 0),
  backfaceCull: (cam) => isZero(backfaceCull(hier, cam, cones, { pointSizeM: 0.1 })),
  occlusionCull: (cam) => isZero(occlusionCull(hier, cam, buildDepthPyramid(hier, cam))),
  'occlusionCull(피라미드 없음)': (cam) => isZero(occlusionCull(hier, cam)),
  distanceCull: (cam) => isZero(distanceCull(hier, cam, { maxDistanceM: Infinity })),
  predictiveMask: (cam) => isZero(predictiveMask(hier, { camera: cam, velocityMps: [0, 0, 0], angularRadPerS: [0, 0, 0] }, { horizonS: 1, steps: 2, pointSizeM: 0.1 })),
  leafPriority: (cam) => isZero(leafPriority(hier, cam)),
  orderChunks: (cam) => orderChunks(hier, cam, allOnes).length === 0,
};

for (const [name, cam] of Object.entries(DEGENERATE)) {
  for (const [stage, check] of Object.entries(STAGES)) {
    test(`F-120 판정 통일: ${stage} / ${name} -> 퇴화(빈 결과)`, () => {
      assert.equal(check(cam), true);
    });
  }
  test(`F-120 판정 통일: cullAndSelectDefault(주입 없음) / ${name} -> degenerate, 빈 결과`, async () => {
    const r = await cullAndSelectDefault(hier, cam, { thresholdPx: 1, pointSizeM: 0.1, maxDistanceM: 1e9, prioritize: true });
    assert.equal(r.cull.stats.degenerate, true);
    assert.ok(isZero(r.cull.mask));
    assert.equal(r.cull.chunks.length, 0);
    assert.equal(r.selection.pointCount, 0);
  });
}

test('F-120 정상 카메라: 모든 단계가 퇴화로 취급하지 않는다(빈 마스크가 아님)', async () => {
  const cam = good();
  assert.equal(isZero(frustumCull(hier, cam, { pointSizeM: 0.1 })), false);
  assert.equal(isZero(backfaceCull(hier, cam, cones, { requireCover: false })), false);
  assert.equal(isZero(occlusionCull(hier, cam)), false);
  assert.equal(isZero(distanceCull(hier, cam, { maxDistanceM: Infinity })), false);
  assert.equal(isZero(predictiveMask(hier, { camera: cam, velocityMps: [0, 0, 0], angularRadPerS: [0, 0, 0] }, { horizonS: 1, steps: 2 })), false);
  assert.equal(isZero(leafPriority(hier, cam)), false);
  const r = await cullAndSelectDefault(hier, cam, { thresholdPx: 1, pointSizeM: 0.1 });
  assert.notEqual(r.cull.stats.degenerate, true);
  assert.ok(r.cull.mask.some((v) => v === 1));
});

// 해상도 경계. 모든 판정은 같은 결과를 내야 한다.
const sized = (width, height) => good({ width, height, K: { ...base.K, cx: width / 2, cy: height / 2 } });
const verdicts = (cam) => [isDegenerateView(cam), isDegenerateViewLocal(cam), isDegenerateViewClient(cam)];

test('F-120 해상도 경계: 8192x8192(=2^26)는 정상, 8193x8193 은 퇴화', () => {
  assert.deepEqual(verdicts(sized(8192, 8192)), [false, false, false]);
  assert.deepEqual(verdicts(sized(8193, 8193)), [true, true, true]);
});

test('F-120 해상도 경계: 1 x 2^26, 1 x (2^26+1)은 한 변 상한 때문에 퇴화이고 2^13 x (2^13+1)은 픽셀 수 때문에 퇴화', () => {
  // 한 변 1e6 상한이 먼저 걸리므로 1 x N 은 모두 퇴화다. 픽셀 수 상한만 따로 보는 것은 아래 두 줄.
  assert.deepEqual(verdicts(sized(1, 2 ** 26)), [true, true, true]);
  assert.deepEqual(verdicts(sized(1, 2 ** 26 + 1)), [true, true, true]);
  assert.deepEqual(verdicts(sized(2 ** 13, 2 ** 13 + 1)), [true, true, true]);
  assert.deepEqual(verdicts(sized(2 ** 13 + 1, 2 ** 13 - 1)), [false, false, false]); // 2^26 - 1
});

test('F-120 해상도 경계: 한 변 1e6 은 정상(픽셀 수 허용 시), 1e6+1 은 퇴화', () => {
  assert.deepEqual(verdicts(sized(1e6, 1)), [false, false, false]);
  assert.deepEqual(verdicts(sized(1e6 + 1, 1)), [true, true, true]);
  assert.deepEqual(verdicts(sized(1, 1e6 + 1)), [true, true, true]);
  assert.deepEqual(verdicts(sized(1e6, 67)), [false, false, false]); // 6.7e7 <= 2^26
  assert.deepEqual(verdicts(sized(1e6, 68)), [true, true, true]); // 6.8e7 > 2^26
});

test('F-120 해상도: 정수가 아니면 퇴화', () => {
  for (const [w, h] of [[64.5, 48], [64, 48.5], [0.5, 48]]) assert.deepEqual(verdicts(sized(w, h)), [true, true, true], `${w}x${h}`);
});

test('F-120 해상도: 60000x60000 은 퇴화이며 빠르게 빈 결과를 내고 던지지 않는다', () => {
  const cam = good({ width: 60000, height: 60000, K: { ...base.K, fx: base.K.fx * 1000, fy: base.K.fy * 1000, cx: 30000, cy: 30000 } });
  assert.equal(isDegenerateView(cam), true);
  const t0 = performance.now();
  const score = leafPriority(hier, cam);
  const order = orderChunks(hier, cam, allOnes);
  const mask = frustumCull(hier, cam);
  const ms = performance.now() - t0;
  assert.equal(score.length, n);
  assert.ok(score.every((v) => v === 0));
  assert.equal(order.length, 0);
  assert.ok(isZero(mask));
  // 벽시계는 CI 부하에 민감하므로 여유를 크게 둔다(회귀 감지는 퇴화 경로가 버퍼를 할당하지 않는다는 위의 결과 검사가 맡는다).
  assert.ok(ms < 10000, `60000x60000 처리 ${ms.toFixed(0)} ms`);
});

test('F-120 정상 큰 해상도(8192x8192)는 우선순위·절두체 모두 던지지 않고 같은 마스크를 낸다', () => {
  const cam = sized(8192, 8192);
  const big = { ...cam, K: { ...cam.K, fx: base.K.fx * 128, fy: base.K.fy * 128 } };
  assert.deepEqual(verdicts(big), [false, false, false]);
  const t0 = performance.now();
  const score = leafPriority(hier, big);
  const order = orderChunks(hier, big, allOnes);
  const ms = performance.now() - t0;
  assert.equal(score.length, n);
  assert.equal(order.length, n);
  assert.ok(ms < 50000, `8192x8192 우선순위 ${ms.toFixed(0)} ms`);
  assert.deepEqual([...clientFrustumCull(boxes, big, { pointSizeM: 0.2 })], [...frustumCull(hier, big, { pointSizeM: 0.2 })]);
});

// R 직교 허용오차(1e-6) 경계: R = I 에서 첫 행의 [0][0] 을 (1+d) 로 하면 R·Rᵀ 의 [0][0] 이 (1+d)^2 ≈ 1+2d, det 도 1+d.
test('F-120 R 거의 직교 경계: 오차 1e-6 이하는 정상, 그 위는 퇴화(모든 판정 동일)', () => {
  const rot = (d) => good({ R: [1 + d, 0, 0, 0, 1, 0, 0, 0, 1] });
  const below = 4e-7; // (1+d)^2-1 ≈ 8e-7, det-1 = 4e-7 : 모두 1e-6 이하
  const above = 2e-6; // det-1 = 2e-6 > 1e-6
  assert.deepEqual(verdicts(rot(below)), [false, false, false]);
  assert.deepEqual(verdicts(rot(-below)), [false, false, false]);
  assert.deepEqual(verdicts(rot(above)), [true, true, true]);
  assert.deepEqual(verdicts(rot(-above)), [true, true, true]);
  // 직교성만 어긋나는 경우(det 는 허용 안): 행 사이 내적 2e-6
  assert.deepEqual(verdicts(good({ R: [1, 2e-6, 0, 0, 1, 0, 0, 0, 1] })), [true, true, true]);
  assert.deepEqual(verdicts(good({ R: [1, 5e-7, 0, 0, 1, 0, 0, 0, 1] })), [false, false, false]);
});

test('F-122 ⑥: leafBoxesOf 는 짧은 boxMin/boxMax 를 거부한다', () => {
  const oc = hier.octree;
  assert.throws(() => leafBoxesOf({ ...oc, boxMin: oc.boxMin.subarray(0, oc.boxMin.length - 3) }), /^Error: cull:/);
  assert.throws(() => leafBoxesOf({ ...oc, boxMax: new Float32Array(0) }), /^Error: cull:/);
});

// F-133 ①·F-132: 구조 오류 카메라는 퇴화(빈 결과)가 아니라 'cull:' 오류. 서버 단계와 같은 규칙.
const STRUCTURAL = {
  'camera null': null,
  'camera {}': {},
  'R 없음': (() => { const c = good(); delete c.R; return c; })(),
  't 없음': (() => { const c = good(); delete c.t; return c; })(),
  'K 없음': (() => { const c = good(); delete c.K; return c; })(),
  'R 길이 8': good({ R: [1, 0, 0, 0, 1, 0, 0, 0] }),
  'R Float32Array': good({ R: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) }),
  "width '640'": good({ width: '640' }),
};
for (const [name, cam] of Object.entries(STRUCTURAL)) {
  test(`F-133 구조 오류: ${name} -> clientFrustumCull 은 'cull:' 오류를 던진다`, () => {
    assert.throws(() => clientFrustumCull(boxes, cam), /^Error: cull:/);
    assert.throws(() => clientFrustumCull(boxes, cam, { pointSizeM: 0.1 }), /^Error: cull:/);
    assert.equal(isDegenerateViewClient(cam), true); // 판정 함수 자체는 던지지 않는다
  });
}
