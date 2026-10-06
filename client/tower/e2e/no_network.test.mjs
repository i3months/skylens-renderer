// 관제탑 e2e 통합 시험: 입력·추적·오버레이·스트리밍·폴백 모듈 조합 사용 중 네트워크·타이머 호출 0(계약: contracts/controlview/e2e.mjs).
// 런타임 감시만 한다: 전역·node 모듈 진입점을 가로채 호출을 센다. 소스 정적 검색은 하지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installNetworkSpies } from '../buildings/network_spies.mjs';
import { createControlView } from './index.mjs';
import { replayRecording } from './recording.mjs';

const SIZE = { width: 640, height: 480 };

test('e2e: 통합 모듈 사용 중 전역 fetch·타이머·WebSocket 호출 0', async () => {
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
    const drones = [
      { id: 'drone-a', enu: [10, 20, 30], yaw: 0.5 },
      { id: 'drone-b', enu: [-15, 25, 25] },
      { id: 'drone-c', enu: [5, -10, 40], yaw: 1.5 },
    ];
    const detections = [
      { id: 'det-1', enu: [8, 15, 0], kind: 'alert', confidence: 0.95 },
      { id: 'det-2', enu: [-5, 10, 1] },
    ];
    const path = { id: 'path-1', points: [[0, 0, 20], [20, 0, 20], [20, 20, 25], [0, 20, 20]] };

    // 모듈을 직접 조립하지 않고 createControlView 와 녹화 재생(replayRecording)만 쓴다. 전부 같은 감시 구간 안이다.
    // 20 프레임 녹화: F0 에 데이터를 넣고, 키 입력·타일 도착·실패를 섞고, F10 에서 가용성을 끈다.
    // 가용성은 step 뒤·snapshot 앞에 적용되므로 F0..F9 는 live, F10..F19 는 fallback 이다.
    const frames20 = [];
    for (let i = 0; i < 20; i += 1) {
      const f = { dtSec: 0.016 };
      if (i === 0) Object.assign(f, { drones, detections, paths: [path] });
      const keys = {};
      if (i % 5 === 0) keys.down = ['ArrowUp'];
      if (i % 3 === 1) keys.up = ['ArrowUp'];
      if (keys.down || keys.up) f.keys = keys;
      if (i === 10) f.available = false;
      frames20.push(f);
    }
    const view20 = createControlView();
    const snaps20 = replayRecording(view20, { version: 1, frames: frames20 }, SIZE);
    assert.equal(snaps20.length, 20, '프레임마다 snapshot 하나');
    snaps20.forEach((s, i) => {
      const wantMode = i < 10 ? 'live' : 'fallback';
      assert.equal(s.mode, wantMode, `frame ${i}: 모드는 ${wantMode} 여야 함`);
      assert.equal(s.fallback.mode, wantMode, `frame ${i}: fallback.frame 모드는 ${wantMode} 여야 함`);
    });
    // 데이터 수: live 프레임은 오버레이가, fallback 프레임은 폴백 그림이 갖는다.
    assert.equal(snaps20[0].overlay.drones.length, 3, 'overlay 드론 3개');
    assert.equal(snaps20[19].fallback.drones.length, 3, 'fallback 프레임 드론 3개');
    assert.equal(snaps20[19].fallback.detections.length, 2, 'fallback 프레임 탐지 2개');
    assert.equal(snaps20[19].fallback.paths.length, 1, 'fallback 프레임 경로 1개');
    view20.releaseAll();

    // 12 프레임 녹화: F0..F7 은 state_match 의 타일 도착 녹화(요청·도착·실패가 실제로 일어남)와 같고, F8 부터 데이터·폴백 전환을 더한다.
    // held·inflight 는 손계산이다(근거는 state_match.test.mjs 의 같은 녹화 주석: 한 변 64 m 타일, 입력 y 가 32 m 씩 북쪽으로,
    // maxDistM 50·maxInflight 1, 바로 아래를 보는 시야는 약 5 m 반폭).
    const recording = {
      version: 1,
      frames: [
        { dtSec: 0.25 }, // F0 y=32 요청 (0,0)
        { dtSec: 0.25, arrivedTiles: [[0, 1], [0, 0]] }, // F1 요청 안 한 (0,1) 은 버리고 (0,0) 만 held
        { dtSec: 0.25, keys: { down: ['ArrowUp'] } }, // F2 y=64 경계 → 요청 (0,1)
        { dtSec: 0.25, keys: { up: ['ArrowUp'] }, failedTiles: [[0, 1]] }, // F3 (0,1) 실패 → inflight 비움
        { dtSec: 0.25, arrivedTiles: [[0, 1]] }, // F4 다시 요청한 (0,1) 도착 → held 둘
        { dtSec: 0.25, keys: { down: ['ArrowUp'] } }, // F5 y=96, 요청 없음
        { dtSec: 0.25 }, // F6 y=128 경계 → 요청 (0,2)
        { dtSec: 0.25, arrivedTiles: [[0, 0], [0, 2]] }, // F7 y=160 → (0,0) 내보냄, 내보낸 (0,0) 도착은 버리고 (0,2) held
        { dtSec: 0.25, keys: { up: ['ArrowUp'] }, drones, detections, paths: [path] }, // F8 데이터는 step 뒤에 들어옴
        { dtSec: 0.25, available: false }, // F9 step 은 live 라 추적 카메라로 update, 그 뒤 폴백
        { dtSec: 0.25, drones: [{ id: 'drone-a', enu: [10, 200, 30], yaw: 0.5 }, drones[1], drones[2]] }, // F10 폴백: update 건너뜀. 데이터(드론 a 를 북으로 180 m 이동)는 step 뒤에 들어옴
        { dtSec: 0.25, available: true }, // F11 step 은 폴백 중이라 update 를 건너뛴다 → F9 의 update 결과가 그대로(F10 에서 드론이 옮겨 가 있어 update 했다면 달라진다)
      ],
    };
    const view = createControlView({
      input: { pos: [32, 32, 1], pitchRad: -Math.PI / 2, fovYRad: 0.2, speedMps: 128 },
      streaming: { maxDistM: 50, maxInflight: 1 },
    });
    const snaps = replayRecording(view, recording, { width: 100, height: 100 });
    const wantModes = ['live', 'live', 'live', 'live', 'live', 'live', 'live', 'live', 'live', 'fallback', 'fallback', 'live'];
    assert.deepEqual(snaps.map((s) => s.mode), wantModes, '재생 프레임별 모드');
    const t = (tx, ty) => ({ tx, ty });
    const wantTiles = [
      { held: [], inflight: [t(0, 0)] },
      { held: [t(0, 0)], inflight: [] },
      { held: [t(0, 0)], inflight: [t(0, 1)] },
      { held: [t(0, 0)], inflight: [] },
      { held: [t(0, 0), t(0, 1)], inflight: [] },
      { held: [t(0, 0), t(0, 1)], inflight: [] },
      { held: [t(0, 0), t(0, 1)], inflight: [t(0, 2)] },
      { held: [t(0, 1), t(0, 2)], inflight: [] },
      { held: [t(0, 1), t(0, 2)], inflight: [] }, // F8: 입력 카메라 y=160 그대로
    ];
    wantTiles.forEach((want, i) => assert.deepEqual(snaps[i].streaming, want, `F${i} held·inflight`));
    // F9·F10 은 fallback 이라 3D 층 결과가 없다.
    assert.equal(snaps[9].streaming, null);
    assert.equal(snaps[10].streaming, null);
    // F11: 회귀 고정(구현 출력, 손계산 아님). F9 의 update 결과가 그대로 남는다: F10·F11 step 은 폴백 중이라 update 하지 않는다.
    // F10 에서 드론이 북으로 옮겨 갔으므로 가드가 없으면 F11 step 이 다른 카메라로 update 해 이 값이 달라진다(가드 제거 변이로 확인).
    assert.deepEqual(snaps[11].streaming, { held: [t(0, 1)], inflight: [t(-1, -1)] }, 'F11 held·inflight');
    assert.equal(snaps[8].overlay.drones.length, 3, '재생 중 오버레이 드론 3개');
    view.releaseAll();

    // 타이머 생성이 없는지 확인(생성 자체가 위반)
    assert.deepEqual(timerCreated, [], `모듈이 타이머를 만들었음: ${timerCreated.join(',')}`);
  } finally {
    unwrapTimers();
    // 지연 호출까지 비운 뒤에 calls 를 읽는다(건물 층 시험과 같은 순서).
    await spies.restore();
  }
  // 복원 뒤에 호출 수를 단언한다.
  assert.deepEqual(spies.calls, [], `네트워크 감시자가 호출을 기록했음: ${spies.calls.join(',')}`);
});

for (const [label, defer] of [
  ['queueMicrotask', (fn) => queueMicrotask(fn)],
  ['setTimeout 5000', (fn) => setTimeout(fn, 5000)],
  ['setImmediate', (fn) => setImmediate(fn)],
]) {
  test(`e2e: ${label} 로 미룬 fetch 는 restore 뒤 calls 에 기록된다(양성 대조)`, async () => {
    const spies = installNetworkSpies();
    defer(() => { globalThis.fetch('http://127.0.0.1:1/x').catch(() => {}); });
    await spies.restore();
    assert.ok(spies.calls.includes('fetch'), `${label} 지연 fetch 가 기록돼야 함`);
  });
}

test('e2e: 감시자가 실제로 호출을 센다(양성 대조)', async (t) => {
  const spies = installNetworkSpies();
  t.after(() => spies.restore());

  // 직접 fetch 호출 - 감시자가 잡아야 함
  globalThis.fetch('http://127.0.0.1:1/test');
  assert.ok(spies.calls.includes('fetch'), '감시자가 fetch 호출을 기록해야 함');
});

test('e2e: WebSocket 생성도 감시자가 센다(양성 대조)', async (t) => {
  const spies = installNetworkSpies();
  t.after(() => spies.restore());

  try {
    // WebSocket 생성 시도 - 감시자가 가로챈다
    new globalThis.WebSocket('ws://127.0.0.1:1/test');
  } catch {
    // 감시자가 예외를 던진다
  }
  assert.ok(spies.calls.includes('WebSocket'), '감시자가 WebSocket 호출을 기록해야 함');
});
