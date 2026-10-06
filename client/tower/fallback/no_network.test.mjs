// 관제탑 폴백 층이 네트워크·타이머를 쓰지 않는지 검사(계약: '이 층은 네트워크·타이머를 쓰지 않는다').
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
  // AbortSignal.timeout 도 내부 타이머를 만든다.
  const origAbortTimeout = AbortSignal.timeout;
  AbortSignal.timeout = function countedAbortTimeout(...args) {
    created.push('AbortSignal.timeout');
    return origAbortTimeout.apply(this, args);
  };
  restores.push(() => { AbortSignal.timeout = origAbortTimeout; });
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
    // 기록 수가 한 바퀴 동안 늘지 않을 때까지 비운다(상한 50 바퀴).
    let stable = 0;
    for (let i = 0; i < 50 && stable < 2; i += 1) {
      const before = created.length;
      await Promise.resolve();
      await new Promise((r) => realSetImmediate(r));
      stable = created.length === before ? stable + 1 : 0;
    }
    restore();
  };
  return { created, restore, release };
}

const SIZE = { width: 640, height: 480 };

test('index: 네트워크·타이머를 쓰지 않는다', async () => {
  const spies = installNetworkSpies();
  const timers = installTimerCounters();
  try {
    let mod;
    try {
      mod = await import('./index.mjs');
    } catch (e) {
      assert.fail(`client/tower/fallback/index.mjs 를 불러올 수 없음(조립 전이면 정상 실패): ${e && e.message}`);
    }
    assert.equal(typeof mod.createTowerFallback, 'function', 'createTowerFallback 을 내보내야 함');

    // createTowerFallback 생성
    const fb = mod.createTowerFallback();
    assert.equal(typeof fb.setAvailable, 'function');
    assert.equal(typeof fb.mode, 'function');
    assert.equal(typeof fb.setDrones, 'function');
    assert.equal(typeof fb.setDetections, 'function');
    assert.equal(typeof fb.setPath, 'function');
    assert.equal(typeof fb.removePath, 'function');
    assert.equal(typeof fb.clear, 'function');
    assert.equal(typeof fb.counts, 'function');
    assert.equal(typeof fb.setView, 'function');
    assert.equal(typeof fb.frame, 'function');

    // 초기 모드는 live
    assert.equal(fb.mode(), 'live', 'mode() 는 처음에 live 여야 함');

    // 드론 설정
    fb.setDrones([
      { id: 'a', enu: [1, 2, 30], yaw: 0.5 },
      { id: 'b', enu: [-4, 8, 20] },
    ]);

    // 탐지 설정
    fb.setDetections([
      { id: 'd1', enu: [3, 3, 0], kind: 'alert', confidence: 0.9 },
      { id: 'd2', enu: [5, -2, 1] },
    ]);

    // 경로 설정
    fb.setPath({ id: 'p1', points: [[0, 0, 10], [10, 0, 10], [10, 10, 12]] });
    fb.setPath({ id: 'p2', points: [[0, 0, 5], [0, 20, 5]] });

    // live 모드일 때 frame
    let frame = fb.frame(SIZE);
    assert.equal(frame.mode, 'live', 'live 모드에서는 frame.mode=live');
    assert.equal(frame.banner, null, 'live 모드에서는 banner=null');

    // 가용성을 fallback 으로 전환
    fb.setAvailable(false);
    assert.equal(fb.mode(), 'fallback', 'mode() 는 false 설정 후 fallback');

    // fallback 모드일 때 frame
    for (let i = 0; i < 5; i += 1) {
      frame = fb.frame(SIZE);
      assert.equal(frame.mode, 'fallback', 'fallback 모드에서는 frame.mode=fallback');
      assert.equal(frame.banner, '실시간 3D 불가', 'fallback 모드에서는 banner=TOWER_FALLBACK_BANNER');
      assert.ok(Array.isArray(frame.drones), 'frame 은 drones 배열이어야 함');
      assert.ok(Array.isArray(frame.detections), 'frame 은 detections 배열이어야 함');
      assert.ok(Array.isArray(frame.paths), 'frame 은 paths 배열이어야 함');
    }

    // 잘못된 입력(던져도 감시 구간 안에서 아무것도 만들지 않는다)
    for (const bad of [() => fb.setDrones('x'), () => fb.setDrones([{ id: 'z', enu: [1e9, 0, 0] }]), () => fb.setPath({ id: 'q' }), () => fb.setView({ centerE: 0 }), () => fb.setView({ centerE: 0, centerN: 0, metersPerPx: 0 }), () => fb.setAvailable('x'), () => fb.frame({ width: -1, height: 5 })]) {
      try { bad(); assert.fail('던져야 함'); } catch (e) { assert.ok(e instanceof TypeError || e instanceof RangeError, `예상 밖 예외: ${e && e.message}`); }
    }
    // 가용성 true → false → true → false 왕복
    fb.setAvailable(true);
    assert.equal(fb.frame(SIZE).mode, 'live');
    fb.setAvailable(false);
    assert.equal(fb.frame(SIZE).mode, 'fallback');

    // setView로 view 직접 지정
    const view = { centerE: 0, centerN: 0, metersPerPx: 1 };
    fb.setView(view);

    // view를 지정한 후 frame
    frame = fb.frame(SIZE);
    assert.equal(frame.mode, 'fallback');
    assert.ok(frame.view, 'setView 후 frame.view 는 존재해야 함');

    // 수동 view 해제 뒤 다시 맞춤
    fb.setView(null);
    assert.ok(fb.frame(SIZE).view, '자동 맞춤 view 가 있어야 함');
    fb.setView(view);

    // counts 확인
    const counts = fb.counts();
    assert.equal(counts.drones, 2, 'counts().drones=2');
    assert.equal(counts.detections, 2, 'counts().detections=2');
    assert.equal(counts.paths, 2, 'counts().paths=2');

    // removePath
    assert.equal(fb.removePath('p2'), true, 'removePath 는 true 를 돌려야 함');
    const countsAfterRemove = fb.counts();
    assert.equal(countsAfterRemove.paths, 1, 'removePath 후 counts().paths=1');

    // clear
    fb.clear();
    const countsAfterClear = fb.counts();
    assert.deepEqual(countsAfterClear, { drones: 0, detections: 0, paths: 0 }, 'clear 후 counts={(drones:0, detections:0, paths:0}');

    // 빈 frame(수동 view 있음·없음, fallback·live)
    assert.equal(fb.frame(SIZE).empty, true);
    fb.setView(null);
    assert.equal(fb.frame(SIZE).view, null);
    fb.setAvailable(true);
    assert.equal(fb.frame(SIZE).empty, true);

  } finally {
    // 미룬 타이머 생성이 기록되도록 마이크로태스크·setImmediate 를 비운 뒤에 계수기를 푼다.
    await timers.release();
    // 지연 호출까지 비운 뒤에 calls 를 읽는다(건물 층 시험과 같은 순서).
    await spies.restore();
  }
  // 복원 뒤에 호출 수를 단언한다(타이머 생성 자체가 위반).
  assert.deepEqual(timers.created, [], `폴백 층이 타이머를 만들었음: ${timers.created.join(',')}`);
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

test('no_network: AbortSignal.timeout 계수가 실제로 센다(양성 대조)', async () => {
  const timers = installTimerCounters();
  try {
    AbortSignal.timeout(60000);
  } finally {
    await timers.release();
  }
  assert.ok(timers.created.includes('AbortSignal.timeout'), `AbortSignal.timeout 호출이 기록돼야 함: ${timers.created.join(',')}`);
});

test('no_network: 비우기는 기록이 늘지 않을 때까지 돌아 여러 단계로 미룬 타이머도 센다(양성 대조)', async () => {
  const timers = installTimerCounters();
  try {
    // 마이크로태스크 → setImmediate → 마이크로태스크 순으로 세 단계 미룬 뒤 타이머를 만든다.
    queueMicrotask(() => realSetImmediate(() => queueMicrotask(() => realSetImmediate(() => queueMicrotask(() => { setTimeout(() => {}, 5000).unref(); })))));
  } finally {
    await timers.release();
  }
  assert.ok(timers.created.includes('setTimeout'), `늦게 미룬 setTimeout 이 기록돼야 함: ${timers.created.join(',')}`);
});
