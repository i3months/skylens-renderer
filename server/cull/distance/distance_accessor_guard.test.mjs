// F-148: 계층의 접근자·Proxy 가 던지는 예외는 'cull:' 오류로 나와야 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceCull } from './index.mjs';

function makeHierarchy(n) {
  const boxMin = new Float32Array(3 * n), boxMax = new Float32Array(3 * n);
  for (let k = 0; k < n; k++) for (let a = 0; a < 3; a++) { boxMin[3 * k + a] = k; boxMax[3 * k + a] = k + 1; }
  const leafStart = new Uint32Array(Array.from({ length: n + 1 }, (_, i) => i));
  return {
    octree: { leafCount: n, nodeCount: n, leafIndex: new Int32Array(Array.from({ length: n }, (_, i) => i)), boxMin, boxMax, leafStart },
    levels: [{ leafStart }],
  };
}
const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const cam = { width: 640, height: 480, K: { fx: 500, fy: 500, cx: 320, cy: 240 }, R: I, t: [0, 0, 0] };
const opts = { maxDistanceM: 2.5 };

test('octree getter 가 던지면 cull: 오류', () => {
  const h = { get octree() { throw new TypeError('boom'); }, levels: [] };
  assert.throws(() => distanceCull(h, cam, opts), /^Error: cull:/);
});

test('Proxy 가 던지는 계층은 cull: 오류', () => {
  const h = new Proxy({}, { get() { throw new TypeError('boom'); } });
  assert.throws(() => distanceCull(h, cam, opts), /^Error: cull:/);
});

test('levels getter 가 던져도 cull: 오류', () => {
  const base = makeHierarchy(5);
  const h = { octree: base.octree, get levels() { throw new TypeError('boom'); } };
  assert.throws(() => distanceCull(h, cam, opts), /^Error: cull:/);
});

test('정상 계층은 마스크가 변하지 않는다(양성 대조)', () => {
  assert.deepEqual(Array.from(distanceCull(makeHierarchy(5), cam, opts)), [1, 1, 0, 0, 0]);
});
