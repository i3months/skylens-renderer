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

// renderer_basis §3-6·§3-7 표 행(공유 점 N, θ 중앙값, s 중앙값)에서 점수를 N·w_θ(θ)·w_s(s) 로 구성한다.
// 구현의 w_θ·w_s 를 그대로 부르고, 문서의 실제 점수(§3-5 의 면적 가산 항 포함)와의 일치는 요구하지 않는다.
const compose = (rows, wTheta = angleScore) => rows.map(([name, n, theta, s]) => ({ name, score: n * wTheta(theta) * scaleScore(s) }))
  .sort((a, b) => b.score - a.score);
// 후보 이름, 공유 점, θ 중앙값(°), s 중앙값
const T36 = [['0054', 3266, 9.27, 0.900], ['0051', 3449, 8.10, 0.911], ['0057', 3033, 10.52, 0.888], ['0060', 2911, 11.80, 0.876],
  ['0048', 3597, 6.89, 0.923], ['0063', 2738, 13.06, 0.865], ['0066', 2600, 14.31, 0.855], ['0045', 3806, 5.73, 0.935],
  ['0069', 2413, 15.53, 0.844], ['0072', 2219, 16.73, 0.834], ['0042', 4069, 4.58, 0.948], ['0075', 2026, 17.89, 0.824]];
// §3-7 은 s 열이 없다. 같은 카메라의 앞뒤 프레임이라 s ≈ 1 로 둔다.
const T37 = [['0027', 4584, 1.06, 1], ['0033', 4765, 1.16, 1], ['0024', 4142, 2.09, 1], ['0039', 4325, 3.42, 1], ['0042', 4069, 4.58, 1], ['0054', 3266, 9.27, 1]];
// θ₀ 를 바꾼 w_θ (σ 는 계약값 4°, 15°). θ₀=10 이면 angleScore 와 같아야 한다.
const wThetaAt = (theta0) => (t) => Math.exp(-((t - theta0) ** 2) / (2 * (t < theta0 ? 4 : 15) ** 2));
const asc37 = (rows, w) => { const r = compose(rows, w).map((x) => x.name); return r.join() === '0054,0042,0039,0024,0033,0027'; };

test('§3-6 표: 구성한 점수의 1위는 camF_0054', () => {
  const r = compose(T36);
  assert.equal(r[0].name, '0054');
  // 2위(0051)보다 3% 이상 앞선다: 3212 vs 3081 (손계산: w_θ(9.27)=exp(−0.73²/32)=exp(−0.5329/32)=0.9835 → 3266·0.9835 ≈ 3212, ×w_s(0.9)=1)
  assert.ok(r[0].score > r[1].score * 1.03, JSON.stringify(r.slice(0, 2)));
  near(r[0].score, 3266 * Math.exp(-((9.27 - 10) ** 2) / 32), 1e-9, '0054 = N·exp(−0.73²/32)');
});

test('§3-6 표: 2위 이하 순위와 상위 8 집합은 문서와 다르다 (결정 0020 ① 의 실측 대가)', () => {
  const r = compose(T36).map((x) => x.name);
  // 가산 항(§3-5 면적 분포)이 없어 세 쌍이 뒤바뀐다: 0048↔0063, 0045↔0069, 0042↔0075.
  const doc = ['0054', '0051', '0057', '0060', '0048', '0063', '0066', '0045', '0069', '0072', '0042', '0075'];
  assert.deepEqual(r, ['0054', '0051', '0057', '0060', '0063', '0048', '0066', '0069', '0045', '0072', '0075', '0042']);
  // 이웃 8장(상위 8) 집합: 문서에는 0045 가 있고 0069 가 없다. 구현은 반대다.
  const top8 = new Set(r.slice(0, 8));
  const docTop8 = new Set(doc.slice(0, 8));
  assert.deepEqual([...docTop8].filter((n) => !top8.has(n)), ['0045'], '문서에만 있음');
  assert.deepEqual([...top8].filter((n) => !docTop8.has(n)), ['0069'], '구현에만 있음');
  // 가산 항을 넣거나 문서와 같아지면 이 시험이 실패한다. 그때 0020 ① 을 고친다.
});

test('§3-7 표: 점수 순서 0027<0033<0024<0039<0042<0054', () => {
  const r = compose(T37).map((x) => x.name);
  assert.deepEqual(r, ['0054', '0042', '0039', '0024', '0033', '0027']);
  // 바로 옆 사진은 공유 점이 가장 많아도(0033: 4765) 점수는 0054 의 1/5 도 안 된다.
  const m = Object.fromEntries(compose(T37).map((x) => [x.name, x.score]));
  assert.ok(m['0033'] < m['0054'] / 5);
});

test('음성: w_θ 의 θ₀ 를 8° 나 12° 로 바꾸면 §3-6 1위가 0054 가 아니다', () => {
  assert.equal(compose(T36, wThetaAt(10))[0].name, '0054'); // 기준: 변이 식이 angleScore 와 같은 결과
  for (const t of [1, 4.58, 9.27, 10, 17.89]) near(wThetaAt(10)(t), angleScore(t), 1e-12, `θ=${t}`);
  for (const theta0 of [8, 12]) {
    assert.notEqual(compose(T36, wThetaAt(theta0))[0].name, '0054', `θ₀=${theta0}`);
  }
  // θ₀ 가 너무 작아도 §3-7 순서가 깨진다
  assert.equal(asc37(T37, wThetaAt(10)), true);
  assert.equal(asc37(T37, wThetaAt(5)), false);
  assert.equal(asc37(T37, wThetaAt(0)), false);
});

test('기하 합성: 기선 1.04/4.14/8.26/15.37 m 후보 순위 (손계산 부등식)', () => {
  const ref = camAt(0);
  const bs = [1.04, 4.14, 8.26, 15.37];
  const ranked = rankViews(ref, bs.map(camAt), planeGrid());
  const score = (b) => ranked.find((r) => r.index === bs.indexOf(b)).score;
  // 손계산: 깊이 45 평면, 평행 카메라. 기준 화면은 |x| ≤ 480·45/754.32 = 28.63 m, |y| ≤ 270·45/754.32 = 16.11 m.
  // 후보는 x 로 b 만큼 옆이라 공유 x 구간은 [−28.63+b, 28.63]. 정수 격자 열 수 × 31 행(|y| ≤ 15):
  //   1.04 → x −27..28 : 56 열 → 1736 점     4.14 → −24..28 : 53 열 → 1643 점
  //   8.26 → −20..28   : 49 열 → 1519 점    15.37 → −13..28 : 42 열 → 1302 점
  // s = 1 이므로 w_s = 1, 점수는 N·(점별 w_θ 의 평균). θ 는 점마다 달라 구간으로 묶는다.
  //   8.26 m : θ ∈ [8, 11]°   → w_θ ≥ angleScore(8) = exp(−4/32) = 0.8825 → 점수 ∈ [1340, 1519]
  //   15.37 m: θ ∈ [16, 19]°  → w_θ ≥ angleScore(19) = exp(−81/450) = 0.835  → 점수 ∈ [1087, 1302]
  //   4.14 m : θ ∈ [4.3, 5.4]° → w_θ ∈ [0.35, 0.52]  → 점수 ∈ [575, 855]
  //   1.04 m : θ ≤ 1.4°       → w_θ ≤ exp(−73.96/32) = 0.099 → 점수 ≤ 172
  assert.ok(score(8.26) <= 1519 && score(8.26) >= 1519 * angleScore(8), String(score(8.26)));
  assert.ok(score(15.37) <= 1302 && score(15.37) >= 1302 * angleScore(19), String(score(15.37)));
  assert.ok(score(4.14) <= 1643 * angleScore(5.4) && score(4.14) >= 1643 * angleScore(4.3), String(score(4.14)));
  assert.ok(score(1.04) <= 1736 * angleScore(1.4), String(score(1.04)));
  // θ₀(9~12)·σ 변이를 잡기 위해 8.26 m 점수를 현재 값(1483.49) ±1% 로 고정한다. 손계산 구간(1340~1519)은 θ₀ 9(점수 1512.6)를 통과시켜 이 변이를 못 잡았다. θ₀ 12 는 1230.9 로 구간 아래라 구간으로도 잡힌다.
  near(score(8.26), 1483.49, 1483.49 * 0.01, '8.26 m 점수 ±1%');
  // 위 구간이 서로 겹치지 않으므로 순위가 정해진다: 8.26 > 15.37 > 4.14 > 1.04
  assert.deepEqual(ranked.map((r) => bs[r.index]), [8.26, 15.37, 4.14, 1.04]);
  // (실데이터 §3-6 은 15.37 m 가 4.14 m 보다 낮다. 이 평면·옆걸음 합성은 그 공유 점 감소를 재현하지 않는다.)
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
