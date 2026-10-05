import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createChaseCamera } from './index.mjs';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('index: 목표가 없으면 camera() 는 null', () => {
  const c = createChaseCamera();
  assert.equal(c.camera(), null);
  assert.equal(c.step(0.1), null);
  c.snap();
  assert.equal(c.camera(), null);
  // 목표 (0,0,0) yaw 0 직후: 기준값 pos = (0, -30, 10), quat 단위.
  c.setTarget([0, 0, 0], 0);
  const cam = c.camera();
  near(cam.pos[0], 0); near(cam.pos[1], -30); near(cam.pos[2], 10);
  near(Math.hypot(...cam.quat), 1);
  near(cam.fovY, 0.9);
});

test('index: dt 상한과 입력 검사', () => {
  // tau 1, maxDt 0.25: 큰 dt 도 0.25 로 잘린다. 기준값 x = 1 − exp(−0.25)·... = 1·(1 − exp(−0.25)).
  const c = createChaseCamera({ tauSec: 1, maxDtSec: 0.25 });
  c.setTarget([0, 0, 0], 0);
  c.setTarget([1, 0, 0], 0);
  const r = c.step(100);
  near(r.pos[0], 1 - Math.exp(-0.25), 1e-12);
  near(c.step(0).pos[0], r.pos[0], 0);
  // 입력 검사.
  assert.throws(() => c.step(NaN), RangeError);
  assert.throws(() => c.step(-1), RangeError);
  assert.throws(() => c.step(Infinity), RangeError);
  assert.throws(() => createChaseCamera(null), TypeError);
  assert.throws(() => createChaseCamera({ tauSec: '1' }), TypeError);
  assert.throws(() => createChaseCamera({ bogus: 1 }), RangeError);
  assert.throws(() => createChaseCamera({ tauSec: NaN }), RangeError);
  assert.throws(() => createChaseCamera({ tauSec: -1 }), RangeError);
  assert.throws(() => createChaseCamera({ distM: -1 }), RangeError);
  assert.throws(() => createChaseCamera({ heightM: Infinity }), RangeError);
  assert.throws(() => createChaseCamera({ maxDtSec: 0 }), RangeError);
  assert.throws(() => createChaseCamera({ fovYRad: 0 }), RangeError);
  assert.throws(() => createChaseCamera({ fovYRad: Math.PI }), RangeError);
  assert.throws(() => createChaseCamera({ fovYRad: 1e-50 }), RangeError); // float32 로 0
  assert.throws(() => c.setTarget([0, 0], 0), TypeError);
  assert.throws(() => c.setTarget([0, 0, 0], 'x'), TypeError);
  assert.throws(() => c.setTarget([0, NaN, 0], 0), RangeError);
  assert.throws(() => c.setTarget([0, 0, 0], Infinity), RangeError);
  assert.doesNotThrow(() => createChaseCamera({ tauSec: 0, distM: 0 }));
});

test('index: 반환 복사본을 바꿔도 내부 상태는 불변', () => {
  const c = createChaseCamera();
  const p = [5, 6, 7];
  c.setTarget(p, 0);
  p[0] = 999; // 입력 배열 변경
  const cam = c.camera();
  near(cam.pos[0], 5);
  cam.pos[0] = 123; cam.quat[0] = 9;
  const s = c.step(0.1);
  s.pos[0] = 456;
  const cam2 = c.camera();
  near(cam2.pos[0], 5); near(cam2.pos[1], 6 - 30); near(cam2.pos[2], 17);
  assert.ok(Math.abs(cam2.quat[0]) <= 1);
  near(c.step(0).pos[0], 5);
});

test('index: 네트워크·타이머를 쓰지 않는다', () => {
  const src = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
  for (const w of ['fetch', 'setTimeout', 'setInterval', 'XMLHttpRequest', 'WebSocket', 'await']) {
    assert.equal(src.includes(w), false, w);
  }
});
