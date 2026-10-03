// F-118 ②: pointSizeM 이 결합 선택의 모든 단계로 전달되고, 화면 가장자리에 원판이 걸친 리프가 살아남는지 시험한다.
// 장면: 카메라 R = I, t = 0, fx = 400, 640×360. 깊이 10 m 에서 점 지름 2 m 는 반경 40 px 원판이다.
//   edge 리프: 중심이 화면 왼쪽 바깥 20 px (원판은 화면 안으로 20 px 걸침)  -> 남아야 한다.
//   decoy 리프: 왼쪽 바깥 200 px (원판도 완전히 밖)                       -> 제거되어야 한다(제거가 실제로 일어남을 보임).
//   center 리프: 화면 한가운데.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHierarchy } from '../../lod/select/index.mjs';
import { boxMayBeVisibleSplat } from '../../lod/select/view_check.mjs';
import { predictiveMask } from '../predict/index.mjs';
import { cullAndSelect, cullAndSelectDefault } from './index.mjs';

const CAM = { width: 640, height: 360, K: { fx: 400, fy: 400, cx: 320, cy: 180 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
const D = 10, SIZE_M = 2;
const at = (u, v) => [((u - CAM.K.cx) * D) / CAM.K.fx, ((v - CAM.K.cy) * D) / CAM.K.fy, D];

function cluster(u, v, n, out) {
  for (let i = 0; i < n; i++) out.push(...at(u + (i % 3) * 0.5, v + (i % 2) * 0.5));
}
const pts = [];
cluster(-20, 180, 30, pts); // edge
cluster(-200, 180, 30, pts); // decoy
cluster(320, 180, 30, pts); // center
const n = pts.length / 3;
const cloud = { format: 1, count: n, positions: Float32Array.from(pts), normals: new Float32Array(3 * n), colors: new Uint8Array(3 * n).fill(200) };
const h = buildHierarchy(cloud, { edge0M: 0.5, levelCount: 2, maxLeafPoints: 8 });
const oc = h.octree;

// 점 번호 -> 리프 번호
const leafOfPoint = new Map();
for (let k = 0; k < oc.leafCount; k++) for (let i = oc.leafStart[k]; i < oc.leafStart[k + 1]; i++) leafOfPoint.set(oc.order[i], k);
const leafsOf = (from) => new Set(Array.from({ length: 30 }, (_, i) => leafOfPoint.get(from + i)));
const edgeLeaves = leafsOf(0), decoyLeaves = leafsOf(30), centerLeaves = leafsOf(60);
const allIn = (set, m) => [...set].every((k) => m[k] === 1);
const noneIn = (set, m) => [...set].every((k) => m[k] === 0);

test('준비: 세 무리는 서로 다른 리프에 있고, 상자 판정이 장면의 의도와 맞는다', () => {
  for (const a of edgeLeaves) { assert.ok(!decoyLeaves.has(a)); assert.ok(!centerLeaves.has(a)); }
  for (const a of decoyLeaves) assert.ok(!centerLeaves.has(a));
  const box = (k) => { const i = oc.leafIndex.indexOf(k); return [oc.boxMin.slice(3 * i, 3 * i + 3), oc.boxMax.slice(3 * i, 3 * i + 3)]; };
  for (const k of edgeLeaves) { const [a, b] = box(k); assert.equal(boxMayBeVisibleSplat(CAM, a, b, 0), false); assert.equal(boxMayBeVisibleSplat(CAM, a, b, SIZE_M), true); }
});

test('combine: pointSizeM 이 있으면 가장자리 걸침 리프는 남고 완전히 밖인 리프는 제거', async () => {
  const r = await cullAndSelectDefault(h, CAM, { thresholdPx: 0.5, stages: ['frustum'], pointSizeM: SIZE_M });
  assert.ok(allIn(edgeLeaves, r.cull.mask), 'edge 리프가 제거됨');
  assert.ok(allIn(centerLeaves, r.cull.mask));
  assert.ok(noneIn(decoyLeaves, r.cull.mask), 'decoy 리프가 남음');
  assert.ok(r.cull.stats.removedFrustum >= 1);
});

test('combine 변이 검사: pointSizeM 을 무시(0)하면 같은 edge 리프가 제거됨 = 위 시험이 pointSizeM 에 민감함', async () => {
  const r = await cullAndSelectDefault(h, CAM, { thresholdPx: 0.5, stages: ['frustum'], pointSizeM: 0 });
  assert.ok(noneIn(edgeLeaves, r.cull.mask), 'pointSizeM 0 인데 edge 리프가 남음');
});

test('combine: pointSizeM 이 없으면 좌우상하 제거 없음, 가림 단계도 아무것도 버리지 않음', async () => {
  const r = await cullAndSelectDefault(h, CAM, { thresholdPx: 0.5, stages: ['frustum', 'occlusion'] });
  assert.equal(r.cull.stats.removedFrustum, 0);
  assert.equal(r.cull.stats.removedOcclusion, 0);
  assert.equal(r.cull.stats.kept, oc.leafCount);
});

test('combine: pointSizeM 이 모든 단계의 stageOpts 로 전달되고, 입력 오류는 cull:', () => {
  const seen = {};
  const ones = () => new Uint8Array(oc.leafCount).fill(1);
  const spy = (name) => (hh, c, o) => { seen[name] = o.pointSizeM; return ones(); };
  const stageImpls = { frustum: spy('frustum'), backface: spy('backface'), occlusion: spy('occlusion'), distance: spy('distance') };
  cullAndSelect(h, CAM, { thresholdPx: 0.5, pointSizeM: 0.75, stageImpls });
  assert.deepEqual(seen, { frustum: 0.75, backface: 0.75, occlusion: 0.75, distance: 0.75 });
  for (const bad of [-1, NaN, Infinity, '1']) assert.throws(() => cullAndSelect(h, CAM, { thresholdPx: 0.5, pointSizeM: bad, stageImpls }), /^Error: cull:/);
});

test('predict: pointSizeM 이 있으면 가장자리 걸침 리프가 남고, 0 이면 제거(변이 검사)', () => {
  const st = { camera: CAM, velocityMps: [0, 0, 0], angularRadPerS: [0, 0, 0] };
  const m = predictiveMask(h, st, { horizonS: 1, steps: 2, pointSizeM: SIZE_M });
  assert.ok(allIn(edgeLeaves, m), 'predict 가 edge 리프를 버림');
  assert.ok(allIn(centerLeaves, m));
  assert.ok(noneIn(decoyLeaves, m), 'predict 가 decoy 를 남김');
  const m0 = predictiveMask(h, st, { horizonS: 1, steps: 2, pointSizeM: 0 });
  assert.ok(noneIn(edgeLeaves, m0), 'pointSizeM 0 인데 edge 리프가 남음');
  const mNone = predictiveMask(h, st, { horizonS: 1, steps: 2 });
  assert.ok(allIn(edgeLeaves, mNone) && allIn(decoyLeaves, mNone), 'pointSizeM 없음은 좌우상하 제거 없음');
  assert.throws(() => predictiveMask(h, st, { horizonS: 1, steps: 2, pointSizeM: -1 }), /^Error: cull:/);
});
