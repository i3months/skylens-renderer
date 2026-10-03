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

// ---- F-129·F-147: 예측 마스크의 상한(위쪽 경계)·하한·음성 시험 ----
// 변위 기하(F-147·F-151): τ 표본 카메라(중심 C, 행렬 R)와 시각 τ+δ(|δ| <= hh) 카메라(중심 C+v·δ, 행렬 R·Qᵀ, Q = Rot(ω·δ)).
//   τ+δ 카메라에서 보이는 점 p 와 τ 카메라 좌표가 같은 점 p' 는 R(p' − C) = R·Qᵀ(p − C − v·δ) 를 풀어
//   p' − p = (Qᵀ − I)(p − C) − Qᵀ·v·δ.  먼 기준점은 표본 중심 C 이고, far = C 에서 상자 최원 꼭짓점까지 거리라 |p − C| <= far
//   ->  |p' − p| <= |v|·hh + 2·far·sin(ω·hh/2).
// 즉 교차항이 없는 식이 이미 올바른 상한이다. 교차항(회전 반경 far+|v|·hh)은 구현이 더 보수적으로 잡아도 되는 여유일 뿐,
// '반드시 남아야 하는 하한' 이 아니다(이전 F-144 의 '엄밀 하한' 전제는 틀렸다: 교차항을 뺀 구현도 올바르다).
// 상한(allowedUnion): 촘촘한 시각(0..horizonS 를 n 등분, n 은 steps 의 배수라 구현의 표본 시각을 모두 포함)마다 상자를
//   M = (geoDisp + crossSlack)·(1 + rel) + eps 만큼 부풀려 보이는 리프의 합집합. geoDisp = |v|·hh + 2·far·sin(ω·hh/2) 는 위 기하 상한이다.
//   구현 상수(1.0001·U + 1e-9)를 복사해 상한으로 쓰지 않는다: 구현이 부풀림을 키우면 상한도 따라 커져 시험이 못 잡기 때문이다.
//   crossSlack 은 구현이 기하 상한보다 보수적으로 잡는 두 항을 덮는 시험 쪽 독립 여유다.
//     (1) 교차항: 회전 반경을 far 가 아니라 far + |v|·hh 로 잡는 몫 = ω·hh·|v|·hh (호 길이 기준; 현 기준이면 이보다 작다).
//     (2) 호 대 현: 구현은 현 2·far·sin(x/2) 대신 호 far·x (x = ω·hh) 를 쓰고, x − 2·sin(x/2) <= x³/24 이므로 초과분 <= far·x³/24.
//   구현의 상대 안전 배율 1e-4 와 가산 1e-9 는 rel = 1e-3, eps = 1e-3 m 가 덮는다(rel >= 1e-4 + 수치 오차, eps >= 1e-9).
//   구현의 표본 시각이 촘촘한 표본에 들어 있으므로 반폭은 hh 그대로 쓴다(표본 간격의 반폭을 더하지 않는다).
//   여유는 상대값이어야 한다(F-151): 절대 여유 1e-3 만으로는 U > 10 m 에서 구현의 상대 몫보다 작다.
// 하한(denseUnion): 촘촘한 시각에서 부풀림 없이(여유 0) 실제로 보이는 리프의 합집합. 마스크는 이것을 모두 덮어야 한다.
// 판별력(부풀림 반폭 h/2·전체 ×1.2·회전항 ×1.5 변이를 잡는지)은 장면 시드와 무관하게 predict_analytic.test.mjs 가 해석적 상자 배치로 맡는다.
const geoDisp = (speed, omega, hh, far) => speed * hh + 2 * far * Math.sin((omega * hh) / 2); // 기하 상한(구현 식과 독립)
const crossSlack = (speed, omega, hh, far) => omega * hh * speed * hh + far * (omega * hh) ** 3 / 24; // 교차항 + 호/현 초과분(위 주석)
const farOf = (a, b, C) => Math.hypot(...[0, 1, 2].map((d) => Math.max(Math.abs(a[d] - C[d]), Math.abs(b[d] - C[d]))));
const IMPL_REL = 1.0001, IMPL_ABS = 1e-9; // index.mjs 의 부풀림 상수: 상한에는 쓰지 않고, 변이(+0.02 m·×1.2) 부풀림을 만드는 판별 시험에만 쓴다
function allowedUnion(camAt, horizonS, n, speed, omega, hh, pointSizeM = 0, eps = 1e-3, rel = 1e-3) {
  const s = new Set();
  for (let i = 0; i <= n; i++) {
    const cam = camAt((horizonS * i) / n), C = cameraCenter(cam);
    for (let k = 0; k < oc.leafCount; k++) {
      const [a, b] = boxOf(k);
      const far = farOf(a, b, C);
      const M = (geoDisp(speed, omega, hh, far) + crossSlack(speed, omega, hh, far)) * (1 + rel) + eps;
      if (boxMayBeVisibleSplat(cam, a.map((x) => x - M), b.map((x) => x + M), pointSizeM)) s.add(k);
    }
  }
  return s;
}
// 하한용: 표본 시각들의 부풀림 없는(여유 0) 보이는 리프 합집합. 상한 여유를 하한에 쓰면 하한이 부풀어 판별력을 흐린다.
function sampleUnion(camAt, horizonS, n, margin = 0) {
  const s = new Set();
  for (let i = 0; i <= n; i++) {
    const cam = camAt((horizonS * i) / n);
    for (let k = 0; k < oc.leafCount; k++) {
      const [a, b] = boxOf(k);
      if (boxMayBeVisibleSplat(cam, a.map((x) => x - margin), b.map((x) => x + margin), 0)) s.add(k);
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

test('결합 운동 하한·상한: 마스크 ⊇ 촘촘한 시각의 실제 보이는 리프 합집합, ⊆ 표본 시점 부풀림 상한 합집합', () => {
  const horizonS = 4;
  // 하한: 촘촘한 시각(8·steps 등분)에서 부풀림 없이 실제로 보이는 리프는 모두 마스크에 있어야 한다(표본 사이 시각까지 빠진 조각 0).
  // 상한: allowedUnion(같은 촘촘한 시각, 반폭 hh, upperDisp·(1+1e-3) + 1e-3). 교차항은 상한에만 쓰고 하한에는 쓰지 않는다(F-147).
  // 사례 0~3: 빠른 이동+회전(대부분 허용 = 전체). 사례 4~6: 회전 위주(이동 0 또는 0.7 m/s 이하)라 허용 집합이 전체보다 확실히 작다.
  // 사례 7: 고속 직선 비행(400 m/s, 아래를 봄). upperDisp 가 100 m 를 넘어 상대 여유가 필요한 사례다(F-151).
  const cases = [
    [lookAt([-70, 30, 0], [0, 0, 0]), [0, 0, 30], [0, 0.6, 0]],
    [lookAt([30, 35, -40], [0, 0, 0]), [-20, 4, 24], [0.3, -0.5, 0.2]],
    [lookAt([0.7193303667008877, 29.438624640461057, 37.752573834732175], [4.574792506173253, 1.4847642369568348, 18.20880121551454]), [21.42895988188684, 2.2685793437995017, -3.642494436353445], [-0.1481265474576503, -0.21067794505506754, -0.11717842030338943]],
    [lookAt([-11.219377592206001, 37.34387482283637, 0.1200649794191122], [-10.225890344008803, 4.829464415088296, 6.464818296954036]), [-28.32231550477445, 1.9914156128652394, 20.60210544615984], [-0.4378025403711945, -0.07488677930086851, -0.22208991623483598]],
    [lookAt([34.94, 45.56, 1.33], [-12.01, 6.97, 38.4]), [0, 0, 0], [0.04, 0.11, 0]],
    [lookAt([20.76, 41.32, 12.42], [7.93, 2.84, -18.47]), [-0.44, 0, 0.34], [0.03, -0.1, 0.04]],
    [lookAt([-56.07, 47.86, -47.35], [-45.18, 2.58, 6.12]), [0, 0, 0], [0.02, -0.13, -0.02]],
    [lookAt([-800, 70, 0], [-800, 0, 0.5]), [400, 0, 0], [0, 0, 0]],
  ];
  // 판별력(h/2·×1.2·회전항 ×1.5 변이)은 이 장면의 시드에 기대지 않고 predict_analytic.test.mjs 의 해석적 배치가 맡는다(F-151).
  // 여기서는 하한·상한 포함 관계와, 상한이 헐겁지 않다는 전제(허용 <= 0.9·leafCount 인 조합 수)만 본다.
  let tight = 0;
  for (const [cam, v, w] of cases) {
    const speed = Math.hypot(...v), omega = Math.hypot(...w);
    const camAt = (tau) => predictCamera(cam, { velocityMps: v, angularRadPerS: w }, tau);
    for (const steps of [1, 2, 4]) {
      const hh = horizonS / steps / 2, dense = steps * 8;
      const m = predictiveMask(h, { camera: cam, velocityMps: v, angularRadPerS: w }, { horizonS, steps, pointSizeM: 0 });
      const lower = sampleUnion(camAt, horizonS, dense);
      for (const k of lower) assert.equal(m[k], 1, `steps=${steps}: 촘촘한 시각에 실제로 보이는 리프 ${k} 가 마스크에서 빠짐`);
      const allowed = allowedUnion(camAt, horizonS, dense, speed, omega, hh);
      for (let k = 0; k < oc.leafCount; k++) if (m[k]) assert.ok(allowed.has(k), `steps=${steps}: 허용 밖 리프 ${k}`);
      if (allowed.size <= 0.9 * oc.leafCount) tight++;
    }
  }
  // 전제(상한이 전체가 아님): 허용이 전체 리프의 90% 이상 부풀어진 리프의 도입 예측으로 채워진다.
  // 상한 여유가 1.0001·(1.001+1e-3) 이므로 회전 예측(×1.5 변이)이 필수인 상황이 생긴다.
  // 사례 4·5(회전 위주)의 모든 steps 와 사례 6(점 크기)의 steps=2·4 에서만 예측이 유효해 총 8 개 조합.
  // 시드 1·2·3·42·99 의 모든 장면에서 일관되게 8 개(회전 위주 사례라 지형 세부에 둔감).
  assert.ok(tight >= 8, `전제: 허용 <= 0.9·leafCount 인 조합 ${tight}`);
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

// 잘게/성기게 나눈 직선 이동(F-155 ④): 장면 시드에 기대지 않도록 상자를 해석적으로 놓는다(predict_analytic.test.mjs 와 같은 방식).
// 좁은 화각 카메라 KN(fx = fy = 4000, 640×480)라 좌·우 반화각의 tan 이 TN = 320/4000 = 0.08 이다. R = I(+z 를 봄), 중심 (x_c, 0, 0).
// 상자 [a,b]×[−q,q]×[z1,z2] (z2 > 0, y 가 0 을 감쌈) 의 판정은 오른쪽 a − x_c − TN·z2 <= 0, 왼쪽 b − x_c + TN·z2 >= 0 뿐이고
// (위·아래·앞은 늘 참), 상자를 모든 축으로 M 만큼 부풀리면 오른쪽 좌변이 정확히 (1 + TN)·M 만큼 준다. 즉 오른쪽 틈 G 인 상자는 M >= G/(1+TN) 일 때만 보인다.
const KN = { fx: 4000, fy: 4000, cx: 320, cy: 240 };
const TN = KN.cx / KN.fx; // 0.08
const KAPPA_N = 1 + TN;
// 시각 τ 의 카메라(회전 없음, 중심 = v·τ, v 는 +x 방향). 구현과 독립으로 t = −C 를 직접 만든다.
const slideCam = (vx) => (tau) => ({ width: 640, height: 480, K: KN, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [-vx * tau, 0, 0] });
const ADD_GAP = 0.01; // 끝 시각 경계 상자의 틈 = KAPPA_N·(|v|·hh + ADD_GAP). 상한 수치 여유 1e-3 < ADD_GAP < 0.02 라 정확한 구현·상한은 못 닿고 +0.02 m 가산 변이는 닿는다.

test('잘게/성기게 나눈 직선 이동(해석 배치): 마스크는 촘촘한 시점 합집합을 덮고, 기하 상한(|v|·구간 반폭) 안에 머문다(+0.02 m 가산 부풀림도 잡음)', () => {
  const horizonS = 4, q = 1;
  // 느린 이동(5 mm/s: 4 s 동안 2 cm)은 고정 가산 여유(+0.02 m)를, 빠른 이동(10 m/s)은 가산·배율(×1.2) 부풀림을 모두 드러낸다.
  for (const vx of [10, 0.005]) {
    const camAt = slideCam(vx);
    // steps=80: 구간 반폭 0.025 s, steps=4: 반폭 0.5 s.
    for (const steps of [80, 4]) {
      const dt = horizonS / steps, hh = dt / 2, vdt = vx * dt, U = vx * hh;
      // 상자 A(하한 판별): x 폭 0(x = vdt/2), 깊이 z ∈ [z2/2, z2], z2 = 0.1·vdt/TN 이라 보이는 x_c 구간이 [0.4·vdt, 0.6·vdt] 이다.
      //   촘촘한 시각(8·steps 등분) τ = dt/2 에서는 보이고, 표본 x_c = 0, vdt 에서는 틈 0.4·vdt 로 안 보인다.
      const zA = (0.1 * vdt) / TN, xA = vdt / 2;
      // 상자 B(상한 판별): 마지막 시각 x_c = vx·horizonS 의 오른쪽 경계 밖 틈 G = KAPPA_N·(U + ADD_GAP). 앞선 시각은 x_c 가 작아 틈이 더 크다.
      const G = KAPPA_N * (U + ADD_GAP), aB = vx * horizonS + G + TN * 100.5;
      const boxes = [
        [[xA, -q, zA / 2], [xA, q, zA]],
        [[aB, -q, 99.5], [aB + 0.5, q, 100.5]],
        [[-1, -q, 99.5], [1, q, 100.5]], // 시작 시각에 보이는 기준 리프
      ];
      const hier = { octree: { leafCount: 3, leafIndex: Int32Array.from([0, 1, 2]), boxMin: Float64Array.from(boxes.flatMap(([a]) => a)), boxMax: Float64Array.from(boxes.flatMap(([, b]) => b)) } };
      const unionAt = (n, M) => {
        const s = new Set();
        for (let i = 0; i <= n; i++) {
          const cam = camAt((horizonS * i) / n);
          boxes.forEach(([a, b], k) => { if (boxMayBeVisibleSplat(cam, a.map((x) => x - M), b.map((x) => x + M), 0)) s.add(k); });
        }
        return s;
      };
      const m = predictiveMask(hier, { camera: camAt(0), velocityMps: [vx, 0, 0] }, { horizonS, steps, pointSizeM: 0 });
      // 하한: 촘촘한 시각에서 부풀림 없이(여유 0) 보이는 리프는 모두 마스크에 있다.
      const exact = unionAt(steps * 8, 0);
      for (const k of exact) assert.equal(m[k], 1, `v=${vx}, steps=${steps}: 촘촘한 시각의 리프 ${k} 가 빠짐`);
      // 구현 식과 독립인 기하 상한: 이동만 있으므로 구간 반폭 동안 카메라는 |v|·hh 이상 움직일 수 없다.
      // 표본을 4배 촘촘히 잡고 상자를 정확히 그 거리(+1e-3 m 수치 여유)만 부풀려 보이는 리프의 합집합이 상한이다(계수·덧셈 여유 없음).
      const bound = unionAt(steps * 4, U + 1e-3);
      for (let k = 0; k < boxes.length; k++) if (m[k]) assert.ok(bound.has(k), `v=${vx}, steps=${steps}: 기하 상한 밖 리프 ${k}`);
      // 전제(해석, 시드 무관): 상자 A 는 표본 사이에만 보이고, 정확한 반폭 hh 부풀림으로는 덮이며 반폭 h/2 로는 안 덮인다.
      assert.ok(exact.has(0) && !unionAt(steps, 0).has(0), `전제: 상자 A 는 표본 사이에만 보임 (v=${vx}, steps=${steps})`);
      assert.ok(KAPPA_N * IMPL_REL * U >= 0.4 * vdt && KAPPA_N * (IMPL_REL * U / 2 + IMPL_ABS) < 0.4 * vdt, '전제: 상자 A 의 식으로 본 경계 거리');
      assert.ok(unionAt(steps, IMPL_REL * U + IMPL_ABS).has(0) && !unionAt(steps, IMPL_REL * U / 2 + IMPL_ABS).has(0), `전제: 상자 A 판정 (v=${vx}, steps=${steps})`);
      // 전제(해석, 시드 무관): 상자 B 는 하한·기하 상한 밖이고, 정확한 구현 부풀림은 못 닿고, +0.02 m 가산 변이는 마지막 표본에서 닿는다.
      assert.ok(KAPPA_N * (U + 1e-3) < G && KAPPA_N * (IMPL_REL * U + IMPL_ABS) < G && KAPPA_N * (IMPL_REL * U + IMPL_ABS + 0.02) >= G, `전제: 상자 B 의 식으로 본 경계 거리 (v=${vx}, steps=${steps})`);
      assert.ok(!exact.has(1) && !bound.has(1), `전제: 상자 B 는 상한 밖 (v=${vx}, steps=${steps})`);
      assert.ok(!unionAt(steps, IMPL_REL * U + IMPL_ABS).has(1), `전제: 정확한 부풀림은 상자 B 를 넣지 않음 (v=${vx}, steps=${steps})`);
      assert.ok(unionAt(steps, IMPL_REL * U + IMPL_ABS + 0.02).has(1), `전제: +0.02 m 가산 부풀림은 상자 B 를 넣음 (v=${vx}, steps=${steps})`);
      // 빠른 이동은 배율 부풀림(×1.2)도 상자 B 로 잡는다: 0.2·U >= 0.05 m > ADD_GAP.
      if (vx >= 1) assert.ok(unionAt(steps, 1.2 * (IMPL_REL * U + IMPL_ABS)).has(1), `전제: ×1.2 부풀림은 상자 B 를 넣음 (steps=${steps})`);
      assert.ok(exact.has(2));
      assert.ok(sum(m) >= exact.size);
    }
  }
});

// 대각 속도(F-158 ①): 위 해석 배치는 속도가 늘 [vx,0,0] 이라 속력 노름 |v| 를 |vx|·L1 로 바꿔도 구분하지 못한다.
// v = (3, 0, 4), 속력 √(3² + 4²) = 5 m/s. 카메라는 +x 를 보고(R 의 행: (0,0,−1), (0,1,0), (1,0,0)), 화면 가로축이 세계 z 다.
// 즉 옆걸음 4 m/s(z), 전진 3 m/s(x) 라 |vx| = 3 은 옆걸음보다 작고, L1 = 7 은 속력보다 크다.
// 중심 C(τ) = (3τ, 0, 4τ), t = −R·C = (4τ, 0, −3τ). 상자 [x1,x2]×[−q,q]×[u1,u2] 의 좌·우 판정(KN, TN = 0.08)은
//   u1 − 4τ <= TN·(x2 − 3τ)  즉 g(τ) = u1 − TN·x2 − 3.76·τ <= 0,
//   u2 − 4τ >= −TN·(x2 − 3τ) 즉 l(τ) = u2 + TN·x2 − 4.24·τ >= 0 이고, 모든 축 M 부풀림은 두 틈을 정확히 KAPPA_N·M 만큼 줄인다.
// horizonS = 2, steps = 4: 표본 0, 0.5, …, 2 s, 구간 반폭 0.25 s. 기하 상한: 반폭 동안 카메라는 5 · 0.25 = 1.25 m 이상 못 움직인다.
test('대각 속도 (3,0,4)(속력 5): 마스크는 표본 사이 리프를 덮고, 기하 상한(5 m/s × 0.25 s = 1.25 m) 밖으로 넓지 않다', () => {
  const horizonS = 2, steps = 4, q = 1;
  const SPEED = 5; // √(3² + 4²), 손 계산
  const HH = 0.25; // horizonS / steps / 2
  const U = 1.25; // SPEED · HH: 반폭 동안 카메라 이동 상한(m)
  const camAt = (tau) => ({ width: 640, height: 480, K: KN, R: [0, 0, -1, 0, 1, 0, 1, 0, 0], t: [4 * tau, 0, -3 * tau] });
  // 상자 A(하한·|vx| 판별): u = 1.06(폭 0), x ∈ [1.75, 2.25]. g(0) = 1.06 − 0.18 = 0.88, −l(0.5) = 2.12 − 1.06 − 0.18 = 0.88.
  //   보이는 시각 구간은 [0.88/3.76, 1.24/4.24] ≈ [0.234, 0.292] s 로 표본 0·0.5 사이에만 있다(τ = 0.25 에서 보임).
  //   표본 틈 0.88 이 KAPPA_N·1.25 = 1.35 이하라 속력 5 의 부풀림은 덮고, KAPPA_N·0.75 = 0.81 (|vx| = 3 의 부풀림)은 못 덮는다.
  // 상자 B(상한·L1 판별): u ∈ [17.18, 17.68], x ∈ [99.5, 100.5]. g 는 τ 에 대해 줄어드므로 최소 틈은 τ = 2 의
  //   g(2) = 17.18 − 8.04 − 7.52 = 1.62 = KAPPA_N·1.5 이다. 기하 상한 KAPPA_N·1.251 = 1.351 보다 크므로 들어오면 안 되고,
  //   L1 = 7 의 부풀림 KAPPA_N·1.75 = 1.89 는 닿는다.
  const boxes = [
    [[1.75, -q, 1.06], [2.25, q, 1.06]],
    [[99.5, -q, 17.18], [100.5, q, 17.68]],
    [[99.5, -q, -1], [100.5, q, 1]], // 시작 시각에 보이는 기준 리프
  ];
  const hier = { octree: { leafCount: 3, leafIndex: Int32Array.from([0, 1, 2]), boxMin: Float64Array.from(boxes.flatMap(([a]) => a)), boxMax: Float64Array.from(boxes.flatMap(([, b]) => b)) } };
  const unionAt = (n, M) => {
    const s = new Set();
    for (let i = 0; i <= n; i++) {
      const cam = camAt((horizonS * i) / n);
      boxes.forEach(([a, b], k) => { if (boxMayBeVisibleSplat(cam, a.map((x) => x - M), b.map((x) => x + M), 0)) s.add(k); });
    }
    return s;
  };
  // 전제(해석, 구현 무관): 위 손 계산이 실제 판정 함수와 맞는다.
  const exact = unionAt(steps * 8, 0);
  assert.ok(exact.has(0) && !unionAt(steps, 0).has(0), '전제: 상자 A 는 표본 사이에만 보임');
  assert.ok(unionAt(steps, U).has(0), '전제: 속력 5 의 반폭 부풀림 1.25 m 는 상자 A 를 덮음');
  assert.ok(!unionAt(steps, 0.76).has(0), '전제: |vx| = 3 의 반폭 부풀림(약 0.75 m)은 상자 A 를 못 덮음');
  assert.ok(!exact.has(1) && !unionAt(steps * 4, U + 1e-3).has(1), '전제: 상자 B 는 기하 상한 밖');
  assert.ok(unionAt(steps, 1.74).has(1), '전제: L1 = 7 의 반폭 부풀림(약 1.75 m)은 상자 B 를 넣음');
  assert.ok(exact.has(2));

  const m = predictiveMask(hier, { camera: camAt(0), velocityMps: [3, 0, 4] }, { horizonS, steps, pointSizeM: 0 });
  // 하한(거짓 제거 0): 촘촘한 시각에서 보이는 리프는 모두 남는다.
  for (const k of exact) assert.equal(m[k], 1, `촘촘한 시각의 리프 ${k} 가 빠짐`);
  // 상한: 표본을 4배 촘촘히 잡고 상자를 U = 1.25 m(+1e-3 수치 여유)만 부풀려 보이는 합집합 안에 머문다.
  const bound = unionAt(steps * 4, U + 1e-3);
  for (let k = 0; k < boxes.length; k++) if (m[k]) assert.ok(bound.has(k), `기하 상한 밖 리프 ${k}`);
  assert.deepEqual(Array.from(m), [1, 0, 1]);
  assert.equal(SPEED * HH, U);
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
