// F-111 ⑥ 확인: visiblePartBound 의 cAbs(= C_ROUND·‖C‖) 여유 항을 덮는다.
//
// C = −Rᵀt 는 부동소수 반올림이 생긴다(회전이 있고 t ≈ 1e9 이면 성분마다 ulp(1e9) ≈ 1.2e-7 m 급).
// 화면 모서리 광선 ∩ 상자 면의 들어가는 점이 z_P 를 정하는 배치에서는, 상대 좌표 pad 의 REL_TOL 항(≈ 1e-8 m)만으로는
// C 의 반올림 오차를 못 덮어 z_P 가 참값보다 커진다. cAbs 가 그 몫을 덮는다.
//
// 배치: 상자 = 얇은 슬래브(월드 z 가 C_z + 10 ~ C_z + 12, x·y 는 ±100), 카메라는 약간 회전해 슬래브 아래 면을 본다.
//   슬래브 x·y 폭이 시야보다 훨씬 넓어 네 화면 모서리 광선이 모두 아래 면(월드 z = mn[2])으로 들어간다.
//
// 참값(F-113 ⑤): 꼭짓점 카메라 좌표는 p = R·X + t 이므로 실제 기하의 카메라 중심은 C* = −R⁻¹t, 광선 방향은 R⁻¹(a, b, 1) 이다.
//   R 은 부동소수라 정확히 직교가 아니고(E = RᵀR − I ≠ 0) R⁻¹ ≠ Rᵀ 이다. 예전처럼 Rᵀ 로 참값을 잡으면 그 차
//   (R⁻¹ − Rᵀ)t 가 이 배치에서 최대 약 3e-7 m 로, 잡으려는 오차(cAbs 몫, 1e-8 ~ 5e-7 m)와 같은 크기라 판정이 흔들린다.
//   그래서 R·t·K 의 부동소수 값을 정확한 유리수(BigInt)로 보고 R⁻¹ = adj(R)/det(R)(여인수)를 정확히 계산해
//   광선 교점 s = (mn_z − C*_z)/(R⁻¹(a, b, 1))_z 와 그 점 X = C* + s·R⁻¹(a, b, 1) 을 구한다. R·X + t = s·(a, b, 1) 이 정확히
//   성립하므로 그 점의 카메라 좌표 z 는 s 이고, X 가 상자 안(x·y 범위, z = mn_z)이며 모서리 광선(V 의 닫힌 경계) 위이므로
//   X ∈ P 이다. 따라서 참 z_P(P 위 z 의 최솟값) ≤ s 이고, 보수적 하한인 zMinM 은 허용 오차 0 으로 zMinM ≤ s 여야 한다.
//
// 오차 한계(원본이 정당하게 통과해야 하는 근거): η = ‖E‖₂ ≤ ‖E‖_F, u = 2⁻⁵³, γ₃ = 3u/(1 − 3u) ≈ 3.33e-16 라 하자.
//   R⁻¹ = (I + E)⁻¹Rᵀ 이므로 R⁻¹ − Rᵀ = −(I + E)⁻¹E·Rᵀ, ‖R‖₂ = √‖RᵀR‖₂ ≤ √(1 + η) 에서
//     ‖C* − C_T‖ = ‖(R⁻¹ − Rᵀ)t‖ ≤ η·√(1 + η)/(1 − η)·‖t‖        (C_T = −Rᵀt, 정확값)
//   cameraCenter 의 반올림은 성분마다 |Ĉ − C_T| ≤ γ₃·Σⱼ|Rⱼᵢ||tⱼ| ≤ γ₃·√(1 + η)·‖t‖ (Rᵀ 행 길이 ≤ √(1 + η)).
//   방향 차 s·‖(R⁻¹ − Rᵀ)(a, b, 1)‖ 와 방향·교점의 부동소수 반올림은 s ≈ 10 m 에서 1e-14 m 급이라 REL_TOL 항(≈ 1e-8 m)과
//   SAFETY(1 − 1e-12) 가 덮는다. 한편 cAbs = C_ROUND·‖Ĉ‖ ≥ 4ε·√(1 − η)·(1 − γ₃·√3)·‖t‖ (‖Rᵀt‖ ≥ σ_min(R)‖t‖ ≥ √(1 − η)‖t‖).
//   그러므로 (γ₃ + η/(1 − η))·√(1 + η) ≤ 4ε·√(1 − η)·(1 − 1e-15) 이면 축마다 pad 가 |Ĉ − C*| 를 덮어 참 들어가는 점이
//   넓힌 상자 안에 있고 zMinM ≤ s 가 보장된다. 이 부등식은 η ≤ ETA_MAX = 5e-16 에서 성립한다(좌변 ≈ 8.33e-16 ≤ 우변 ≈ 8.88e-16,
//   남는 몫 ≈ 5.5e-17·‖t‖ ≈ 1e-7 m). 아래 세 배치의 ‖E‖_F 는 1.6e-16 ~ 2.7e-16 이고, 시험이 이를 정확히(유리수로) 확인한다.
//   η 가 이보다 크면(예: 1e-7 비직교 R 을 t ≈ 1e9 에 쓰면 ‖C* − C_T‖ ≈ 100 m) 이 시험의 전제가 깨지므로 전제 확인에서 멈춘다.
// 변이(cAbs = 0, C_ROUND 축소, pad 에서 cAbs 항 삭제) 시 세 사례 모두 zMinM > 참값으로 실패한다
//   (R⁻¹ 참값 기준 초과량: 배치 1 ≈ 1.4e-8 m, 배치 2 ≈ 4.5e-7 m, 배치 3 ≈ 1.8e-7 m. 원본의 여유는 9.5e-7 ~ 1.4e-6 m).
import test from 'node:test';
import assert from 'node:assert/strict';
import { cameraCenter, visiblePartBound } from './screen_error.mjs';

const K = { fx: 500, fy: 500, cx: 320, cy: 240 };
const W = 640, H = 480;

// 유리수 [분자, 분모] (BigInt). 부동소수는 정확히 2 의 거듭제곱 분모로 바뀐다.
const rat = (x) => { let e = 0n; while (!Number.isInteger(x)) { x *= 2; e++; } return [BigInt(x), 1n << e]; };
const mul = (a, b) => [a[0] * b[0], a[1] * b[1]];
const add = (a, b) => [a[0] * b[1] + b[0] * a[1], a[1] * b[1]];
const neg = (a) => [-a[0], a[1]];
const sub = (a, b) => add(a, neg(b));
const div = (a, b) => (b[0] < 0n ? [-a[0] * b[1], a[1] * -b[0]] : [a[0] * b[1], a[1] * b[0]]);
const less = (a, b) => a[0] * b[1] < b[0] * a[1]; // 분모는 모두 양수
const toNum = (a) => Number((a[0] * (1n << 60n)) / a[1]) / 2 ** 60;
const ZERO = [0n, 1n];

/** 3×3 행렬(행 우선, 부동소수) 의 정확한 역행렬 adj(R)/det(R) (유리수, 행 우선). */
function exactInverse(R) {
  const r = R.map(rat);
  const m = (i, j) => r[3 * i + j];
  const cof = (i, j) => {
    const [a0, a1] = [0, 1, 2].filter((x) => x !== i), [b0, b1] = [0, 1, 2].filter((x) => x !== j);
    const v = sub(mul(m(a0, b0), m(a1, b1)), mul(m(a0, b1), m(a1, b0)));
    return (i + j) % 2 ? neg(v) : v;
  };
  const det = add(add(mul(m(0, 0), cof(0, 0)), mul(m(0, 1), cof(0, 1))), mul(m(0, 2), cof(0, 2)));
  assert.ok(det[0] !== 0n, 'R 은 가역이어야 한다');
  const inv = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) inv.push(div(cof(j, i), det)); // (R⁻¹)ᵢⱼ = Cⱼᵢ / det
  return inv;
}

/** 정확한 ‖RᵀR − I‖_F² (유리수). */
function orthoErrSq(R) {
  const r = R.map(rat);
  let f = ZERO;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let s = [i === j ? -1n : 0n, 1n];
    for (let k = 0; k < 3; k++) s = add(s, mul(r[3 * k + i], r[3 * k + j]));
    f = add(f, mul(s, s));
  }
  return f;
}

/** 정확한 카메라 중심 C* = −R⁻¹t (유리수). */
const exactCenter = (Ri, t) => [0, 1, 2].map((i) => neg([0, 1, 2].reduce((acc, j) => add(acc, mul(Ri[3 * i + j], rat(t[j]))), ZERO)));

/**
 * 정확한 참값: 네 화면 모서리 광선이 월드 z = mn[2] 면과 만나는 점(∈ P 확인) 의 카메라 좌표 z 의 최솟값(유리수).
 * 광선은 R⁻¹ 기준(C* + s·R⁻¹(a, b, 1)).
 */
function exactZ({ R, t, mn, mx }) {
  const Ri = exactInverse(R);
  const C = exactCenter(Ri, t);
  let best = null;
  for (let q = 0; q < 4; q++) {
    const d = [div(sub(rat(q & 1 ? W : 0), rat(K.cx)), rat(K.fx)), div(sub(rat(q & 2 ? H : 0), rat(K.cy)), rat(K.fy)), [1n, 1n]];
    const dw = [0, 1, 2].map((i) => [0, 1, 2].reduce((acc, j) => add(acc, mul(Ri[3 * i + j], d[j])), ZERO)); // 월드 방향 R⁻¹(a, b, 1)
    assert.ok(dw[2][0] > 0n, '광선이 면을 향해야 한다');
    const s = div(sub(rat(mn[2]), C[2]), dw[2]);
    assert.ok(s[0] > 0n, '교점은 카메라 앞이어야 한다');
    // 교점이 실제로 상자 면 위(x·y 범위 안)여서 P 의 점인지 정확히 확인
    for (const ax of [0, 1]) {
      const X = add(C[ax], mul(s, dw[ax]));
      assert.ok(!less(X, rat(mn[ax])) && !less(rat(mx[ax]), X), `광선 ${q} 의 교점이 상자 면 밖(축 ${ax})`);
    }
    if (best === null || less(s, best)) best = s;
  }
  return best;
}

// 전제(머리 주석 '오차 한계'): ‖RᵀR − I‖_F ≤ ETA_MAX 이면 원본의 cAbs 가 R⁻¹ 과 Rᵀ 의 차까지 덮는다.
const ETA_MAX = 5e-16;
const GAMMA3 = (3 * 2 ** -53) / (1 - 3 * 2 ** -53);

test('⑥ 오차 한계 부등식: η ≤ ETA_MAX 이면 (γ₃ + η/(1 − η))·√(1 + η) ≤ 4ε·√(1 − η)·(1 − 1e-15)', () => {
  const lhs = (GAMMA3 + ETA_MAX / (1 - ETA_MAX)) * Math.sqrt(1 + ETA_MAX);
  const rhs = 4 * Number.EPSILON * Math.sqrt(1 - ETA_MAX) * (1 - 1e-15);
  assert.ok(lhs < rhs, `좌변 ${lhs} vs 우변 ${rhs}`);
});

// 회전이 있고 t ≈ 1e9 인 세 배치(탐색으로 고른 것: cAbs = 0 이면 z_P 가 R⁻¹ 참값보다 1.4e-8 ~ 4.5e-7 m 크게 나온다).
// refZ 는 R⁻¹ 참값(exactZ)을 숫자로 박아 둔 것이다.
const CASES = [
  {
    R: [0.9499458213597786, 0.14079803278573233, 0.2788885986281325, -0.20988718233537965, 0.9488439677539383, 0.23588661587355533, -0.2314093930081725, -0.28261464721530444, 0.930902064670048],
    t: [-452198950.22428584, -740895476.7059777, -1474704647.1131942],
    mn: [-67200568.07680224, 349889692.8373328, 1673686069.0215483],
    mx: [-67200368.07680224, 349889892.8373328, 1673686071.0215483],
    refZ: 8.179180666949163,
  },
  {
    R: [0.9804291782907311, -0.040323330989746616, 0.1926983532209167, 0.046634671323929844, 0.9985102601092855, -0.02832786414462015, -0.19126900895511242, 0.036759888933161386, 0.9808490591212037],
    t: [-727146883.975672, -1048901039.7351182, -1209287847.2296321],
    mn: [530531789.11123604, 1062470652.486482, 1296535738.0989563],
    mx: [530531989.11123604, 1062470852.486482, 1296535740.0989563],
    refZ: 8.946357006780454,
  },
  {
    R: [0.9941592464976503, -0.10193506247997042, -0.03544905697516806, 0.09905951742193844, 0.9922413347293741, -0.0751288603840274, 0.04283228468523319, 0.0711784847525889, 0.9965435357760184],
    t: [-1228079384.6556685, -1003797831.8806831, -973978408.8341539],
    mn: [1362059824.9883208, 940151559.0210543, 851663454.0672468],
    mx: [1362060024.9883208, 940151759.0210543, 851663456.0672468],
    refZ: 9.476043086684369,
  },
];

for (const [i, c] of CASES.entries()) {
  test(`⑥ C 반올림이 있는 배치 ${i + 1}: z_P 는 정확한 참값 이하`, () => {
    // 전제: R 의 비직교 정도가 오차 한계 안(정확한 유리수 비교)
    const etaSq = orthoErrSq(c.R);
    assert.ok(!less(mul(rat(ETA_MAX), rat(ETA_MAX)), etaSq), `‖RᵀR − I‖_F = ${Math.sqrt(toNum(etaSq))} > ${ETA_MAX}`);
    // 기준값 점검: 시험 안의 유리수 계산이 박아 둔 숫자와 같다
    const truth = exactZ(c);
    assert.ok(Math.abs(toNum(truth) - c.refZ) <= 1e-9, `참값 ${toNum(truth)} vs 기준 ${c.refZ}`);
    // C 에 실제로 오차가 있는지(정확한 C* = −R⁻¹t 와 cameraCenter 가 다름) 확인
    const camera = { R: c.R, t: c.t, K, width: W, height: H };
    const C = cameraCenter(camera);
    const exactC = exactCenter(exactInverse(c.R), c.t);
    const err = Math.max(...[0, 1, 2].map((j) => Math.abs(toNum(sub(rat(C[j]), exactC[j])))));
    assert.ok(err > 1e-8, `C 오차 ${err}`);
    const v = visiblePartBound(camera, C, c.mn, c.mx);
    assert.ok(v, 'P 가 비면 안 된다');
    // 핵심: 계산한 z_P 가 참값 이하(정확한 비교)
    assert.ok(!less(truth, rat(v.zMinM)), `z_P ${v.zMinM} > 참값 ${toNum(truth)} (차 ${v.zMinM - toNum(truth)})`);
    // 자명하게 작은 값으로 통과하지 않도록: 참값에서 1e-5 m 이상 벗어나지 않는다(원본 여유 ≤ 1.4e-6 m)
    assert.ok(v.zMinM >= c.refZ - 1e-5, `z_P ${v.zMinM} 가 너무 작다`);
  });
}
