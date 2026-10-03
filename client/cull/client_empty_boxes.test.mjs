// F-148 ②: clientFrustumCull 은 상자 0 개이면 빈 마스크가 아니라 'cull:' 오류를 던진다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { viewpointToCamera } from '../../tools/render_views/index.mjs';
import { clientFrustumCull } from './index.mjs';

const cam = viewpointToCamera({ eye: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], fov_y_deg: 50, width: 64, height: 48 });
const degenerate = { ...cam, width: 0 };
const empty = () => ({ boxMin: new Float32Array(0), boxMax: new Float32Array(0) });

test('F-148 빈 상자 + 정상 카메라 -> cull: 오류', () => {
  assert.throws(() => clientFrustumCull(empty(), cam), /^Error: cull:/);
  assert.throws(() => clientFrustumCull(empty(), cam, { pointSizeM: 0.1 }), /^Error: cull:/);
});

test('F-148 빈 상자 + 퇴화 카메라 -> cull: 오류', () => {
  assert.throws(() => clientFrustumCull(empty(), degenerate), /^Error: cull:/);
});

test('F-148 양성 대조: 상자 1 개 -> 마스크 [1], 퇴화 카메라 -> [0]', () => {
  const one = { boxMin: new Float32Array([-1, -1, -1]), boxMax: new Float32Array([1, 1, 1]) };
  assert.deepEqual(Array.from(clientFrustumCull(one, cam)), [1]);
  assert.deepEqual(Array.from(clientFrustumCull(one, degenerate)), [0]);
});
