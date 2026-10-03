// F-150 ②: 상자 좌표에 ±Infinity 가 있으면 리프를 제거하지 않고 'cull:' 오류를 던진다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { viewpointToCamera } from '../../tools/render_views/index.mjs';
import { clientFrustumCull } from './index.mjs';

const cam = viewpointToCamera({ eye: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], fov_y_deg: 50, width: 64, height: 48 });
const make = () => ({ boxMin: new Float32Array([-1, -1, -1, -1, -1, -1]), boxMax: new Float32Array([1, 1, 1, 1, 1, 1]) });

for (const v of [Infinity, -Infinity]) {
  for (const which of ['boxMin', 'boxMax']) {
    for (const idx of [0, 4]) {
      test(`F-150 ${which}[${idx}] = ${v} -> cull: 오류`, () => {
        const lb = make();
        lb[which][idx] = v;
        assert.throws(() => clientFrustumCull(lb, cam), /^Error: cull:/);
        assert.throws(() => clientFrustumCull(lb, cam, { pointSizeM: 0.1 }), /^Error: cull:/);
      });
    }
  }
}

test('F-150 양성 대조: 유한 상자 -> 마스크 [1, 1]', () => {
  assert.deepEqual(Array.from(clientFrustumCull(make(), cam)), [1, 1]);
});

test('F-150 NaN 은 기존 정책 유지(던지지 않음)', () => {
  const lb = make();
  lb.boxMin[0] = NaN;
  assert.doesNotThrow(() => clientFrustumCull(lb, cam));
});
