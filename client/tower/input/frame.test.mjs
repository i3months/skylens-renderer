// 입력→카메라 갱신이 같은 프레임 안(T15.4.10): 입력 층(createTowerInput)과 지형 층(createTerrainLayer)을 묶어
// keyDown → step → camera() → syncCamera → terrain.render 가 한 동기 흐름에서 이어짐을 확인한다.
// createTowerInput 은 다른 작업(client/tower/input/index.mjs)이 만들므로 동적 import 로 불러온다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerrainLayer } from '../terrain/index.mjs';
import { syncCamera } from '../../status/camera/index.mjs';

const { createTowerInput } = await import('./index.mjs');

const SIZE = { width: 64, height: 48, devicePixelRatio: 1 };
const START = [32, 10, 30]; // 타일(0,0) 남쪽 가장자리 근처, 북쪽(yaw 0)을 비스듬히 내려다본다
const EPS = 1e-9;

/** 요철 있는 합성 지형 타일 하나(64 m 타일, 17×17 격자). 결정적 값이라 매번 같다. */
function bumpyTile() {
  const cells = 17;
  const heights = new Float32Array(cells * cells);
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) heights[j * cells + i] = 6 * Math.sin(i * 0.9) * Math.cos(j * 0.7) + 0.3 * i;
  }
  return { tx: 0, ty: 0, lod: 0, cells, heights };
}

function makeRig() {
  const terrain = createTerrainLayer();
  terrain.accept(0, [bumpyTile()]);
  const input = createTowerInput({ pos: [...START], yaw: 0, maxDtSec: 1 });
  let seq = 0;
  /** 입력 camera() → syncCamera 의 view → contracts/raster 형식 camera(width,height,K,R,t). */
  const toCamera = () => {
    const { view } = syncCamera(input.camera(), SIZE, seq++);
    return { width: view.width, height: view.height, K: view.K, R: view.R, t: view.t };
  };
  return { terrain, input, toCamera };
}

const sameColor = (a, b) => Buffer.compare(Buffer.from(a.color), Buffer.from(b.color)) === 0;
const nonEmpty = (r) => r.index.some((v) => v >= 0);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) <= EPS, `${msg}: ${a} vs ${b}`);

/**
 * 한 프레임(await 없는 동기 흐름). order 'ok' = keyDown → step → render(정상),
 * 'late' = render 뒤에 step(변이: 한 프레임 늦음).
 */
function frame(rig, key, dt, order) {
  const { terrain, input, toCamera } = rig;
  const camB = toCamera();
  const before = terrain.render(camB);
  input.keyDown(key);
  let camA;
  let after;
  if (order === 'ok') {
    input.step(dt);
    camA = toCamera();
    after = terrain.render(camA);
  } else {
    camA = toCamera();
    after = terrain.render(camA); // step 보다 먼저 그려 갱신이 보이지 않는다
    input.step(dt);
  }
  return { before, after, camB, camA };
}

/** (1)의 판정: 같은 프레임에서 영상이 바뀌었는가, t 가 이동량(moved, ENU)만큼 변했는가. */
function judge(r, moved) {
  const changed = !sameColor(r.before, r.after);
  const R = r.camB.R; // 직진은 방위를 안 바꾸므로 R 은 그대로다
  const dt = r.camA.t.map((v, i) => v - r.camB.t[i]);
  // t = −R·pos 이므로 pos 가 moved 만큼 바뀌면 Δt = −R·moved
  const want = [0, 1, 2].map((i) => -(R[i * 3] * moved[0] + R[i * 3 + 1] * moved[1] + R[i * 3 + 2] * moved[2]));
  const tOk = dt.every((v, i) => Math.abs(v - want[i]) <= EPS);
  return { changed, tOk, dt, want };
}

test('ArrowUp → step(0.2) → render 가 같은 프레임에서 step 이전 render 와 달라지고 t 가 1.6 m 앞만큼 변한다', () => {
  const rig = makeRig();
  const r = frame(rig, 'ArrowUp', 0.2, 'ok');
  assert.ok(nonEmpty(r.before) && nonEmpty(r.after), '합성 지형이 화면에 그려져야 한다');
  const pos = rig.input.pose().pos;
  near(pos[0], START[0], 'x 불변');
  near(pos[1], START[1] + 1.6, 'y 는 speed 8 m/s × 0.2 s = 1.6 m 북쪽으로');
  near(pos[2], START[2], 'z 불변');
  const j = judge(r, [0, 1.6, 0]);
  assert.ok(j.changed, 'step 후 render 가 step 전과 달라야 한다');
  assert.ok(j.tOk, `Δt ${JSON.stringify(j.dt)} 가 −R·[0,1.6,0] ${JSON.stringify(j.want)} 와 같아야 한다`);
  // 실제로 1.6 m 만큼 변했다(0 이 아님).
  const len = Math.hypot(...j.dt);
  assert.ok(len > 1.59 && len < 1.61, `|Δt| = ${len}`);
  // 앞으로 다가감(Δt[2] < 0), 동서 이동 없음(|Δt[0]| ≈ 0)
  assert.ok(j.dt[2] < 0, `Δt[2] = ${j.dt[2]} 는 음수여야 함(앞으로 다가감)`);
  assert.ok(Math.abs(j.dt[0]) <= EPS, `|Δt[0]| = ${Math.abs(j.dt[0])} 는 거의 0이어야 함`);
});

test('변이: step 을 render 뒤에 호출하면 (1)의 판정이 실패한다(영상 동일, t 불변)', () => {
  const rig = makeRig();
  const r = frame(rig, 'ArrowUp', 0.2, 'late');
  const j = judge(r, [0, 1.6, 0]);
  assert.equal(j.changed, false, '늦게 step 하면 render 가 step 전과 같다');
  assert.equal(j.tOk, false, '늦게 step 하면 t 가 이동량만큼 변하지 않았다');
  // 한 프레임 뒤에야 반영된다(그래서 같은 프레임 동기 호출이 계약이다).
  assert.ok(!sameColor(r.before, rig.terrain.render(rig.toCamera())));
});

test('키를 안 눌렀으면 step 전후 render 의 color 가 바이트 동일하다', () => {
  const rig = makeRig();
  const b = rig.terrain.render(rig.toCamera());
  rig.input.step(0.2);
  const a = rig.terrain.render(rig.toCamera());
  assert.ok(nonEmpty(b));
  assert.ok(sameColor(b, a));
  // 눌렀다 뗀 키도 남지 않는다.
  rig.input.keyDown('ArrowUp');
  rig.input.keyUp('ArrowUp');
  rig.input.step(0.2);
  assert.ok(sameColor(b, rig.terrain.render(rig.toCamera())));
});

test('KeyE → step(1) 이면 z 가 altRate(5 m) 만큼 오르고 t 와 render 에 같은 프레임에서 반영된다', () => {
  const rig = makeRig();
  const camB = rig.toCamera();
  const before = rig.terrain.render(camB);
  rig.input.keyDown('KeyE');
  rig.input.step(1);
  const camA = rig.toCamera();
  const after = rig.terrain.render(camA);
  near(rig.input.pose().pos[2], START[2] + 5, 'pose z');
  near(rig.input.camera().pos[2], START[2] + 5, 'camera z');
  // Δt = −R·[0,0,5] = −5·(R 의 3열)
  [0, 1, 2].forEach((i) => near(camA.t[i] - camB.t[i], -camB.R[i * 3 + 2] * 5, `Δt[${i}]`));
  assert.ok(!sameColor(before, after));
});
