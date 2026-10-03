// F-150: 거리 컬링도 공용 리프 검사를 쓴다. ±Infinity 상자·중복 leafIndex 는 'cull:' 오류.
import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceCull } from './index.mjs';

const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const cam = { width: 640, height: 480, K: { fx: 500, fy: 500, cx: 320, cy: 240 }, R: I, t: [0, 0, 0] };

function make() {
  return {
    octree: {
      leafCount: 2, nodeCount: 2,
      leafIndex: new Int32Array([0, 1]),
      boxMin: new Float32Array([0, 0, 5, 0, 0, 6]),
      boxMax: new Float32Array([1, 1, 6, 1, 1, 7]),
    },
    levels: [{ leafStart: new Uint32Array([0, 1, 2]) }],
  };
}

test('상자에 ±Infinity 가 있으면 cull: 오류', () => {
  for (const [arr, i, v] of [['boxMin', 2, -Infinity], ['boxMax', 5, Infinity], ['boxMin', 0, Infinity], ['boxMax', 0, -Infinity]]) {
    const h = make();
    h.octree[arr][i] = v;
    assert.throws(() => distanceCull(h, cam, { maxDistanceM: 1000 }), /^Error: cull:/);
  }
});

test('leafIndex 중복은 cull: 오류', () => {
  const h = make();
  h.octree.leafIndex[1] = 0;
  assert.throws(() => distanceCull(h, cam, { maxDistanceM: 1000 }), /^Error: cull:/);
});

test('정상 입력은 그대로 동작', () => {
  assert.deepEqual(Array.from(distanceCull(make(), cam, { maxDistanceM: 1000 })), [1, 1]);
  assert.deepEqual(Array.from(distanceCull(make(), cam, { maxDistanceM: 5.5 })), [1, 0]);
});
