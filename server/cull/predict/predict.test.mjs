// 시점 예측 시험: 해석해·단조·경로 재생(빠진 조각 0)·퇴화·입력 오류. 기준값은 시험 안에 숫자로 고정한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../../../fixtures/scenes/terrain/index.mjs';
import { dronePath } from '../../../fixtures/paths/index.mjs';
import { buildHierarchy } from '../../lod/hierarchy/index.mjs';
import { boxMayBeVisible } from '../../lod/select/view_check.mjs';
import { cameraCenter } from '../../lod/select/screen_error.mjs';
import { predictCamera, predictiveMask } from './index.mjs';

const K = { fx: 400, fy: 400, cx: 320, cy: 240 };
function lookAt(eye, target) {
  const f = target.map((v, i) => v - eye[i]); const fn = Math.hypot(...f); const z = f.map((v) => v / fn);
  let x = [z[2] * 0 - z[1] * 0, 0, 0]; // up=(0,1,0): x = up × z 가 아니라 GL 규약과 무관하게 정규직교만 필요
  x = [z[2], 0, -z[0]]; const xn = Math.hypot(...x); x = x.map((v) => v / xn);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const R = [...x, ...y, ...z];
  const t = [0, 1, 2].map((r) => -(R[3 * r] * eye[0] + R[3 * r + 1] * eye[1] + R[3 * r + 2] * eye[2]));
  return { width: 640, height: 480, K, R, t };
}
const mulv = (R, v) => [0, 1, 2].map((i) => R[3 * i] * v[0] + R[3 * i + 1] * v[1] + R[3 * i + 2] * v[2]);

const cloud0 = generate({ seed: 3, count: 20000 });
const h = buildHierarchy(cloud0.cloud ?? cloud0, { edge0M: 0.4, levelCount: 3, maxLeafPoints: 512 });
const oc = h.octree;
const boxOf = (k) => { const n = oc.leafIndex.indexOf(k); return [oc.boxMin.slice(3 * n, 3 * n + 3), oc.boxMax.slice(3 * n, 3 * n + 3)]; };
const visibleSet = (cam) => { const s = new Set(); for (let k = 0; k < oc.leafCount; k++) { const [a, b] = boxOf(k); if (boxMayBeVisible(cam, a, b)) s.add(k); } return s; };
const sum = (m) => m.reduce((a, b) => a + b, 0);
const ex = (c) => { const e = cameraCenter(c); return e; };

test('직선 등속: 중심 = C+v·dt, 회전 불변, 해석해와 1e-9 이내', () => {
  const cam = lookAt([10, 30, 5], [0, 0, 0]);
  const p = predictCamera(cam, { velocityMps: [3, -1, 2], angularRadPerS: [0, 0, 0] }, 2.5);
  const C = cameraCenter(cam), Cn = cameraCenter(p);
  [7.5, -2.5, 5].forEach((d, i) => assert.ok(Math.abs(Cn[i] - (C[i] + d)) < 1e-9));
  cam.R.forEach((v, i) => assert.ok(Math.abs(p.R[i] - v) < 1e-12));
  assert.deepEqual(p.K, K); assert.equal(p.width, 640); assert.equal(p.height, 480);
});

test('등속 회전: 세계 +y 축 90도/s 를 1초 -> 카메라 축(+z)이 해석해(세계 Rot_y(90도))로 돈다', () => {
  // 카메라가 세계 +x 를 본다: R 의 3번째 행(+z 축의 세계 방향) = (1,0,0)
  const R = [0, 0, -1, 0, 1, 0, 1, 0, 0]; // 행: x축=(0,0,-1), y축=(0,1,0), z축=(1,0,0)
  const cam = { width: 640, height: 480, K, R, t: [0, 0, 0] };
  const p = predictCamera(cam, { velocityMps: [0, 0, 0], angularRadPerS: [0, Math.PI / 2, 0] }, 1);
  // 세계 y 축 둘레 +90도: (1,0,0) -> (0,0,-1)
  const z = p.R.slice(6, 9), x = p.R.slice(0, 3);
  [0, 0, -1].forEach((v, i) => assert.ok(Math.abs(z[i] - v) < 1e-9, `z축 ${z}`));
  [-1, 0, 0].forEach((v, i) => assert.ok(Math.abs(x[i] - v) < 1e-9, `x축 ${x}`)); // (0,0,-1) -> (-1,0,0)
  // 직교·det
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const d = p.R[3 * i] * p.R[3 * j] + p.R[3 * i + 1] * p.R[3 * j + 1] + p.R[3 * i + 2] * p.R[3 * j + 2];
    assert.ok(Math.abs(d - (i === j ? 1 : 0)) < 1e-9);
  }
});

test('회전+이동 복합: 임의 축에서도 R 직교 1e-9, t = −R·C_new, 중심은 직선', () => {
  let c = lookAt([0, 40, 0], [20, 0, 20]);
  for (let i = 0; i < 200; i++) c = predictCamera(c, { velocityMps: [1, 0.5, -2], angularRadPerS: [0.3, -0.7, 0.2] }, 0.05);
  const C = cameraCenter(c);
  [10, 40 + 5, -20].forEach((v, i) => assert.ok(Math.abs(C[i] - v) < 1e-9, `C${i}=${C[i]}`));
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const d = c.R[3 * i] * c.R[3 * j] + c.R[3 * i + 1] * c.R[3 * j + 1] + c.R[3 * i + 2] * c.R[3 * j + 2];
    assert.ok(Math.abs(d - (i === j ? 1 : 0)) < 1e-9);
  }
  // 한 번에 10초 예측과 200 번 0.05초 누적이 같다
  const one = predictCamera(lookAt([0, 40, 0], [20, 0, 20]), { velocityMps: [1, 0.5, -2], angularRadPerS: [0.3, -0.7, 0.2] }, 10);
  one.R.forEach((v, i) => assert.ok(Math.abs(v - c.R[i]) < 1e-9));
});

test('속도 0 이면 현재 시점 판정과 같다(horizon 이 커도)', () => {
  const cam = lookAt([0, 60, 0], [10, 0, 10]);
  const m = predictiveMask(h, { camera: cam, velocityMps: [0, 0, 0], angularRadPerS: [0, 0, 0] }, { horizonS: 5, steps: 4 });
  const m2 = predictiveMask(h, { camera: cam }, { horizonS: 5, steps: 4 });
  const cur = visibleSet(cam);
  assert.equal(sum(m), cur.size);
  assert.ok(cur.size > 0 && cur.size < oc.leafCount, `현재 보이는 리프 ${cur.size}/${oc.leafCount}`);
  for (let k = 0; k < oc.leafCount; k++) { assert.equal(m[k], cur.has(k) ? 1 : 0); assert.equal(m2[k], m[k]); }
});

test('단조: 현재 마스크 ⊆ 예측 마스크, horizon 이 커지면 커진다', () => {
  const cam = lookAt([-60, 40, 0], [0, 0, 0]);
  const st = { camera: cam, velocityMps: [6, 0, 0], angularRadPerS: [0, 0.4, 0] };
  const cur = visibleSet(cam);
  let prev = -1;
  for (const hz of [0, 1, 3, 6]) {
    const m = predictiveMask(h, st, { horizonS: hz, steps: 12 });
    for (const k of cur) assert.equal(m[k], 1);
    assert.ok(sum(m) >= Math.max(prev, cur.size));
    prev = sum(m);
  }
  assert.ok(prev > cur.size, '움직이면 앞당겨 보낼 리프가 늘어야 함');
});

function replay(cam0, v, w, horizonS, steps, taus) {
  const m = predictiveMask(h, { camera: cam0, velocityMps: v, angularRadPerS: w }, { horizonS, steps });
  let missed = 0, checked = 0;
  for (const tau of taus) {
    const vis = visibleSet(predictCamera(cam0, { velocityMps: v, angularRadPerS: w }, tau));
    for (const k of vis) { checked++; if (!m[k]) missed++; }
  }
  return { missed, checked, kept: sum(m) };
}
const dense = (hz, n) => Array.from({ length: n + 1 }, (_, i) => (hz * i) / n);

test('경로 재생(직선·회전·복합): 시각 τ 의 실제 절두체에 보이는 리프가 예측 마스크에서 빠진 수 = 0', () => {
  const cases = [
    [lookAt([-70, 30, 0], [0, 0, 0]), [10, 0, 0], [0, 0, 0]],
    [lookAt([0, 50, 0], [30, 0, 0]), [0, 0, 0], [0, 0.8, 0]],
    [lookAt([30, 35, -40], [0, 0, 0]), [-4, 1, 6], [0.2, -0.6, 0.3]],
  ];
  for (const [c, v, w] of cases) {
    const r = replay(c, v, w, 4, 8, dense(4, 400));
    assert.equal(r.missed, 0, `빠진 리프 ${r.missed}/${r.checked}`);
    assert.ok(r.checked > 0);
  }
});

test('fixtures/paths 시작 프레임 카메라에서도 빠진 조각 0 (등속 직선+회전 합성)', () => {
  const f = dronePath({ seed: 7, frames: 30, center: [0, 0, 0], radius: 60, altitude: 40 }).frames[0];
  const cam = lookAt(f.eye, f.target);
  const r = replay(cam, [-5, 0, 3], [0, 0.5, 0], 3, 6, dense(3, 300));
  assert.equal(r.missed, 0);
});

test('퇴화: NaN 카메라·NaN 속도·Infinity 각속도 -> 던지지 않고 빈 마스크', () => {
  const cam = lookAt([0, 50, 0], [10, 0, 10]);
  const opt = { horizonS: 2, steps: 4 };
  const bad = { ...cam, R: cam.R.map((v, i) => (i === 0 ? NaN : v)) };
  for (const st of [{ camera: bad }, { camera: { ...cam, t: [NaN, 0, 0] } }, { camera: { ...cam, width: 0 } },
    { camera: cam, velocityMps: [NaN, 0, 0] }, { camera: cam, angularRadPerS: [0, Infinity, 0] }]) {
    const m = predictiveMask(h, st, opt);
    assert.equal(m.length, oc.leafCount); assert.equal(sum(m), 0);
  }
  assert.doesNotThrow(() => predictCamera(bad, { velocityMps: [1, 0, 0] }, 1));
});

test("입력 오류는 'cull:' 로 던진다", () => {
  const st = { camera: lookAt([0, 50, 0], [10, 0, 10]) };
  for (const o of [{ horizonS: -1, steps: 2 }, { horizonS: NaN, steps: 2 }, { horizonS: Infinity, steps: 2 }, { horizonS: '1', steps: 2 },
    { horizonS: 1, steps: 0 }, { horizonS: 1, steps: 1.5 }, { horizonS: 1, steps: -3 }, { horizonS: 1 }, undefined]) {
    assert.throws(() => predictiveMask(h, st, o), /^Error: cull:/);
  }
  assert.throws(() => predictiveMask(h, { ...st, velocityMps: [1, 2] }, { horizonS: 1, steps: 2 }), /^Error: cull:/);
  assert.throws(() => predictiveMask({}, st, { horizonS: 1, steps: 2 }), /^Error: cull:/);
  assert.throws(() => predictCamera(st.camera, {}, 'x'), /^Error: cull:/);
  assert.throws(() => predictCamera(st.camera, { velocityMps: 5 }, 1), /^Error: cull:/);
});
