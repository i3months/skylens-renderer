// 추적 카메라→카메라 갱신이 같은 프레임 안(T15.5): 추적 층(createChaseCamera)과 지형 층(createTerrainLayer)을 묶어
// setTarget → step → camera() → syncCamera → terrain.render 가 한 동기 흐름에서 이어짐을 확인한다.
// createChaseCamera 는 다른 작업(client/tower/chase/index.mjs)이 만들므로 동적 import 로 불러온다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerrainLayer } from '../terrain/index.mjs';
import { dampFactor } from './damp.mjs';
import { syncCamera } from '../../status/camera/index.mjs';

const { createChaseCamera } = await import('./index.mjs');

const SIZE = { width: 64, height: 48, devicePixelRatio: 1 };
const T0 = [32, 40, 0]; // 목표 처음 자리. 방위 0 이면 카메라는 [32, 10, 10](남쪽 30 m 뒤, 10 m 위)
const T1 = [40, 40, 0]; // 동쪽으로 8 m 옮긴 목표
const A = 0.43528187799224083; // 1 − exp(−0.2/0.35)
const MOVED_X = 3.4822550239379266; // 8 × A: step(0.2) 뒤 카메라 x 이동량(m)
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
  const chase = createChaseCamera({ tauSec: 0.35, distM: 30, heightM: 10, lookAheadM: 0, maxDtSec: 1 });
  let seq = 0;
  /** 추적 camera() → syncCamera 의 view → contracts/raster 형식 camera(width,height,K,R,t). */
  const toCamera = () => {
    const { view } = syncCamera(chase.camera(), SIZE, seq++);
    return { width: view.width, height: view.height, K: view.K, R: view.R, t: view.t };
  };
  return { terrain, chase, toCamera };
}

const sameColor = (a, b) => Buffer.compare(Buffer.from(a.color), Buffer.from(b.color)) === 0;
const nonEmpty = (r) => r.index.some((v) => v >= 0);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) <= EPS, `${msg}: ${a} vs ${b}`);

/**
 * 한 프레임(await 없는 동기 흐름). order 'ok' = 목표 이동 → step → render(정상),
 * 'late' = render 뒤에 step(변이: 한 프레임 늦음).
 */
function frame(rig, dt, order) {
  const { terrain, chase, toCamera } = rig;
  chase.setTarget(T0, 0);
  const camB = toCamera();
  const posB = chase.camera().pos;
  const before = terrain.render(camB);
  chase.setTarget(T1, 0);
  let camA;
  let after;
  if (order === 'ok') {
    chase.step(dt);
    camA = toCamera();
    after = terrain.render(camA);
  } else {
    camA = toCamera();
    after = terrain.render(camA); // step 보다 먼저 그려 갱신이 보이지 않는다
    chase.step(dt);
  }
  return { before, after, camB, camA, posB };
}

test('setTarget 직후 camera() 로 render 한 color 는 목표를 옮기지 않은 두 번째 render 와 바이트 동일하다', () => {
  const rig = makeRig();
  rig.chase.setTarget(T0, 0);
  const first = rig.terrain.render(rig.toCamera());
  const second = rig.terrain.render(rig.toCamera());
  assert.ok(nonEmpty(first), '합성 지형이 화면에 그려져야 한다');
  assert.ok(sameColor(first, second));
  // 첫 setTarget 은 감쇠 없이 놓는다: 카메라는 목표 남쪽 30 m 뒤·10 m 위.
  const p = rig.chase.camera().pos;
  near(p[0], 32, 'x');
  near(p[1], 10, 'y');
  near(p[2], 10, 'z');
  // step(0) 도 변화가 없다.
  rig.chase.step(0);
  assert.ok(sameColor(first, rig.terrain.render(rig.toCamera())));
});

test('목표를 8 m 옮기고 step(0.2) 후 같은 프레임 render 는 카메라 x 가 8×(1−e^(−0.2/0.35)) = 3.4822550239379266 m 만 옮겨진다', () => {
  const rig = makeRig();
  const r = frame(rig, 0.2, 'ok');
  assert.ok(nonEmpty(r.before) && nonEmpty(r.after), '합성 지형이 화면에 그려져야 한다');
  near(dampFactor(0.2, 0.35), A, '감쇠 계수(구현 출력)');
  const p = rig.chase.camera().pos;
  near(r.posB[0], 32, '이전 x');
  near(p[0], 32 + MOVED_X, '카메라 x 는 목표 8 m 가 아니라 3.4822550239379266 m 만 이동');
  near(rig.chase.step(0).pos[0] - 32, MOVED_X, '이동량(구현 출력)');
  near(p[1], 10, 'y 불변');
  near(p[2], 10, 'z 불변');
  assert.ok(p[0] < 32 + 8, '목표(8 m)까지는 가지 않았다');
  assert.ok(!sameColor(r.before, r.after), '같은 프레임에서 render 가 바뀌어야 한다');
  // 방위는 그대로이므로 R 불변, Δt = −R·[MOVED_X,0,0]
  [0, 1, 2].forEach((i) => near(r.camA.t[i] - r.camB.t[i], -r.camB.R[i * 3] * MOVED_X, `Δt[${i}]`));
});

test('변이: step 을 render 뒤에 호출하면 ②가 실패한다(영상 동일, 카메라 t 불변)', () => {
  const rig = makeRig();
  const r = frame(rig, 0.2, 'late');
  assert.ok(sameColor(r.before, r.after), '늦게 step 하면 render 가 step 전과 같다');
  assert.deepEqual(r.camA.t, r.camB.t, '늦게 step 하면 t 가 변하지 않았다');
  near(rig.chase.camera().pos[0] - r.posB[0], MOVED_X, 'step 은 render 뒤에 일어났다');
  // 한 프레임 뒤에야 반영된다(그래서 같은 프레임 동기 호출이 계약이다).
  assert.ok(!sameColor(r.before, rig.terrain.render(rig.toCamera())));
});
