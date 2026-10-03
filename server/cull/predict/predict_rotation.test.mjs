// 시점 예측의 회전 부풀림 시험(F-139): 회전만 있는 경우 표본 사이 시각에만 보이는 리프를 덮는지(하한),
// 회전 부풀림이 기하 상한을 넘지 않는지(상한). 구현 식을 복사하지 않고 기하만으로 판정한다. 기준값은 시험 안에 숫자로 고정한다.
// 예외: 상한 시험의 마스크 크기(81·147·165)는 기하에서 나온 값이 아니라 현재 구현 출력의 스냅숏이다(회귀 감지용, 판정 근거 아님).
// 부풀림을 줄이는 변이의 하한 판정은 마지막 시험(시선 근처 한 축 변위, 필요 부풀림 ≈ 0.97 × 호 길이)이 기하만으로 맡는다.
//
// 장면: 카메라 중심을 원점에 두고 R = I(+z 를 봄). 반지름 20 m 의 수평 원(y = 0) 위에 0.01 rad 간격으로 작은 상자
// (반변 0.05 m) 600 개를 φ = −3 .. 2.99 rad 에 놓는다(φ 는 +z 에서 +x 쪽으로 잰 각). 세계 +y 축 둘레로 ω 만큼 돌면
// 카메라 시선은 시각 τ 에 각 ω·τ 를 본다. 화각이 좁아(fx = 4000, 좌우 반화각 atan(320/4000) ≈ 0.08 rad) 표본 사이에 틈이 생긴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boxMayBeVisibleSplat } from '../../lod/select/view_check.mjs';
import { predictCamera, predictiveMask } from './index.mjs';

const RING_R = 20, HALF = 0.05, N = 600;
const boxMin = new Float64Array(3 * N), boxMax = new Float64Array(3 * N), phi = new Float64Array(N);
for (let j = 0; j < N; j++) {
  phi[j] = -3 + 0.01 * j;
  const c = [RING_R * Math.sin(phi[j]), 0, RING_R * Math.cos(phi[j])];
  for (let a = 0; a < 3; a++) { boxMin[3 * j + a] = c[a] - HALF; boxMax[3 * j + a] = c[a] + HALF; }
}
const h = { octree: { leafCount: N, leafIndex: Int32Array.from({ length: N }, (_, i) => i), boxMin, boxMax } };
const boxOf = (k) => [Array.from(boxMin.subarray(3 * k, 3 * k + 3)), Array.from(boxMax.subarray(3 * k, 3 * k + 3))];
const cam0 = { width: 640, height: 480, K: { fx: 4000, fy: 4000, cx: 320, cy: 240 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
const sum = (m) => m.reduce((a, b) => a + b, 0);
// 상자를 M 만큼(모든 축) 부풀려 cam 에서 보이는 리프 집합. M = 0 이면 실제 절두체 판정.
const visibleSet = (cam, M = 0) => {
  const s = new Set();
  for (let k = 0; k < N; k++) {
    const [a, b] = boxOf(k);
    if (boxMayBeVisibleSplat(cam, a.map((x) => x - M), b.map((x) => x + M), 0)) s.add(k);
  }
  return s;
};
// 카메라 중심(원점)에서 상자 최원 꼭짓점까지의 거리.
const farOf = (k) => { const [a, b] = boxOf(k); return Math.hypot(...[0, 1, 2].map((d) => Math.max(Math.abs(a[d]), Math.abs(b[d])))); };

test('회전만·성긴 표본: 표본 시각에는 안 보이고 표본 사이 τ 에만 보이는 리프가 예측 마스크에 모두 있다', () => {
  // ω = 1 rad/s(+y), horizonS = 2, steps = 2: 표본 τ = 0, 1, 2 의 시선 각 0, 1, 2 rad. 표본 간격 1 rad ≫ 화각 0.16 rad.
  const w = [0, 1, 0], horizonS = 2, steps = 2;
  const at = (tau) => predictCamera(cam0, { angularRadPerS: w }, tau);
  const sampled = new Set();
  for (let i = 0; i <= steps; i++) for (const k of visibleSet(at((horizonS * i) / steps))) sampled.add(k);
  const between = new Set();
  for (let i = 0; i <= 800; i++) for (const k of visibleSet(at((horizonS * i) / 800))) if (!sampled.has(k)) between.add(k);
  // 전제(숫자 고정): 표본 시각에 보이는 리프 51 개, 표본 사이에만 보이는 리프 166 개.
  assert.equal(sampled.size, 51, `표본 시각에 보이는 리프 ${sampled.size}`);
  assert.equal(between.size, 166, `표본 사이에만 보이는 리프 ${between.size}`);
  // 전제: 두 표본의 한가운데(τ = 0.5, 시선 각 0.5 rad) 방향의 리프(φ = 0.5, j = 350)는 τ = 0.5 에서만 보이고 표본 시각에는 안 보인다.
  const mid = 350;
  assert.ok(Math.abs(phi[mid] - 0.5) < 1e-12);
  assert.ok(visibleSet(at(0.5)).has(mid), '전제: τ=0.5 에서 보임');
  for (const tau of [0, 1, 2]) assert.ok(!visibleSet(at(tau)).has(mid), `전제: τ=${tau} 에서는 안 보임`);
  // 표본 시각에 가장 가까운 시선과의 각 차 0.5 rad 를 돌아야 화면에 들어온다(반화각 0.08 rad 를 빼도 0.42 rad 이상).
  const m = predictiveMask(h, { camera: cam0, angularRadPerS: w }, { horizonS, steps, pointSizeM: 0 });
  assert.equal(m[mid], 1, '표본 사이에만 보이는 가운데 리프가 빠짐');
  let missed = 0;
  for (const k of between) if (!m[k]) missed++;
  assert.equal(missed, 0, `표본 사이에만 보이는 리프 중 빠진 수 ${missed}/${between.size}`);
  for (const k of sampled) assert.equal(m[k], 1);
  assert.ok(sum(m) < N, `전제: 마스크가 전체가 아님 ${sum(m)}/${N}`);
});

test('회전만·과잉 없음: 예측 마스크 ⊆ 촘촘한 시각들에서 기하 상한 2·far·sin(ω·h/2) 만큼 부풀린 상자가 보이는 리프', () => {
  // 각 θ 만큼 도는 동안 중심에서 거리 far 인 점이 움직이는 직선 거리는 현의 길이 2·far·sin(θ/2) 이하다.
  // 한 표본이 맡는 구간 반폭 h 동안 θ = ω·h. 여유는 미리 정한 상대 1%(호/현 비 θ/(2·sin(θ/2)) 가 θ ≤ 0.24 rad 에서 1.0024 이하)와
  // 절대 1e-6 m 뿐이다. 표본 시각은 구현보다 8 배 촘촘히(0..horizonS) 잡는다.
  for (const [w, horizonS, steps, expectMask] of [[[0, 0.2, 0], 2, 2, 81], [[0, 0.5, 0], 2, 4, 147], [[0, -0.4, 0], 3, 5, 165]]) {
    const omega = Math.hypot(...w), hh = horizonS / steps / 2, theta = omega * hh;
    assert.ok(theta <= 0.24, `전제: θ=${theta} 가 작아야 1% 여유가 성립`);
    const at = (tau) => predictCamera(cam0, { angularRadPerS: w }, tau);
    const fine = steps * 8;
    const bound = new Set();
    for (let i = 0; i <= fine; i++) {
      const cam = at((horizonS * i) / fine);
      for (let k = 0; k < N; k++) {
        if (bound.has(k)) continue;
        const M = 1.01 * 2 * farOf(k) * Math.sin(theta / 2) + 1e-6;
        const [a, b] = boxOf(k);
        if (boxMayBeVisibleSplat(cam, a.map((x) => x - M), b.map((x) => x + M), 0)) bound.add(k);
      }
    }
    const m = predictiveMask(h, { camera: cam0, angularRadPerS: w }, { horizonS, steps, pointSizeM: 0 });
    const outside = [];
    for (let k = 0; k < N; k++) if (m[k] && !bound.has(k)) outside.push(k);
    assert.deepEqual(outside, [], `ω=${omega} steps=${steps}: 기하 상한 밖 리프 ${outside.length}개`);
    // 스냅숏(구현 출력, 기하 판정 아님): 마스크 크기가 바뀌면 의도한 변경인지 확인하라는 회귀 신호일 뿐이다.
    assert.equal(sum(m), expectMask, `ω=${omega} steps=${steps}: 마스크 크기(스냅숏)`);
    assert.ok(bound.size < N, '전제: 상한 집합이 전체가 아님');
    for (const k of visibleSet(cam0)) assert.equal(m[k], 1);
  }
});

test('회전만·시선 근처 한 축 변위: 호 길이 0.95 배 부풀림으로는 못 덮고 1.0 배로는 덮는 리프가 예측 마스크에 있다', () => {
  // 기하(구현 식과 독립): 리프 하나(중심 P = (0, 0, 20), 반변 b = 1e-4 m). 화각을 아주 좁게(반화각 α = 2e-4 rad) 잡고
  // +y 둘레 ω = 0.01 rad/s, horizonS = 2, steps = 1 → 표본 τ = 0, 2, 구간 반폭 h = 1 s, 반폭 동안의 회전각 θ = ω·h = 0.01 rad.
  // 처음 시선을 −θ 로 두면 표본 시선은 −θ, +θ 이고 한가운데(τ = 1)에서 정확히 +z(P 방향)를 본다.
  // 표본 시각에는 P 가 화면 가장자리 평면에서 각 θ − α 만큼 밖이다. 가장자리 평면(원점을 지나는 수직 평면)의 단위 법선 n 은
  // 세계 x 축에서 θ − α 만 기운다(변위가 거의 x 한 축). 축 정렬 상자를 모든 축으로 M 부풀리면 n 방향으로 (b + M)·‖n‖₁ 만큼
  // 뻗으므로, 표본 시각에 평면 안으로 들어오는 최소 부풀림은 M* = R·sin(θ − α) / (cos(θ − α) + sin(θ − α)) − b.
  // 비교 길이 L = |ω|·h·far(far = 중심에서 최원 꼭짓점 거리): 반폭 동안 거리 far 인 점이 그리는 호의 길이.
  // M*/L ≈ 0.970 이라 0.95·L 로는 어느 표본에서도 안 보이고 1.0·L 로는 보인다.
  const R0 = 20, b = 1e-4, alpha = 2e-4, omega = 0.01, horizonS = 2, steps = 1;
  const hh = horizonS / steps / 2, theta = omega * hh;
  const fx = 320 / Math.tan(alpha);
  const ps = -theta; // 처음 시선 각(+z 에서 +x 쪽으로)
  const camS = {
    width: 640, height: 480, K: { fx, fy: fx, cx: 320, cy: 240 },
    R: [Math.cos(ps), 0, -Math.sin(ps), 0, 1, 0, Math.sin(ps), 0, Math.cos(ps)], t: [0, 0, 0],
  };
  const mn1 = [-b, -b, R0 - b], mx1 = [b, b, R0 + b];
  const h1 = { octree: { leafCount: 1, leafIndex: Int32Array.from([0]), boxMin: Float64Array.from(mn1), boxMax: Float64Array.from(mx1) } };
  const w = [0, omega, 0];
  const at = (tau) => predictCamera(camS, { angularRadPerS: w }, tau);
  const vis = (cam, M) => boxMayBeVisibleSplat(cam, mn1.map((x) => x - M), mx1.map((x) => x + M), 0);
  // 전제: 한가운데(τ = 1)에는 보이고 두 표본 시각에는 안 보인다.
  assert.ok(vis(at(hh), 0), '전제: τ=h 에서 보임');
  for (const tau of [0, horizonS]) assert.ok(!vis(at(tau), 0), `전제: τ=${tau} 에서는 안 보임`);
  const far = Math.hypot(b, b, R0 + b);
  const L = omega * hh * far;
  const g = theta - alpha;
  const Mstar = (R0 * Math.sin(g)) / (Math.cos(g) + Math.sin(g)) - b;
  const ratio = Mstar / L;
  // 숫자 고정: M* ≈ 0.19400 m, L ≈ 0.20000 m, M*/L ≈ 0.9700.
  assert.ok(Math.abs(Mstar - 0.19400) < 5e-5, `M*=${Mstar}`);
  assert.ok(Math.abs(L - 0.20000) < 5e-5, `L=${L}`);
  assert.ok(ratio > 0.965 && ratio < 0.975, `M*/L=${ratio}`);
  // 닫힌 꼴 M* 를 절두체 판정으로 확인: M* 바로 아래로는 두 표본 모두 못 보고, 바로 위로는 보인다.
  for (const tau of [0, horizonS]) assert.ok(!vis(at(tau), Mstar * (1 - 1e-6)), `전제: τ=${tau} 에서 M*·(1−1e-6) 로는 안 보임`);
  assert.ok(vis(at(0), Mstar * (1 + 1e-6)) && vis(at(horizonS), Mstar * (1 + 1e-6)), '전제: M*·(1+1e-6) 로는 보임');
  // 호 길이 0.95 배로는 못 덮고(어느 표본도 못 봄) 1.0 배로는 덮는다.
  for (const tau of [0, horizonS]) assert.ok(!vis(at(tau), 0.95 * L), `전제: τ=${tau} 에서 0.95·L 로는 안 보임`);
  assert.ok(vis(at(0), L), '전제: 1.0·L 로는 보임');
  // 판정: 표본 사이에만 보이는 이 리프가 예측 마스크에 있어야 한다.
  const m = predictiveMask(h1, { camera: camS, angularRadPerS: w }, { horizonS, steps, pointSizeM: 0 });
  assert.equal(m[0], 1, `시선 근처 한 축 변위 리프가 빠짐(필요 부풀림 M*/L=${ratio.toFixed(4)})`);
});
