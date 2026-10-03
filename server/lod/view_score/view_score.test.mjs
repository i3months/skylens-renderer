// T07.8 이웃 시점 점수 시험. 정답은 renderer_basis §3 의 표와 손계산 리터럴이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { angleScore, scaleScore, viewScore, rankViews, rayAngleDeg, cameraCenter } from './index.mjs';

const near = (got, want, tol, msg) => assert.ok(Math.abs(got - want) <= tol, `${msg}: ${got} vs ${want} (허용 ${tol})`);
const round2 = (x) => Math.round(x * 100) / 100;

const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
// renderer_basis §1-2 의 960×540 앞 카메라 K
const K = { fx: 754.32, fy: 753.85, cx: 480, cy: 270 };
// 중심 (b, 0, 0), 광축 +z 인 카메라. C = −Rᵀt 이므로 t = (−b, 0, 0).
const camAt = (b) => ({ width: 960, height: 540, K: { ...K }, R: [...I3], t: [-b, 0, 0] });

// 깊이 45 m 평면(z = 45) 위 1 m 격자 점 61×31 = 1891개. 기준 화면은 x ∈ ±28.64 m, y ∈ ±16.12 m 를 덮는다.
function planeGrid() {
  const a = [];
  for (let x = -30; x <= 30; x += 1) for (let y = -15; y <= 15; y += 1) a.push(x, y, 45);
  return new Float32Array(a);
}

test('w_θ 표(renderer_basis §3-3) 소수 둘째 자리', () => {
  const table = [[1, 0.08], [3, 0.22], [6, 0.61], [10, 1.0], [20, 0.8], [40, 0.14]];
  for (const [theta, want] of table) assert.equal(round2(angleScore(theta)), want, `θ=${theta}°`);
  // 1° 는 문서 식 그대로 exp(−81/32)
  near(angleScore(1), 0.0795595087, 1e-9, 'exp(−81/32)');
  // θ₀ 에서 최대, 양쪽에서 감소
  assert.equal(angleScore(10), 1);
  assert.ok(angleScore(9.9) < 1 && angleScore(10.1) < 1);
});

test('w_s: 밴드 1.2 안은 1, 밖은 (1.2/max(s,1/s))²', () => {
  for (const s of [1, 1.2, 1 / 1.2, 1.1, 0.9]) assert.equal(scaleScore(s), 1, `s=${s}`);
  near(scaleScore(1.5), 0.64, 1e-12, 's=1.5 → (1.2/1.5)²');
  near(scaleScore(1 / 1.5), 0.64, 1e-12, 's=1/1.5 → 대칭');
  near(scaleScore(2.4), 0.25, 1e-12, 's=2.4 → (1/2)²');
  near(scaleScore(1.25), 0.9216, 1e-12, 's=1.25 → 0.96²');
  // 문서 §3-4: camF_0054 의 s 중앙값 0.90 → w_s = 1
  assert.equal(scaleScore(0.9), 1);
});

test('카메라 중심 C = −Rᵀt', () => {
  // z 축 90° 회전, t = (1, 2, 3): Rᵀt = (2, −1, 3) → C = (−2, 1, −3)
  const cam = { width: 10, height: 10, K: { ...K }, R: [0, -1, 0, 1, 0, 0, 0, 0, 1], t: [1, 2, 3] };
  assert.deepEqual(cameraCenter(cam), [-2, 1, -3]);
});

test('광선 각 θ 는 해석해와 0.1° 이내이고 θ ≈ b/d', () => {
  // 기준 중심 (0,0,0), 후보 중심 (b,0,0), 점 (0,0,45): 해석해 θ = atan(b/45)
  const want = { 1.04: 1.324, 4.14: 5.256, 8.26: 10.401, 15.37: 18.858 };
  for (const b of [1.04, 4.14, 8.26, 15.37]) {
    const th = rayAngleDeg(camAt(0), camAt(b), [0, 0, 45]);
    near(th, want[b], 0.1, `b=${b} 해석해`);
    // 소각 근사 b/d rad: 문서 §3-2 의 "8.26/45 rad ≈ 10.5°". 18.9° 에서도 4% 안.
    const approx = (b / 45) * (180 / Math.PI);
    assert.ok(Math.abs(th - approx) / approx < 0.04, `b=${b} 근사 ${approx}`);
  }
  near(rayAngleDeg(camAt(0), camAt(8.26), [0, 0, 45]), 10.4, 0.1, '문서 예 b=8.26, d=45');
});

test('공유 점: 깊이>0, 두 화면 안에 들어야 센다', () => {
  const ref = camAt(0);
  const cand = camAt(8.26);
  // (0,0,45) 는 둘 다에 보임. 점수 = w_θ(atan(8.26/45)) · 1
  const one = new Float32Array([0, 0, 45]);
  near(viewScore(ref, cand, one), angleScore(10.401175691), 1e-6, '한 점');
  // 카메라 뒤(z<0)
  // x=33: 기준 u = 754.32·33/45+480 ≈ 1033 (밖), 후보 u = 754.32·24.74/45+480 ≈ 895 (안)
  // x=−25: 기준 u ≈ 61 (안), 후보 u = 754.32·(−33.26)/45+480 ≈ −77 (밖)
  const none = new Float32Array([0, 0, -45, 33, 0, 45, -25, 0, 45]);
  assert.equal(viewScore(ref, cand, none), 0);
  // 빈 점 배열은 점수 0
  assert.equal(viewScore(ref, cand, new Float32Array(0)), 0);
});

test('축척 점수는 깊이와 초점거리 비로 계산된다', () => {
  // 후보가 광축 방향으로 15 m 다가감: C_j = (0,0,15), 점 (0,0,45) 에서 d_i = 45, d_j = 30
  // θ = 0° → w_θ = exp(−100/32) = 0.0439369336; s = 30/45 = 2/3 → w_s = (1.2·2/3)² = 0.64
  const ref = camAt(0);
  const cand = { ...camAt(0), t: [0, 0, -15] };
  near(viewScore(ref, cand, new Float32Array([0, 0, 45])), 0.0439369336 * 0.64, 1e-9, '전진 후보');
  // 후보 fx 를 2/3 로 줄이면 s = (30/502.88)/(45/754.32) = 1 → w_s = 1
  const cand2 = { ...cand, K: { ...K, fx: (754.32 * 2) / 3 } };
  near(viewScore(ref, cand2, new Float32Array([0, 0, 45])), 0.0439369336, 1e-9, 'fx 보정');
});

test('기하 합성: 기선 1.04/4.14/8.26/15.37 m 후보 순위', () => {
  const ref = camAt(0);
  const bs = [1.04, 4.14, 8.26, 15.37];
  const ranked = rankViews(ref, bs.map(camAt), planeGrid());
  // renderer_basis §3-7 순서 8.26 > 4.14 > 1.04 를 지킨다.
  const pos = (b) => ranked.findIndex((r) => r.index === bs.indexOf(b));
  assert.ok(pos(8.26) < pos(4.14) && pos(4.14) < pos(1.04), JSON.stringify(ranked));
  // 15.37 m 의 위치(계산으로 확인): 이 합성 기하에서는 2위다.
  //   평행 카메라 옆걸음이라 s = 1(w_s = 1)이고, 공유 폭은 57.27 − b m 로 줄어든다.
  //   15.37 m: 공유 폭 41.9 m, θ ≈ 18.9° → w_θ ≈ 0.84  → 점수 ≈ 1132
  //    4.14 m: 공유 폭 53.1 m, θ ≈ 5.3°  → w_θ ≈ 0.50  → 점수 ≈ 683
  //   실데이터 §3-6 에서는 15.37 m(1,712)가 4.14 m(1,732)보다 근소하게 낮다. 실데이터는 앞으로 나아가며
  //   비스듬히 내려다봐 공유 점이 2,026 개로 4.14 m(4,069)의 절반이고 s 도 0.82 로 작아지기 때문이다.
  //   이 평면·옆걸음 합성 기하는 그 공유 점 감소를 재현하지 않으므로 순위가 바뀐다.
  assert.deepEqual(ranked.map((r) => bs[r.index]), [8.26, 15.37, 4.14, 1.04]);
  near(ranked[0].score, 1483.49, 0.01, '8.26 m 점수');
  near(ranked[1].score, 1132.09, 0.01, '15.37 m 점수');
  near(ranked[2].score, 682.96, 0.01, '4.14 m 점수');
  near(ranked[3].score, 151.76, 0.01, '1.04 m 점수');
});

test('rankViews: 동점이면 index 작은 쪽이 앞', () => {
  const ref = camAt(0);
  const cands = [camAt(-8.26), camAt(8.26), camAt(-8.26)];
  // 점 (0,0,45) 하나: 좌우 대칭이라 세 후보 점수가 같다
  const r = rankViews(ref, cands, new Float32Array([0, 0, 45]));
  assert.deepEqual(r.map((e) => e.index), [0, 1, 2]);
  assert.equal(r[0].score, r[1].score);
});

test('입력을 바꾸지 않는다', () => {
  const ref = camAt(0);
  const cands = [camAt(4.14), camAt(8.26)];
  const pts = planeGrid();
  const snap = JSON.stringify({ ref, cands, pts: Array.from(pts) });
  rankViews(ref, cands, pts);
  viewScore(ref, cands[0], pts);
  assert.equal(JSON.stringify({ ref, cands, pts: Array.from(pts) }), snap);
  assert.equal(cands.length, 2);
});

test('입력 검증: NaN, 범위 밖, 빈 후보, 잘못된 카메라·점', () => {
  for (const v of [NaN, Infinity, -1, 181, '10', undefined]) assert.throws(() => angleScore(v), /^Error: lod:/);
  for (const v of [NaN, 0, -1, Infinity, '1']) assert.throws(() => scaleScore(v), /^Error: lod:/);
  const ref = camAt(0);
  const pts = new Float32Array([0, 0, 45]);
  assert.throws(() => rankViews(ref, [], pts), /lod: candCams/);
  assert.throws(() => rankViews(ref, null, pts), /lod: candCams/);
  assert.throws(() => viewScore(ref, camAt(1), new Float32Array([0, NaN, 45])), /lod: points\[1\]/);
  assert.throws(() => viewScore(ref, camAt(1), [0, 0, 45]), /lod: points/);
  assert.throws(() => viewScore(ref, camAt(1), new Float32Array(2)), /lod: points/);
  assert.throws(() => viewScore({ ...ref, t: [NaN, 0, 0] }, camAt(1), pts), /lod: refCam/);
  assert.throws(() => rankViews(ref, [camAt(1), { ...ref, R: [2, 0, 0, 0, 1, 0, 0, 0, 1] }], pts), /lod: candCams\[1\]/);
  assert.throws(() => rayAngleDeg(ref, camAt(1), [0, 0, 0]), /lod:/);
});
