// 관제탑 오버레이 층이 네트워크·타이머를 쓰지 않는지 검사(계약: '이 층은 네트워크·타이머를 쓰지 않는다').
// 런타임 감시만 한다: 전역·node 모듈 진입점을 가로채 호출을 센다. 소스 정적 검색은 하지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import timersCjs from 'node:timers';
import timersPromises from 'node:timers/promises';
import { syncBuiltinESMExports } from 'node:module';
import { installNetworkSpies } from '../buildings/network_spies.mjs';

const TIMER_NAMES = ['setTimeout', 'setInterval', 'setImmediate'];
const SCHEDULER_NAMES = ['wait', 'yield'];
// 래퍼 설치 전에 잡아 둔 진짜 setImmediate(계수 대상이 아닌 비우기 전용).
const realSetImmediate = setImmediate;

/** 타이머 생성 자체를 세는 래퍼를 건다: 전역, node:timers(이름 가져오기 포함), node:timers/promises. */
function installTimerCounters() {
  const created = [];
  const restores = [];
  const wrap = (obj, label) => {
    for (const name of TIMER_NAMES) {
      const orig = obj[name];
      if (typeof orig !== 'function') continue;
      obj[name] = function countedTimer(...args) {
        created.push(`${label}${name}`);
        return orig.apply(this, args);
      };
      restores.push(() => { obj[name] = orig; });
    }
  };
  wrap(globalThis, '');
  wrap(timersCjs, 'node:timers.');
  wrap(timersPromises, 'node:timers/promises.');
  // timers/promises.scheduler.wait·yield 도 센다(내부적으로 타이머를 만든다).
  const sched = timersPromises.scheduler;
  for (const name of SCHEDULER_NAMES) {
    const orig = sched[name];
    if (typeof orig !== 'function') continue;
    sched[name] = function countedScheduler(...args) {
      created.push(`node:timers/promises.scheduler.${name}`);
      return orig.apply(this, args);
    };
    restores.push(() => { sched[name] = orig; });
  }
  syncBuiltinESMExports();
  const restore = () => {
    for (const r of restores.reverse()) r();
    syncBuiltinESMExports();
  };
  // 마이크로태스크·setImmediate 를 몇 바퀴 비워 queueMicrotask 등으로 미룬 타이머 생성까지 기록한 뒤 푼다.
  const release = async () => {
    for (let i = 0; i < 3; i += 1) {
      await Promise.resolve();
      await new Promise((r) => realSetImmediate(r));
    }
    restore();
  };
  return { created, restore, release };
}

const POSE = { pos: [0, 0, 100], quat: [0, 0, 0, 1], fovY: 1 };
const SIZE = { width: 640, height: 480 };

test('index: 네트워크·타이머를 쓰지 않는다', async () => {
  const spies = installNetworkSpies();
  const timers = installTimerCounters();
  try {
    let mod;
    try {
      mod = await import('./index.mjs');
    } catch (e) {
      assert.fail(`client/tower/overlay/index.mjs 를 불러올 수 없음(조립 전이면 정상 실패): ${e && e.message}`);
    }
    assert.equal(typeof mod.createTowerOverlay, 'function', 'createTowerOverlay 를 내보내야 함');

    const overlay = mod.createTowerOverlay();
    overlay.setDrones([
      { id: 'a', enu: [1, 2, 30], yaw: 0.5 },
      { id: 'b', enu: [-4, 8, 20] },
    ]);
    overlay.setDetections([
      { id: 'd1', enu: [3, 3, 0], kind: 'alert', confidence: 0.9 },
      { id: 'd2', enu: [5, -2, 1] },
    ]);
    overlay.setPath({ id: 'p1', points: [[0, 0, 10], [10, 0, 10], [10, 10, 12]] });
    overlay.setPath({ id: 'p2', points: [[0, 0, 5], [0, 20, 5]] });

    for (let i = 0; i < 10; i += 1) {
      const out = overlay.project(POSE, SIZE);
      assert.equal(out.drones.length, 2, 'project 는 드론 2개를 돌려야 함');
      assert.equal(out.detections.length, 2, 'project 는 탐지 2개를 돌려야 함');
      assert.equal(out.paths.length, 2, 'project 는 경로 2개를 돌려야 함');
    }
    const p = overlay.unproject(POSE, SIZE, 320, 240, 50);
    assert.ok(Array.isArray(p) && p.length === 3, 'unproject 는 [e,n,u] 를 돌려야 함');
    assert.equal(overlay.removePath('p2'), true);
    overlay.clear();
    assert.deepEqual(overlay.counts(), { drones: 0, detections: 0, paths: 0 });
  } finally {
    // 미룬 타이머 생성이 기록되도록 마이크로태스크·setImmediate 를 비운 뒤에 계수기를 푼다.
    await timers.release();
    // 지연 호출까지 비운 뒤에 calls 를 읽는다(건물 층 시험과 같은 순서).
    await spies.restore();
  }
  // 복원 뒤에 호출 수를 단언한다(타이머 생성 자체가 위반).
  assert.deepEqual(timers.created, [], `오버레이 층이 타이머를 만들었음: ${timers.created.join(',')}`);
  assert.deepEqual(spies.calls, [], `네트워크 감시자가 호출을 기록했음: ${spies.calls.join(',')}`);
});

test('no_network: 타이머 계수기가 전역·node:timers·timers/promises 호출을 실제로 센다(양성 대조)', async () => {
  const timers = installTimerCounters();
  const handles = [];
  try {
    handles.push(globalThis.setTimeout(() => {}, 0));
    handles.push(globalThis.setInterval(() => {}, 1000));
    handles.push(globalThis.setImmediate(() => {}));
    handles.push(timersCjs.setTimeout(() => {}, 0));
    handles.push(timersCjs.setImmediate(() => {}));
    await timersPromises.setTimeout(0);
    await timersPromises.setImmediate();
    await timersPromises.scheduler.wait(0);
    await timersPromises.scheduler.yield();
  } finally {
    timers.restore();
    for (const h of handles) { clearTimeout(h); clearInterval(h); clearImmediate(h); }
  }
  for (const want of [
    'setTimeout', 'setInterval', 'setImmediate',
    'node:timers.setTimeout', 'node:timers.setImmediate',
    'node:timers/promises.setTimeout', 'node:timers/promises.setImmediate',
    'node:timers/promises.scheduler.wait', 'node:timers/promises.scheduler.yield',
  ]) {
    assert.ok(timers.created.includes(want), `${want} 호출이 기록돼야 함: ${timers.created.join(',')}`);
  }
});

test('no_network: node:timers 이름 가져오기도 계수기에 잡힌다(양성 대조)', async () => {
  const timers = installTimerCounters();
  let h;
  try {
    const { setTimeout: named } = await import('node:timers');
    h = named(() => {}, 0);
  } finally {
    timers.restore();
    clearTimeout(h);
  }
  assert.ok(timers.created.includes('node:timers.setTimeout'), `이름 가져오기 호출이 기록돼야 함: ${timers.created.join(',')}`);
});

test('no_network: queueMicrotask 로 미룬 타이머 생성도 release 뒤 기록된다(양성 대조)', async () => {
  const spies = installNetworkSpies();
  const timers = installTimerCounters();
  try {
    queueMicrotask(() => { setTimeout(() => {}, 5000); });
    await timers.release();
  } finally {
    await spies.restore();
  }
  assert.ok(timers.created.includes('setTimeout'), `미룬 setTimeout 이 기록돼야 함: ${timers.created.join(',')}`);
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
  globalThis.fetch('http://127.0.0.1:1/test');
  assert.ok(spies.calls.includes('fetch'), '감시자가 fetch 호출을 기록해야 함');
});
