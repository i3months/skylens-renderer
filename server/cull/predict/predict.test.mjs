// 시점 예측 시험: 해석해·단조·경로 재생(빠진 조각 0)·퇴화·입력 오류. 기준값은 시험 안에 숫자로 고정한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../../../fixtures/scenes/terrain/index.mjs';
import { dronePath } from '../../../fixtures/paths/index.mjs';
import { buildHierarchy } from '../../lod/hierarchy/index.mjs';
import { boxMayBeVisibleSplat } from '../../lod/select/view_check.mjs';
import { cameraCenter } from '../../lod/select/screen_error.mjs';
import { frustumCull } from '../frustum/index.mjs';
import { predictCamera, predictiveMask } from './index.mjs';
import { isDegenerateView } from '../degenerate/index.mjs';

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
// pointSizeM = 0 이면 원판 중심만 보는 규칙(boxMayBeVisible 과 같음), 양수면 같은 지름의 원판 규칙.
const visibleSet = (cam, pointSizeM = 0) => { const s = new Set(); for (let k = 0; k < oc.leafCount; k++) { const [a, b] = boxOf(k); if (boxMayBeVisibleSplat(cam, a, b, pointSizeM)) s.add(k); } return s; };
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
  const m = predictiveMask(h, { camera: cam, velocityMps: [0, 0, 0], angularRadPerS: [0, 0, 0] }, { horizonS: 5, steps: 4, pointSizeM: 0 });
  const m2 = predictiveMask(h, { camera: cam }, { horizonS: 5, steps: 4, pointSizeM: 0 });
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
    const m = predictiveMask(h, st, { horizonS: hz, steps: 12, pointSizeM: 0 });
    for (const k of cur) assert.equal(m[k], 1);
    assert.ok(sum(m) >= Math.max(prev, cur.size));
    prev = sum(m);
  }
  assert.ok(prev > cur.size, '움직이면 앞당겨 보낼 리프가 늘어야 함');
});

function replay(cam0, v, w, horizonS, steps, taus, pointSizeM = 0) {
  const m = predictiveMask(h, { camera: cam0, velocityMps: v, angularRadPerS: w }, { horizonS, steps, pointSizeM });
  let missed = 0, checked = 0;
  for (const tau of taus) {
    const vis = visibleSet(predictCamera(cam0, { velocityMps: v, angularRadPerS: w }, tau), pointSizeM);
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
    for (const ps of [0, 0.5]) {
      const r = replay(c, v, w, 4, 8, dense(4, 400), ps);
      assert.equal(r.missed, 0, `pointSizeM=${ps} 빠진 리프 ${r.missed}/${r.checked}`);
      assert.ok(r.checked > 0);
    }
  }
});

test('fixtures/paths 시작 프레임 카메라에서도 빠진 조각 0 (등속 직선+회전 합성)', () => {
  const f = dronePath({ seed: 7, frames: 30, center: [0, 0, 0], radius: 60, altitude: 40 }).frames[0];
  const cam = lookAt(f.eye, f.target);
  for (const ps of [0, 0.5]) assert.equal(replay(cam, [-5, 0, 3], [0, 0.5, 0], 3, 6, dense(3, 300), ps).missed, 0);
});

test('양수 지름: 화면 가장자리에 걸친 리프는 살고(중심만 보면 밖), 지름 0 이면 버린다', () => {
  const cam = lookAt([0, 50, 0], [10, 0, 10]); // 지름 0: 25 개, 지름 2: 27 개
  const D = 2;
  const c0 = visibleSet(cam, 0), cD = visibleSet(cam, D);
  const edge = [...cD].filter((k) => !c0.has(k));
  assert.ok(edge.length > 0, '가장자리에 걸친 리프가 있어야 함');
  const mD = predictiveMask(h, { camera: cam }, { horizonS: 3, steps: 3, pointSizeM: D });
  const m0 = predictiveMask(h, { camera: cam }, { horizonS: 3, steps: 3, pointSizeM: 0 });
  for (const k of edge) { assert.equal(mD[k], 1); assert.equal(m0[k], 0); }
  assert.equal(sum(mD), cD.size);
});

test('빈 리프는 버린다: v=ω=0 이면 frustumCull 과 바이트 단위로 같다(빈 리프 포함 계층, 지름 없음·0·양수)', () => {
  const ls = Uint32Array.from(h.levels[0].leafStart);
  const cam = lookAt([0, 60, 0], [10, 0, 10]);
  const vis = [...visibleSet(cam, 0)];
  assert.ok(vis.length >= 2);
  const kEmpty = vis[0];
  // 리프 kEmpty 를 비운다: 이후 구간을 앞으로 당긴다
  const cnt = ls[kEmpty + 1] - ls[kEmpty];
  for (let k = kEmpty + 1; k < ls.length; k++) ls[k] -= cnt;
  const h2 = { ...h, levels: [{ ...h.levels[0], leafStart: ls }, ...h.levels.slice(1)] };
  for (const ps of [undefined, 0, 0.5]) {
    const a = predictiveMask(h2, { camera: cam, velocityMps: [0, 0, 0], angularRadPerS: [0, 0, 0] }, { horizonS: 4, steps: 3, pointSizeM: ps });
    const b = frustumCull(h2, cam, ps === undefined ? undefined : { pointSizeM: ps });
    assert.equal(Buffer.compare(Buffer.from(a), Buffer.from(b)), 0, `pointSizeM=${ps}`);
    assert.equal(a[kEmpty], 0);
    assert.ok(sum(a) > 0);
  }
  const moving = predictiveMask(h2, { camera: cam, velocityMps: [3, 0, 0] }, { horizonS: 4, steps: 3 });
  assert.equal(moving[kEmpty], 0);
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
  assert.throws(() => predictCamera(null, {}, 1), /^Error: cull:/);
  assert.throws(() => predictCamera(st.camera, null, 1), /^Error: cull:/);
  assert.throws(() => predictiveMask(h, st, null), /^Error: cull:/);
});

// ---- F-129: 예측 마스크의 상한(위쪽 경계)·음성 시험 ----
// 허용 집합: 시각 τ(0..horizonS 를 n 등분)의 카메라에서, 상자를 그 시점 중심에서의 이동·회전 변위 상한만큼 부풀려 보이는 리프의 합집합.
// 변위 상한 = speed·hh + omega·hh·(상자 최원점 거리 + speed·hh)(hh = 구간 반폭).
function allowedUnion(camAt, horizonS, n, speed, omega, hh, pointSizeM = 0) {
  const s = new Set();
  for (let i = 0; i <= n; i++) {
    const cam = camAt((horizonS * i) / n), C = cameraCenter(cam);
    for (let k = 0; k < oc.leafCount; k++) {
      const [a, b] = boxOf(k);
      const far = Math.hypot(...[0, 1, 2].map((d) => Math.max(Math.abs(a[d] - C[d]), Math.abs(b[d] - C[d]))));
      const M = 1.001 * (speed * hh + omega * hh * (far + speed * hh)) + 1e-6;
      if (boxMayBeVisibleSplat(cam, a.map((x) => x - M), b.map((x) => x + M), pointSizeM)) s.add(k);
    }
  }
  return s;
}

test('상한: 움직이는 카메라의 예측 마스크 ⊆ (표본 시점들의 보이는 리프 + 부풀림 여유), 모두 1 이 아니다', () => {
  const horizonS = 4, steps = 8, hh = horizonS / steps / 2;
  const cases = [
    [lookAt([-70, 30, 0], [0, 0, 0]), [10, 0, 0], [0, 0, 0]],
    [lookAt([0, 50, 0], [30, 0, 0]), [0, 0, 0], [0, 0.05, 0]],
    [lookAt([30, 35, -40], [0, 0, 0]), [-4, 1, 6], [0.02, -0.03, 0.01]],
  ];
  for (const [cam, v, w] of cases) {
    const speed = Math.hypot(...v), omega = Math.hypot(...w);
    const camAt = (tau) => predictCamera(cam, { velocityMps: v, angularRadPerS: w }, tau);
    const allowed = allowedUnion(camAt, horizonS, steps * 4, speed, omega, hh);
    const m = predictiveMask(h, { camera: cam, velocityMps: v, angularRadPerS: w }, { horizonS, steps, pointSizeM: 0 });
    for (let k = 0; k < oc.leafCount; k++) if (m[k]) assert.ok(allowed.has(k), `허용 밖 리프 ${k}`);
    assert.ok(allowed.size < oc.leafCount, `전제: 허용 집합이 전체가 아님 ${allowed.size}/${oc.leafCount}`);
    assert.ok(sum(m) >= visibleSet(cam).size);
  }
});

test('음성: 장면 밖(시선이 장면 반대쪽)을 향해 천천히 움직이면 마스크는 전부 0', () => {
  const cam = lookAt([0, 200, 0], [1, 500, 0]); // 장면(y<=115) 위에서 위쪽 하늘을 본다(시선이 위쪽 축과 정확히 평행이면 lookAt 이 퇴화하므로 약간 비튼다)
  assert.equal(isDegenerateView(cam), false, '전제: 비퇴화 카메라(퇴화 처리 때문에 0 이 되는 것이 아님)');
  assert.equal(visibleSet(cam).size, 0, '전제: 현재 보이는 리프 없음');
  const m = predictiveMask(h, { camera: cam, velocityMps: [0, 2, 0], angularRadPerS: [0, 0.05, 0] }, { horizonS: 2, steps: 4, pointSizeM: 0 });
  assert.equal(m.length, oc.leafCount);
  assert.equal(sum(m), 0);
});

test('고속·시선에 수직 이동: 해석적 평행이동 시점(눈·목표를 같이 이동)의 보이는 리프가 모두 남고, 새로 보이는 리프가 생긴다', () => {
  const eye = [-60, 40, 0], tgt = [0, 0, 0], v = [0, 0, 35], horizonS = 4, steps = 8; // 시선 +x, 이동 +z = 수직
  const camAt = (tau) => lookAt([eye[0] + v[0] * tau, eye[1] + v[1] * tau, eye[2] + v[2] * tau], [tgt[0] + v[0] * tau, tgt[1] + v[1] * tau, tgt[2] + v[2] * tau]);
  const cam = camAt(0);
  const m = predictiveMask(h, { camera: cam, velocityMps: v }, { horizonS, steps, pointSizeM: 0 });
  const cur = visibleSet(cam);
  let missed = 0, gained = new Set();
  for (let i = 0; i <= steps; i++) for (const k of visibleSet(camAt((horizonS * i) / steps))) { if (!m[k]) missed++; if (!cur.has(k)) gained.add(k); }
  assert.equal(missed, 0);
  assert.ok(gained.size >= 3, `전제: 이동으로 새로 보이는 리프 ${gained.size}`);
  for (const k of gained) assert.equal(m[k], 1);
  // 상한: 평행이동뿐이므로 부풀림은 v·h 만.
  const allowed = allowedUnion(camAt, horizonS, steps * 4, Math.hypot(...v), 0, horizonS / steps / 2);
  for (let k = 0; k < oc.leafCount; k++) if (m[k]) assert.ok(allowed.has(k), `허용 밖 리프 ${k}`);
  assert.ok(allowed.size < oc.leafCount);
});

test('잘게/성기게 나눈 직선 이동: 마스크는 해석적 시점 합집합을 덮고, 기하 상한(|v|·구간 반폭) 안에 머문다(과잉 부풀림 없음)', () => {
  const horizonS = 4;
  // 느린 이동(5 mm/s: 4 s 동안 2 cm)은 고정 가산 여유(예: +0.2 m)를, 빠른 이동은 배율 부풀림을 드러낸다.
  for (const [eye, tgt, v] of [[[-60, 40, 0], [0, 0, 0], [6, 0, 8]], [[-60, 40, 0], [0, 0, 0], [0.003, 0, 0.004]], [[20, 70, -50], [-10, 0, 10], [0.003, -0.001, 0.004]],
    [[-60, 30, -60], [-60, 45, -10], [0.003, 0, 0.004]], [[-30, 30, 30], [20, 40, 30], [0.003, 0, 0.004]]]) { // 뒤의 둘은 0.2 m 부풀림이 리프 경계에 걸리는 시점(탐색으로 고름)
  const camAt = (tau) => lookAt([eye[0] + v[0] * tau, eye[1] + v[1] * tau, eye[2] + v[2] * tau], [tgt[0] + v[0] * tau, tgt[1] + v[1] * tau, tgt[2] + v[2] * tau]);
  // steps=80: 구간 반폭 0.025 s -> 부풀림 0.25 m. steps=4: 반폭 0.5 s -> 5 m(작은 계수 오차도 리프 경계에 걸리도록 크게).
  for (const steps of [80, 4]) {
    const hh = horizonS / steps / 2;
    const m = predictiveMask(h, { camera: camAt(0), velocityMps: v }, { horizonS, steps, pointSizeM: 0 });
    const exact = allowedUnion(camAt, horizonS, steps, 0, 0, 0);
    for (const k of exact) assert.equal(m[k], 1, `steps=${steps}: 정확한 합집합의 리프 ${k} 가 빠짐`);
    // 구현 식과 독립인 기하 상한: 이동만 있으므로 한 표본이 덮는 구간 반폭 동안 카메라는 |v|·hh 이상 움직일 수 없다.
    // 표본을 4배 촘촘히 잡고 상자를 정확히 그 거리(+1e-3 m 수치 여유)만 부풀려 보이는 리프의 합집합이 상한이다(계수·덧셈 여유 없음).
    const M = Math.hypot(...v) * hh + 1e-3;
    const bound = new Set();
    for (let i = 0; i <= steps * 4; i++) {
      const cam = camAt((horizonS * i) / (steps * 4));
      for (let k = 0; k < oc.leafCount; k++) {
        const [a, b] = boxOf(k);
        if (boxMayBeVisibleSplat(cam, a.map((x) => x - M), b.map((x) => x + M), 0)) bound.add(k);
      }
    }
    for (let k = 0; k < oc.leafCount; k++) if (m[k]) assert.ok(bound.has(k), `steps=${steps}: 기하 상한 밖 리프 ${k}`);
    assert.ok(sum(m) >= exact.size);
  }
  }
});

// ---- F-134: 유한하지만 극단적인 입력 ----
test('극단 유한 입력: 부풀림이 비유한이어도 현재 시점(s=0)은 순수 절두체 판정과 같고, 예측 시점은 보수적으로 남긴다', () => {
  const cam = lookAt([0, 60, 0], [10, 0, 10]);
  const plain = visibleSet(cam);
  // 속도 1e308·horizon 1e10: 부풀림 Infinity, 예측 시점의 중심도 Infinity 라 퇴화 -> s=0 만 남는다. 마스크 = 순수 절두체 집합.
  const a = predictiveMask(h, { camera: cam, velocityMps: [1e308, 0, 0] }, { horizonS: 1e10, steps: 1, pointSizeM: 0 });
  assert.equal(sum(a), plain.size);
  for (let k = 0; k < oc.leafCount; k++) assert.equal(a[k], plain.has(k) ? 1 : 0);
  // 같은 극단 horizon 이어도 속도 0 이면 순수 절두체 집합(horizon 1e300).
  const z = predictiveMask(h, { camera: cam, velocityMps: [0, 0, 0] }, { horizonS: 1e300, steps: 2, pointSizeM: 0 });
  assert.equal(sum(z), plain.size);
  // 각속도 1e307·horizon 1: 예측 카메라는 유한(정상)인데 부풀림이 Infinity -> 상한을 못 잡으므로 빈 리프가 아닌 리프는 모두 남긴다.
  const w = predictiveMask(h, { camera: cam, angularRadPerS: [0, 1e307, 0] }, { horizonS: 1, steps: 1, pointSizeM: 0 });
  assert.equal(isDegenerateView(predictCamera(cam, { angularRadPerS: [0, 1e307, 0] }, 1)), false, '전제: 예측 카메라는 정상');
  assert.equal(sum(w), oc.leafCount);
});
