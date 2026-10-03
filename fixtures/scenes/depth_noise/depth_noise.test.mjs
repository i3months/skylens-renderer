// depth_noise 장면 시험(T05.6). 완료 기준 수치는 아래 상수로 고정한다(측정 후 조정 금지).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSceneResult, resultHash, FORMAT_POINT27, FORMAT_GAUSS56 } from '../../../contracts/scenes/index.mjs';
import { generate, sigmaDepth, sceneToCamera, project, trueDepthAt, DOC_K, DEFAULTS, DEPTH_RANGE } from './index.mjs';

const BIN_CENTERS = [10, 20, 40, 60, 80]; // m
const BIN_HALF = 0.05; // ±5%
const STD_TOL = 0.10; // 표준편차 상대 오차 10% 이내
const MIN_BIN_POINTS = 1000; // 구간마다 이만큼은 있어야 비교가 의미 있다
const CLEAN_TOL = 1e-4; // noise:false 잔차 상한(m)
const COUNT = 200000;

/** 점군을 카메라로 다시 투영해 구간별 깊이 잔차 통계를 낸다(투영은 이 장면 모듈 자체 구현). */
function residualStats(r) {
  const { K, f, b } = r.truth;
  const P = r.cloud.positions;
  const bins = BIN_CENTERS.map((c) => ({ c, n: 0, sum: 0, sum2: 0, varModel: 0 }));
  let maxAbs = 0;
  let miss = 0;
  for (let i = 0; i < r.count; i++) {
    const Xc = sceneToCamera([P[3 * i], P[3 * i + 1], P[3 * i + 2]]);
    const [u, v, d] = project(Xc, K);
    const hit = trueDepthAt(u, v, K, r.truth.planes);
    if (hit === null) { miss++; continue; }
    const res = d - hit.d;
    if (Math.abs(res) > maxAbs) maxAbs = Math.abs(res);
    for (const B of bins) {
      if (Math.abs(hit.d - B.c) <= BIN_HALF * B.c) {
        B.n++; B.sum += res; B.sum2 += res * res;
        B.varModel += sigmaDepth(hit.d, f, b) ** 2;
      }
    }
  }
  for (const B of bins) {
    const mean = B.sum / B.n;
    B.std = Math.sqrt(B.sum2 / B.n - mean * mean);
    B.sigma = Math.sqrt(B.varModel / B.n); // 구간 안 σ(d)² 평균의 제곱근 = 기대 표준편차
  }
  return { bins, maxAbs, miss };
}

test('sigmaDepth 는 문서 §3-7 표와 맞는다 (d=45.3, f=754, b=1.04 → 2.61 m)', () => {
  assert.ok(Math.abs(sigmaDepth(45.3, 754, 1.04) - 2.61) < 0.01);
  assert.ok(Math.abs(sigmaDepth(45.3, 754, 8.26) - 0.33) < 0.005);
});

test('기본 K 와 f 는 문서 §1-2(960×540, fx 754.32, fy 753.85, cx 480, cy 270)와 같다', () => {
  const r = generate({ seed: 1, count: 10 });
  assert.deepEqual(r.truth.K, { fx: 754.32, fy: 753.85, cx: 480, cy: 270, width: 960, height: 540 });
  assert.equal(r.truth.f, DOC_K.fx);
  assert.equal(DEFAULTS.f, 754.32);
  assert.equal(r.truth.b, 0.5);
  assert.equal(r.truth.sigmaOfD, 'd^2/(f*b)');
  assert.ok(Array.isArray(r.truth.planes) && r.truth.planes.length >= 3);
  assert.equal(r.truth.pixels, undefined);
});

test('잡음 점군: 거리 구간 5개(±5%)에서 깊이 잔차 표준편차가 sigmaDepth 와 10% 이내', () => {
  const r = generate({ seed: 12345, count: COUNT });
  const { bins, miss } = residualStats(r);
  assert.equal(miss, 0);
  for (const B of bins) {
    assert.ok(B.n >= MIN_BIN_POINTS, `${B.c} m 구간 점 ${B.n} < ${MIN_BIN_POINTS}`);
    const rel = Math.abs(B.std / B.sigma - 1);
    assert.ok(rel <= STD_TOL, `${B.c} m: std ${B.std.toFixed(4)} vs σ ${B.sigma.toFixed(4)} (상대 ${rel.toFixed(4)})`);
    // 구간 중심의 sigmaDepth 와도 비교(구간 폭 ±5% 로 σ 는 ±10% 안에서 변한다)
    assert.ok(Math.abs(B.std / sigmaDepth(B.c, r.truth.f, r.truth.b) - 1) <= STD_TOL, `${B.c} m 중심 σ 비교`);
  }
});

test('다른 f, b 옵션에서도 잔차 표준편차가 σ(d)=d²/(f·b) 를 따른다', () => {
  const r = generate({ seed: 777, count: COUNT, f: 1280, b: 2 });
  assert.equal(r.truth.K.fx, 1280);
  const { bins } = residualStats(r);
  for (const B of bins) {
    assert.ok(B.n >= MIN_BIN_POINTS, `${B.c} m 구간 점 ${B.n}`);
    assert.ok(Math.abs(B.std / B.sigma - 1) <= STD_TOL, `${B.c} m: ${B.std} vs ${B.sigma}`);
  }
});

test('noise:false 는 정답 점군: 잔차 ≤ 1e-4 m, 깊이 범위 5~80 m', () => {
  const r = generate({ seed: 12345, count: COUNT, noise: false });
  assert.equal(r.truth.noise, false);
  const { maxAbs, miss } = residualStats(r);
  assert.equal(miss, 0);
  assert.ok(maxAbs <= CLEAN_TOL, `최대 잔차 ${maxAbs}`);
  const P = r.cloud.positions;
  let dmin = Infinity, dmax = -Infinity;
  for (let i = 0; i < r.count; i++) { const d = -P[3 * i + 2]; dmin = Math.min(dmin, d); dmax = Math.max(dmax, d); }
  assert.ok(dmin >= DEPTH_RANGE[0] - 1e-3 && dmax <= DEPTH_RANGE[1] + 1e-3, `깊이 ${dmin}~${dmax}`);
  assert.ok(dmin < 6 && dmax > 76, `깊이가 5~80 m 에 걸쳐야 함: ${dmin}~${dmax}`);
});

test('잡음은 광선 방향뿐: 같은 시드의 정답·잡음 점은 같은 픽셀로 투영된다', () => {
  const a = generate({ seed: 5, count: 2000 });
  const c = generate({ seed: 5, count: 2000, noise: false });
  const K = a.truth.K;
  for (let i = 0; i < a.count; i++) {
    const pa = project(sceneToCamera(Array.from(a.cloud.positions.subarray(3 * i, 3 * i + 3))), K);
    const pc = project(sceneToCamera(Array.from(c.cloud.positions.subarray(3 * i, 3 * i + 3))), K);
    assert.ok(Math.abs(pa[0] - pc[0]) < 1e-2 && Math.abs(pa[1] - pc[1]) < 1e-2, `점 ${i}`);
  }
});

test('같은 시드 → 바이트 동일, 다른 시드 → 다름 (두 형식)', () => {
  for (const format of [FORMAT_POINT27, FORMAT_GAUSS56]) {
    const h1 = resultHash(generate({ seed: 42, count: 20000, format }));
    const h2 = resultHash(generate({ seed: 42, count: 20000, format }));
    const h3 = resultHash(generate({ seed: 43, count: 20000, format }));
    assert.equal(h1, h2);
    assert.notEqual(h1, h3);
  }
});

test('두 형식 모두 assertSceneResult 통과, count 정확, 법선 단위·카메라 쪽, 색 무늬 있음', () => {
  for (const format of [FORMAT_POINT27, FORMAT_GAUSS56]) {
    const r = generate({ seed: 9, count: 5000, format });
    assertSceneResult(r, { scene: 'depth_noise', count: 5000 });
    assert.equal(r.format, format);
    JSON.stringify(r.truth);
  }
  const r = generate({ seed: 9, count: 5000 });
  assert.equal(generate({ seed: 1 }).count, DEFAULTS.count);
  const { positions: P, normals: N, colors: C } = r.cloud;
  const colorSet = new Set();
  for (let i = 0; i < r.count; i++) {
    const n = [N[3 * i], N[3 * i + 1], N[3 * i + 2]];
    assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-5);
    // 바깥(카메라 쪽): 법선 · (카메라 − 점) > 0, 카메라는 씬 원점
    assert.ok(-(n[0] * P[3 * i] + n[1] * P[3 * i + 1] + n[2] * P[3 * i + 2]) > 0, `법선 ${i}`);
    colorSet.add((C[3 * i] << 16) | (C[3 * i + 1] << 8) | C[3 * i + 2]);
  }
  assert.ok(colorSet.size > 50, `색 종류 ${colorSet.size}`);
  const t = r.truth.bounds;
  for (let i = 0; i < r.count; i++) for (let k = 0; k < 3; k++) {
    assert.ok(P[3 * i + k] >= t.min[k] && P[3 * i + k] <= t.max[k]);
  }
});
