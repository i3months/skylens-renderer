// 관제탑 폴백 전환 시험(T15.9). 계약: contracts/controlview/e2e.mjs(TOWER_E2E_API.availability·fallbackStreaming·data).
// 조립 층 createControlView 를 replayRecording(녹화 재생)으로 몰아 검사한다. 시험 안에서 모듈을 따로 엮지 않는다.
// 기대값은 아래 주석의 유도로 손계산해 숫자로 박았다(구현 출력을 받아 적지 않았다).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlView } from './index.mjs';
import { replayRecording } from './recording.mjs';
import { installNetworkSpies } from '../buildings/network_spies.mjs';
import { TOWER_FALLBACK_BANNER } from '../../../contracts/controlview/fallback.mjs';
import { TOWER_E2E_RECORDING } from '../../../contracts/controlview/e2e.mjs';

const SIZE = { width: 800, height: 600 };
const EPS = 1e-9;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) <= EPS, `${msg}: ${a} != ${b}`);
const rec = (frames) => ({ version: TOWER_E2E_RECORDING.version, frames });
const DT = 0.1;

// 합성 장면: 드론 d1(0,0)·d2(200,100), 탐지 t1(100,50)·t2(200,-100)(alert), 경로 p1 (0,0)→(100,50)→(200,100).
const DRONES = [{ id: 'd1', enu: [0, 0, 30], yaw: 0.5 }, { id: 'd2', enu: [200, 100, 40] }];
const DETS = [{ id: 't1', enu: [100, 50, 0] }, { id: 't2', enu: [200, -100, 0], kind: 'alert', confidence: 0.9 }];
const PATH = { id: 'p1', points: [[0, 0, 0], [100, 50, 0], [200, 100, 0]] };

// 폴백 지도 손계산: e 0..200, n -100..100 → span 200, avail = 600-32 = 568, 1 m = 568/200 = 2.84 px, 중심 (100,0).
// x = 400 + (e-100)·2.84, y = 300 − n·2.84. 예: d1(0,0) → (400−284, 300) = (116, 300), d2(200,100) → (684, 16).
const EXPECT = {
  view: { centerE: 100, centerN: 0, metersPerPx: 200 / 568 },
  drones: [{ id: 'd1', x: 116, y: 300 }, { id: 'd2', x: 684, y: 16 }],
  detections: [{ id: 't1', x: 400, y: 158 }, { id: 't2', x: 684, y: 584 }],
  path: [{ x: 116, y: 300 }, { x: 400, y: 158 }, { x: 684, y: 16 }],
};

// 폴백 frame 이 그리는 것이 손계산 지도와 같은지 본다.
function assertFallbackMap(f) {
  assert.equal(f.mode, 'fallback');
  assert.equal(f.banner, TOWER_FALLBACK_BANNER);
  assert.equal(f.banner, '실시간 3D 불가');
  assert.equal(f.empty, false);
  assert.equal(f.drones.length, 2);
  assert.equal(f.detections.length, 2);
  assert.equal(f.paths.length, 1);
  near(f.view.centerE, EXPECT.view.centerE, 'centerE');
  near(f.view.centerN, EXPECT.view.centerN, 'centerN');
  near(f.view.metersPerPx, EXPECT.view.metersPerPx, 'metersPerPx');
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
}

// fallback 스냅샷은 3D 층 결과(camera·overlay·streaming)를 내지 않는다(계약 availability).
function assertNo3D(s, label) {
  assert.equal(s.mode, 'fallback', `${label} mode`);
  assert.equal(s.camera, null, `${label} camera`);
  assert.equal(s.overlay, null, `${label} overlay`);
  assert.equal(s.streaming, null, `${label} streaming`);
}

// ---------------------------------------------------------------------------------------------
// 스트리밍 손계산 장면(c·d): 드론 없음 → 추적하지 않고 입력 카메라를 쓴다(계약 tracking).
// 입력 카메라: pos (32,32,30), yaw 0, pitchRad −π/2(곧장 아래). 키를 누르지 않으므로 step 이 자세를 바꾸지 않는다.
//   곧장 아래를 보면 화면 오른쪽 = 동(+x), 화면 위 = 북(+y), 앞 = −z.
//   tan(fovY/2) = tan(0.45) = 0.48306 (입력 기본 fovYRad 0.9), 가로 tan = 0.48306·800/600 = 0.64407.
// 필요 타일(streaming 기본 zRangeM [−100,600], maxDistM 1500, 타일 64 m):
//   시야 사각뿔은 z ≤ 30 쪽으로만 뻗으므로 z = −100(깊이 130 m)에서 발자국이 가장 넓다:
//   x ∈ 32 ± 130·0.64407 = [−51.73, 115.73] → tx ∈ {−1, 0, 1} (경계 −64·128 과 12 m 이상 떨어짐)
//   y ∈ 32 ± 130·0.48306 = [−30.80, 94.80]  → ty ∈ {−1, 0, 1}
//   가장 먼 모서리 거리 √(83.7² + 62.8² + 130²) ≈ 167 m < 1500 → 거리 구는 자르지 않는다. 필요 9 개.
// 순서: 타일 중심 (32+64i, 32+64j) 과 카메라 (32,32) 의 제곱거리 4096·(i²+j²), 같으면 (tx,ty) 사전순.
// 요청: 기본 maxInflight 16 ≥ 9 → 첫 update 가 9 개를 모두 요청한다. 카메라가 그대로라 retain 밖 취소·내보내기는 없다(maxHeld 4096).
// state() 는 (tx,ty) 사전순이다.
const SCAN_INPUT = { pos: [32, 32, 30], yaw: 0, pitchRad: -Math.PI / 2 };
const ALL9 = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 0], [0, 1], [1, -1], [1, 0], [1, 1]]; // 사전순
const FIRST2 = [[0, 0], [1, 0]]; // 폴백 진입 프레임에 도착시키는 두 타일
const REST7 = ALL9.filter(([x, y]) => !FIRST2.some(([a, b]) => a === x && b === y)); // 사전순 나머지 7
const tiles = (s) => s.streaming.held.map((t) => [t.tx, t.ty]);
const infl = (s) => s.streaming.inflight.map((t) => [t.tx, t.ty]);

test('(a) 서버 불가 구간: 배너와 마커 개수·위치가 손계산 지도와 같고 3D 층 결과는 없다', () => {
  const view = createControlView();
  // 재생 순서: step → 데이터 → 가용성 → snapshot. 0 프레임에서 데이터를 넣고 곧바로 서버 불가.
  const snaps = replayRecording(view, rec([
    { dtSec: DT, drones: DRONES, detections: DETS, paths: [PATH], available: false },
    { dtSec: DT },
  ]), SIZE);
  // 프레임 | mode     | 비고
  // 0      | fallback | 데이터 직후 불가
  // 1      | fallback | 그대로(같은 그리기 목록)
  assert.equal(view.mode(), 'fallback');
  snaps.forEach((s, i) => assertNo3D(s, `frame ${i}`));
  assertFallbackMap(snaps[0].fallback);
  assert.deepEqual(snaps[1].fallback, snaps[0].fallback);
});

test('(a) 서버 불가인데 받은 항목이 없으면 배너는 나오고 목록은 비어 있다', () => {
  const view = createControlView();
  const [s] = replayRecording(view, rec([{ dtSec: DT, available: false }]), SIZE);
  assertNo3D(s, 'frame 0');
  assert.equal(s.fallback.banner, '실시간 3D 불가');
  assert.equal(s.fallback.empty, true);
  assert.equal(s.fallback.view, null);
  assert.deepEqual([s.fallback.drones, s.fallback.detections, s.fallback.paths], [[], [], []]);
});

test('(b) live→fallback→live→fallback 전환에 데이터가 유지되고 네트워크 호출이 0 이다', async () => {
  const spies = installNetworkSpies();
  let snaps;
  try {
    const view = createControlView();
    snaps = replayRecording(view, rec([
      { dtSec: DT, drones: DRONES, detections: DETS, paths: [PATH] }, // 0 live: live 에서도 폴백은 데이터를 받아 둔다
      { dtSec: DT, available: false }, // 1 fallback
      { dtSec: DT, available: true }, // 2 live
      { dtSec: DT }, // 3 live
      { dtSec: DT, available: false }, // 4 fallback(두 번째 진입)
    ]), SIZE);
  } finally {
    await spies.restore();
  }
  // 프레임 | mode     | overlay 드론·탐지·경로 | fallback 목록
  // 0      | live     | 2 · 2 · 1             | 빈 목록(배너 null)
  // 1      | fallback | null                  | 손계산 지도
  // 2      | live     | 2 · 2 · 1             | 빈 목록
  // 3      | live     | 2 · 2 · 1             | 빈 목록
  // 4      | fallback | null                  | 1 프레임과 같다
  assert.deepEqual(snaps.map((s) => s.mode), ['live', 'fallback', 'live', 'live', 'fallback']);
  for (const i of [0, 2, 3]) {
    const s = snaps[i];
    assert.equal(s.fallback.mode, 'live');
    assert.equal(s.fallback.banner, null);
    assert.equal(s.fallback.view, null);
    assert.deepEqual([s.fallback.drones, s.fallback.detections, s.fallback.paths], [[], [], []]);
    assert.deepEqual([s.overlay.drones.length, s.overlay.detections.length, s.overlay.paths.length], [2, 2, 1], `frame ${i} overlay`);
    assert.notEqual(s.streaming, null, `frame ${i} streaming`);
  }
  assertNo3D(snaps[1], 'frame 1');
  assertNo3D(snaps[4], 'frame 4');
  assertFallbackMap(snaps[1].fallback);
  // 두 번째 폴백 진입 때 첫 번째와 같은 그리기 목록이 곧바로 나온다.
  assert.deepEqual(snaps[4].fallback, snaps[1].fallback);
  assert.deepEqual(spies.calls, [], `네트워크 호출: ${spies.calls.join(',')}`);
});

test('(c) 폴백 중 step 은 streaming.update 를 부르지 않고 arrived·failed 는 전달하며, 복귀 뒤 첫 step 이 다시 update 한다', () => {
  const view = createControlView({ input: SCAN_INPUT });
  const snaps = replayRecording(view, rec([
    { dtSec: DT, detections: DETS, paths: [PATH] }, // 0
    { dtSec: DT, available: false, arrivedTiles: FIRST2 }, // 1
    { dtSec: DT, failedTiles: REST7 }, // 2
    { dtSec: DT, arrivedTiles: REST7 }, // 3
    { dtSec: DT, available: true }, // 4
    { dtSec: DT }, // 5
    { dtSec: DT, arrivedTiles: REST7 }, // 6
    { dtSec: DT }, // 7
  ]), SIZE);
  // 재생 순서는 step → 데이터 → 가용성 → 도착/실패 → snapshot 이므로, 가용성을 바꾼 프레임의 step 은 바뀌기 전 모드로 돈다.
  // 프레임 | step 때 모드 | update? | 도착/실패 뒤 held·inflight(개수) | snapshot mode | snapshot.streaming
  // 0      | live         | 예      | 0 · 9  (9 ≤ maxInflight 16, 모두 요청)         | live     | held 0, inflight 9
  // 1      | live         | 예(새 요청 없음: 9 개 모두 inflight) → 불가 전환 → (0,0)(1,0) 도착 | 2 · 7 | fallback | null
  // 2      | fallback     | 아니오  | 나머지 7 실패 → 2 · 0                       | fallback | null
  // 3      | fallback     | 아니오  | 7 도착 통지는 inflight 가 아니라 거부 → 2 · 0 | fallback | null
  // 4      | fallback     | 아니오  | 복귀 전환(step 은 이미 끝남) → 2 · 0         | live     | held 2, inflight 0
  // 5      | live         | 예      | 필요 9 − held 2 = 7 개 다시 요청(7 ≤ 16) → 2 · 7 | live | held 2, inflight 7
  // 6      | live         | 예(새 요청 없음) → 7 도착 → 9 · 0                  | live     | held 9, inflight 0
  // 7      | live         | 예(필요 9 모두 held, 요청 0)  → 9 · 0              | live     | held 9, inflight 0
  // 대조(폴백 중에도 update 하는 옛 동작): 3 프레임 step 이 실패한 7 개를 다시 요청해 도착을 받아들이므로 4 프레임이 held 9 가 된다.
  const TABLE = [
    { mode: 'live', held: [], inflight: ALL9 },
    { mode: 'fallback' },
    { mode: 'fallback' },
    { mode: 'fallback' },
    { mode: 'live', held: FIRST2, inflight: [] },
    { mode: 'live', held: FIRST2, inflight: REST7 },
    { mode: 'live', held: ALL9, inflight: [] },
    { mode: 'live', held: ALL9, inflight: [] },
  ];
  assert.equal(snaps.length, TABLE.length);
  TABLE.forEach((want, i) => {
    const s = snaps[i];
    assert.equal(s.mode, want.mode, `frame ${i} mode`);
    if (want.mode === 'fallback') {
      assertNo3D(s, `frame ${i}`);
      assert.equal(s.fallback.empty, false, `frame ${i} 폴백은 받은 탐지·경로를 그린다`);
      return;
    }
    assert.deepEqual(tiles(s), want.held, `frame ${i} held`);
    assert.deepEqual(infl(s), want.inflight, `frame ${i} inflight`);
  });
});

test('(c) 폴백 중 이미 나간 inflight 는 그대로 두고, 복귀 뒤 첫 step 전까지 새로 요청하지 않는다', () => {
  const view = createControlView({ input: SCAN_INPUT });
  const snaps = replayRecording(view, rec([
    { dtSec: DT, arrivedTiles: FIRST2 }, // 0
    { dtSec: DT, available: false, failedTiles: [[0, 1]] }, // 1
    { dtSec: DT }, // 2
    { dtSec: DT, available: true }, // 3
    { dtSec: DT }, // 4
  ]), SIZE);
  // 프레임 | step 때 모드 | update? | held·inflight                                   | snapshot
  // 0      | live         | 예      | 9 요청 → (0,0)(1,0) 도착 → 2 · 7                 | live, held 2, inflight 7
  // 1      | live         | 예(요청 0) → 불가 → (0,1) 실패 → 2 · 6           | fallback(null)
  // 2      | fallback     | 아니오  | 2 · 6 (실패한 (0,1) 을 다시 요청하지 않는다)     | fallback(null)
  // 3      | fallback     | 아니오  | 복귀 → 2 · 6                                     | live, held 2, inflight 6
  // 4      | live         | 예      | 필요 9 중 held·inflight 아닌 (0,1) 1 개 요청 → 2 · 7 | live, held 2, inflight 7
  const REST6 = REST7.filter(([x, y]) => !(x === 0 && y === 1));
  assert.deepEqual(snaps.map((s) => s.mode), ['live', 'fallback', 'fallback', 'live', 'live']);
  assert.deepEqual([tiles(snaps[0]), infl(snaps[0])], [FIRST2, REST7], 'frame 0 held·inflight');
  assertNo3D(snaps[1], 'frame 1');
  assertNo3D(snaps[2], 'frame 2');
  assert.deepEqual([tiles(snaps[3]), infl(snaps[3])], [FIRST2, REST6], 'frame 3 held·inflight');
  assert.deepEqual([tiles(snaps[4]), infl(snaps[4])], [FIRST2, REST7], 'frame 4 held·inflight');
});

test('(d) 도착하지 않은 타일을 메우지 않는다: held 는 도착한 요청 타일뿐이고 폴백 frame 에 타일 정보가 없다', () => {
  const view = createControlView({ input: SCAN_INPUT });
  const snaps = replayRecording(view, rec([
    // 0: 요청하지 않은 (5,5)·(2,0) 의 도착 통지는 받아들이지 않는다((2,0) 은 x∈[128,192] 로 발자국 밖, 필요 아님).
    { dtSec: DT, detections: DETS, paths: [PATH], drones: [], arrivedTiles: [[0, 0], [1, 0], [5, 5], [2, 0]] },
    // 1: 폴백 진입. 폴백 중에도 요청하지 않은 타일 통지는 거부.
    { dtSec: DT, available: false, arrivedTiles: [[5, 5]] },
    // 2: 복귀.
    { dtSec: DT, available: true },
  ]), SIZE);
  // 프레임 | held·inflight                     | snapshot
  // 0      | 2 · 7 ((5,5)·(2,0) 거부)          | live, held [(0,0),(1,0)], inflight 나머지 7
  // 1      | 2 · 7                             | fallback(null)
  // 2      | 2 · 7 (step 은 폴백 중에 돌았다)  | live, held 2, inflight 7
  assert.deepEqual([tiles(snaps[0]), infl(snaps[0])], [FIRST2, REST7], 'frame 0 held·inflight');
  // held 는 도착한 타일뿐이고, 도착하지 않은 (요청 중인) 타일은 held 에 없다.
  for (const t of REST7) assert.equal(tiles(snaps[0]).some(([x, y]) => x === t[0] && y === t[1]), false, `${t} 가 held 에 있다`);

  const f = snaps[1].fallback;
  assertNo3D(snaps[1], 'frame 1');
  // 폴백 frame 은 타일 정보를 내지 않고, 최상위 키도 계약 형식 그대로다.
  assert.deepEqual(Object.keys(f).sort(), ['banner', 'detections', 'drones', 'empty', 'mode', 'paths', 'view']);
  // 폴백이 그리는 것은 받은 항목(드론 0 · 탐지 2 · 경로 1)뿐이다.
  assert.deepEqual([f.drones.length, f.detections.length, f.paths.length], [0, 2, 1]);
  assert.deepEqual([tiles(snaps[2]), infl(snaps[2])], [FIRST2, REST7], 'frame 2 held·inflight');
});
