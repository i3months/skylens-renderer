// F-152 4: 계층 필드는 검사 시점에 한 번만 읽는다. 검사 뒤 leafCount 를 다시 읽지 않으므로 따로 감싸지 않는다.
// 검사 시점의 읽기 예외는 'cull:' 오류가 되고, 정상 입력의 결과는 그대로다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHierarchy } from '../../lod/select/index.mjs';
import { cullAndSelect } from './index.mjs';

const CAM = { width: 64, height: 48, K: { fx: 60, fy: 60, cx: 32, cy: 24 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
function scene() {
  const pos = [], nor = [];
  for (let i = 0; i < 100; i++) { pos.push((i % 10) * 0.1 - 0.5, Math.floor(i / 10) * 0.1 - 1, 5); nor.push(0, 0, -1); }
  const n = pos.length / 3;
  return buildHierarchy({ format: 1, count: n, positions: Float32Array.from(pos), normals: Float32Array.from(nor), colors: new Uint8Array(3 * n).fill(200) },
    { edge0M: 0.5, levelCount: 2, maxLeafPoints: 16 });
}
const ones = (h) => new Uint8Array(h.octree.leafCount).fill(1);
const OPTS = { thresholdPx: 0.5, stages: ['distance'], stageImpls: { distance: ones } };
const RX = /^Error: cull:/;

function withLeafCount(h, get) {
  const oc = Object.create(h.octree);
  Object.defineProperty(oc, 'leafCount', { get, enumerable: true });
  return { ...h, octree: oc };
}

test('검사 시점에 leafCount 읽기가 던지면 cull: 오류', () => {
  const bad = withLeafCount(scene(), () => { throw new TypeError('boom'); });
  assert.throws(() => cullAndSelect(bad, CAM, OPTS), (e) => RX.test(String(e)));
});

test('검사 시점에 첫 읽기부터 던지는 Proxy octree 도 cull: 오류', () => {
  const h = scene();
  const bad = { ...h, octree: new Proxy(h.octree, { get() { throw new TypeError('boom'); } }) };
  assert.throws(() => cullAndSelect(bad, CAM, OPTS), (e) => RX.test(String(e)));
});

test('leafCount 는 검사 블록에서 읽은 값을 그대로 쓴다(마스크 길이가 첫 읽기 값)', () => {
  const h = scene();
  const real = h.octree.leafCount;
  // 접근자를 거쳐도 결과 길이는 검사 때 읽은 값과 같다
  let reads = 0;
  const probe = withLeafCount(h, () => { reads++; return real; });
  const r = cullAndSelect(probe, CAM, OPTS);
  assert.equal(r.cull.mask.length, real);
  assert.equal(r.cull.stats.leafCount, real);
  assert.ok(reads >= 1);
});

test('정상 입력 결과는 그대로', () => {
  const h = scene();
  const r = cullAndSelect(h, CAM, OPTS);
  assert.equal(r.cull.mask.length, h.octree.leafCount);
  assert.equal(r.cull.stats.kept, r.cull.chunks.length);
});
