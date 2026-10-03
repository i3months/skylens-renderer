// F-107 ②⑤ 확인: 큰 좌표에서 boxDistanceM 의 넘침, visiblePartBound 의 여유 pad 가 월드 좌표에 비례하던 문제.
//
// ② √(g0²+g1²+g2²) 는 간격 약 1.3e154 이상에서 Infinity(t ≈ 1e160 이면 budget 은 던지고 select·progressive 는 빈 결과),
//    약 1e-162 이하에서 0(상자 밖인데 '안' 으로 봄)이 된다. hypot 이면 유한·양수이고 상대 오차가 몇 ulp 이다.
// ⑤ 같은 배치(카메라·상자의 상대 위치, 회전, K)를 원점 근처와 월드 좌표 ~1e9 에 두고 visible 을 비교한다.
//    한계 도출: R 은 성분이 0·±1 인 순환 치환이고 모든 좌표는 ulp(4e9) = 2⁻²¹ 의 배수(정수·0.5)라
//      - C = −Rᵀt: 곱은 0·±1 이라 정확, 0 이 아닌 항이 하나뿐이라 합도 정확.
//      - 카메라 좌표 R·X + t = X_j − C_j: 두 수가 같은 2 의 거듭제곱 구간 안이거나 차가 2⁻²¹ 배수·2⁵³ 이하라 정확(Sterbenz).
//      - 시야 판정·모서리 교점·광선 방향 Rᵀ(a, b, 1) 은 위 정확한 값들만 입력으로 받으므로 원점 배치와 비트 단위로 같다.
//    따라서 cosMin 은 두 배치에서 정확히 같아야 한다(허용 오차 0). 다른 것은 pad 의 C_ROUND·‖C‖ 항뿐인데, 광선 위 cos 는
//    s 와 무관해 cosMin 에 영향이 없고 zMinM 만 그 크기(8.9e-16·‖C‖ ≈ 4e-6 m)만큼 움직인다 → zMinM 한계는 그 값에서 정한다.
//    참값: 카메라가 상자 면 앞(또는 안)이고 네 화면 모서리 광선이 모두 상자에 들어가면 c_P = cV(viewMinCos).
//    계산값은 SAFETY = 1 − 1e-12 를 곱하고 1/hypot 반올림(몇 ulp)이 있으므로 cV·(1 − 1e-12)·(1 ± 4ε) 안이다.
//    옛 코드는 1e9 에서 pad ≈ 2 m(x)·6 m(y) 라 들어가는 점이 s = 0 이 되어 cos = 0/0 이 빠지고 cosMin = Infinity 가 된다.
//    판별력(수동 변이): pad 만 옛 식으로 되돌리면 앞 시험이 zMinM = 0 으로 실패, 광선 cos 를 점에서 다시 재면(s = 0 → NaN)
//    카메라가 상자 안인 시험이 cosMin 0.811 > cV 0.781 로 실패한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boxDistanceM, cameraCenter, effectiveDistance, visiblePartBound, viewMinCos } from './screen_error.mjs';

const EPS = Number.EPSILON;
const SAFETY = 1 - 1e-12; // screen_error.mjs 와 같은 값(교점 반올림 몫)
const C_ROUND = 4 * EPS; // screen_error.mjs 의 C 반올림 몫(‖C‖ 배)
const REL_TOL = 1e-9; // screen_error.mjs 의 경계 여유

test('② boxDistanceM: 간격 1e160 에서 유한, 1e-170 에서 양수(상대 오차 몇 ulp)', () => {
  const s = 1e160;
  const d = boxDistanceM([s, 2 * s, -3 * s], [0, 0, 0], [1, 1, 1]);
  const want = s * Math.sqrt(14); // 간격 (s−1, 2s−1, 3s) 이고 1 은 s 의 ulp 보다 훨씬 작다
  assert.ok(Number.isFinite(d), `d = ${d}`);
  assert.ok(Math.abs(d - want) <= 4 * EPS * want, `d ${d} vs ${want}`);
  // 카메라 t ≈ 1e160 을 거친 effectiveDistance 도 유한한 d
  const cam = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, -s], K: { fx: 500, fy: 500, cx: 320, cy: 240 }, width: 640, height: 480 };
  const C = cameraCenter(cam);
  const e = effectiveDistance(cam, C, [0, 0, 0], [1, 1, 1]);
  assert.ok(Number.isFinite(e.distM) && Math.abs(e.distM - s) <= 4 * EPS * s, `distM ${e.distM}`);
  // 밑넘침: 상자 밖인데 0(안)으로 보면 안 된다
  const u = 1e-170;
  const du = boxDistanceM([0, 0, 0], [3 * u, 4 * u, 0], [4 * u, 5 * u, 1]);
  assert.ok(Math.abs(du - 5 * u) <= 4 * EPS * 5 * u, `du ${du}`);
});

// 카메라 z = 월드 x, 카메라 x = 월드 y, 카메라 y = 월드 z (순환 치환, det = +1).
const R = [0, 1, 0, 0, 0, 1, 1, 0, 0];
const K = { fx: 500, fy: 500, cx: 320, cy: 240 };
const W = 640, H = 480;

function placed(O, mnL, mxL) {
  // 카메라 중심 C = O, 상자 = O + 지역 좌표. t = −R·C.
  const t = [-(R[0] * O[0] + R[1] * O[1] + R[2] * O[2]), -(R[3] * O[0] + R[4] * O[1] + R[5] * O[2]), -(R[6] * O[0] + R[7] * O[1] + R[8] * O[2])];
  const cam = { R, t, K, width: W, height: H };
  const mn = mnL.map((v, i) => O[i] + v), mx = mxL.map((v, i) => O[i] + v);
  for (let i = 0; i < 3; i++) assert.equal(mn[i] - O[i], mnL[i], '시험 전제: 좌표가 정확히 표현됨');
  const C = cameraCenter(cam);
  assert.deepEqual(C, O, '시험 전제: C = −Rᵀt 가 정확');
  return { cam, C, mn, mx };
}

const ORIGIN = [0, 0, 0];
const FAR = [1e9, -3e9, 2.5e9]; // 옛 pad: x 약 2 m, y 약 6 m, z 약 5 m

function checkTrueCos(v, label) {
  const cV = viewMinCos({ K, width: W, height: H });
  assert.ok(v, `${label}: visible 이 null`);
  const lo = cV * SAFETY * (1 - 4 * EPS), hi = cV * SAFETY * (1 + 4 * EPS);
  assert.ok(v.cosMin >= lo && v.cosMin <= hi, `${label}: cosMin ${v.cosMin} 이 참값 cV·SAFETY = ${cV * SAFETY} 범위 밖`);
}

test('⑤ 카메라가 상자 면 0.5 m 앞(옛 pad 안): 1e9 에서도 visible.cosMin 이 원점 배치와 같고 참값 cV', () => {
  // 상자 x ∈ [0.5, 2.5], y ∈ [−4, 4], z ∈ [−3, 3](지역). 모서리 광선 (1, ±0.64, ±0.48) 은 x = 0.5 면에서 들어간다.
  const mnL = [0.5, -4, -3], mxL = [2.5, 4, 3];
  const a = placed(ORIGIN, mnL, mxL), b = placed(FAR, mnL, mxL);
  const va = visiblePartBound(a.cam, a.C, a.mn, a.mx), vb = visiblePartBound(b.cam, b.C, b.mn, b.mx);
  checkTrueCos(va, '원점');
  checkTrueCos(vb, '1e9');
  assert.equal(vb.cosMin, va.cosMin, `cosMin 1e9 ${vb.cosMin} ≠ 원점 ${va.cosMin}`);
  // zMinM: 참값 z_P = 0.5. 계산값 = (0.5 − pad_x)·SAFETY, pad_x = REL_TOL·(2 + 0.5 + 2.5) + C_ROUND·‖C‖ (반올림 몇 ulp 더)
  for (const [v, C] of [[va, a.C], [vb, b.C]]) {
    const pad = REL_TOL * 5 + C_ROUND * Math.hypot(...C);
    assert.ok(v.zMinM <= 0.5, `zMinM ${v.zMinM} > 참값 0.5`);
    assert.ok(v.zMinM >= (0.5 - pad) * SAFETY - 4 * EPS, `zMinM ${v.zMinM} 이 하한 ${(0.5 - pad) * SAFETY} 보다 작음`);
  }
  assert.ok(Math.abs(vb.zMinM - va.zMinM) <= C_ROUND * Math.hypot(...b.C) + 4 * EPS, `zMinM 차 ${vb.zMinM - va.zMinM}`);
  // effectiveDistance 도 같은 규칙: d = 0.5, d_eff = max(d·cMin², z_P·c_P) 가 두 배치에서 위 zMinM 차 이내로 같다
  const ea = effectiveDistance(a.cam, a.C, a.mn, a.mx), eb = effectiveDistance(b.cam, b.C, b.mn, b.mx);
  assert.equal(ea.distM, 0.5);
  assert.equal(eb.distM, 0.5);
  assert.ok(Number.isFinite(eb.effDistM) && eb.effDistM > 0, `effDistM ${eb.effDistM}`);
  assert.ok(eb.effDistM <= ea.effDistM + 4 * EPS, `1e9 의 d_eff ${eb.effDistM} 가 원점 ${ea.effDistM} 보다 큼(보수성)`);
  assert.ok(ea.effDistM - eb.effDistM <= C_ROUND * Math.hypot(...b.C) + 4 * EPS, `d_eff 차 ${ea.effDistM - eb.effDistM}`);
});

test('⑤ 카메라가 상자 안: visiblePartBound 의 cosMin 은 원점·1e9 모두 참값 cV(꼭짓점 근처 P 가 V 전체 방향을 덮음)', () => {
  const mnL = [-1, -1, -1], mxL = [3, 2, 2];
  const a = placed(ORIGIN, mnL, mxL), b = placed(FAR, mnL, mxL);
  const va = visiblePartBound(a.cam, a.C, a.mn, a.mx), vb = visiblePartBound(b.cam, b.C, b.mn, b.mx);
  checkTrueCos(va, '원점');
  checkTrueCos(vb, '1e9');
  assert.equal(vb.cosMin, va.cosMin);
  // 카메라 중심이 P 의 꼭짓점이라 z_P = 0
  assert.equal(va.zMinM, 0);
  assert.equal(vb.zMinM, 0);
  // effectiveDistance 는 d = 0 이라 단계 0(visible 을 보지 않음)
  assert.equal(effectiveDistance(b.cam, b.C, b.mn, b.mx).effDistM, 0);
});
