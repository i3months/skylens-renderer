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
  for (const f of ['index.mjs', 'state.mjs', 'keys.mjs', 'camera.mjs']) {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
    for (const w of ['fetch', 'setTimeout', 'setInterval', 'setImmediate', 'XMLHttpRequest', 'WebSocket']) {
      assert.equal(src.includes(w), false, `${f}: ${w}`);
    }
  }
});

test('index: dt 상한과 반대 키 상쇄', () => {
  // dt 0.5 s 는 상한 0.25 s 로 잘린다: y = 8 * 0.25 = 2.
  const a = createTowerInput({ pos: [0, 0, 10], yaw: 0 });
  a.keyDown('ArrowUp');
  near(a.step(0.5).pos[1], 2);
  // 좌우 동시면 방위 불변.
  const b = createTowerInput({ pos: [0, 0, 10], yaw: 0.3 });
  b.keyDown('ArrowLeft');
  b.keyDown('ArrowRight');
  near(b.step(0.1).yaw, 0.3);
  near(b.pose().yaw, 0.3);
});

test('index: 앞뒤·고도 반대 키는 keys 경유로 상쇄된다', () => {
  const a = createTowerInput({ pos: [0, 0, 10], yaw: 0 });
  a.keyDown('ArrowUp');
  a.keyDown('ArrowDown');
  const pa = a.step(0.1).pos;
  near(pa[0], 0); near(pa[1], 0); near(pa[2], 10);
  const b = createTowerInput({ pos: [0, 0, 10], yaw: 0 });
  b.keyDown('KeyE');
  b.keyDown('KeyQ');
  const pb = b.step(0.1).pos;
  near(pb[0], 0); near(pb[1], 0); near(pb[2], 10);
});

test('index: keyDown → releaseAll → step 뒤 위치 불변', () => {
  const inp = createTowerInput({ pos: [0, 0, 10], yaw: 0 });
  inp.keyDown('ArrowUp');
  inp.releaseAll();
  const p = inp.step(0.1);
  assert.deepEqual(p.pos, [0, 0, 10]);
  assert.deepEqual(inp.pose().pos, [0, 0, 10]);
});

test('index: opts 범위 위반은 RangeError', () => {
  assert.throws(() => createTowerInput({ maxDtSec: -1 }), RangeError);
  assert.throws(() => createTowerInput({ maxDtSec: 0 }), RangeError);
  assert.throws(() => createTowerInput({ minAltM: 10, maxAltM: 5 }), RangeError);
  assert.throws(() => createTowerInput({ speedMps: -1 }), RangeError);
  assert.throws(() => createTowerInput({ yawRateRad: -0.1 }), RangeError);
  assert.throws(() => createTowerInput({ altRateMps: -5 }), RangeError);
  // 경계값(minAltM = maxAltM)은 허용한다.
  assert.doesNotThrow(() => createTowerInput({ minAltM: 5, maxAltM: 5 }));
});

test('index: 기본값 ArrowRight step(0.2) → yaw 0.19 (기본 선회율 0.95)', () => {
  const inp = createTowerInput({ pos: [0, 0, 10], yaw: 0 });
  inp.keyDown('ArrowRight');
  near(inp.step(0.2).yaw, 0.19);
});
