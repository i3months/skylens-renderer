// 입력 층이 네트워크·타이머를 쓰지 않는지 검사(계약: '이 층은 네트워크·타이머를 쓰지 않는다').
import test from 'node:test';
import assert from 'node:assert/strict';
import timersCjs from 'node:timers';
import timersPromises from 'node:timers/promises';
import { syncBuiltinESMExports } from 'node:module';
import { installNetworkSpies } from '../buildings/network_spies.mjs';

test('no_network: 입력 층 전체 사용 중 전역 fetch·타이머·WebSocket 호출 0', async () => {
  const spies = installNetworkSpies();
  // 타이머 생성 자체를 센다: 감시자가 가짜로 바꾼 전역 타이머 위에 계수 래퍼를 얹는다.
  const timerCreated = [];
  const timerOrig = {};
  for (const name of ['setTimeout', 'setInterval', 'setImmediate']) {
    timerOrig[name] = globalThis[name];
    globalThis[name] = function countedTimer(...args) {
      timerCreated.push(name);
      return timerOrig[name].apply(this, args);
    };
  }
  // node:timers 모듈 경유 호출(import * as T from 'node:timers')도 센다: 모듈 객체를 감싸고 ESM 내보내기를 동기화한다.
  const modOrig = {};
  for (const name of ['setTimeout', 'setInterval', 'setImmediate']) {
    modOrig[name] = timersCjs[name];
    timersCjs[name] = function countedModTimer(...args) {
      timerCreated.push(`node:timers.${name}`);
      return modOrig[name].apply(this, args);
    };
  }
  // node:timers/promises(setTimeout·setImmediate·setInterval·scheduler.wait·scheduler.yield)도 센다.
  const promOrig = {};
  for (const name of ['setTimeout', 'setInterval', 'setImmediate']) {
    promOrig[name] = timersPromises[name];
    timersPromises[name] = function countedPromTimer(...args) {
      timerCreated.push(`node:timers/promises.${name}`);
      return promOrig[name].apply(this, args);
    };
  }
  const schedOrig = {};
  for (const name of ['wait', 'yield']) {
    schedOrig[name] = timersPromises.scheduler[name];
    timersPromises.scheduler[name] = function countedSched(...args) {
      timerCreated.push(`node:timers/promises.scheduler.${name}`);
      return schedOrig[name].apply(this, args);
    };
  }
  syncBuiltinESMExports();
  const unwrapTimers = () => {
    for (const name of Object.keys(timerOrig)) globalThis[name] = timerOrig[name];
    for (const name of Object.keys(modOrig)) timersCjs[name] = modOrig[name];
    for (const name of Object.keys(promOrig)) timersPromises[name] = promOrig[name];
    for (const name of Object.keys(schedOrig)) timersPromises.scheduler[name] = schedOrig[name];
    syncBuiltinESMExports();
  };
  try {
    // 동적 import 로 index.mjs 불러오기. 아직 없으면 실패한다.
    let mod;
    try {
      mod = await import('./index.mjs');
    } catch (e) {
      assert.fail(`client/tower/input/index.mjs 를 불러올 수 없음(조립 전이면 정상 실패): ${e && e.message}`);
    }
    assert.equal(typeof mod.createTowerInput, 'function', 'createTowerInput 을 내보내야 함');

    // 입력 층 생성
    const input = mod.createTowerInput();

    // 여섯 키 keyDown (TOWER_INPUT_KEYS 의 모든 키)
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyE', 'KeyQ'];
    for (const key of keys) {
      const ok = input.keyDown(key);
      assert.equal(ok, true, `keyDown(${key}) 는 true 를 돌려야 함`);
    }

    // step(0.1) 을 10 회 실행
    for (let i = 0; i < 10; i += 1) {
      const pose = input.step(0.1);
      assert.equal(typeof pose, 'object', `step 은 객체를 돌려야 함`);
      assert.ok(Array.isArray(pose.pos) && pose.pos.length === 3, 'pose.pos 는 [x,y,z] 배열이어야 함');
      assert.equal(typeof pose.yaw, 'number', 'pose.yaw 는 숫자여야 함');
      assert.equal(typeof pose.pitch, 'number', 'pose.pitch 는 숫자여야 함');
    }

    // camera() 호출
    const camera = input.camera();
    assert.equal(typeof camera, 'object', 'camera 는 객체를 돌려야 함');
    assert.ok(Array.isArray(camera.pos) && camera.pos.length === 3, 'camera.pos 는 [x,y,z] 배열이어야 함');
    assert.ok(Array.isArray(camera.quat) && camera.quat.length === 4, 'camera.quat 는 [x,y,z,w] 배열이어야 함');
    assert.equal(typeof camera.fovY, 'number', 'camera.fovY 는 숫자여야 함');

    // releaseAll() 호출
    input.releaseAll();

  } finally {
    unwrapTimers();
    // 지연 호출까지 비운 뒤에 calls 를 읽는다(건물 층 시험과 같은 순서).
    await spies.restore();
  }
  // 복원 뒤에 호출 수를 단언한다(타이머 생성 자체가 위반).
  assert.deepEqual(timerCreated, [], `입력 층이 타이머를 만들었음: ${timerCreated.join(',')}`);
  assert.deepEqual(spies.calls, [], `네트워크 감시자가 호출을 기록했음: ${spies.calls.join(',')}`);
});

for (const [label, defer] of [
  ['queueMicrotask', (fn) => queueMicrotask(fn)],
  ['setTimeout 5000', (fn) => setTimeout(fn, 5000)],
  ['setImmediate', (fn) => setImmediate(fn)],
]) {
  test(`no_network: ${label} 로 미룬 fetch 는 restore 뒤 calls 에 기록된다(양성 대조)`, async () => {
    const spies = installNetworkSpies();
    defer(() => { globalThis.fetch('http://127.0.0.1:1/x').catch(() => {}); });
    await spies.restore();
    assert.ok(spies.calls.includes('fetch'), `${label} 지연 fetch 가 기록돼야 함`);
  });
}

test('no_network: 감시자가 실제로 호출을 센다(양성 대조)', async (t) => {
  const spies = installNetworkSpies();
  t.after(() => spies.restore());

  // 직접 fetch 호출 - 감시자가 잡아야 함
  globalThis.fetch('http://127.0.0.1:1/test');
  assert.ok(spies.calls.includes('fetch'), '감시자가 fetch 호출을 기록해야 함');
});

// 양성 대조: node:timers/promises 경유 타이머 생성이 감시자에 잡히는지(래퍼 계수 방식 그대로)를 직접 확인한다.
for (const [label, call] of [
  ['setTimeout', (T) => T.setTimeout(0)],
  ['setImmediate', (T) => T.setImmediate()],
  ['setInterval', (T) => T.setInterval(1000)[Symbol.asyncIterator]().return()],
  ['scheduler.wait', (T) => T.scheduler.wait(0)],
  ['scheduler.yield', (T) => T.scheduler.yield()],
]) {
  test(`no_network: node:timers/promises ${label} 호출을 계수 래퍼가 센다(양성 대조)`, async () => {
    const orig = {};
    const created = [];
    const target = label.startsWith('scheduler.') ? timersPromises.scheduler : timersPromises;
    const key = label.replace('scheduler.', '');
    orig[key] = target[key];
    target[key] = function counted(...args) { created.push(key); return orig[key].apply(this, args); };
    try {
      await call(timersPromises);
    } finally {
      target[key] = orig[key];
    }
    assert.deepEqual(created, [key]);
  });
}
