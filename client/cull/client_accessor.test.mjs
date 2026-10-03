// F-152 ⑤: leafBoxes 읽기에서 getter·Proxy 가 던져도 원래 오류가 새지 않고 'cull:' 오류로 감싼다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { viewpointToCamera } from '../../tools/render_views/index.mjs';
import { clientFrustumCull } from './index.mjs';

const cam = viewpointToCamera({ eye: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], fov_y_deg: 50, width: 64, height: 48 });

test('F-152 Proxy 가 던지는 leafBoxes -> cull: 오류, 원래 메시지 포함', () => {
  const lb = new Proxy({}, { get() { throw new Error('프록시 폭발'); } });
  assert.throws(() => clientFrustumCull(lb, cam), (e) => /^Error: cull:/.test(String(e)) && e.message.includes('프록시 폭발'));
});

test('F-152 getter 가 던지는 boxMin/boxMax -> cull: 오류', () => {
  const f32 = new Float32Array(3);
  const a = { get boxMin() { throw new Error('getter 폭발'); }, boxMax: f32 };
  assert.throws(() => clientFrustumCull(a, cam), (e) => /^Error: cull:/.test(String(e)) && e.message.includes('getter 폭발'));
  const b = { boxMin: f32, get boxMax() { throw new RangeError('getter2'); } };
  assert.throws(() => clientFrustumCull(b, cam), (e) => /^Error: cull:/.test(String(e)) && e.message.includes('getter2'));
});

test('F-152 양성 대조: 정상 leafBoxes -> [1]', () => {
  const lb = { boxMin: new Float32Array([-1, -1, -1]), boxMax: new Float32Array([1, 1, 1]) };
  assert.deepEqual(Array.from(clientFrustumCull(lb, cam)), [1]);
});
