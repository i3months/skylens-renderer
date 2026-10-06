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
// 투영점 목록 비교: want = [[id, x, y, visible], ...], got 의 좌표 필드 이름은 xk·yk(overlay 는 u·v, 폴백은 x·y).
const ptsEq = (got, want, xk, yk) =>
  Array.isArray(got) && got.length === want.length &&
  want.every(([id, x, y, vis], k) => got[k].id === id && near(got[k][xk], x) && near(got[k][yk], y) && got[k].visible === vis);

// ── 손계산 보조 ──
// 카메라 자세 쿼터니언(카메라→ENU, (x,y,z,w)). 근거: contracts/controlview/input.mjs camera —
//   yaw=0·pitch=0 이면 카메라 앞(z)=북(+y), 오른쪽(x)=동(+x), 아래(y)=−z. 이 기준 자세의 회전 행렬은 열이 (1,0,0),(0,0,−1),(0,1,0) 인
//   x 축 둘레 −90° 회전 Rx(−π/2) 이다. pitch(위가 +)는 오른쪽 축 둘레 Rx(pitch), yaw(시계 +)는 위 축 둘레 Rz(−yaw) 이므로
//   카메라→ENU = Rz(−yaw)·Rx(pitch − π/2).
//   반각 쿼터니언 qz(b) = (0,0,sin(b/2),cos(b/2)), qx(a) = (sin(a/2),0,0,cos(a/2)). Hamilton 곱 qz⊗qx:
//   벡터부 = cz·(sx,0,0) + cx·(0,0,sz) + (0,0,sz)×(sx,0,0) = (cz·sx, sz·sx, cx·sz), 스칼라부 = cz·cx.
//   q 와 −q 는 같은 회전이라 비교는 부호를 가리지 않는다(quatEq).
function qYP(yaw, pitch) {
  const a = (pitch - Math.PI / 2) / 2, b = -yaw / 2;
  const sx = Math.sin(a), cx = Math.cos(a), sz = Math.sin(b), cz = Math.cos(b);
  return [cz * sx, sz * sx, cx * sz, cz * cx];
}
const quatEq = (got, want) => Array.isArray(got) && got.length === 4 &&
  [1, -1].some((sg) => want.every((v, k) => near(got[k], sg * v)));

// 추적 카메라 피치: rig 시선 d = 목표 − 카메라 = (30 sin ψ, 30 cos ψ, −10)(lookAhead 0, dist 30, height 10)
//   → pitchCam = atan2(−10, 30) = −atan(1/3), yawCam = atan2(30 sin ψ, 30 cos ψ) = ψ.
//   cos(PHI) = 3/√10, sin(PHI) = −1/√10. 그래서 yaw 0 추적 카메라의 축(ENU)은
//   오른쪽 (1,0,0), 앞 (0, 3/√10, −1/√10), 아래 = 앞×오른쪽 = (0, −1/√10, −3/√10).
//   yaw π/2 이면 오른쪽 (0,−1,0), 앞 (3/√10, 0, −1/√10), 아래 (−1/√10, 0, −3/√10).
const PHI = -Math.atan(1 / 3);
const S10 = Math.sqrt(10);
const R2 = Math.SQRT1_2;
// 투영(overlay 계약): X_c = (rel·오른쪽, rel·아래, rel·앞), u = f·X_c.x/X_c.z + w/2, v = f·X_c.y/X_c.z + h/2, f = (h/2)/tan(fovY/2).
// 아래 시험들은 f 가 깔끔해지도록 fovY 를 고른다: fovY = π/2 → f = h/2, fovY = 2·atan(1/2) → f = h.
const FOV_HALF = Math.PI / 2; // f = h/2
const FOV_FULL = 2 * Math.atan(0.5); // f = h
// 감쇠 계수 a = 1 − exp(−dt/tau). tau = .25/ln 2, dt = .25 이면 a = 1 − 1/2 = 1/2.
const TAU_HALF = 0.25 / Math.LN2;

/**
 * 프레임별 기대표와 비교해 불일치 목록을 돌려준다. 기대 항목에 적힌 필드만 본다.
 * 필드: mode, camPos:[x,y,z], quat:[x,y,z,w](부호 무관), fovY, held:[[tx,ty]...], inflight:[[tx,ty]...],
 *       overlayDrones:개수, ovDrones:[[id,u,v,visible]...], ovDetections:[[id,u,v,visible]...], ovPathIds:[id...](정렬),
 *       banner, fbDrones:[[id,x,y]...], fbDetections:[[id,x,y]...], fbPaths:[[id,[[x,y]...]]...]
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
    if (want.quat !== undefined && !quatEq(s.camera?.quat, want.quat)) bad('camera.quat', s.camera?.quat, want.quat);
    if (want.fovY !== undefined && !near(s.camera?.fovY, want.fovY)) bad('camera.fovY', s.camera?.fovY, want.fovY);
    if (want.held !== undefined && !tilesEq(s.streaming?.held, want.held)) bad('held', s.streaming?.held, want.held);
    if (want.inflight !== undefined && !tilesEq(s.streaming?.inflight, want.inflight)) bad('inflight', s.streaming?.inflight, want.inflight);
    if (want.inflightCount !== undefined && s.streaming?.inflight?.length !== want.inflightCount) bad('inflight 개수', s.streaming?.inflight?.length, want.inflightCount);
    if (want.heldCount !== undefined && s.streaming?.held?.length !== want.heldCount) bad('held 개수', s.streaming?.held?.length, want.heldCount);
    if (want.overlayDrones !== undefined && s.overlay?.drones?.length !== want.overlayDrones) bad('overlay 드론 개수', s.overlay?.drones?.length, want.overlayDrones);
    if (want.ovDrones !== undefined && !ptsEq(s.overlay?.drones, want.ovDrones, 'u', 'v')) bad('overlay.drones', s.overlay?.drones, want.ovDrones);
    if (want.ovDetections !== undefined && !ptsEq(s.overlay?.detections, want.ovDetections, 'u', 'v')) bad('overlay.detections', s.overlay?.detections, want.ovDetections);
    if (want.ovPathIds !== undefined) {
      const ids = (s.overlay?.paths ?? []).map((p) => p.id).sort();
      if (s.overlay === null || JSON.stringify(ids) !== JSON.stringify([...want.ovPathIds].sort())) bad('overlay.paths id', ids, want.ovPathIds);
    }
    if (want.banner !== undefined && s.fallback.banner !== want.banner) bad('banner', s.fallback.banner, want.banner);
    for (const [key, field] of [['fbDrones', 'drones'], ['fbDetections', 'detections']]) {
      if (want[key] === undefined) continue;
      const got = s.fallback[field];
      const ok = ptsEq(got, want[key].map(([id, x, y]) => [id, x, y, true]), 'x', 'y');
      if (!ok) bad(`fallback.${field}`, got, want[key]);
    }
    if (want.fbPaths !== undefined) {
      const got = s.fallback.paths;
      const ok = Array.isArray(got) && got.length === want.fbPaths.length &&
        want.fbPaths.every(([id, pts], k) => got[k].id === id && got[k].polyline.length === pts.length &&
          pts.every(([x, y], j) => near(got[k].polyline[j].x, x) && near(got[k].polyline[j].y, y)));
      if (!ok) bad('fallback.paths', got, want.fbPaths);
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
  // 자세: pitch 기본 −0.3, fovY 기본 .9. yaw 는 F0 에서 0, F1 에서 .25 가 되고(→ 를 F2 에서 뗌) 그 뒤 그대로 → quat = qYP(yaw, −0.3).
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
  const Q0 = qYP(0, -0.3), Q25 = qYP(0.25, -0.3);
  const table = [
    { mode: 'live', camPos: [0, 2.5, 1], quat: Q0, fovY: 0.9 },
    { mode: 'live', camPos: [X1, Y1, 1], quat: Q25, fovY: 0.9 },
    { mode: 'live', camPos: [X2, Y2, 1], quat: Q25, fovY: 0.9 },
    { mode: 'live', camPos: [X2, Y2, 2.25], quat: Q25, fovY: 0.9 },
    { mode: 'live', camPos: [X2, Y2, 2.25], quat: Q25, fovY: 0.9 },
    { mode: 'live', camPos: [X2, Y2, 1], quat: Q25, fovY: 0.9 },
    { mode: 'live', camPos: [X2, Y2, 1], quat: Q25, fovY: 0.9 },
    { mode: 'live', camPos: [X2, Y2, 1], quat: Q25, fovY: 0.9 },
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
  // 자세: 입력 카메라는 qYP(0, −0.3). 추적 카메라는 yawCam = 감쇠 yaw, pitchCam = PHI(위 rig 근거). F2 의 step 목표 yaw 는 아직 0
  //       (π/2 는 F2 데이터) 이라 F1·F2 는 qYP(0, PHI), F3 은 qYP((π/2)·a, PHI). fovY 는 입력·추적 모두 기본 .9.
  const rec = [
    { dtSec: 0.25, drones: [{ id: 'd1', enu: [100, 200, 50], yaw: 0 }] },
    { dtSec: 0.25, drones: [{ id: 'd1', enu: [110, 200, 50], yaw: 0 }] },
    { dtSec: 0.25, drones: [{ id: 'd1', enu: [110, 200, 50], yaw: Math.PI / 2 }] },
    { dtSec: 0.25, drones: [] },
    { dtSec: 0.25, drones: [{ id: 'd1', enu: [0, 500, 20], yaw: 0 }] },
    { dtSec: 0.25 },
  ];
  const table = [
    { mode: 'live', camPos: [0, 0, 1], quat: qYP(0, -0.3), fovY: 0.9, overlayDrones: 1 },
    { mode: 'live', camPos: [100, 170, 60], quat: qYP(0, PHI), fovY: 0.9, overlayDrones: 1 },
    { mode: 'live', camPos: [105.10458340443047, 170, 60], quat: qYP(0, PHI), fovY: 0.9, overlayDrones: 1 },
    { mode: 'live', camPos: [86.0446754169607, 179.13813216687055, 60], quat: qYP(0.8018260861497567, PHI), fovY: 0.9, overlayDrones: 0 },
    { mode: 'live', camPos: [0, 0, 1], quat: qYP(0, -0.3), fovY: 0.9, overlayDrones: 1 },
    { mode: 'live', camPos: [0, 470, 30], quat: qYP(0, PHI), fovY: 0.9, overlayDrones: 1 },
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
    { mode: 'live', banner: null, fbDrones: [], fbDetections: [], fbPaths: [], inflightCount: 2, heldCount: 0, overlayDrones: 1 },
    { mode: 'fallback', banner: TOWER_FALLBACK_BANNER, fbDrones: [['d1', 96, 81]], fbDetections: [['det1', 136, 51]], fbPaths: [] },
    { mode: 'fallback', banner: TOWER_FALLBACK_BANNER, fbDrones: [['d1', 106, 73.5]], fbDetections: [['det1', 126, 58.5]], fbPaths: [] },
    { mode: 'live', banner: null, fbDrones: [], fbDetections: [], fbPaths: [], inflightCount: 2, heldCount: 0, overlayDrones: 1 },
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
  // 자세: yaw 0, pitch −π/2 → quat = qYP(0, −π/2) = x 축 둘레 −180° = ±(1,0,0,0). fovY .2.
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
  const QD = qYP(0, -Math.PI / 2);
  const table = [
    { mode: 'live', quat: QD, fovY: 0.2, camPos: [32, 32, 1], held: [], inflight: [[0, 0]] },
    { mode: 'live', quat: QD, fovY: 0.2, camPos: [32, 32, 1], held: [[0, 0]], inflight: [] },
    { mode: 'live', quat: QD, fovY: 0.2, camPos: [32, 64, 1], held: [[0, 0]], inflight: [[0, 1]] },
    { mode: 'live', quat: QD, fovY: 0.2, camPos: [32, 64, 1], held: [[0, 0]], inflight: [] },
    { mode: 'live', quat: QD, fovY: 0.2, camPos: [32, 64, 1], held: [[0, 0], [0, 1]], inflight: [] },
    { mode: 'live', quat: QD, fovY: 0.2, camPos: [32, 96, 1], held: [[0, 0], [0, 1]], inflight: [] },
    { mode: 'live', quat: QD, fovY: 0.2, camPos: [32, 128, 1], held: [[0, 0], [0, 1]], inflight: [[0, 2]] },
    { mode: 'live', quat: QD, fovY: 0.2, camPos: [32, 160, 1], held: [[0, 1], [0, 2]], inflight: [] },
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
  // enu 성분 개수 위반은 범위 위반(overlay validate checkVec: '성분 3개') → RangeError
  assert.throws(() => view.setDrones([{ id: 'd1', enu: [1, 2] }]), RangeError);
  assert.throws(() => view.setAvailable('no'), TypeError);
  assert.equal(JSON.stringify(view.snapshot(size)), before);
  // 추적 목표 갱신 뒤 streaming.update 가 던지는 프레임: 입력은 바로 아래를 봐서 타일이 적지만, 추적 카메라는 거의 수평이라
  // 30 km 시야의 needed 가 maxTilesPerUpdate 를 넘는다 → 입력·추적 모두 되돌린다
  const far = createControlView({ input: { pitchRad: -Math.PI / 2 }, streaming: { maxDistM: 30000 } });
  far.step(0.25, size);
  far.keyDown('ArrowUp');
  // 방위가 도착한 적 없는 첫 드론은 추적하지 않으므로(계약 tracking) 방위를 함께 준다
  far.setDrones([{ id: 'z', enu: [0, 0, 50], yaw: 0 }]);
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

// 손계산이 쉬운 자세: 입력 카메라는 pitch 0·fovY π/2(f = h/2), 추적 카메라는 fovY 2·atan(1/2)(f = h)·감쇠 a = 1/2.
// 입력 yaw ψ·pitch 0 의 카메라 축(ENU): 오른쪽 (cos ψ, −sin ψ, 0), 아래 (0,0,−1), 앞 (sin ψ, cos ψ, 0).
// quat: qYP(ψ, 0) = (−√½·cos(ψ/2), √½·sin(ψ/2), −√½·sin(ψ/2), √½·cos(ψ/2)). ψ = 0 이면 (−√½, 0, 0, √½)(x 축 −90°).
const INPUT_FLAT = { pitchRad: 0, fovYRad: FOV_HALF };
const CHASE_EASY = { tauSec: TAU_HALF, fovYRad: FOV_FULL };

test('e2e: 같은 프레임의 뗌+누름은 누름으로 끝난다(녹화 재생 순서: up 다음 down)', () => {
  // 속도 10 m/s, dt .25 → 한 프레임 2.5 m. yawRate 1 rad/s → 한 프레임 .25 rad.
  // G0: ↑ 누름 → y = 2.5
  // G1: ↑ 를 같은 프레임에 뗐다 누름 → 누른 채로 끝남 → y = 5. (누름→뗌 순서였다면 뗀 채로 끝나 y = 2.5 에 머문다)
  // G2: → 를 같은 프레임에 뗐다(안 눌린 키라 무시) 누름 → 눌림. yawMid = .125 → x = 2.5·sin(.125), y = 5 + 2.5·cos(.125), yaw → .25
  // G3: ↑·→ 뗌 → 움직이지 않음, yaw .25 유지
  const rec = [
    { dtSec: 0.25, keys: { down: ['ArrowUp'] } },
    { dtSec: 0.25, keys: { down: ['ArrowUp'], up: ['ArrowUp'] } },
    { dtSec: 0.25, keys: { down: ['ArrowRight'], up: ['ArrowRight'] } },
    { dtSec: 0.25, keys: { up: ['ArrowUp', 'ArrowRight'] } },
  ];
  const X = 2.5 * Math.sin(0.125), Y = 5 + 2.5 * Math.cos(0.125);
  const Q0 = [-R2, 0, 0, R2], Q25 = [-R2 * Math.cos(0.125), R2 * Math.sin(0.125), -R2 * Math.sin(0.125), R2 * Math.cos(0.125)];
  const table = [
    { mode: 'live', camPos: [0, 2.5, 1], quat: Q0, fovY: FOV_HALF, ovDrones: [], ovDetections: [], fbPaths: [] },
    { mode: 'live', camPos: [0, 5, 1], quat: Q0, fovY: FOV_HALF, ovDrones: [], ovDetections: [], fbPaths: [] },
    { mode: 'live', camPos: [X, Y, 1], quat: Q25, fovY: FOV_HALF, ovDrones: [], ovDetections: [], fbPaths: [] },
    { mode: 'live', camPos: [X, Y, 1], quat: Q25, fovY: FOV_HALF, ovDrones: [], ovDetections: [], fbPaths: [] },
  ];
  assertMatch(replayRecording(createControlView({ input: INPUT_FLAT }), rec, { width: 160, height: 120 }), table);
});

test('e2e: 방위 없는 프레임은 이전 방위를 유지하고, 다른 드론으로 바뀌면 컷 전환하며, 오버레이는 활성 카메라로 투영한다', () => {
  // 크기 160×120: 입력 f = 60, 추적 f = 120, (cx, cy) = (80, 60). 데이터는 step 뒤에 들어온다.
  // F0: step 때 드론 없음 → 입력 카메라 (0,0,1) yaw 0, quat (−√½,0,0,√½), fovY π/2.
  //     데이터 d1 (100,200,50) yaw π/2, 탐지 k1 (115,230,40).
  //     d1: rel (100,200,49) → X_c = (100, −49, 200) → u = 80 + 60·100/200 = 110, v = 60 − 60·49/200 = 45.3
  //     k1: rel (115,230,39) → X_c = (115, −39, 230) → u = 80 + 60·115/230 = 110, v = 60 − 60·39/230 = 60 − 234/23
  // F1: 첫 목표 d1, yaw π/2 → 감쇠 없이 놓임: p = (100,200,50), ψ = π/2. 카메라 = p − 30·(1,0,0) + (0,0,10) = (70,200,60), qYP(π/2, PHI), fovY 2·atan(1/2).
  //     데이터 d1 (110,200,50) 방위 없음.
  //     d1: rel (40,0,−10): X_c = (0, (−40+30)/√10, (120+10)/√10) → u = 80, v = 60 − 120·10/130 = 60 − 120/13
  //     k1: rel (45,30,−20): X_c = (−30, (−45+60)/√10, (135+20)/√10) → u = 80 − 120·30·√10/155 = 80 − 720√10/31, v = 60 + 120·15/155 = 60 + 360/31
  // F2: d1 에 방위가 없다 → 같은 드론의 이전 방위 π/2 유지(0 으로 두면 ψ 가 π/4 로 감쇠해 카메라가 달라진다).
  //     같은 드론이라 감쇠: p = (100,200,50) + ((110,200,50) − (100,200,50))·1/2 = (105,200,50), ψ = π/2. 카메라 (75,200,60).
  //     데이터 [d2 (115,210,50) yaw 0, d1 (110,200,50)] → 다음 프레임 첫 드론이 d2.
  //     d2: rel (40,10,−10): X_c = (−10, (−40+30)/√10, (120+10)/√10) → u = 80 − 120·10·√10/130 = 80 − 120√10/13, v = 60 − 120/13
  //     d1: rel (35,0,−10): X_c = (0, (−35+30)/√10, (105+10)/√10) → u = 80, v = 60 − 120·5/115 = 60 − 120/23
  //     k1: rel (40,30,−20): X_c = (−30, (−40+60)/√10, (120+20)/√10) → u = 80 − 180√10/7(< 0 → visible false), v = 60 + 120/7
  // F3: 첫 드론이 d2 로 바뀜 → 컷 전환: p = (115,210,50), ψ = 0. 카메라 (115,180,60), qYP(0, PHI).
  //     (감쇠였다면 p = (110,205,50), ψ = π/4 로 옛 자리에서 날아온다)
  //     d2: rel (0,30,−10): X_c = (0, (−30+30)/√10, (90+10)/√10) → (80, 60) 화면 중앙
  //     d1: rel (−5,20,−10): X_c = (−5, (−20+30)/√10, (60+10)/√10) → u = 80 − 120·5·√10/70 = 80 − 60√10/7, v = 60 + 120/7
  //     k1: rel (0,50,−20): X_c = (0, (−50+60)/√10, (150+20)/√10) → u = 80, v = 60 + 120·10/170 = 60 + 120/17
  const rec = [
    { dtSec: 0.25, drones: [{ id: 'd1', enu: [100, 200, 50], yaw: Math.PI / 2 }], detections: [{ id: 'k1', enu: [115, 230, 40] }] },
    { dtSec: 0.25, drones: [{ id: 'd1', enu: [110, 200, 50] }] },
    { dtSec: 0.25, drones: [{ id: 'd2', enu: [115, 210, 50], yaw: 0 }, { id: 'd1', enu: [110, 200, 50] }] },
    { dtSec: 0.25 },
  ];
  const table = [
    {
      mode: 'live', camPos: [0, 0, 1], quat: [-R2, 0, 0, R2], fovY: FOV_HALF,
      ovDrones: [['d1', 110, 45.3, true]], ovDetections: [['k1', 110, 60 - 234 / 23, true]], fbDrones: [], fbPaths: [],
    },
    {
      mode: 'live', camPos: [70, 200, 60], quat: qYP(Math.PI / 2, PHI), fovY: FOV_FULL,
      ovDrones: [['d1', 80, 60 - 120 / 13, true]], ovDetections: [['k1', 80 - (720 * S10) / 31, 60 + 360 / 31, true]], fbDrones: [], fbPaths: [],
    },
    {
      mode: 'live', camPos: [75, 200, 60], quat: qYP(Math.PI / 2, PHI), fovY: FOV_FULL,
      ovDrones: [['d2', 80 - (120 * S10) / 13, 60 - 120 / 13, true], ['d1', 80, 60 - 120 / 23, true]],
      ovDetections: [['k1', 80 - (180 * S10) / 7, 60 + 120 / 7, false]], fbDrones: [], fbPaths: [],
    },
    {
      mode: 'live', camPos: [115, 180, 60], quat: qYP(0, PHI), fovY: FOV_FULL,
      ovDrones: [['d2', 80, 60, true], ['d1', 80 - (60 * S10) / 7, 60 + 120 / 7, true]],
      ovDetections: [['k1', 80, 60 + 120 / 17, true]], fbDrones: [], fbPaths: [],
    },
  ];
  const view = createControlView({ input: INPUT_FLAT, chase: CHASE_EASY });
  assertMatch(replayRecording(view, rec, { width: 160, height: 120 }), table);
});

test('e2e: 추적 중 step 이 던지면 입력·추적을 되돌리고 다음 프레임은 되돌린 상태에서 이어간다', () => {
  // 스트리밍 maxDistM 30 km. 타일 높이는 [−100, 600] 이라 카메라 높이가 30600 m 를 넘으면 거리 구가 타일에 닿지 않아 needed 0.
  // 드론을 높이 40000 m 에 두면 추적 카메라(높이 40010)는 타일이 없고, 드론을 50 m 로 내리면 거의 수평 시야가 30 km 를 덮어
  // needed 가 maxTilesPerUpdate(4096)를 넘어 streaming.update 가 RangeError 를 던진다(추적 목표 갱신·감쇠 뒤에 던짐).
  // 입력 카메라는 바로 아래(pitch −π/2)를 봐서 높이 1 m 에서는 타일이 몇 개뿐이다.
  // S0F0: 드론 없음 → 입력 카메라 (0,0,1), quat qYP(0,−π/2) = ±(1,0,0,0), fovY .9.
  //       데이터 z (0,0,40000) yaw 0 은 입력 카메라 뒤(앞 = (0,0,−1), 깊이 −39999 ≤ 0) → u = v = 0, visible false.
  // S0F1: 첫 목표 z → 놓임 p = (0,0,40000), ψ 0. 카메라 (0,−30,40010), qYP(0,PHI), fovY 2·atan(1/2).
  //       데이터 z (40,0,40000): rel (40,30,−10): X_c = (40, 0, 100/√10) → u = 80 + 120·40·√10/100 = 80 + 48√10(≥ 160 → visible false), v = 60
  // 그다음 ↑ 를 누르고 z 를 (0,0,50) 으로 옮긴 뒤 step → RangeError. 입력(↑ 로 2.5 m 전진)·추적(p 가 (0,0,20025) 로 감쇠)을 모두 되돌려
  // snapshot 은 던지기 전과 같다. 이어서 z 를 (40,0,40000) 으로 되돌려 둔다.
  // S1F0: 되돌린 p = (0,0,40000) 에서 감쇠: p = (20,0,40000). 카메라 (20,−30,40010). (되돌리지 않았다면 (20,0,30012.5) 에서 시작)
  //       z: rel (20,30,−10): X_c = (20, 0, 100/√10) → u = 80 + 24√10, v = 60, visible
  // S1F1: p = (30,0,40000). 카메라 (30,−30,40010). 데이터 드론 없음 → 오버레이 드론 없음.
  // S1F2: 목표 해제 → 입력 카메라. 던진 프레임의 전진은 없었으므로 ↑ 는 S1F0·S1F1·S1F2 세 번 → y = 7.5
  const size = { width: 160, height: 120 };
  const view = createControlView({ input: { pitchRad: -Math.PI / 2 }, chase: CHASE_EASY, streaming: { maxDistM: 30000 } });
  const s0 = replayRecording(view, [
    { dtSec: 0.25, drones: [{ id: 'z', enu: [0, 0, 40000], yaw: 0 }] },
    { dtSec: 0.25, drones: [{ id: 'z', enu: [40, 0, 40000], yaw: 0 }] },
  ], size);
  const QDOWN = qYP(0, -Math.PI / 2);
  assertMatch(s0, [
    { mode: 'live', camPos: [0, 0, 1], quat: QDOWN, fovY: 0.9, ovDrones: [['z', 0, 0, false]] },
    { mode: 'live', camPos: [0, -30, 40010], quat: qYP(0, PHI), fovY: FOV_FULL, ovDrones: [['z', 80 + 48 * S10, 60, false]] },
  ]);
  view.keyDown('ArrowUp');
  view.setDrones([{ id: 'z', enu: [0, 0, 50], yaw: 0 }]);
  const before = JSON.stringify(view.snapshot(size));
  assert.throws(() => view.step(0.25, size), RangeError);
  assert.equal(JSON.stringify(view.snapshot(size)), before);
  view.setDrones([{ id: 'z', enu: [40, 0, 40000], yaw: 0 }]);
  const s1 = replayRecording(view, [{ dtSec: 0.25 }, { dtSec: 0.25, drones: [] }, { dtSec: 0.25 }], size);
  assertMatch(s1, [
    { mode: 'live', camPos: [20, -30, 40010], quat: qYP(0, PHI), fovY: FOV_FULL, ovDrones: [['z', 80 + 24 * S10, 60, true]] },
    { mode: 'live', camPos: [30, -30, 40010], quat: qYP(0, PHI), fovY: FOV_FULL, ovDrones: [] },
    { mode: 'live', camPos: [0, 7.5, 1], quat: QDOWN, fovY: 0.9, ovDrones: [] },
  ]);
});

// 오버레이만 거부하는 입력: 같은 검사기를 쓰는 overlay·fallback 은 보통 같은 판정을 내리므로, 접근자로 overlay 의 읽기에만 나쁜 값을 준다.
// 호출 스택에 overlay/index.mjs 가 있고 fallback/index.mjs 가 없을 때(= overlay 가 검사하며 읽을 때)만 bad 를 돌려준다.
// 조립 층은 입력을 한 번만 읽어 사본을 두 층에 넘기므로 두 층이 같은 사본을 보아 아무도 거부하지 않는다(불변식). 두 층은 같은 새 데이터를 가져야 한다.
function readByOverlayOnly() {
  const lim = Error.stackTraceLimit;
  Error.stackTraceLimit = 200;
  const st = new Error().stack ?? '';
  Error.stackTraceLimit = lim;
  return st.includes('/overlay/index.mjs') && !st.includes('/fallback/index.mjs');
}
function overlayOnlyBad(obj, key, good, badValue) {
  Object.defineProperty(obj, key, { enumerable: true, configurable: true, get: () => (readByOverlayOnly() ? badValue : good) });
  return obj;
}
function threw(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

test('e2e: removePath 는 overlay·fallback 양쪽에서 빼고, 조립 층이 한 번 읽은 사본을 두 층에 넘겨 거부 없이 같은 새 데이터를 갖는다', () => {
  // 크기 232×132, 폴백 기본값 → 여백 16, avail 100. 받은 점의 경계 상자 변이 100 m 이하면 metersPerPx = 1.
  // 추적 카메라 fovY 2·atan(1/2) → f = 132, (cx, cy) = (116, 66).
  // H0: d1 (100,200,50) yaw 0, k1 (120,230,30), p1 [(100,200),(140,200)], p2 [(120,215),(130,225)], 데이터 뒤 서버 불가.
  //     상자 e [100,140], n [200,230] → 중심 (120,215) → x = 116 + (e − 120) = e − 4, y = 66 − (n − 215) = 281 − n.
  //     d1 (96,81), k1 (116,51), p1 (96,81)-(136,81), p2 (116,66)-(126,56)
  // removePath('p1') 뒤 H1: 상자 e [100,130], n [200,230] → 중심 (115,215) → x = e + 1, y = 281 − n.
  //     d1 (101,81), k1 (121,51), p2 (121,66)-(131,56). (폴백에 p1 이 남으면 상자·경로 목록이 달라진다)
  // overlay 만 거부(4 건): 드론 [d1, d9 (100,230,50)], 탐지 [k1, k2 (110,210,0)], p2 교체 [(130,225),(110,205)], 새 p3 [(100,230),(130,200)].
  //   거부 없음(두 층이 같은 사본을 본다) → 두 층 모두 새 값을 가진다:
  //   새 점은 모두 상자 e [100,130], n [200,230] 안이라 사상은 그대로 → d9 (101,51), k2 (111,71), p2 (131,56)-(111,76), p3 (101,51)-(131,81).
  // H3: 서버 복귀(live). 첫 드론 d1(yaw 0)을 H1 부터 추적 → 카메라 (100,170,60), qYP(0, PHI).
  //     d1 은 시선 위 → (116, 66). k1: rel (20,60,−30): X_c = (20, (−60+90)/√10, (180+30)/√10) → u = 116 + 132·20·√10/210 = 116 + 88√10/7, v = 66 + 132·30/210 = 66 + 132/7
  //     d9: rel (0,60,−10): X_c = (0, (−60+30)/√10, (180+10)/√10) → u = 116, v = 66 − 132·30/190 = 66 − 396/19
  //     k2: rel (10,40,−60): X_c = (10, (−40+180)/√10, (120+60)/√10) → u = 116 + 22√10/3, v = 66 + 132·140/180 = 66 + 308/3(≥ 132 → visible false)
  const size = { width: 232, height: 132 };
  const view = createControlView({ chase: CHASE_EASY });
  const D1 = { id: 'd1', enu: [100, 200, 50], yaw: 0 }, K1 = { id: 'k1', enu: [120, 230, 30] };
  const h0 = replayRecording(view, [{
    dtSec: 0.25, drones: [D1], detections: [K1],
    paths: [{ id: 'p1', points: [[100, 200, 0], [140, 200, 0]] }, { id: 'p2', points: [[120, 215, 0], [130, 225, 0]] }],
    available: false,
  }], size);
  assertMatch(h0, [{
    mode: 'fallback', banner: TOWER_FALLBACK_BANNER, fbDrones: [['d1', 96, 81]], fbDetections: [['k1', 116, 51]],
    fbPaths: [['p1', [[96, 81], [136, 81]]], ['p2', [[116, 66], [126, 56]]]],
  }]);
  assert.equal(view.removePath('p1'), true);
  const h1Row = {
    mode: 'fallback', banner: TOWER_FALLBACK_BANNER, fbDrones: [['d1', 101, 81]], fbDetections: [['k1', 121, 51]],
    fbPaths: [['p2', [[121, 66], [131, 56]]]],
  };
  assertMatch(replayRecording(view, [{ dtSec: 0.25 }], size), [h1Row]);

  // 접근자는 overlay 가 직접 읽을 때만 나쁜 값을 주지만, 조립 층의 사본을 보므로 4 건 모두 거부되지 않는다(불변식).
  const rd = threw(() => view.setDrones([D1, overlayOnlyBad({ id: 'd9' }, 'enu', [100, 230, 50], [1, 2])]));
  assert.equal(rd, false, 'rd: 두 층이 같은 사본을 보아 거부 없음');
  const rk = threw(() => view.setDetections([K1, overlayOnlyBad({ id: 'k2' }, 'enu', [110, 210, 0], [1, 2])]));
  assert.equal(rk, false, 'rk: 두 층이 같은 사본을 보아 거부 없음');
  const rp2 = threw(() => view.setPath(overlayOnlyBad({ id: 'p2' }, 'points', [[130, 225, 0], [110, 205, 0]], [[0, 0, 0]])));
  assert.equal(rp2, false, 'rp2: 두 층이 같은 사본을 보아 거부 없음');
  const rp3 = threw(() => view.setPath(overlayOnlyBad({ id: 'p3' }, 'points', [[100, 230, 0], [130, 200, 0]], [[0, 0, 0]])));
  assert.equal(rp3, false, 'rp3: 두 층이 같은 사본을 보아 거부 없음');

  const h2Row = {
    mode: 'fallback', banner: TOWER_FALLBACK_BANNER,
    fbDrones: [['d1', 101, 81], ['d9', 101, 51]],
    fbDetections: [['k1', 121, 51], ['k2', 111, 71]],
    fbPaths: [['p2', [[131, 56], [111, 76]]], ['p3', [[101, 51], [131, 81]]]],
  };
  const D1_OV = ['d1', 116, 66, true], K1_OV = ['k1', 116 + (88 * S10) / 7, 66 + 132 / 7, true];
  const h3Row = {
    mode: 'live', camPos: [100, 170, 60], quat: qYP(0, PHI), fovY: FOV_FULL, fbDrones: [], fbDetections: [], fbPaths: [],
    ovDrones: [D1_OV, ['d9', 116, 66 - 396 / 19, true]],
    ovDetections: [K1_OV, ['k2', 116 + (22 * S10) / 3, 66 + 308 / 3, false]],
    ovPathIds: ['p2', 'p3'],
  };
  assertMatch(replayRecording(view, [{ dtSec: 0.25 }, { dtSec: 0.25, available: true }], size), [h2Row, h3Row]);
});

// 'overlay 검사 ⊆ 폴백 검사' 고정: 폴백이 받아들이는 경계 입력을 조립이 거부하면(= 오버레이 쪽 검사만 거부) 실패한다.
// 오버레이 단독 거부는 조립에서 폴백이 먼저 반영된 뒤에 던져 폴백만 새 값을 갖는 불일치를 만든다(되돌리기 코드는 없다).
// 그래서 검사 규칙이 오버레이에만 더 생기면 이 시험이 알린다. 경계: 개수 상한·id 64 코드포인트(서로게이트 쌍)·|e|,|n| = 1e6·yaw 음수/큰 값·alert·confidence 0/1.
// 한정: 이 시험은 경계 표본(위 목록)만 검사한다. 경계 밖 임의 입력의 포함 관계는 보장하지 않는다.
test('e2e: 폴백이 받는 경계 입력을 오버레이 쪽 검사가 단독으로 거부하지 않는다(오버레이 검사 ⊆ 폴백 검사)', () => {
  const size = { width: 200, height: 100 };
  const view = createControlView();
  const id64 = '\u{1F6E9}'.repeat(64); // 코드포인트 64 개(UTF-16 128 단위)
  const drones = [
    { id: id64, enu: [1e6, -1e6, 0], yaw: -1e9 },
    { id: 'a', enu: [-1e6, 1e6, -1e5], yaw: 0 },
    { id: 'b', enu: [0, 0, 1e9] },
  ];
  for (let i = 0; i < 253; i++) drones.push({ id: `n${i}`, enu: [i, -i, 0] }); // 총 256 = maxDrones
  assert.doesNotThrow(() => view.setDrones(drones), 'setDrones 경계');
  const dets = [
    { id: id64, enu: [1e6, 1e6, 0], kind: 'alert', confidence: 0 },
    { id: 'c1', enu: [-1e6, -1e6, 0], kind: 'detection', confidence: 1 },
  ];
  for (let i = 0; i < 4094; i++) dets.push({ id: `k${i}`, enu: [i % 1000, -(i % 1000), 5] }); // 총 4096 = maxDetections
  assert.doesNotThrow(() => view.setDetections(dets), 'setDetections 경계');
  assert.doesNotThrow(() => view.setPath({ id: id64, points: [[1e6, 1e6, 0], [-1e6, -1e6, 1e5]] }), 'setPath 경계');
  view.setAvailable(false); // 폴백 모드에서 폴백 층이 받은 것을 본다
  const snap = view.step(0.25, size);
  assert.equal(snap.mode, 'fallback');
  assert.equal(snap.fallback.drones.length, 256);
  assert.equal(snap.fallback.detections.length, 4096);
  assert.equal(snap.fallback.paths.length, 1);
});
