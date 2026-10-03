// 거리 컬링의 퇴화 시점 처리: isDegenerateView 와 같은 기준으로 빈 마스크를 돌려준다(F-120).
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
const cam = (over = {}) => ({ width: 640, height: 480, K: { fx: 500, fy: 500, cx: 320, cy: 240 }, R: I, t: [0, 0, 0], ...over });
const h = makeHierarchy(5);
const count = (m) => m.reduce((a, b) => a + b, 0);

test('정상 카메라는 그대로 판정한다', () => {
  assert.equal(count(distanceCull(h, cam(), { maxDistanceM: 1000 })), 5);
  assert.equal(count(distanceCull(h, cam(), { maxDistanceM: Infinity })), 5);
  // 리프 k 의 최소 거리는 k*sqrt3: 2.5 이하면 리프 0, 1 만 남는다.
  assert.deepEqual(Array.from(distanceCull(h, cam(), { maxDistanceM: 2.5 })), [1, 1, 0, 0, 0]);
});

const bad = {
  'width 1, fx 1e7': cam({ width: 1, height: 1, K: { fx: 1e7, fy: 1e7, cx: 0, cy: 0 } }),
  '해상도 8193x8193': cam({ width: 8193, height: 8193 }),
  '해상도 2e9': cam({ width: 2e9, height: 2e9 }),
  'R = 0': cam({ R: new Array(9).fill(0) }),
  'R = 2I': cam({ R: [2, 0, 0, 0, 2, 0, 0, 0, 2] }),
  '반사 R': cam({ R: [-1, 0, 0, 0, 1, 0, 0, 0, 1] }),
  '거의 직교인 R (편차 1e-6 직후)': cam({ R: [1 + 1.5e-6, 0, 0, 0, 1, 0, 0, 0, 1] }),
  'width/height 없음': { K: { fx: 500, fy: 500, cx: 320, cy: 240 }, R: I, t: [0, 0, 0] },
  'K 없음': { width: 640, height: 480, R: I, t: [0, 0, 0] },
  'NaN t': cam({ t: [NaN, 0, 0] }),
};
for (const [name, c] of Object.entries(bad)) {
  for (const m of [1000, Infinity]) {
    test(`퇴화 시점(${name}), maxDistanceM=${m} → 빈 마스크`, () => {
      const mask = distanceCull(h, c, { maxDistanceM: m });
      assert.equal(mask.length, 5);
      assert.equal(count(mask), 0);
    });
  }
}
