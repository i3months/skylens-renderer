import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTowerInput } from './index.mjs';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('index: keyDown → step → camera 가 한 프레임 안 동기 호출에서 갱신된다', () => {
  const inp = createTowerInput({ pos: [0, 0, 10], yaw: 0, speedMps: 10 });
  const before = inp.camera().pos;
  assert.equal(inp.keyDown('ArrowUp'), true);
  const p = inp.step(0.1);
  const after = inp.camera().pos;
  // 기준값: yaw 0, speed 10, dt 0.1 -> y = 1, x = 0.
  near(after[1], 1);
  near(after[0], 0);
  near(p.pos[1], 1);
  assert.notDeepEqual(before, after);
  assert.equal(inp.keyDown('KeyZ'), false);
  assert.throws(() => createTowerInput({ pos: [0, 0] }), TypeError);
  assert.throws(() => createTowerInput({ pos: [0, NaN, 0] }), RangeError);
  assert.throws(() => createTowerInput({ yaw: Infinity }), RangeError);
  assert.throws(() => createTowerInput({ bogus: 1 }), RangeError);
});

test('index: 네트워크·타이머를 쓰지 않는다', () => {
  const src = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
  for (const w of ['fetch', 'setTimeout', 'setInterval', 'XMLHttpRequest', 'WebSocket']) {
    assert.equal(src.includes(w), false, w);
  }
});

test('index: dt 상한과 반대 키 상쇄', () => {
  // dt 0.5 s 는 상한 0.25 s 로 잘린다: y = 10 * 0.25 = 2.5.
  const a = createTowerInput({ pos: [0, 0, 10], yaw: 0 });
  a.keyDown('ArrowUp');
  near(a.step(0.5).pos[1], 2.5);
  // 좌우 동시면 방위 불변.
  const b = createTowerInput({ pos: [0, 0, 10], yaw: 0.3 });
  b.keyDown('ArrowLeft');
  b.keyDown('ArrowRight');
  near(b.step(0.1).yaw, 0.3);
  near(b.pose().yaw, 0.3);
});
