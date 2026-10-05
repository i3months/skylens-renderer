// 관제탑 폴백 전환 시험(T15.9). createControlView 를 쓰지 않고 각 모듈 public index 를 직접 엮어
// '조립 층이 해야 할 일'의 참조 동작을 확인한다: 서버 불가 때는 폴백만 그리고(3D 층 갱신 없음), 데이터는 양쪽에 같이 넣어 둔다.
// 기대값은 손계산 숫자를 시험 안에 박았다. 구현 모듈의 내부 함수는 쓰지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTowerOverlay } from '../overlay/index.mjs';
import { createTowerStreaming } from '../streaming/index.mjs';
import { createTowerFallback } from '../fallback/index.mjs';
import { createTowerInput } from '../input/index.mjs';
import { createChaseCamera } from '../chase/index.mjs';
import { installNetworkSpies } from '../buildings/network_spies.mjs';
import { TOWER_FALLBACK_BANNER } from '../../../contracts/controlview/fallback.mjs';

const SIZE = { width: 800, height: 600 };
const EPS = 1e-9;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) <= EPS, `${msg}: ${a} != ${b}`);

// 합성 장면: 드론 d1(0,0)·d2(200,100), 탐지 t1(100,50)·t2(200,-100)(alert), 경로 p1 (0,0)→(100,50)→(200,100).
const DRONES = [{ id: 'd1', enu: [0, 0, 30], yaw: 0.5 }, { id: 'd2', enu: [200, 100, 40] }];
const DETS = [{ id: 't1', enu: [100, 50, 0] }, { id: 't2', enu: [200, -100, 0], kind: 'alert', confidence: 0.9 }];
const PATH = { id: 'p1', points: [[0, 0, 0], [100, 50, 0], [200, 100, 0]] };
const COUNTS = { drones: 2, detections: 2, paths: 1 };

// 손계산: e 0..200, n -100..100 → span 200, avail = 600-32 = 568, 1 m = 2.84 px, 중심 (100,0).
const EXPECT = {
  view: { centerE: 100, centerN: 0, metersPerPx: 200 / 568 },
  drones: [{ id: 'd1', x: 116, y: 300 }, { id: 'd2', x: 684, y: 16 }],
  detections: [{ id: 't1', x: 400, y: 158 }, { id: 't2', x: 684, y: 584 }],
  path: [{ x: 116, y: 300 }, { x: 400, y: 158 }, { x: 684, y: 16 }],
};

// 조립 층의 참조 동작: 데이터는 overlay 와 fallback 양쪽에 넣고, 3D 층(streaming)은 live 일 때만 갱신한다.
function assemble() {
  const overlay = createTowerOverlay();
  const fallback = createTowerFallback();
  const streaming = createTowerStreaming({ maxInflight: 4 });
  const input = createTowerInput({ pos: [32, 10, 30], yaw: 0 });
  const chase = createChaseCamera();
  input.step(0);
  return {
    overlay, fallback, streaming, input, chase,
    setData() {
      overlay.setDrones(DRONES); fallback.setDrones(DRONES);
      overlay.setDetections(DETS); fallback.setDetections(DETS);
      overlay.setPath(PATH); fallback.setPath(PATH);
    },
    camera: () => input.camera(),
    // 한 프레임: live 이면 3D 층을 갱신하고, fallback 이면 갱신하지 않는다.
    frame() {
      input.step(0);
      const cam = input.camera();
      const live = fallback.mode() === 'live';
      const plan = live ? streaming.update(cam, SIZE) : null;
      return { plan, overlay: overlay.project(cam, SIZE), fallback: fallback.frame(SIZE) };
    },
    setAvailable(v) { fallback.setAvailable(v); },
  };
}

test('(a) 서버 불가 구간: 배너와 마커 개수·위치가 overlay.counts 와 같은 데이터로 손계산 값과 같다', () => {
  const r = assemble();
  r.setData();
  r.setAvailable(false);
  assert.equal(r.fallback.mode(), 'fallback');
  const f = r.frame().fallback;
  assert.equal(f.mode, 'fallback');
  assert.equal(f.banner, TOWER_FALLBACK_BANNER);
  assert.equal(f.banner, '실시간 3D 불가');
  assert.equal(f.empty, false);
  // 개수: overlay 가 센 값(2, 2, 1)과 폴백 목록 길이가 같다.
  assert.deepEqual(r.overlay.counts(), COUNTS);
  assert.deepEqual(r.fallback.counts(), r.overlay.counts());
  assert.equal(f.drones.length, 2);
  assert.equal(f.detections.length, 2);
  assert.equal(f.paths.length, 1);
  // 지도 view.
  near(f.view.centerE, EXPECT.view.centerE, 'centerE');
  near(f.view.centerN, EXPECT.view.centerN, 'centerN');
  near(f.view.metersPerPx, EXPECT.view.metersPerPx, 'metersPerPx');
  // 위치.
  EXPECT.drones.forEach((e, i) => {
    assert.equal(f.drones[i].id, e.id);
    near(f.drones[i].x, e.x, `${e.id}.x`);
    near(f.drones[i].y, e.y, `${e.id}.y`);
    assert.equal(f.drones[i].visible, true);
  });
  assert.equal(f.drones[0].yaw, 0.5);
  EXPECT.detections.forEach((e, i) => {
    assert.equal(f.detections[i].id, e.id);
    near(f.detections[i].x, e.x, `${e.id}.x`);
    near(f.detections[i].y, e.y, `${e.id}.y`);
    assert.equal(f.detections[i].visible, true);
  });
  assert.equal(f.detections[0].kind, 'detection');
  assert.equal(f.detections[1].kind, 'alert');
  assert.equal(f.detections[1].confidence, 0.9);
  assert.equal(f.paths[0].id, 'p1');
  assert.equal(f.paths[0].polyline.length, 3);
  EXPECT.path.forEach((e, i) => {
    near(f.paths[0].polyline[i].x, e.x, `path[${i}].x`);
    near(f.paths[0].polyline[i].y, e.y, `path[${i}].y`);
  });
});

test('(a) 서버 불가인데 받은 항목이 없으면 배너는 나오고 목록은 비어 있다', () => {
  const r = assemble();
  r.setAvailable(false);
  const f = r.frame().fallback;
  assert.equal(f.banner, '실시간 3D 불가');
  assert.equal(f.empty, true);
  assert.equal(f.view, null);
  assert.deepEqual([f.drones, f.detections, f.paths], [[], [], []]);
});

test('(b) live→fallback→live 전환에 데이터가 유지되고 네트워크 호출이 0 이다', async () => {
  const spies = installNetworkSpies();
  let fb1, fb2;
  try {
    const r = assemble();
    r.setData(); // live 에서도 폴백은 데이터를 받아 둔다
    const live1 = r.frame();
    assert.equal(live1.fallback.mode, 'live');
    assert.equal(live1.fallback.banner, null);
    assert.equal(live1.fallback.view, null);
    assert.deepEqual([live1.fallback.drones, live1.fallback.detections, live1.fallback.paths], [[], [], []]);
    assert.deepEqual(r.fallback.counts(), COUNTS);

    r.setAvailable(false);
    fb1 = r.frame();
    assert.deepEqual(r.fallback.counts(), COUNTS);
    assert.equal(fb1.fallback.drones.length, 2);

    r.setAvailable(true);
    const live2 = r.frame();
    assert.equal(live2.fallback.mode, 'live');
    assert.deepEqual(r.fallback.counts(), COUNTS);
    assert.deepEqual(r.overlay.counts(), COUNTS);
    // live 에서 3D 오버레이 투영도 같은 데이터로 계속 낸다: 드론 2 · 탐지 2 · 경로 1.
    assert.equal(live2.overlay.drones.length, 2);
    assert.equal(live2.overlay.detections.length, 2);
    assert.equal(live2.overlay.paths.length, 1);

    r.setAvailable(false);
    fb2 = r.frame();
    assert.deepEqual(r.fallback.counts(), COUNTS);
  } finally {
    await spies.restore();
  }
  // 두 번째 폴백 진입 때 첫 번째와 같은 그리기 목록이 곧바로 나온다.
  assert.deepEqual(fb2.fallback, fb1.fallback);
  assert.deepEqual(spies.calls, [], `네트워크 호출: ${spies.calls.join(',')}`);
});

test('(c) 폴백일 때 streaming.update 를 부르지 않으면 inflight 가 늘지 않는다', () => {
  const r = assemble();
  r.setData();
  // live 첫 프레임: 카메라 시점에서 보이는 타일 366 개 중 maxInflight 4 개를 요청한다.
  const f1 = r.frame();
  assert.equal(f1.plan.needed.length, 366);
  assert.deepEqual(f1.plan.request, [{ tx: 0, ty: 0 }, { tx: -1, ty: 0 }, { tx: 1, ty: 0 }, { tx: 0, ty: 1 }]);
  assert.equal(r.streaming.state().inflight.length, 4);
  // 두 타일이 도착: held 2, inflight 2.
  assert.equal(r.streaming.arrived(0, 0), true);
  assert.equal(r.streaming.arrived(1, 0), true);
  assert.equal(r.streaming.state().held.length, 2);
  assert.equal(r.streaming.state().inflight.length, 2);

  // 서버 불가 10 프레임: update 를 부르지 않으므로 계획이 없고 inflight 는 2 로 그대로다.
  r.setAvailable(false);
  for (let i = 0; i < 10; i++) {
    const f = r.frame();
    assert.equal(f.plan, null, '폴백 프레임은 3D 층 결과를 내지 않는다');
    assert.equal(r.streaming.state().inflight.length, 2, `폴백 ${i} 번째 프레임의 inflight`);
    assert.equal(r.streaming.state().held.length, 2);
  }

  // 대조: live 로 돌아와 update 를 부르면 그제야 2 개를 더 요청해 inflight 가 4 가 된다.
  r.setAvailable(true);
  const f2 = r.frame();
  assert.equal(f2.plan.request.length, 2);
  assert.equal(r.streaming.state().inflight.length, 4);
});

test('(d) 도착하지 않은 타일을 메우지 않는다: missing 은 held 가 아닌 타일, 폴백 frame 에 타일 정보가 없다', () => {
  const r = assemble();
  r.setData();
  r.frame();
  r.streaming.arrived(0, 0);
  r.streaming.arrived(1, 0);
  const cam = r.camera();
  const key = (t) => `${t.tx},${t.ty}`;
  const held = new Set(r.streaming.state().held.map(key));
  assert.deepEqual([...held].sort(), ['0,0', '1,0']);
  const miss = r.streaming.missing(cam, SIZE);
  // 필요 366 개 중 held 2 개가 빠진 364 개이고, held 인 타일은 하나도 들어 있지 않다.
  assert.equal(miss.length, 364);
  for (const t of miss) assert.equal(held.has(key(t)), false, `held 타일 ${key(t)} 가 missing 에 있다`);
  // 요청했지만 아직 도착하지 않은 타일 (-1,0)·(0,1) 은 missing 에 있다.
  const mk = new Set(miss.map(key));
  assert.equal(mk.has('-1,0'), true);
  assert.equal(mk.has('0,1'), true);
  // missing 은 상태를 바꾸지 않는다.
  assert.equal(r.streaming.state().held.length, 2);
  assert.equal(r.streaming.state().inflight.length, 2);

  // 폴백 frame 은 타일 정보를 내지 않고, 최상위 키도 계약 형식 그대로다.
  r.setAvailable(false);
  const f = r.frame().fallback;
  assert.deepEqual(Object.keys(f).sort(), ['banner', 'detections', 'drones', 'empty', 'mode', 'paths', 'view']);
  // 폴백이 그리는 것은 받은 항목(드론 2 · 탐지 2 · 경로 1)뿐이다.
  assert.equal(f.drones.length + f.detections.length + f.paths.length, 5);
  assert.equal(r.streaming.state().held.length, 2);
});
