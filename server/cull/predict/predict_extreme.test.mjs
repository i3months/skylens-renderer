// F-138 ⑦: 부풀림 m 이 유한하지 않은 극단 입력은 보수적으로 남긴다(horizon 을 늘려도 남는 리프가 줄지 않는다).
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../../../fixtures/scenes/terrain/index.mjs';
import { buildHierarchy } from '../../lod/hierarchy/index.mjs';
import { predictiveMask } from './index.mjs';

const cloud0 = generate({ seed: 3, count: 20000 });
const h = buildHierarchy(cloud0.cloud ?? cloud0, { edge0M: 0.4, levelCount: 3, maxLeafPoints: 512 });
const n = h.octree.leafCount;
const count = (m) => m.reduce((a, b) => a + b, 0);
const cam = { width: 640, height: 480, K: { fx: 400, fy: 400, cx: 320, cy: 240 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 150] };
const run = (horizonS, v, w = [0, 0, 0]) => predictiveMask(h, { camera: cam, velocityMps: v, angularRadPerS: w }, { horizonS, steps: 4, pointSizeM: 0.1 });

test('v=1e10: horizon 을 늘려도 남는 리프가 줄지 않는다(비단조 회귀)', () => {
  let prev = -1;
  for (const hz of [1, 1e3, 1e100, 1e300]) {
    const c = count(run(hz, [1e10, 0, 0]));
    assert.ok(c >= prev, `horizon ${hz}: ${c} < ${prev}`);
    prev = c;
  }
});

test('부풀림이 비유한(v=1e10, horizon=1e300)이면 현재 시점에서 보이던 리프는 모두 남는다', () => {
  const base = run(0, [0, 0, 0]);
  const ext = run(1e300, [1e10, 0, 0]);
  for (let k = 0; k < n; k++) if (base[k]) assert.equal(ext[k], 1, `leaf ${k} 가 거짓 제거됨`);
  assert.ok(count(ext) >= count(base));
});

test('회전 극단(ω=1e10)도 단조', () => {
  const a = count(run(1, [0, 0, 0], [0, 1e10, 0]));
  const b = count(run(1e300, [0, 0, 0], [0, 1e10, 0]));
  assert.ok(b >= a);
});
