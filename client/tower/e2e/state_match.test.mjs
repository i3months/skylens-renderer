// 관제탑 화면 조립(T15.9) 상태 일치 시험. 녹화를 재생해 프레임별 상태가 손계산 기대표와 0 불일치인지 본다.
// 기준값은 모두 시험 안에 숫자로 박는다(구현에서 다시 계산하지 않는다). 계약: contracts/controlview/e2e.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlView } from './index.mjs';
import { replayRecording } from './recording.mjs';
import { TOWER_E2E_MATCH } from '../../../contracts/controlview/e2e.mjs';
import { TOWER_FALLBACK_BANNER } from '../../../contracts/controlview/fallback.mjs';

// 초월함수(sin·cos·exp)를 거친 값의 비교 허용치. 손계산 값은 소수 16 자리까지 적었다.
const EPS = 1e-9;

const near = (a, b) => typeof a === 'number' && Math.abs(a - b) <= EPS;
const tilesEq = (got, want) =>
  Array.isArray(got) && got.length === want.length && got.every((t, i) => t.tx === want[i][0] && t.ty === want[i][1]);

/**
 * 프레임별 기대표와 비교해 불일치 목록을 돌려준다. 기대 항목에 적힌 필드만 본다.
 * 필드: mode, camPos:[x,y,z], held:[[tx,ty]...], inflight:[[tx,ty]...], overlayDrones:개수,
 *       banner, fbDrones:[[id,x,y]...], fbDetections:[[id,x,y]...]
 */
function mismatches(snaps, table) {
  const out = [];
  if (snaps.length !== table.length) out.push(`프레임 수 ${snaps.length} ≠ ${table.length}`);
  table.forEach((want, i) => {
    const s = snaps[i];
    if (s === undefined) return;
    const bad = (what, got, exp) => out.push(`frame ${i} ${what}: got ${JSON.stringify(got)} want ${JSON.stringify(exp)}`);
    if (want.mode !== undefined && s.mode !== want.mode) bad('mode', s.mode, want.mode);
    if (s.mode === 'fallback') {
      // fallback 모드에서는 3D 층 결과를 내지 않는다
      if (s.camera !== null) bad('camera(fallback 은 null)', s.camera, null);
      if (s.streaming !== null) bad('streaming(fallback 은 null)', s.streaming, null);
      if (s.overlay !== null) bad('overlay(fallback 은 null)', s.overlay, null);
    }
    if (want.camPos !== undefined) {
      const p = s.camera?.pos;
      if (!p || !want.camPos.every((v, k) => near(p[k], v))) bad('camera.pos', p, want.camPos);
    }
    if (want.held !== undefined && !tilesEq(s.streaming?.held, want.held)) bad('held', s.streaming?.held, want.held);
    if (want.inflight !== undefined && !tilesEq(s.streaming?.inflight, want.inflight)) bad('inflight', s.streaming?.inflight, want.inflight);
    if (want.inflightCount !== undefined && s.streaming?.inflight?.length !== want.inflightCount) bad('inflight 개수', s.streaming?.inflight?.length, want.inflightCount);
    if (want.heldCount !== undefined && s.streaming?.held?.length !== want.heldCount) bad('held 개수', s.streaming?.held?.length, want.heldCount);
    if (want.overlayDrones !== undefined && s.overlay?.drones?.length !== want.overlayDrones) bad('overlay 드론 개수', s.overlay?.drones?.length, want.overlayDrones);
    if (want.banner !== undefined && s.fallback.banner !== want.banner) bad('banner', s.fallback.banner, want.banner);
    for (const [key, field] of [['fbDrones', 'drones'], ['fbDetections', 'detections']]) {
      if (want[key] === undefined) continue;
      const got = s.fallback[field];
      const ok = got.length === want[key].length && want[key].every(([id, x, y], k) => got[k].id === id && near(got[k].x, x) && near(got[k].y, y) && got[k].visible === true);
      if (!ok) bad(`fallback.${field}`, got, want[key]);
    }
  });
  return out;
}

function assertMatch(snaps, table) {
  const m = mismatches(snaps, table);
  assert.ok(m.length <= TOWER_E2E_MATCH.maxFrameStateMismatch, `불일치 ${m.length} 건:\n${m.join('\n')}`);
}

test('e2e: 전진·회전·고도 키 녹화의 프레임별 위치(ENU)가 손계산과 같다', () => {
  // 입력 기본값: 시작 (0,0,1), yaw 0, speed 10 m/s, yawRate 1 rad/s, altRate 5 m/s, maxDt 0.25 s, 고도 [1,500].
  // 드론이 없으므로 카메라는 입력 카메라이고 camera.pos = 입력 위치다.
  // F0 ↑, dt .25: y = 10·.25 = 2.5
  // F1 ↑+→, dt .25: yawMid = .125, x = sin(.125)·2.5 = 0.31168683346306925, y = 2.5 + cos(.125)·2.5 = 4.980494168073323, yaw → .25
  // F2 ↑, → 뗌, dt 1.0 → 상한 .25: yawMid = .25, x += sin(.25)·2.5 → 0.9301967315993765, y += cos(.25)·2.5 → 7.402775222349934
  // F3 E, ↑ 뗌, dt .5 → .25: z = 1 + 5·.25 = 2.25
  // F4 E+Q 상쇄: 변화 없음
  // F5 E 뗌(Q 만): z = 2.25 − 1.25 = 1
  // F6 Q: 하한 1 에서 잘림
  // F7 dt 0: 변화 없음
  const rec = {
    version: 1,
    frames: [
      { dtSec: 0.25, keys: { down: ['ArrowUp'] } },
      { dtSec: 0.25, keys: { down: ['ArrowRight'] } },
      { dtSec: 1.0, keys: { up: ['ArrowRight'] } },
      { dtSec: 0.5, keys: { down: ['KeyE'], up: ['ArrowUp'] } },
      { dtSec: 0.25, keys: { down: ['KeyQ'] } },
      { dtSec: 0.25, keys: { up: ['KeyE'] } },
      { dtSec: 0.25 },
      { dtSec: 0 },
    ],
  };
  const X1 = 0.31168683346306925, Y1 = 4.980494168073323, X2 = 0.9301967315993765, Y2 = 7.402775222349934;
  const table = [
    { mode: 'live', camPos: [0, 2.5, 1] },
    { mode: 'live', camPos: [X1, Y1, 1] },
    { mode: 'live', camPos: [X2, Y2, 1] },
    { mode: 'live', camPos: [X2, Y2, 2.25] },
    { mode: 'live', camPos: [X2, Y2, 2.25] },
    { mode: 'live', camPos: [X2, Y2, 1] },
    { mode: 'live', camPos: [X2, Y2, 1] },
    { mode: 'live', camPos: [X2, Y2, 1] },
  ];
  const view = createControlView();
  assertMatch(replayRecording(view, rec, { width: 160, height: 120 }), table);
});

test('e2e: 드론 추적 녹화의 프레임별 카메라 위치가 손계산과 같다', () => {
  // 추적 기본값: tau .35 s, dist 30 m, height 10 m, lookAhead 0. 데이터는 step 뒤에 들어오므로 다음 프레임 step 이 목표로 쓴다.
  // 감쇠 계수 a = 1 − exp(−.25/.35) = 0.5104583404430468
  // F0: step 때 드론 없음 → 입력 카메라 (0,0,1). 데이터: d1 (100,200,50) yaw 0
  // F1: 첫 목표 → 감쇠 없이 놓임. 카메라 = (100, 200−30, 50+10) = (100,170,60). 데이터: d1 (110,200,50) yaw 0
  // F2: x = 100 + 10·a = 105.10458340443047 → 카메라 (105.10458340443047, 170, 60). 데이터: d1 yaw π/2
  // F3: x = 105.104… + (110 − 105.104…)·a = 107.60348963558225, yaw = (π/2)·a = 0.8018260861497567
  //     카메라 = (x − 30·sin yaw, 200 − 30·cos yaw, 60) = (86.0446754169607, 179.13813216687055, 60). 데이터: 드론 없음
  // F4: 목표 해제 → 입력 카메라 (0,0,1). 데이터: d1 (0,500,20) yaw 0 다시 나타남
  // F5: 재등장은 컷 전환(옛 자리에서 날아오지 않음) → 카메라 (0, 470, 30)
  const rec = [
    { dtSec: 0.25, drones: [{ id: 'd1', enu: [100, 200, 50], yaw: 0 }] },
    { dtSec: 0.25, drones: [{ id: 'd1', enu: [110, 200, 50], yaw: 0 }] },
    { dtSec: 0.25, drones: [{ id: 'd1', enu: [110, 200, 50], yaw: Math.PI / 2 }] },
    { dtSec: 0.25, drones: [] },
    { dtSec: 0.25, drones: [{ id: 'd1', enu: [0, 500, 20], yaw: 0 }] },
    { dtSec: 0.25 },
  ];
  const table = [
    { mode: 'live', camPos: [0, 0, 1], overlayDrones: 1 },
    { mode: 'live', camPos: [100, 170, 60], overlayDrones: 1 },
    { mode: 'live', camPos: [105.10458340443047, 170, 60], overlayDrones: 1 },
    { mode: 'live', camPos: [86.0446754169607, 179.13813216687055, 60], overlayDrones: 0 },
    { mode: 'live', camPos: [0, 0, 1], overlayDrones: 1 },
    { mode: 'live', camPos: [0, 470, 30], overlayDrones: 1 },
  ];
  const view = createControlView();
  assertMatch(replayRecording(view, rec, { width: 160, height: 120 }), table);
});

test('e2e: 서버 불가 구간은 fallback 프레임이고 3D 층 결과를 내지 않는다', () => {
  // 크기 232×132, 폴백 기본값 minSpanM 100, marginPx 16 → avail = 132 − 32 = 100, 점이 100 m 안이면 metersPerPx = 1.
  // F1: d1 (100,200), det1 (140,230) → 중심 (120,215). d1: x = 116 − 20 = 96, y = 66 + 15 = 81. det1: x = 136, y = 51
  // F2: d1 (120,215) → 중심 (130,222.5). d1: x = 106, y = 73.5. det1: x = 126, y = 58.5
  // live 프레임: maxInflight 2 이고 1500 m 시야에는 타일이 2 개보다 많으므로 inflight 2, 도착 없음 held 0.
  const rec = [
    { dtSec: 0.25, drones: [{ id: 'd1', enu: [100, 200, 50] }], detections: [{ id: 'det1', enu: [140, 230, 0], kind: 'alert' }], available: true },
    { dtSec: 0.25, available: false },
    { dtSec: 0.25, drones: [{ id: 'd1', enu: [120, 215, 50] }] },
    { dtSec: 0.25, available: true },
  ];
  const table = [
    { mode: 'live', banner: null, fbDrones: [], fbDetections: [], inflightCount: 2, heldCount: 0, overlayDrones: 1 },
    { mode: 'fallback', banner: TOWER_FALLBACK_BANNER, fbDrones: [['d1', 96, 81]], fbDetections: [['det1', 136, 51]] },
    { mode: 'fallback', banner: TOWER_FALLBACK_BANNER, fbDrones: [['d1', 106, 73.5]], fbDetections: [['det1', 126, 58.5]] },
    { mode: 'live', banner: null, fbDrones: [], fbDetections: [], inflightCount: 2, heldCount: 0, overlayDrones: 1 },
  ];
  const view = createControlView({ streaming: { maxInflight: 2 } });
  const snaps = replayRecording(view, rec, { width: 232, height: 132 });
  assertMatch(snaps, table);
  // 폴백 프레임에는 3D 층 필드가 없다(null)
  for (const s of snaps.slice(1, 3)) {
    assert.equal(s.camera, null);
    assert.equal(s.streaming, null);
    assert.equal(s.overlay, null);
  }
});

test('e2e: 타일 도착 순서에 따른 held·inflight 가 손계산과 같다', () => {
  // 입력: 시작 (32,32,1)(타일 (0,0) 한가운데), 바로 아래를 봄(pitch −π/2), fovY .2, 속도 128 m/s → 한 프레임(.25 s) 32 m 북쪽.
  // 스트리밍: maxDistM 50, maxInflight 1. 바로 아래를 보는 정사각 시야가 50 m 구 안에서 덮는 반폭은 50·tan(.1) ≈ 5 m 이하.
  // 그래서 위치 y 에서 [y−5, y+5] 가 걸친 타일(한 변 64 m. x 는 [27,37] 이라 tx=0)이 needed 이고, 경계에서 32 m 떨어진 타일은 들지 않는다.
  // F0: y=32 → needed {(0,0)} → 요청 (0,0)
  // F1: 요청 안 한 (0,1) 도착은 버린다. (0,0) 도착 → held
  // F2: ↑, y=64(경계) → (0,0),(0,1) → 요청 (0,1)
  // F3: ↑ 뗌, (0,1) 실패 → inflight 비움
  // F4: 다시 요청 (0,1) 후 도착 → held (0,0),(0,1)
  // F5: ↑, y=96 → (0,1) 만. retain(팽창 1) ty 0..2 라 (0,0) 유지, 요청 없음
  // F6: y=128(경계) → (0,1),(0,2) → 요청 (0,2)
  // F7: y=160 → (0,2) 만. retain ty 1..3 → (0,0) 내보냄. 이미 내보낸 (0,0) 도착은 버림, (0,2) 도착 → held
  const rec = [
    { dtSec: 0.25 },
    { dtSec: 0.25, arrivedTiles: [[0, 1], [0, 0]] },
    { dtSec: 0.25, keys: { down: ['ArrowUp'] } },
    { dtSec: 0.25, keys: { up: ['ArrowUp'] }, failedTiles: [[0, 1]] },
    { dtSec: 0.25, arrivedTiles: [[0, 1]] },
    { dtSec: 0.25, keys: { down: ['ArrowUp'] } },
    { dtSec: 0.25 },
    { dtSec: 0.25, arrivedTiles: [[0, 0], [0, 2]] },
  ];
  const table = [
    { mode: 'live', camPos: [32, 32, 1], held: [], inflight: [[0, 0]] },
    { mode: 'live', camPos: [32, 32, 1], held: [[0, 0]], inflight: [] },
    { mode: 'live', camPos: [32, 64, 1], held: [[0, 0]], inflight: [[0, 1]] },
    { mode: 'live', camPos: [32, 64, 1], held: [[0, 0]], inflight: [] },
    { mode: 'live', camPos: [32, 64, 1], held: [[0, 0], [0, 1]], inflight: [] },
    { mode: 'live', camPos: [32, 96, 1], held: [[0, 0], [0, 1]], inflight: [] },
    { mode: 'live', camPos: [32, 128, 1], held: [[0, 0], [0, 1]], inflight: [[0, 2]] },
    { mode: 'live', camPos: [32, 160, 1], held: [[0, 1], [0, 2]], inflight: [] },
  ];
  const view = createControlView({
    input: { pos: [32, 32, 1], pitchRad: -Math.PI / 2, fovYRad: 0.2, speedMps: 128 },
    streaming: { maxDistM: 50, maxInflight: 1 },
  });
  assertMatch(replayRecording(view, rec, { width: 100, height: 100 }), table);
});

test('e2e: 같은 녹화를 두 번 재생하면 JSON 으로 같다', () => {
  const rec = [
    { dtSec: 0.25, keys: { down: ['ArrowUp', 'ArrowLeft'] }, drones: [{ id: 'd1', enu: [10, 20, 30], yaw: 1 }] },
    { dtSec: 0.1, paths: [{ id: 'p1', points: [[0, 0, 0], [10, 50, 5]] }], available: false },
    { dtSec: 0.2, available: true, detections: [{ id: 'x', enu: [5, 5, 0] }] },
  ];
  const size = { width: 320, height: 240 };
  const a = replayRecording(createControlView(), rec, size);
  const b = replayRecording(createControlView(), rec, size);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('e2e: step·데이터가 던지면 상태 불변', () => {
  const size = { width: 160, height: 120 };
  const view = createControlView({ streaming: { maxInflight: 2 } });
  view.keyDown('ArrowUp');
  view.step(0.25, size);
  view.setDrones([{ id: 'd1', enu: [100, 200, 50], yaw: 0 }]);
  view.step(0.25, size);
  const before = JSON.stringify(view.snapshot(size));
  assert.throws(() => view.step(-1, size), RangeError);
  assert.throws(() => view.step(Number.NaN, size), RangeError);
  assert.throws(() => view.step(0.25, { width: 0, height: 10 }), RangeError);
  assert.throws(() => view.setDrones([{ id: 'd1', enu: [1, 2] }]));
  assert.throws(() => view.setAvailable('no'), TypeError);
  assert.equal(JSON.stringify(view.snapshot(size)), before);
  // 추적 목표 갱신 뒤 streaming.update 가 던지는 프레임: 입력은 바로 아래를 봐서 타일이 적지만, 추적 카메라는 거의 수평이라
  // 30 km 시야의 needed 가 maxTilesPerUpdate 를 넘는다 → 입력·추적 모두 되돌린다
  const far = createControlView({ input: { pitchRad: -Math.PI / 2 }, streaming: { maxDistM: 30000 } });
  far.step(0.25, size);
  far.keyDown('ArrowUp');
  far.setDrones([{ id: 'z', enu: [0, 0, 50] }]);
  const farData = JSON.stringify(far.snapshot(size));
  assert.throws(() => far.step(0.25, size), RangeError);
  assert.equal(JSON.stringify(far.snapshot(size)), farData);
  // 드론을 치우면 되돌린 입력에서 이어서 적분한다(던진 프레임의 이동은 없다): 0.25 s 전진 한 번 = 2.5 m
  far.setDrones([]);
  const s = far.step(0.25, size);
  assert.deepEqual(s.camera.pos, [0, 2.5, 1]);
});

test('e2e: 알 수 없는 opts 키는 RangeError', () => {
  assert.throws(() => createControlView({ bogus: {} }), RangeError);
  assert.throws(() => createControlView(null), TypeError);
});
