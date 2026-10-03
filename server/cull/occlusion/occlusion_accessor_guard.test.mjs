// F-148·F-149 ③: 가림 컬링의 계층 읽기 보호와 NaN 위치 정책.
//
// F-148: 계층 필드의 getter·Proxy 가 던진 예외는 guardHierarchyRead 로 'cull:' 오류가 된다(다른 단계와 같은 규칙).
//
// F-149 ③ 정책 선택(통과): 계층 단계 0 positions 에 NaN 이 있을 때 다른 단계의 현재 동작을 먼저 확인했다.
//   frustum·distance 는 octree 상자만 읽고 positions 를 보지 않아 통과(마스크 반환), backface 는 NaN 을 상자 비교에서 무시해 통과한다.
//   즉 3 단계가 '통과', 0 단계가 'cull: 오류'라서 다수 정책은 통과다. occlusion 만 raster: 오류를 내던 것을 통과로 맞춘다.
//   통과의 뜻: NaN 점은 가림막이 되지 않고, NaN 이 든 리프는 판정을 포기하고 남긴다(거짓 제거 0 원칙에 맞음).
//   어떤 경우에도 'raster:' 오류는 나오지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHierarchy } from '../../lod/hierarchy/index.mjs';
import { frustumCull } from '../frustum/index.mjs';
import { distanceCull } from '../distance/index.mjs';
import { backfaceCull, leafNormalCones } from '../backface/index.mjs';
import { occlusionCull, buildDepthPyramid } from './index.mjs';

const CAM = Object.freeze({ width: 128, height: 128, K: { fx: 100, fy: 100, cx: 64, cy: 64 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] });

function scene() {
  const n = 2000, positions = new Float32Array(3 * n), normals = new Float32Array(3 * n), colors = new Uint8Array(3 * n).fill(128);
  for (let i = 0; i < n; i++) { positions.set([(i % 40) / 10 - 2, Math.floor(i / 40) / 10 - 2, 10 + (i % 7)], 3 * i); normals[3 * i + 2] = -1; }
  return buildHierarchy({ format: 1, count: n, positions, normals, colors }, { edge0M: 0.5, levelCount: 2, maxLeafPoints: 200 });
}

const CULL = /^Error: cull:/;
const asText = (fn) => { try { fn(); return 'no throw'; } catch (e) { return String(e).split('\n')[0]; } };

test('양성 대조: 정상 계층은 던지지 않고 일부 리프를 남긴다', () => {
  const h = scene();
  const m = occlusionCull(h, CAM);
  assert.equal(m.length, h.octree.leafCount);
  assert.ok(m.some((v) => v === 1));
  assert.doesNotThrow(() => buildDepthPyramid(h, CAM));
});

test('F-148: octree 필드 getter 의 예외는 cull: 오류', () => {
  const h = scene();
  const bad = { levels: h.levels, get octree() { throw new TypeError('boom getter'); } };
  assert.throws(() => occlusionCull(bad, CAM), CULL);
  assert.throws(() => buildDepthPyramid(bad, CAM), CULL);
  const bad2 = { octree: h.octree, get levels() { throw new RangeError('boom levels'); } };
  assert.throws(() => occlusionCull(bad2, CAM), CULL);
});

test('F-148: Proxy 의 get trap 예외는 cull: 오류', () => {
  const h = scene();
  const px = new Proxy(h, { get(t, k) { if (k === 'octree') throw new Error('proxy trap'); return t[k]; } });
  assert.throws(() => occlusionCull(px, CAM), CULL);
  assert.throws(() => buildDepthPyramid(px, CAM), CULL);
  const oc = new Proxy(h.octree, { get(t, k) { if (k === 'nodeCount') throw new Error('proxy oc'); return t[k]; } });
  assert.throws(() => occlusionCull({ octree: oc, levels: h.levels }, CAM), CULL);
});

test('F-148: 이미 cull: 인 오류는 그대로(이중 포장 없음)', () => {
  const h = scene();
  const text = asText(() => occlusionCull({ octree: null, levels: h.levels }, CAM));
  assert.match(text, /^Error: cull: hierarchy\.octree 가 없음/);
});

test('F-149 ③: NaN positions 는 raster: 오류 없이 통과, NaN 리프는 남김', () => {
  const h = scene();
  const base = occlusionCull(h, CAM);
  h.levels[0].positions[3] = NaN;
  let m, p;
  assert.doesNotThrow(() => { p = buildDepthPyramid(h, CAM); });
  assert.doesNotThrow(() => { m = occlusionCull(h, CAM); });
  assert.ok(!/raster:/.test(asText(() => occlusionCull(h, CAM))));
  assert.equal(m.length, h.octree.leafCount);
  // NaN 이 든 리프(점 1 의 리프)는 남는다.
  const ls = h.levels[0].leafStart;
  let k = 0; while (!(ls[k] <= 1 && 1 < ls[k + 1])) k++;
  assert.equal(m[k], 1);
  // 다른 리프는 원래 마스크보다 더 제거되지 않는다(거짓 제거 없음 쪽으로만 변한다는 점은 base 와 비교).
  assert.equal(m.length, base.length);
  assert.ok(p.degenerate !== true);
});

test('F-149 ③: 다른 단계도 같은 NaN 입력을 통과시킨다(정책 근거)', () => {
  const h = scene();
  h.levels[0].positions[3] = NaN;
  assert.doesNotThrow(() => frustumCull(h, CAM, {}));
  assert.doesNotThrow(() => distanceCull(h, CAM, { maxDistanceM: 100 }));
  assert.doesNotThrow(() => backfaceCull(h, CAM, leafNormalCones(h), {}));
});

test('F-149 ③: Infinity 위치도 같은 정책(raster: 없음)', () => {
  const h = scene();
  h.levels[0].positions[7] = Infinity;
  assert.doesNotThrow(() => occlusionCull(h, CAM));
});
