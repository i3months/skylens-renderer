// 시점 예측의 퇴화 시점 처리: 현재·예측 시점 모두 isDegenerateView 로 거르고, 던지지 않는다(F-127).
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../../../fixtures/scenes/terrain/index.mjs';
import { buildHierarchy } from '../../lod/hierarchy/index.mjs';
import { predictiveMask, predictCamera } from './index.mjs';
import { isDegenerateView } from '../degenerate/index.mjs';

const cloud0 = generate({ seed: 3, count: 20000 });
const h = buildHierarchy(cloud0.cloud ?? cloud0, { edge0M: 0.4, levelCount: 3, maxLeafPoints: 512 });
const count = (m) => m.reduce((a, b) => a + b, 0);
// 기준 카메라: 정상(회전·해상도 유효). 지형을 충분히 보도록 멀리서 원점을 향한다.
const good = { width: 640, height: 480, K: { fx: 200, fy: 200, cx: 320, cy: 240 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
const opts = { horizonS: 1, steps: 4, pointSizeM: 0.1 };
const st = (camera, extra = {}) => ({ camera, velocityMps: [0, 0, 0], angularRadPerS: [0, 0, 0], ...extra });

test('정상 카메라는 퇴화가 아니고, 어딘가에서는 리프가 남는다', () => {
  assert.equal(isDegenerateView(good), false);
  let best = 0;
  for (const z of [-200, -100, -50, 50, 100, 200]) {
    for (const y of [0, 20, 60]) {
      best = Math.max(best, count(predictiveMask(h, st({ ...good, t: [0, y, z] }), opts)));
    }
  }
  assert.ok(best > 0, '정상 카메라로 보이는 리프가 하나도 없음');
});

const bad = {
  'width 1, fx 1e7': { ...good, width: 1, height: 1, K: { fx: 1e7, fy: 1e7, cx: 0, cy: 0 } },
  '해상도 8193x8193': { ...good, width: 8193, height: 8193 },
  '해상도 2e9': { ...good, width: 2e9, height: 2e9 },
  'R = 0': { ...good, R: new Array(9).fill(0) },
  'R = 2I': { ...good, R: [2, 0, 0, 0, 2, 0, 0, 0, 2] },
  '반사 R': { ...good, R: [-1, 0, 0, 0, 1, 0, 0, 0, 1] },
  '거의 직교인 R (편차 1e-6 직후)': { ...good, R: [1 + 1.5e-6, 0, 0, 0, 1, 0, 0, 0, 1] },
  'NaN t': { ...good, t: [NaN, 0, 0] },
};
for (const [name, c] of Object.entries(bad)) {
  for (const motion of [{}, { velocityMps: [3, 0, 1], angularRadPerS: [0, 0.2, 0] }]) {
    test(`퇴화 시점(${name}), 이동=${Object.keys(motion).length > 0} → 빈 마스크, 던지지 않음`, () => {
      assert.equal(isDegenerateView(c), true);
      let mask;
      assert.doesNotThrow(() => { mask = predictiveMask(h, st(c, motion), opts); });
      assert.equal(mask.length, h.octree.leafCount);
      assert.equal(count(mask), 0);
    });
  }
}

test('예측 카메라가 퇴화(회전 누적 오차 등)이면 그 표본만 건너뛴다', () => {
  // predictCamera 가 만든 카메라는 정상이어야 하고, 정상 입력에서는 던지지 않는다.
  const p = predictCamera(good, { velocityMps: [1, 0, 0], angularRadPerS: [0, 0.1, 0] }, 1);
  assert.equal(isDegenerateView(p), false);
  assert.doesNotThrow(() => predictiveMask(h, st(good, { velocityMps: [1, 0, 0], angularRadPerS: [0, 0.1, 0] }), opts));
});
