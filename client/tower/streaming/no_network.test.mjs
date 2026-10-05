// 조각 요청 층이 네트워크·타이머를 쓰지 않는지 검사(계약: '이 층은 네트워크·타이머를 쓰지 않는다').
// 런타임 감시만 한다: 전역·node 모듈 진입점을 가로채 호출을 센다. 소스 정적 검색은 하지 않는다.
// 감시 설치(installWatch)를 함수로 빼서 본 시험과 양성 대조가 같은 감시를 쓴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import timersCjs from 'node:timers';
import timersPromises from 'node:timers/promises';
import { syncBuiltinESMExports } from 'node:module';
import { installNetworkSpies } from '../buildings/network_spies.mjs';
import { poseToCameraPose } from '../input/camera.mjs';

const TIMER_NAMES = ['setTimeout', 'setInterval', 'setImmediate'];
const realSetImmediate = setImmediate; // 감시를 걸기 전의 진짜 setImmediate(비우기 전용)

/** 타이머 생성 자체를 세는 래퍼: 전역, node:timers, node:timers/promises(scheduler.wait·yield 포함). */
function installTimerCounters() {
  const created = [];
  const restores = [];
  const wrap = (obj, name, label) => {
    const orig = obj[name];
    if (typeof orig !== 'function') return;
    obj[name] = function countedTimer(...args) {
      created.push(`${label}${name}`);
      return orig.apply(this, args);
    };
    restores.push(() => { obj[name] = orig; });
  };
  for (const name of TIMER_NAMES) {
    wrap(globalThis, name, '');
    wrap(timersCjs, name, 'node:timers.');
    wrap(timersPromises, name, 'node:timers/promises.');
  }
  for (const name of ['wait', 'yield']) wrap(timersPromises.scheduler, name, 'node:timers/promises.scheduler.');
  syncBuiltinESMExports();
  const restore = () => {
    for (const r of restores.reverse()) r();
    syncBuiltinESMExports();
  };
  return { created, restore };
}

/**
 * 네트워크 감시자와 타이머 계수기를 함께 건다.
 * await watch.restore() 는 마이크로태스크·setImmediate 한 바퀴를 비워 미룬 호출까지 기록한 뒤에 계수기를 풀고 감시자를 원복한다.
 * 그 뒤에 calls(네트워크)와 created(타이머)를 읽는다.
 */
function installWatch() {
  const spies = installNetworkSpies();
  const timers = installTimerCounters();
  let done = false;
  const restore = async () => {
    if (done) return;
    done = true;
    try {
      for (let i = 0; i < 2; i += 1) await new Promise((r) => realSetImmediate(r)); // 마이크로태스크·setImmediate 비우기
    } finally {
      timers.restore();
      await spies.restore();
    }
  };
  return { calls: spies.calls, created: timers.created, restore };
}

// 지면을 내려다보는 시점(pitch -0.5).
const POSE = poseToCameraPose({ pos: [10, 20, 80], yaw: 0.3, pitch: -0.5 }, 1);
const SIZE = { width: 640, height: 480 };

test('index: 네트워크·타이머를 쓰지 않는다', async () => {
  const watch = installWatch();
  try {
    let mod;
    try {
      mod = await import('./index.mjs');
    } catch (e) {
      assert.fail(`client/tower/streaming/index.mjs 를 불러올 수 없음(조립 전이면 정상 실패): ${e && e.message}`);
    }
    assert.equal(typeof mod.createTowerStreaming, 'function', 'createTowerStreaming 을 내보내야 함');

    const s = mod.createTowerStreaming();
    for (let i = 0; i < 5; i += 1) {
      const pose = { ...POSE, pos: [10 + i * 40, 20, 80] }; // quat 는 그대로, 위치만 이동
      const plan = s.update(pose, SIZE);
      assert.ok(Array.isArray(plan.needed) && plan.needed.length > 0, 'update 는 needed 를 돌려야 함');
      assert.ok(Array.isArray(plan.request), 'update 는 request 를 돌려야 함');
      const miss = s.missing(pose, SIZE);
      assert.ok(Array.isArray(miss), 'missing 은 배열이어야 함');
      const [a, b, c] = plan.request;
      if (a) assert.equal(s.arrived(a.tx, a.ty), true);
      if (b) assert.equal(s.failed(b.tx, b.ty), true);
      if (c) assert.equal(s.arrived(c.tx, c.ty), true);
      assert.equal(s.arrived(99999, 99999), false);
      assert.equal(s.failed(99999, 99999), false);
      const st = s.state();
      assert.ok(Array.isArray(st.held) && Array.isArray(st.inflight), 'state 는 held·inflight 를 돌려야 함');
    }
    s.reset();
    assert.deepEqual(s.state(), { held: [], inflight: [] });
  } finally {
    await watch.restore();
  }
  // 복원 뒤에 호출 수를 단언한다(타이머 생성 자체가 위반).
  assert.deepEqual(watch.created, [], `조각 요청 층이 타이머를 만들었음: ${watch.created.join(',')}`);
  assert.deepEqual(watch.calls, [], `네트워크 감시자가 호출을 기록했음: ${watch.calls.join(',')}`);
});

// 양성 대조: 같은 installWatch 로 감시된 호출이 실제로 계수되는지 본다.
for (const [label, call, want] of [
  ['fetch', () => { globalThis.fetch('http://127.0.0.1:1/x').catch(() => {}); }, 'calls:fetch'],
  ['globalThis.setTimeout', () => { clearTimeout(globalThis.setTimeout(() => {}, 5000)); }, 'created:setTimeout'],
  ['globalThis.setInterval', () => { clearInterval(globalThis.setInterval(() => {}, 5000)); }, 'created:setInterval'],
  ['globalThis.setImmediate', () => { globalThis.setImmediate(() => {}); }, 'created:setImmediate'],
  ['node:timers.setTimeout', () => { clearTimeout(timersCjs.setTimeout(() => {}, 5000)); }, 'created:node:timers.setTimeout'],
  ['node:timers/promises.setTimeout', () => { timersPromises.setTimeout(0); }, 'created:node:timers/promises.setTimeout'],
  ['node:timers/promises.setImmediate', () => { timersPromises.setImmediate(); }, 'created:node:timers/promises.setImmediate'],
  ['node:timers/promises.scheduler.wait', () => { timersPromises.scheduler.wait(0); }, 'created:node:timers/promises.scheduler.wait'],
  ['node:timers/promises.scheduler.yield', () => { timersPromises.scheduler.yield(); }, 'created:node:timers/promises.scheduler.yield'],
]) {
  for (const [how, defer] of [
    ['직접', (fn) => fn()],
    ['queueMicrotask 로 미룬', (fn) => queueMicrotask(fn)],
  ]) {
    test(`no_network: ${how} ${label} 호출이 계수된다(양성 대조)`, async () => {
      const watch = installWatch();
      defer(call);
      await watch.restore();
      const [kind, ...rest] = want.split(':');
      const name = rest.join(':');
      const list = kind === 'calls' ? watch.calls : watch.created;
      assert.ok(list.includes(name), `${name} 가 기록돼야 함: ${list.join(',')}`);
    });
  }
}

test('no_network: 감시를 풀면 계수기도 원복된다', async () => {
  const before = { st: globalThis.setTimeout, f: globalThis.fetch, w: timersPromises.scheduler.wait };
  const watch = installWatch();
  assert.notEqual(globalThis.setTimeout, before.st);
  await watch.restore();
  assert.equal(globalThis.fetch, before.f);
  assert.equal(timersPromises.scheduler.wait, before.w);
});
