// 카메라 추적 층이 네트워크·타이머를 쓰지 않는지 검사(계약: '이 층은 네트워크·타이머를 쓰지 않는다').
import test from 'node:test';
import assert from 'node:assert/strict';
import { installNetworkSpies } from '../buildings/network_spies.mjs';

test('no_network: 카메라 추적 층 전체 사용 중 전역 fetch·타이머·WebSocket 호출 0', async () => {
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
  const unwrapTimers = () => { for (const name of Object.keys(timerOrig)) globalThis[name] = timerOrig[name]; };
  try {
    // 동적 import 로 index.mjs 불러오기. 아직 없으면 실패한다.
    let mod;
    try {
      mod = await import('./index.mjs');
    } catch (e) {
      assert.fail(`client/tower/chase/index.mjs 를 불러올 수 없음(조립 전이면 정상 실패): ${e && e.message}`);
    }
    assert.equal(typeof mod.createChaseCamera, 'function', 'createChaseCamera 를 내보내야 함');

    // 카메라 추적 층 생성
    const chase = mod.createChaseCamera();

    // setTarget 호출: 추적 목표 설정
    chase.setTarget([0, 0, 10], 0);

    // step(0.1) 을 10 회 실행
    for (let i = 0; i < 10; i += 1) {
      const pose = chase.step(0.1);
      assert.equal(typeof pose, 'object', 'step 은 객체를 돌려야 함');
      assert.ok(Array.isArray(pose.pos) && pose.pos.length === 3, 'pose.pos 는 [x,y,z] 배열이어야 함');
      assert.equal(typeof pose.yaw, 'number', 'pose.yaw 는 숫자여야 함');
    }

    // snap() 호출: 추적을 목표에 즉시 맞춘다
    chase.snap();

    // camera() 호출
    const camera = chase.camera();
    assert.equal(typeof camera, 'object', 'camera 는 객체를 돌려야 함');
    assert.ok(Array.isArray(camera.pos) && camera.pos.length === 3, 'camera.pos 는 [x,y,z] 배열이어야 함');
    assert.ok(Array.isArray(camera.quat) && camera.quat.length === 4, 'camera.quat 는 [x,y,z,w] 배열이어야 함');
    assert.equal(typeof camera.fovY, 'number', 'camera.fovY 는 숫자여야 함');

    // 카메라 추적 층이 타이머를 만들지 않았는지 확인(생성 자체가 위반)
    assert.deepEqual(timerCreated, [], `카메라 추적 층이 타이머를 만들었음: ${timerCreated.join(',')}`);
  } finally {
    unwrapTimers();
    // 지연 호출까지 비운 뒤에 calls 를 읽는다(건물 층 시험과 같은 순서).
    await spies.restore();
  }
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

test('no_network: chase 소스에 네트워크·타이머·비동기 호출이 없다', async () => {
  const { readFileSync } = await import('node:fs');
  const banned = /\b(fetch|XMLHttpRequest|WebSocket|setTimeout|setInterval|setImmediate|await|async)\b|node:timers/;
  for (const f of ['damp', 'rig', 'state', 'index']) {
    const src = readFileSync(new URL(`./${f}.mjs`, import.meta.url), 'utf8')
      .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.ok(!banned.test(src), `${f}.mjs 에 금지어: ${src.match(banned)?.[0]}`);
  }
});
