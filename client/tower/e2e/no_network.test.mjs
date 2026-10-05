// 관제탑 e2e 통합 시험: 입력·추적·오버레이·스트리밍·폴백 모듈 조합 사용 중 네트워크·타이머 호출 0(계약: contracts/controlview/e2e.mjs).
// 런타임 감시만 한다: 전역·node 모듈 진입점을 가로채 호출을 센다. 소스 정적 검색은 하지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installNetworkSpies } from '../buildings/network_spies.mjs';
import { createTowerInput } from '../input/index.mjs';
import { createChaseCamera } from '../chase/index.mjs';
import { createTowerOverlay } from '../overlay/index.mjs';
import { createTowerStreaming } from '../streaming/index.mjs';
import { createTowerFallback } from '../fallback/index.mjs';
import { TOWER_E2E_MATCH } from '../../../contracts/controlview/e2e.mjs';

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
    // 입력 모듈 생성
    const input = createTowerInput({
      pos: [0, 0, 50],
      yaw: 0,
    });

    // 추적 카메라 모듈 생성
    const chase = createChaseCamera();
    chase.setTarget([0, 0, 10], 0);

    // 오버레이 모듈 생성
    const overlay = createTowerOverlay({ nearM: 10 });

    // 스트리밍 모듈 생성
    const streaming = createTowerStreaming();

    // 폴백 모듈 생성
    const fallback = createTowerFallback();

    // 드론 3개 설정
    const drones = [
      { id: 'drone-a', enu: [10, 20, 30], yaw: 0.5 },
      { id: 'drone-b', enu: [-15, 25, 25] },
      { id: 'drone-c', enu: [5, -10, 40], yaw: 1.5 },
    ];
    overlay.setDrones(drones);
    fallback.setDrones(drones);

    // 탐지 설정
    const detections = [
      { id: 'det-1', enu: [8, 15, 0], kind: 'alert', confidence: 0.95 },
      { id: 'det-2', enu: [-5, 10, 1] },
    ];
    overlay.setDetections(detections);
    fallback.setDetections(detections);

    // 경로 설정
    const path = { id: 'path-1', points: [[0, 0, 20], [20, 0, 20], [20, 20, 25], [0, 20, 20]] };
    overlay.setPath(path);
    fallback.setPath(path);

    // 타일 도착 기록 (streaming 에 도착 신고)
    const arrivingTiles = [];
    const failingTiles = [];

    // 20회 업데이트 루프
    for (let i = 0; i < 20; i += 1) {
      // 입력: 키 입력 시뮬레이션 (일부 iteration 에서만)
      if (i % 5 === 0) input.keyDown('ArrowUp');
      if (i % 7 === 2) input.keyDown('ArrowRight');
      if (i % 3 === 1) input.keyUp('ArrowUp');

      // 입력 step: dt = 0.016 (약 60fps)
      input.step(0.016);

      // 추적 카메라 step
      chase.step(0.016);

      // 폴백 모드 전환 (중간에 한 번)
      if (i === 10) {
        fallback.setAvailable(false);
      }

      // 카메라 자세 얻기
      let cameraPose = chase.camera();
      if (cameraPose === null) {
        // 목표가 없으면 input 의 카메라로 대신 사용
        cameraPose = input.camera();
      }

      // 오버레이 project (카메라 자세 기반 프로젝션)
      const overlayResult = overlay.project(cameraPose, SIZE);

      // 스트리밍: 카메라 자세로 필요 타일 계산 및 계획
      const updateResult = streaming.update(cameraPose, SIZE);
      if (updateResult && updateResult.needed) {
        // 도착 타일 시뮬레이션 (일부 iteration)
        if (i % 6 === 0 && updateResult.needed.length > 0) {
          arrivingTiles.push(updateResult.needed[0]);
          streaming.arrived(updateResult.needed[0].tx, updateResult.needed[0].ty);
        }
        // 실패 타일 시뮬레이션 (일부 iteration)
        if (i % 8 === 3 && updateResult.needed.length > 1) {
          failingTiles.push(updateResult.needed[1]);
          streaming.failed(updateResult.needed[1].tx, updateResult.needed[1].ty);
        }
      }

      // 폴백 frame 렌더링
      const fallbackFrame = fallback.frame(SIZE);
      assert.equal(fallbackFrame.mode === 'live' || fallbackFrame.mode === 'fallback', true, `fallback.frame 은 live 또는 fallback 모드여야 함`);
    }

    // 최종 상태 확인
    assert.equal(overlay.counts().drones, 3, 'overlay 드론 3개');
    assert.equal(overlay.counts().detections, 2, 'overlay 탐지 2개');
    assert.equal(overlay.counts().paths, 1, 'overlay 경로 1개');
    assert.equal(fallback.counts().drones, 3, 'fallback 드론 3개');
    assert.equal(fallback.counts().detections, 2, 'fallback 탐지 2개');
    assert.equal(fallback.counts().paths, 1, 'fallback 경로 1개');
    assert.ok(arrivingTiles.length > 0, '일부 타일이 도착했어야 함');
    assert.ok(failingTiles.length > 0, '일부 타일이 실패했어야 함');

    // 입력 릴리스
    input.releaseAll();

    // 타이머 생성이 없는지 확인(생성 자체가 위반)
    assert.deepEqual(timerCreated, [], `모듈이 타이머를 만들었음: ${timerCreated.join(',')}`);
  } finally {
    unwrapTimers();
    // 지연 호출까지 비운 뒤에 calls 를 읽는다(건물 층 시험과 같은 순서).
    await spies.restore();
  }
  // 복원 뒤에 호출 수를 단언한다.
  assert.deepEqual(spies.calls, [], `네트워크 감시자가 호출을 기록했음: ${spies.calls.join(',')}`);
  assert.ok(spies.calls.length <= TOWER_E2E_MATCH.maxNetworkCalls, `네트워크 호출 수가 한도(${TOWER_E2E_MATCH.maxNetworkCalls})를 넘음: ${spies.calls.length}`);
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
