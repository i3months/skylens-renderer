import test from 'node:test';
import assert from 'node:assert/strict';
import { frustumCull } from './index.mjs';

const cam = { width: 64, height: 48, K: { fx: 50, fy: 50, cx: 32, cy: 24 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

function hier(leafCount, nodeCount) {
  const leafIndex = new Int32Array(nodeCount).fill(-1);
  for (let i = 0; i < Math.min(leafCount, nodeCount); i++) leafIndex[i] = i;
  const leafStart = new Uint32Array(leafCount + 1);
  for (let i = 0; i <= leafCount; i++) leafStart[i] = i;
  return {
    octree: { leafCount, nodeCount, leafIndex, boxMin: new Float32Array(3 * nodeCount).fill(-1), boxMax: new Float32Array(3 * nodeCount).fill(1) },
    levels: [{ leafStart }],
  };
}

// F-145: leafCount 0 계층은 빈 마스크가 아니라 'cull:' 오류
test('leafCount 0 · nodeCount 1 계층은 cull: 오류', () => {
  assert.throws(() => frustumCull(hier(0, 1), cam), /cull:/);
  assert.throws(() => frustumCull(hier(0, 1), cam, { pointSizeM: 0.1 }), /cull:/);
});

test('정상 계층(leafCount 1)은 영향 없음', () => {
  const m = frustumCull(hier(1, 1), { ...cam, t: [0, 0, 5] });
  assert.equal(m.length, 1);
});

test('필드 읽기 중 예외(접근자·Proxy)도 cull: 오류', () => {
  const h = hier(1, 1);
  Object.defineProperty(h.octree, 'leafCount', { get() { throw new RangeError('boom'); } });
  assert.throws(() => frustumCull(h, cam), /cull:/);
  const p = new Proxy({}, { get() { throw new Error('boom'); } });
  assert.throws(() => frustumCull(p, cam), /cull:/);
});
