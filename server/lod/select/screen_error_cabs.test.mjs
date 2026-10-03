// F-111 ⑥ 확인: visiblePartBound 의 cAbs(= C_ROUND·‖C‖) 여유 항을 덮는다.
//
// C = −Rᵀt 는 부동소수 반올림이 생긴다(회전이 있고 t ≈ 1e9 이면 성분마다 ulp(1e9) ≈ 1.2e-7 m 급).
// 화면 모서리 광선 ∩ 상자 면의 들어가는 점이 z_P 를 정하는 배치에서는, 상대 좌표 pad 의 REL_TOL 항(≈ 1e-8 m)만으로는
// C 의 반올림 오차를 못 덮어 z_P 가 참값보다 커진다. cAbs 가 그 몫을 덮는다.
// 변이(cAbs = 0) 시 아래 세 사례가 모두 z_P > 참값으로 실패한다(탐색 3000 배치 중 1043 개가 실패, 원본은 0 개).
//
// 배치: 상자 = 얇은 슬래브(월드 z 가 C_z + 10 ~ C_z + 12, x·y 는 ±100), 카메라는 약간 회전해 슬래브 아래 면을 본다.
//   슬래브 x·y 폭이 시야보다 훨씬 넓고 깊이 방향 두께 때문에 윗면 점은 z 가 더 크므로, P 의 최소 z 는
//   네 화면 모서리 광선이 아래 면(월드 z = mn[2])과 만나는 점 중 가장 가까운 것이다(이웃 후보는 모두 더 멀다).
//   참값은 R·t·K 의 부동소수 값을 정확한 유리수(BigInt)로 보고 C = −Rᵀt 와 광선 교점 s = (mn_z − C_z)/(Rᵀ(a,b,1))_z 를 정확히 계산해
//   네 광선의 최솟값(카메라 좌표 z = s)으로 구한다. 기준값 refZ 는 그 값을 숫자로 박아 둔 것이다.
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
const div = (a, b) => (b[0] < 0n ? [-a[0] * b[1], a[1] * -b[0]] : [a[0] * b[1], a[1] * b[0]]);
const less = (a, b) => a[0] * b[1] < b[0] * a[1]; // 분모는 모두 양수
const toNum = (a) => Number((a[0] * (1n << 60n)) / a[1]) / 2 ** 60;

/** 정확한 참값: 네 화면 모서리 광선이 월드 z = mn[2] 면과 만나는 카메라 좌표 z 의 최솟값(유리수). */
function exactZ({ R, t, mn }) {
  const Rr = R.map(rat), tr = t.map(rat);
  const Cz = neg(add(add(mul(Rr[2], tr[0]), mul(Rr[5], tr[1])), mul(Rr[8], tr[2]))); // C_z = −(Rᵀt)_z
  let best = null;
  for (let q = 0; q < 4; q++) {
    const da = div(add(rat(q & 1 ? W : 0), neg(rat(K.cx))), rat(K.fx));
    const db = div(add(rat(q & 2 ? H : 0), neg(rat(K.cy))), rat(K.fy));
    const dz = add(add(mul(Rr[2], da), mul(Rr[5], db)), Rr[8]); // 월드 방향 Rᵀ(a, b, 1) 의 z 성분
    assert.ok(dz[0] > 0n, '광선이 면을 향해야 한다');
    const s = div(add(rat(mn[2]), neg(Cz)), dz);
    if (best === null || less(s, best)) best = s;
  }
  return best;
}

// 회전이 있고 t ≈ 1e9 인 세 배치(탐색으로 고른 것: cAbs = 0 이면 z_P 가 참값보다 5e-8 ~ 2e-7 m 크게 나온다).
const CASES = [
  {
    R: [0.9499458213597786, 0.14079803278573233, 0.2788885986281325, -0.20988718233537965, 0.9488439677539383, 0.23588661587355533, -0.2314093930081725, -0.28261464721530444, 0.930902064670048],
    t: [-452198950.22428584, -740895476.7059777, -1474704647.1131942],
    mn: [-67200568.07680224, 349889692.8373328, 1673686069.0215483],
    mx: [-67200368.07680224, 349889892.8373328, 1673686071.0215483],
    refZ: 8.17918062447734,
  },
  {
    R: [0.9804291782907311, -0.040323330989746616, 0.1926983532209167, 0.046634671323929844, 0.9985102601092855, -0.02832786414462015, -0.19126900895511242, 0.036759888933161386, 0.9808490591212037],
    t: [-727146883.975672, -1048901039.7351182, -1209287847.2296321],
    mn: [530531789.11123604, 1062470652.486482, 1296535738.0989563],
    mx: [530531989.11123604, 1062470852.486482, 1296535740.0989563],
    refZ: 8.946357306796926,
  },
  {
    R: [0.9941592464976503, -0.10193506247997042, -0.03544905697516806, 0.09905951742193844, 0.9922413347293741, -0.0751288603840274, 0.04283228468523319, 0.0711784847525889, 0.9965435357760184],
    t: [-1228079384.6556685, -1003797831.8806831, -973978408.8341539],
    mn: [1362059824.9883208, 940151559.0210543, 851663454.0672468],
    mx: [1362060024.9883208, 940151759.0210543, 851663456.0672468],
    refZ: 9.476043227483387,
  },
];

for (const [i, c] of CASES.entries()) {
  test(`⑥ C 반올림이 있는 배치 ${i + 1}: z_P 는 정확한 참값 이하`, () => {
    // 기준값 점검: 시험 안의 유리수 계산이 박아 둔 숫자와 같다
    const truth = exactZ(c);
    assert.ok(Math.abs(toNum(truth) - c.refZ) <= 1e-9, `참값 ${toNum(truth)} vs 기준 ${c.refZ}`);
    // C 에 실제로 반올림이 있는지(정확한 C 와 cameraCenter 가 다름) 확인
    const camera = { R: c.R, t: c.t, K, width: W, height: H };
    const C = cameraCenter(camera);
    const Rr = c.R.map(rat), tr = c.t.map(rat);
    const exactC = [0, 1, 2].map((j) => neg(add(add(mul(Rr[j], tr[0]), mul(Rr[3 + j], tr[1])), mul(Rr[6 + j], tr[2]))));
    const err = Math.max(...[0, 1, 2].map((j) => Math.abs(toNum(add(rat(C[j]), neg(exactC[j]))))));
    assert.ok(err > 1e-8, `C 반올림 오차 ${err}`);
    const v = visiblePartBound(camera, C, c.mn, c.mx);
    assert.ok(v, 'P 가 비면 안 된다');
    // 핵심: 계산한 z_P 가 참값 이하(정확한 비교)
    assert.ok(!less(truth, rat(v.zMinM)), `z_P ${v.zMinM} > 참값 ${toNum(truth)} (차 ${v.zMinM - toNum(truth)})`);
    // 자명하게 작은 값으로 통과하지 않도록: 참값에서 1e-3 m 이상 벗어나지 않는다
    assert.ok(v.zMinM >= c.refZ - 1e-3, `z_P ${v.zMinM} 가 너무 작다`);
  });
}
