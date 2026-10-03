// 시점 예측 부풀림의 판별력 시험(F-151): 장면 시드에 기대지 않고, 경계까지의 거리가 식으로 정해지는 상자를 직접 놓는다.
// 하한(촘촘한 시각에서 부풀림 없이 보이는 리프 ⊆ 마스크)·상한(마스크 ⊆ 촘촘한 시각의 upperDisp·(1+1e-3)+1e-3 부풀림 합집합)은
// predict.test.mjs 와 같은 정의다. 여기서는 구현 부풀림을 줄이거나(반폭 h/2) 키우는(전체 ×1.2, 회전항 ×1.5) 변이마다
// 하한 또는 상한을 깨는 리프가 반드시 하나 이상 있도록 배치하고, 그 전제를 식과 판정 함수로 함께 단언한다.
//
// 카메라: K = (fx = fy = 4000, cx = 320, cy = 240), 640×480 이라 좌·우 반화각의 tan 이 T = 320/4000 = 0.08 이다.
// τ = 0 에서 R = I(+z 를 봄), 중심 원점. 이때 상자 [a,b]×[−q,q]×[z1,z2] (z2 > 0) 의 판정은
//   오른쪽: (a − x_c) − T·z2 <= 0,  왼쪽: (b − x_c) + T·z2 >= 0  (위·아래·앞은 y 가 0 을 감싸고 z2 > 0 이라 늘 참)
// 이고, 상자를 모든 축으로 M 만큼 부풀리면 a → a − M, z2 → z2 + M 이라 오른쪽 식의 좌변이 정확히 (1 + T)·M 만큼 준다.
// 즉 오른쪽 경계까지의 틈 G = a − x_c − T·z2 인 상자는 M >= G/(1 + T) 일 때만 보인다(해석적 경계 거리).
import test from 'node:test';
import assert from 'node:assert/strict';
import { boxMayBeVisibleSplat } from '../../lod/select/view_check.mjs';
import { cameraCenter } from '../../lod/select/screen_error.mjs';
import { predictCamera, predictiveMask } from './index.mjs';

const K = { fx: 4000, fy: 4000, cx: 320, cy: 240 };
const T = K.cx / K.fx; // 0.08 (좌우 대칭: (W − cx)/fx 도 같다)
const KAPPA = 1 + T; // 부풀림 M 이 오른쪽 경계 틈을 줄이는 배율
const cam0 = { width: 640, height: 480, K, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
const IMPL_REL = 1.0001, IMPL_ABS = 1e-9; // index.mjs 의 부풀림 상수: 상한에는 쓰지 않고, 변이 부풀림(×1.2·×1.5)을 만드는 판별 시험에만 쓴다
const REL = 1e-3, EPS = 1e-3; // 상한 여유: M = (geoDisp + crossSlack)·(1 + REL) + EPS (predict.test.mjs 와 같다)
const MID = 1.1; // 판별 상자의 경계 틈 = KAPPA·MID·U. 1 + REL(+EPS/U) < MID < 1.2 라 정확한 구현·상한은 못 닿고 ×1.2·×1.5 변이는 닿는다.

const upperDisp = (speed, omega, hh, far) => speed * hh + omega * hh * (far + speed * hh); // 판별 상자 배치용 기준값(상한 아님)
// 상한: 기하 상한 |v|·hh + 2·far·sin(ω·hh/2) 에 구현이 더 보수적으로 잡는 몫을 시험 쪽에서 독립 도출한 crossSlack 으로 더한다.
//   교차항 ω·hh·|v|·hh (회전 반경 far + |v|·hh) + 호/현 초과분 far·(ω·hh)³/24 (x − 2·sin(x/2) <= x³/24). 구현 상수를 복사하지 않는다.
const geoDisp = (speed, omega, hh, far) => speed * hh + 2 * far * Math.sin((omega * hh) / 2);
const crossSlack = (speed, omega, hh, far) => omega * hh * speed * hh + far * (omega * hh) ** 3 / 24;
const farOf = (a, b, C) => Math.hypot(...[0, 1, 2].map((d) => Math.max(Math.abs(a[d] - C[d]), Math.abs(b[d] - C[d]))));
const inflate = (a, b, M) => [a.map((x) => x - M), b.map((x) => x + M)];

function hierarchyOf(boxes) {
  const n = boxes.length, boxMin = new Float64Array(3 * n), boxMax = new Float64Array(3 * n);
  boxes.forEach(([a, b], k) => { for (let d = 0; d < 3; d++) { boxMin[3 * k + d] = a[d]; boxMax[3 * k + d] = b[d]; } });
  return { octree: { leafCount: n, leafIndex: Int32Array.from({ length: n }, (_, i) => i), boxMin, boxMax } };
}

// 하한: 촘촘한 시각(n 등분)에서 부풀림 없이 보이는 리프. 상한: 같은 시각에서 U·(1+REL)+EPS 부풀림으로 보이는 리프.
function bounds(boxes, camAt, horizonS, n, speed, omega, hh) {
  const lower = new Set(), allowed = new Set();
  for (let i = 0; i <= n; i++) {
    const cam = camAt((horizonS * i) / n), C = cameraCenter(cam);
    boxes.forEach(([a, b], k) => {
      if (boxMayBeVisibleSplat(cam, a, b, 0)) lower.add(k);
      const far = farOf(a, b, C);
      const M = (geoDisp(speed, omega, hh, far) + crossSlack(speed, omega, hh, far)) * (1 + REL) + EPS;
      if (boxMayBeVisibleSplat(cam, ...inflate(a, b, M), 0)) allowed.add(k);
    });
  }
  return { lower, allowed };
}

function checkMask(boxes, v, w, horizonS, steps) {
  const camAt = (tau) => predictCamera(cam0, { velocityMps: v, angularRadPerS: w }, tau);
  const speed = Math.hypot(...v), omega = Math.hypot(...w), hh = horizonS / steps / 2;
  const m = predictiveMask(hierarchyOf(boxes), { camera: cam0, velocityMps: v, angularRadPerS: w }, { horizonS, steps, pointSizeM: 0 });
  const { lower, allowed } = bounds(boxes, camAt, horizonS, steps * 8, speed, omega, hh);
  for (const k of lower) assert.equal(m[k], 1, `steps=${steps}: 촘촘한 시각에 보이는 리프 ${k} 가 마스크에서 빠짐`);
  for (let k = 0; k < boxes.length; k++) if (m[k]) assert.ok(allowed.has(k), `steps=${steps}: 허용 밖 리프 ${k}`);
  return { lower, allowed, speed, omega, hh };
}

// τ = 0 카메라(cam0)의 오른쪽 경계 밖에 틈 G = KAPPA·MID·U(far) 로 놓인 상자. far 가 상자 위치에 따라 바뀌므로 고정점 반복으로 푼다
// (dG/dXc 에 대한 우변 기울기 KAPPA·MID·ω·hh <= 0.12 라 수렴). 깊이 z ∈ [zc−s, zc+s], 반변 s.
function edgeBox(speed, omega, hh, zc = 100, s = 0.5) {
  let xc = s + T * (zc + s);
  for (let it = 0; it < 200; it++) {
    const far = Math.hypot(xc + s, s, zc + s);
    xc = s + T * (zc + s) + KAPPA * MID * upperDisp(speed, omega, hh, far);
  }
  return [[xc - s, -s, zc - s], [xc + s, s, zc + s]];
}

test('직선 이동(해석 배치): 표본 사이에만 보이는 리프는 마스크에 있고(반폭 h/2 변이가 빠뜨림), 끝 시각 너머 경계 리프는 허용 밖(×1.2 변이가 넣음)', () => {
  // 카메라는 +z 를 보며 +x 로 v = 10 m/s. 중심 x_c(τ) = v·τ, 회전 없음 -> U = |v|·hh, far 는 쓰이지 않는다.
  // 깊이 z ∈ [4, 5] 의 상자는 x_c ∈ [a − 0.4, b + 0.4] 일 때만 보인다(T·z2 = 0.4).
  const v = [10, 0, 0], horizonS = 4, Z = [4, 5], q = 1;
  for (const steps of [1, 2, 4]) {
    const dt = horizonS / steps, hh = dt / 2, vdt = v[0] * dt;
    // 상자 A(하한 판별): 보이는 x_c 구간 = [vdt/2 − wA, vdt/2 + wA], wA = 0.1·vdt. 촘촘한 시각 τ = dt/2(8·steps 등분의 4 번째)에서 보이고,
    //   표본 x_c = 0, vdt, … 에서는 0.4·vdt 떨어져 안 보인다. 표본에서 덮으려면 M >= 0.4·vdt / KAPPA ≈ 0.370·vdt 가 필요하다.
    //   정확한 반폭 hh 의 부풀림 1.0001·vdt/2 는 닿고, 반폭 h/2 의 부풀림 1.0001·vdt/4 ≈ 0.25·vdt 는 못 닿는다.
    const wA = 0.1 * vdt, aA = vdt / 2 - wA + T * Z[1], bA = vdt / 2 + wA - T * Z[1];
    // 상자 B(상한 판별): 마지막 시각 x_c = v·horizonS 너머 틈 G = KAPPA·MID·|v|·hh. 상한(1.001·U + 1e-3)·정확한 구현(1.0001·U)은 못 닿고
    //   전체 ×1.2(1.2·1.0001·U)는 닿는다. 앞선 시각들은 x_c 가 더 작아 틈이 더 크다.
    const G = KAPPA * MID * v[0] * hh, aB = v[0] * horizonS + G + T * Z[1];
    const boxes = [
      [[aA, -q, Z[0]], [bA, q, Z[1]]],
      [[aB, -q, Z[0]], [aB + 0.5, q, Z[1]]],
      [[-1, -q, Z[0]], [1, q, Z[1]]], // 시작 시각에 보이는 기준 리프
    ];
    assert.ok(bA > aA, `전제: 상자 A 의 x 폭이 양수 (steps=${steps})`);
    const { lower, allowed } = checkMask(boxes, v, [0, 0, 0], horizonS, steps);
    const samples = Array.from({ length: steps + 1 }, (_, i) => predictCamera(cam0, { velocityMps: v }, (horizonS * i) / steps));
    const seenAtSamples = (k, M) => samples.some((c) => boxMayBeVisibleSplat(c, ...inflate(...boxes[k], M), 0));
    // 전제(하한 판별, 해석): 상자 A 는 하한에 있고 표본 시각에는 안 보이며, 정확한 반폭 부풀림으로는 보이고 h/2 부풀림으로는 안 보인다.
    assert.ok(lower.has(0) && !seenAtSamples(0, 0), `전제: 상자 A 는 표본 사이에만 보임 (steps=${steps})`);
    // 전제: wA = 0.1·vdt 인 상자의 경계 거리는
    //   정확한 반폭 hh 부풀림: 1.0001·v[0]·(hh=dt/2)·KAPPA >= 0.4·v[0]·dt ⟺ 1.0001·KAPPA >= 0.8 (참)
    //   h/2 부풀림: 1.0001·v[0]·(hh/2)·KAPPA < 0.4·v[0]·dt ⟺ 1.0001·KAPPA < 1.6 (참)
    assert.ok(KAPPA * IMPL_REL * v[0] * hh >= 0.4 * vdt && KAPPA * (IMPL_REL * v[0] * hh / 2 + IMPL_ABS) < 0.4 * vdt, '전제: 식으로 본 경계 거리');
    assert.ok(seenAtSamples(0, IMPL_REL * v[0] * hh + IMPL_ABS), `전제: 반폭 hh 부풀림이 상자 A 를 덮음 (steps=${steps})`);
    assert.ok(!seenAtSamples(0, IMPL_REL * v[0] * (hh / 2) + IMPL_ABS), `전제: 반폭 h/2 부풀림은 상자 A 를 놓침 (steps=${steps})`);
    // 전제(상한 판별, 해석): 상자 B 는 하한·상한 밖이고, ×1.2 부풀림이면 마지막 표본에서 보인다.
    const U = v[0] * hh;
    // 전제: edgeBox 의 고정점 반복으로 설정된 xc 에서 상한(1.0001·U·KAPPA)은 G = KAPPA·MID·U 에 못 닿고
    //   (MID=1.1 이므로 1.0001 < 1.1), ×1.2 부풀림은 1.2·1.0001·KAPPA·U >= 1.1·KAPPA·U 로 닿는다
    assert.ok(KAPPA * (U * (1 + REL) + EPS) < G && KAPPA * 1.2 * (IMPL_REL * U + IMPL_ABS) >= G, '전제: 식으로 본 경계 거리');
    assert.ok(!lower.has(1) && !allowed.has(1), `전제: 상자 B 는 허용 밖 (steps=${steps})`);
    assert.ok(seenAtSamples(1, 1.2 * (IMPL_REL * U + IMPL_ABS)), `전제: ×1.2 부풀림은 상자 B 를 넣음 (steps=${steps})`);
    assert.ok(lower.has(2));
  }
});

test('회전만·회전+이동(해석 배치): 시작 시각 오른쪽 경계 밖 리프는 허용 밖이고, 전체 ×1.2·회전항 ×1.5 부풀림이면 보인다', () => {
  // 세계 −y 축 둘레 ω = 0.05 rad/s 로 왼쪽(−x)으로 돌고, 회전+이동 사례는 −x 로 2 m/s 이동도 더한다. 둘 다 상자에서 멀어지는 쪽이라
  // 상자에 가장 가까운 시각은 τ = 0(R = I, 중심 원점)이다. 상자는 그때의 오른쪽 경계 밖에 틈 G = KAPPA·MID·U(far) 로 놓는다(edgeBox).
  // far ≈ 101~104 m 라 회전+이동 사례에서도 회전항 ω·hh·(far+|v|·hh) 이 U 의 70% 이상이다(이동항 |v|·hh 는 30% 미만).
  // 그래서 회전항 ×1.5 는 U 를 약 1.36 배(회전만이면 1.5 배)로 키워 MID = 1.1 을 넘는다. steps=1 의 U 는 10 m 를 넘어 상대 여유가 필요한 영역이다.
  const horizonS = 4, w = [0, -0.05, 0];
  for (const v of [[0, 0, 0], [-2, 0, 0]]) {
    for (const steps of [1, 2, 4]) {
      const hh = horizonS / steps / 2, speed = Math.hypot(...v), omega = Math.hypot(...w);
      const box = edgeBox(speed, omega, hh);
      const boxes = [box, [[-1, -1, 99.5], [1, 1, 100.5]]]; // 둘째: 시작 시각에 보이는 기준 리프
      const { lower, allowed } = checkMask(boxes, v, w, horizonS, steps);
      const far = farOf(...box, [0, 0, 0]), U = upperDisp(speed, omega, hh, far);
      const G = box[0][0] - T * box[1][2]; // τ = 0 에서 x_c = 0
      const rot15 = speed * hh + 1.5 * omega * hh * (far + speed * hh);
      // 전제(해석): 틈 G = KAPPA·MID·U. 상한·정확한 구현은 못 닿고, ×1.2·회전항 ×1.5 는 닿는다.
      assert.ok(Math.abs(G - KAPPA * MID * U) <= 1e-9 * G, `전제: 고정점 수렴 (G=${G}, U=${U})`);
      assert.ok(KAPPA * (U * (1 + REL) + EPS) < G, `전제: 상한 부풀림은 경계에 못 닿음 (steps=${steps})`);
      assert.ok(KAPPA * (IMPL_REL * U + IMPL_ABS) < G, `전제: 정확한 구현 부풀림은 경계에 못 닿음 (steps=${steps})`);
      assert.ok(KAPPA * 1.2 * (IMPL_REL * U + IMPL_ABS) >= G && KAPPA * (IMPL_REL * rot15 + IMPL_ABS) >= G, `전제: 변이 부풀림은 닿음 (steps=${steps}, 회전항 비 ${rot15 / U})`);
      // 전제(판정 함수): 같은 결론을 boxMayBeVisibleSplat 으로 확인. 다른 촘촘한 시각은 상자에서 멀어지므로 허용 밖이어야 한다.
      assert.ok(!lower.has(0) && !allowed.has(0), `전제: 경계 상자는 허용 밖 (v=${v}, steps=${steps})`);
      assert.ok(boxMayBeVisibleSplat(cam0, ...inflate(...box, 1.2 * (IMPL_REL * U + IMPL_ABS)), 0), '전제: ×1.2 부풀림이면 τ=0 에서 보임');
      assert.ok(boxMayBeVisibleSplat(cam0, ...inflate(...box, IMPL_REL * rot15 + IMPL_ABS), 0), '전제: 회전항 ×1.5 부풀림이면 τ=0 에서 보임');
      assert.ok(!boxMayBeVisibleSplat(cam0, ...inflate(...box, IMPL_REL * U + IMPL_ABS), 0), '전제: 정확한 부풀림이면 τ=0 에서 안 보임');
      assert.ok(lower.has(1));
    }
  }
});
