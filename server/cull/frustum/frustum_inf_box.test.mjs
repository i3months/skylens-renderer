import test from 'node:test';
import assert from 'node:assert/strict';
import { frustumCull } from './index.mjs';

const cam = { width: 64, height: 48, K: { fx: 50, fy: 50, cx: 32, cy: 24 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 5] };

// 상자는 카메라 앞 [-1,1]^3, 리프마다 leafStart 구간 1 점.
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

test('리프 노드 상자에 ±Infinity 가 있으면 cull: 오류', () => {
  for (const [arr, v] of [['boxMin', Infinity], ['boxMin', -Infinity], ['boxMax', Infinity], ['boxMax', -Infinity]]) {
    const h = hier(2, [-1, 0, 1]);
    h.octree[arr][3 * 2 + 1] = v;
    assert.throws(() => frustumCull(h, cam), /^Error: cull:/);
    assert.throws(() => frustumCull(h, cam, { pointSizeM: 0.1 }), /^Error: cull:/);
  }
});

test('중복 leafIndex 는 cull: 오류', () => {
  assert.throws(() => frustumCull(hier(2, [1, 1]), cam), /^Error: cull:/);
});

test('정상 입력은 기존과 같은 마스크이고 내부 노드의 ±Infinity 는 무시', () => {
  assert.deepEqual(Array.from(frustumCull(hier(2, [-1, 0, 1]), cam)), [1, 1]);
  assert.deepEqual(Array.from(frustumCull(hier(1, [0]), cam)), [1]);
  const h = hier(2, [-1, 0, 1]);
  h.octree.boxMin[0] = -Infinity;
  assert.deepEqual(Array.from(frustumCull(h, cam)), [1, 1]);
});
