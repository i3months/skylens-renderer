// F-145: 리프 0 개 계층(leafCount < 1)은 거리 컬링이 'cull:' 구조 오류로 던진다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceCull } from './index.mjs';

const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const cam = { width: 640, height: 480, K: { fx: 500, fy: 500, cx: 320, cy: 240 }, R: I, t: [0, 0, 0] };

function make(leafCount, nodeCount) {
  return {
    octree: {
      leafCount, nodeCount,
      leafIndex: new Int32Array(nodeCount).fill(-1),
      boxMin: new Float32Array(3 * nodeCount), boxMax: new Float32Array(3 * nodeCount),
    },
    levels: [{ leafStart: new Uint32Array(leafCount + 1) }],
  };
}

test('leafCount 0, nodeCount 1 계층은 모든 maxDistanceM 에서 cull: 오류', () => {
  for (const m of [1000, Infinity, undefined, NaN, -1]) {
    assert.throws(() => distanceCull(make(0, 1), cam, { maxDistanceM: m }), /cull:/);
  }
});

test('leafCount 0, nodeCount 0 계층도 cull: 오류', () => {
  assert.throws(() => distanceCull(make(0, 0), cam, { maxDistanceM: 10 }), /cull:/);
});

test('정상 계층(리프 1 개)은 영향 없음', () => {
  const h = make(1, 1);
  h.octree.leafIndex[0] = 0;
  h.octree.boxMax.set([1, 1, 1]);
  h.levels[0].leafStart = new Uint32Array([0, 1]);
  assert.deepEqual(Array.from(distanceCull(h, cam, { maxDistanceM: 1000 })), [1]);
});
