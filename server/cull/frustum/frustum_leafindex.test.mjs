import test from 'node:test';
import assert from 'node:assert/strict';
import { frustumCull } from './index.mjs';

const cam = { width: 64, height: 48, K: { fx: 50, fy: 50, cx: 32, cy: 24 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 5] };

// leafIndex 를 직접 지정해 계층을 만든다. 상자는 카메라 앞 [-1,1]^3.
function hier(leafCount, leafIndexArr) {
  const nodeCount = leafIndexArr.length;
  const leafStart = new Uint32Array(leafCount + 1);
  for (let i = 0; i <= leafCount; i++) leafStart[i] = i;
  return {
    octree: {
      leafCount, nodeCount, leafIndex: Int32Array.from(leafIndexArr),
      boxMin: new Float32Array(3 * nodeCount).fill(-1), boxMax: new Float32Array(3 * nodeCount).fill(1),
    },
    levels: [{ leafStart }],
  };
}

test('leafCount 1 · nodeCount 0 은 cull: 오류(리프 수 불일치)', () => {
  assert.throws(() => frustumCull(hier(1, []), cam), /^Error: cull:/);
  assert.throws(() => frustumCull(hier(1, []), cam, { pointSizeM: 0.1 }), /^Error: cull:/);
});

test('리프 수가 leafCount 보다 적거나 많으면 cull: 오류', () => {
  assert.throws(() => frustumCull(hier(2, [0, -1]), cam), /^Error: cull:/);
  assert.throws(() => frustumCull(hier(1, [0, 1]), cam), /^Error: cull:/);
});

test('중복 leafIndex 는 cull: 오류', () => {
  assert.throws(() => frustumCull(hier(2, [0, 0]), cam), /^Error: cull:/);
});

test('범위 밖 leafIndex(음수 -2·leafCount 이상)는 cull: 오류', () => {
  assert.throws(() => frustumCull(hier(2, [0, -2]), cam), /^Error: cull:/);
  assert.throws(() => frustumCull(hier(2, [0, 2]), cam), /^Error: cull:/);
});

test('정상 계층(내부 노드 -1 포함)은 양성 대조: 오류 없이 마스크', () => {
  const m = frustumCull(hier(2, [-1, 0, 1]), cam);
  assert.equal(m.length, 2);
  assert.deepEqual(Array.from(m), [1, 1]);
  assert.deepEqual(Array.from(frustumCull(hier(1, [0]), cam)), [1]);
});
