// F-148/F-149: 계층 필드 getter·Proxy 예외, levels 없음/빈 배열, 일반 배열 입력은 모두 'cull:' 오류. 정상 입력은 영향 없음.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHierarchy } from '../../lod/select/index.mjs';
import { orderChunks, leafPriority } from './index.mjs';

const CAM = { width: 320, height: 180, K: { fx: 400, fy: 400, cx: 160, cy: 90 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
const pos = [];
for (let i = 0; i < 20; i++) for (let j = 0; j < 12; j++) pos.push((i - 10) * 0.05, (j - 6) * 0.05, 1.5);
const n = pos.length / 3;
const cloud = { format: 1, count: n, positions: Float32Array.from(pos), normals: new Float32Array(3 * n), colors: new Uint8Array(3 * n).fill(200) };
const good = buildHierarchy(cloud, { edge0M: 0.05, levelCount: 2, maxLeafPoints: 16 });
const L = good.octree.leafCount;
const mask = new Uint8Array(L).fill(1);
const CULL = /^Error: cull:/;
const bad = (h) => {
  assert.throws(() => leafPriority(h, CAM), (e) => CULL.test(String(e)));
  assert.throws(() => orderChunks(h, CAM, mask), (e) => CULL.test(String(e)));
};

test('octree 필드 getter 가 던지면 cull: 오류', () => {
  const oc = { ...good.octree };
  Object.defineProperty(oc, 'boxMin', { get() { throw new RangeError('boom'); } });
  bad({ ...good, octree: oc });
});

test('Proxy 가 던지면 cull: 오류', () => {
  const thrower = new Proxy({}, { get() { throw new Error('trap'); }, has() { throw new Error('trap'); } });
  bad({ ...good, octree: thrower });
  bad(new Proxy(good, { get() { throw new Error('trap'); } }));
});

test('levels 없음·levels=[] 은 cull: 오류', () => {
  bad({ octree: good.octree });
  bad({ ...good, levels: [] });
  bad({ ...good, levels: [{}] });
});

test('일반 배열 boxMin·boxMax·leafIndex·positions 는 cull: 오류', () => {
  bad({ ...good, octree: { ...good.octree, boxMin: Array.from(good.octree.boxMin) } });
  bad({ ...good, octree: { ...good.octree, boxMax: Array.from(good.octree.boxMax) } });
  bad({ ...good, octree: { ...good.octree, leafIndex: Array.from(good.octree.leafIndex) } });
  bad({ ...good, levels: [{ ...good.levels[0], positions: Array.from(good.levels[0].positions) }, ...good.levels.slice(1)] });
});

test('정상 계층 양성 대조: 던지지 않고 결과 길이·순서가 유효', () => {
  const s = leafPriority(good, CAM);
  assert.equal(s.length, L);
  const o = orderChunks(good, CAM, mask);
  assert.equal(o.length, L);
  assert.deepEqual([...o].sort((a, b) => a - b), [...Array(L).keys()]);
});
