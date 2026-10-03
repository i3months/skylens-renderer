// F-104 ①② 확인: cMin 계산의 넘침(Math.hypot), 화면 안 부분만 보는 cEff = max(cMin, cV) 의 보수성과 점 수 감소.
//
// ① 좌표 1e200 에서 √(x²+y²+z²) 는 Infinity 로 넘쳐 cMin = 0 이 됐다. hypot 이면 정확한 값.
// ② 보수성: 무작위 회전·fx ≠ fy·비중심 cx·cy 카메라, 화면 모서리 근처·카메라 평면에 걸친 상자를 포함해,
//    상자 안 무작위 선분을 시야 사각뿔 V 로 잘라 '화면에 보이는 부분' 의 실제 투영 길이를 잰다.
//    비 = (투영 길이) / (f·e_vis/d_eff) ≤ 1 (f = max(fx, fy), e_vis = 보이는 부분 길이, d_eff = max(d·cMin², z_P·c_P)).
//    판별력: cos 인자를 뺀 변이(d_eff = z_P)는 이 시험에서 비 > 1 이 된다(아래 단언). 모서리 광선 후보를 빼는 변이 등은
//    작업 보고에 수동 변이 결과로 적는다.
// 측정: terrain(select_coarse 와 같은 장면·시점 8곳)과 화면 모서리 정육면체에서 옛 규칙(cMin 만) 대비 선택 점 수.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NOT_DRAWN, edgeOfLevel } from '../../../contracts/lod/index.mjs';
import { generate } from '../../../fixtures/scenes/terrain/index.mjs';
import { viewpointToCamera } from '../../../tools/render_views/index.mjs';
import { buildHierarchy, selectLevels } from './index.mjs';
import {
  minCosToAxis, viewMinCos, effectiveDistance, visiblePartBound, cameraCenter, screenFocalPx, screenErrorRule,
} from './screen_error.mjs';
import { boxMayBeVisible } from './view_check.mjs';
import { buildDistanceTable, levelForDistance } from '../distance_table/index.mjs';

const ID = [1, 0, 0, 0, 1, 0, 0, 0, 1];

test('① minCosToAxis: 좌표 1e200 에서도 0 이 되지 않고 정확한 cos 를 준다', () => {
  const cam = { R: ID, t: [0, 0, 0] };
  const s = 1e200;
  const c = minCosToAxis(cam, [s, s, 2 * s], [1.5 * s, 1.5 * s, 3 * s]);
  // 최소 cos 는 꼭짓점 (1.5s, 1.5s, 2s): 2/√(1.5²+1.5²+2²)
  const want = 2 / Math.sqrt(1.5 * 1.5 + 1.5 * 1.5 + 4);
  assert.ok(c > 0, `cMin ${c}`);
  assert.ok(Math.abs(c - want) < 1e-12, `cMin ${c} ≠ ${want}`);
  // 아주 작은 좌표(밑넘침)도 마찬가지
  const u = 1e-200;
  assert.ok(Math.abs(minCosToAxis(cam, [u, u, 2 * u], [1.5 * u, 1.5 * u, 3 * u]) - want) < 1e-12);
});

test('viewMinCos = 화면 네 모서리 광선 cos 의 최솟값, 화면 안 무작위 픽셀은 모두 그 이상', () => {
  const rnd = rng(7);
  for (let i = 0; i < 200; i++) {
    const width = 100 + Math.floor(rnd() * 1900), height = 100 + Math.floor(rnd() * 1100);
    const K = { fx: 50 + rnd() * 1500, fy: 50 + rnd() * 1500, cx: (rnd() * 1.6 - 0.3) * width, cy: (rnd() * 1.6 - 0.3) * height };
    const cV = viewMinCos({ K, width, height });
    const cosPix = (u, v) => 1 / Math.hypot(1, (u - K.cx) / K.fx, (v - K.cy) / K.fy);
    const corners = Math.min(cosPix(0, 0), cosPix(width, 0), cosPix(0, height), cosPix(width, height));
    assert.ok(Math.abs(cV - corners) < 1e-15, `${cV} vs ${corners}`);
    for (let j = 0; j < 50; j++) assert.ok(cosPix(rnd() * width, rnd() * height) >= cV - 1e-15);
  }
  // 크기가 없거나 유한하지 않으면 보정 없음(0)
  assert.equal(viewMinCos({ K: { fx: 1, fy: 1, cx: 0, cy: 0 } }), 0);
  assert.equal(viewMinCos({ K: { fx: 1, fy: 1, cx: 0, cy: 0 }, width: NaN, height: 10 }), 0);
});

// ---- ② 보수성: 무작위 선분 투영 비 ----

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** 균일 무작위 회전(단위 사원수 → 행 우선 3×3). */
function randomRotation(rnd) {
  const u1 = rnd(), u2 = rnd() * 2 * Math.PI, u3 = rnd() * 2 * Math.PI;
  const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
  const [w, x, y, z] = [a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)];
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

const toCam = ({ R, t }, X) => [
  R[0] * X[0] + R[1] * X[1] + R[2] * X[2] + t[0],
  R[3] * X[0] + R[4] * X[1] + R[5] * X[2] + t[1],
  R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + t[2],
];

/** 카메라 좌표 선분 P(s) = A + s(B−A), s ∈ [0,1] 을 시야 사각뿔의 네 옆면으로 자른 구간 [s0, s1] (없으면 null). */
function clipToView(K, W, H, A, B) {
  // 반공간 g(p) ≥ 0: fx·x + cx·z, −(fx·x + (cx−W)·z), fy·y + cy·z, −(fy·y + (cy−H)·z). 네 반공간의 교집합은 z ≥ 0 원뿔.
  const gs = [
    (p) => K.fx * p[0] + K.cx * p[2],
    (p) => -(K.fx * p[0] + (K.cx - W) * p[2]),
    (p) => K.fy * p[1] + K.cy * p[2],
    (p) => -(K.fy * p[1] + (K.cy - H) * p[2]),
  ];
  let s0 = 0, s1 = 1;
  for (const g of gs) {
    const ga = g(A), gb = g(B); // g 는 선형이라 g(P(s)) = ga + s(gb − ga)
    if (ga < 0 && gb < 0) return null;
    if (ga < 0) s0 = Math.max(s0, ga / (ga - gb));
    else if (gb < 0) s1 = Math.min(s1, ga / (ga - gb));
  }
  return s1 > s0 ? [s0, s1] : null;
}

/** 화면 안·모서리 밖 근처 픽셀 방향, 깊이 D 에 중심을 둔 상자. size 는 D 대비 비율. */
function randomCase(rnd) {
  const width = 160 + Math.floor(rnd() * 1800), height = 120 + Math.floor(rnd() * 1000);
  const K = {
    fx: 40 + rnd() * 1500,
    fy: 40 + rnd() * 1500,
    cx: (0.2 + 0.6 * rnd()) * width,
    cy: (0.2 + 0.6 * rnd()) * height,
  };
  const R = randomRotation(rnd);
  const C = [(rnd() - 0.5) * 200, (rnd() - 0.5) * 200, (rnd() - 0.5) * 200];
  const t = [-(R[0] * C[0] + R[1] * C[1] + R[2] * C[2]), -(R[3] * C[0] + R[4] * C[1] + R[5] * C[2]), -(R[6] * C[0] + R[7] * C[1] + R[8] * C[2])];
  const cam = { width, height, K, R, t };
  // 상자 중심 방향: 모서리 근처를 자주 고른다(가장 엄한 곳)
  const pick = (n) => (rnd() < 0.5 ? (rnd() < 0.5 ? -0.2 : 1) + rnd() * 0.2 : rnd() * 1.4 - 0.2) * n;
  const u = pick(width), v = pick(height);
  const dir = [(u - K.cx) / K.fx, (v - K.cy) / K.fy, 1];
  const D = 1 + rnd() * 100;
  const n = Math.hypot(...dir);
  const pc = dir.map((x) => (x / n) * D); // 카메라 좌표 중심
  // 월드로: X = Rᵀ(p − t)
  const Xc = [0, 1, 2].map((a) => R[a] * (pc[0] - t[0]) + R[3 + a] * (pc[1] - t[1]) + R[6 + a] * (pc[2] - t[2]));
  const half = [0, 1, 2].map(() => D * (0.01 + rnd() * (rnd() < 0.3 ? 1.5 : 0.3)));
  const mn = Xc.map((x, a) => x - half[a]), mx = Xc.map((x, a) => x + half[a]);
  return { cam, mn, mx };
}

test('② 무작위 회전·fx≠fy·비중심: 화면에 보이는 선분 부분의 투영 길이 ≤ f·e/d_eff (비 ≤ 1)', (t) => {
  const rnd = rng(20261003);
  let segs = 0, boxes = 0, improved = 0, straddle = 0, segsImproved = 0, maxRatio = 0, maxRatioImproved = 0, maxRatioMutant = 0;
  for (let i = 0; i < 6000; i++) {
    const { cam, mn, mx } = randomCase(rnd);
    if (!boxMayBeVisible(cam, mn, mx)) continue;
    const C = cameraCenter(cam);
    const e = effectiveDistance(cam, C, mn, mx);
    if (!(e.effDistM > 0)) continue; // 카메라 중심이 상자 안
    boxes++;
    const oldEff = e.cosMin > 0 ? e.distM * e.cosMin * e.cosMin : 0;
    assert.ok(e.effDistM >= oldEff, '새 d_eff 는 옛 d·cMin² 이상');
    const isImproved = e.effDistM > oldEff * (1 + 1e-9);
    if (isImproved) improved++;
    if (e.cosMin <= 0) straddle++;
    const f = screenFocalPx(cam.K);
    const { fx, fy, cx, cy } = cam.K;
    // 변이: cos 인자를 뺀 d_eff = z_P (덜 보수적)
    const dMut = e.visible ? Math.max(oldEff, e.visible.zMinM) : oldEff;
    for (let j = 0; j < 40; j++) {
      const P = [0, 1, 2].map((a) => mn[a] + rnd() * (mx[a] - mn[a]));
      const Q = [0, 1, 2].map((a) => mn[a] + rnd() * (mx[a] - mn[a]));
      // 축 평행 선분(칸 변과 같은 모양)을 절반 섞는다
      if (j % 2 === 0) { const ax = j % 6 / 2; for (let a = 0; a < 3; a++) if (a !== ax) Q[a] = P[a]; }
      const A = toCam(cam, P), B = toCam(cam, Q);
      const cl = clipToView(cam.K, cam.width, cam.height, A, B);
      if (!cl) continue;
      const at = (s) => [0, 1, 2].map((a) => A[a] + s * (B[a] - A[a]));
      const a0 = at(cl[0]), a1 = at(cl[1]);
      if (!(a0[2] > 0 && a1[2] > 0)) continue; // 사각뿔 꼭짓점(카메라 중심)만 닿는 경우: d > 0 이라 생기지 않음
      const eVis = Math.hypot(a1[0] - a0[0], a1[1] - a0[1], a1[2] - a0[2]);
      if (!(eVis > 1e-9 * e.distM)) continue;
      const proj = (p) => [(fx * p[0]) / p[2] + cx, (fy * p[1]) / p[2] + cy];
      const p0 = proj(a0), p1 = proj(a1);
      const px = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      const ratio = px / ((f * eVis) / e.effDistM);
      segs++;
      if (ratio > maxRatio) maxRatio = ratio;
      if (isImproved) { segsImproved++; if (ratio > maxRatioImproved) maxRatioImproved = ratio; }
      maxRatioMutant = Math.max(maxRatioMutant, px / ((f * eVis) / dMut));
      assert.ok(ratio <= 1 + 1e-9, `비 ${ratio} > 1 (상자 ${i}, cMin ${e.cosMin}, P ${JSON.stringify(e.visible)})`);
    }
  }
  t.diagnostic(`상자 ${boxes}(d_eff 가 커진 상자 ${improved}, 카메라 평면 걸침 ${straddle}), 선분 ${segs}(개선 상자 ${segsImproved}), 비 최대 ${maxRatio.toFixed(4)}(개선 상자 ${maxRatioImproved.toFixed(4)}), cos 인자 뺀 변이 비 최대 ${maxRatioMutant.toFixed(4)}`);
  assert.ok(boxes >= 2000 && improved >= 500 && straddle >= 50 && segsImproved >= 10000, '표본이 충분히 엄한 경우를 포함');
  // 상한이 헐겁지 않다(개선 상자에서 비가 1 에 가깝다)
  assert.ok(maxRatioImproved > 0.9, `개선 상자 비 최대 ${maxRatioImproved}`);
  // 판별력: 덜 보수적인 변이는 상한을 넘는다
  assert.ok(maxRatioMutant > 1, `변이 비 최대 ${maxRatioMutant}`);
});

// ---- 측정: 옛 규칙(cMin 만) 대비 점 수 ----

/** 옛 규칙(F-104 ② 이전, d_eff = d·cMin²) 으로 고른 선택 점 수와 새 선택 점 수, 리프별 단계 비교. */
function compareCounts(h, cam, tau) {
  const sel = selectLevels(h, cam, { thresholdPx: tau });
  const { octree, levels, edge0M } = h;
  const table = buildDistanceTable({ fx: screenFocalPx(cam.K), thresholdPx: tau, edge0M, levelCount: levels.length });
  const C = cameraCenter(cam);
  let oldCount = 0, coarser = 0, finer = 0;
  for (let node = 0; node < octree.nodeCount; node++) {
    const k = octree.leafIndex[node];
    if (k < 0 || sel.leafLevel[k] === NOT_DRAWN) continue;
    const mn = octree.boxMin.subarray(3 * node, 3 * node + 3), mx = octree.boxMax.subarray(3 * node, 3 * node + 3);
    const e = effectiveDistance(cam, C, mn, mx);
    const oldEff = e.distM > 0 && e.cosMin > 0 ? e.distM * e.cosMin * e.cosMin : 0;
    const lo = oldEff > 0 ? levelForDistance(table, oldEff) : 0;
    oldCount += levels[lo].leafStart[k + 1] - levels[lo].leafStart[k];
    if (sel.leafLevel[k] > lo) coarser++;
    if (sel.leafLevel[k] < lo) finer++;
  }
  return { newCount: sel.pointCount, oldCount, coarser, finer };
}

const VP = [
  { name: 'top_down_150', eye: [0, 150, 0.01], target: [0, 15, 0] },
  { name: 'oblique_sw_120', eye: [-140, 120, -140], target: [0, 15, 0] },
  { name: 'east_90', eye: [140, 90, 0], target: [-20, 15, 0] },
  { name: 'south_60', eye: [0, 60, 140], target: [0, 15, 0] },
  { name: 'low_ne_30', eye: [100, 30, 100], target: [0, 15, -30] },
  { name: 'west_45', eye: [-120, 45, 60], target: [40, 10, -20] },
  { name: 'far_north_150', eye: [60, 150, -160], target: [0, 15, 20] },
  { name: 'inside_100', eye: [-50, 100, -50], target: [50, 10, 50] },
];

test('측정: terrain 시점 8곳(select_coarse 와 같은 설정)에서 새 규칙은 옛 규칙보다 거칠거나 같고 점 수가 준다', (t) => {
  const N = 200000;
  const { cloud } = generate({ seed: 1, count: N });
  const h = buildHierarchy(cloud, { edge0M: Math.sqrt((200 * 200) / N) / 2, levelCount: 6, maxLeafPoints: 2048 });
  let sumOld = 0, sumNew = 0;
  for (const vp of VP) {
    const cam = viewpointToCamera({ eye: vp.eye, target: vp.target, up: [0, 1, 0], width: 320, height: 180, fov_y_deg: 90 });
    const r = compareCounts(h, cam, 0.5);
    assert.equal(r.finer, 0, `${vp.name}: 옛 규칙보다 고운 리프 ${r.finer}`);
    assert.ok(r.newCount <= r.oldCount);
    sumOld += r.oldCount; sumNew += r.newCount;
    t.diagnostic(`${vp.name}: 옛 ${r.oldCount} → 새 ${r.newCount} (${((1 - r.newCount / r.oldCount) * 100).toFixed(1)}% 감소, 거칠어진 리프 ${r.coarser})`);
  }
  t.diagnostic(`합계: 옛 ${sumOld} → 새 ${sumNew} (${((1 - sumNew / sumOld) * 100).toFixed(1)}% 감소)`);
  assert.ok(sumNew < sumOld, '시점 8곳 합계 점 수가 줄어야 한다');
});

test('카메라 평면에 걸친 상자가 더는 무조건 단계 0 이 아니다(카메라 중심이 상자 밖이면 z_P·c_P)', () => {
  const cam = { width: 320, height: 180, K: { fx: 90, fy: 90, cx: 160, cy: 90 }, R: ID, t: [0, 0, 0] };
  const rule = screenErrorRule(cam, { thresholdPx: 0.5, edge0M: 0.05, levelCount: 8 });
  // 단계 수를 넉넉히(8, 칸 변 최대 6.4 m) 둬서 단계가 위로 잘리지 않는다: 잘못 거친 단계를 고르면 실제로 τ 를 넘는다.
  // 옆으로 놓였으나 z 가 −100~600 m 로 카메라 평면에 걸친 상자(화면 오른쪽 아래 모서리 부근만 보임)
  const mn = [300, 300, -100], mx = [600, 600, 600];
  assert.ok(boxMayBeVisible(cam, mn, mx));
  const e = rule.leaf(mn, mx);
  assert.equal(e.cosMin, 0);
  // P = 상자 ∩ V 의 cos 최솟값은 화면 모서리 광선 cos 이상
  assert.ok(e.visible && e.visible.cosMin >= viewMinCos(cam) * (1 - 1e-9));
  assert.ok(e.effDistM > 0 && e.level >= 1, `단계 ${e.level}, d_eff ${e.effDistM}`);
  // 카메라 중심이 상자 안이면 여전히 단계 0
  assert.equal(rule.leaf([-1, -1, -1], [1, 1, 1]).level, 0);
  // 칸 변 상한: 고른 단계의 격자 칸(상자로 자름) 변을 시야 사각뿔로 잘라 실제로 투영해 길이를 잰다(규칙 식을 되풀이하지 않음).
  // 표본: 보이는 부분의 가장 가까운 점 부근(화면 모서리 광선이 상자에 들어가는 곳, 가장 엄한 곳)과 상자 전체의 무작위 점.
  const edge = edgeOfLevel(0.05, e.level);
  const rnd = rng(31);
  const near = (() => { // 모서리 (320, 180) 광선 s·(1.778.., 1, 1) 이 y = 300 면에 닿는 점 (카메라 = 월드)
    const dx = (320 - 160) / 90, dy = (180 - 90) / 90;
    const s = 300 / dy;
    return [s * dx, 300, s];
  })();
  let worstPx = 0, cells = 0;
  for (let i = 0; i < 1500; i++) {
    const p = i < 1000
      ? [0, 1, 2].map((a) => Math.min(Math.max(near[a] + (rnd() - 0.5) * 6, mn[a]), mx[a]))
      : [0, 1, 2].map((a) => mn[a] + rnd() * (mx[a] - mn[a]));
    const lo = p.map((x, a) => Math.max(Math.floor(x / edge) * edge, mn[a]));
    const hi = p.map((x, a) => Math.min((Math.floor(x / edge) + 1) * edge, mx[a]));
    for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) {
      const x = a ^ b;
      if (x !== 1 && x !== 2 && x !== 4) continue;
      const A = [0, 1, 2].map((q) => (a >> q & 1 ? hi[q] : lo[q])), B = [0, 1, 2].map((q) => (b >> q & 1 ? hi[q] : lo[q]));
      const cl = clipToView(cam.K, cam.width, cam.height, toCam(cam, A), toCam(cam, B));
      if (!cl) continue;
      const at = (q) => [0, 1, 2].map((r) => A[r] + q * (B[r] - A[r]));
      const a0 = toCam(cam, at(cl[0])), a1 = toCam(cam, at(cl[1]));
      if (!(a0[2] > 0 && a1[2] > 0)) continue;
      const pr = (v) => [(cam.K.fx * v[0]) / v[2] + cam.K.cx, (cam.K.fy * v[1]) / v[2] + cam.K.cy];
      const q0 = pr(a0), q1 = pr(a1);
      worstPx = Math.max(worstPx, Math.hypot(q1[0] - q0[0], q1[1] - q0[1]));
      cells++;
    }
  }
  assert.ok(cells > 1000 && worstPx > 0, `표본 선분 ${cells}, 최대 ${worstPx}`);
  assert.ok(worstPx <= 0.5 + 1e-9, `실제 투영 칸 변 최대 ${worstPx} px > τ 0.5`);
});

test('visiblePartBound: 화면 모서리 광선이 cos 최솟값을 정하는 상자 (손계산 리터럴)', () => {
  // 200×200 화면, fx = fy = 100, 주점 (100, 100), R = I, t = 0, C = 원점. 시야는 |x| ≤ z, |y| ≤ z (모서리 광선 방향 (±1, ±1, 1)).
  // 상자 [50,100]×[0,70]×[10,200]. 상자 ∩ 시야 = {z ≥ x, z ≥ y} 부분(z = 10 쪽은 x ≥ 50 > z 라 시야 밖).
  //   z 최솟값: z ≥ x ≥ 50 이므로 50.
  //   cos α = z/|p| 의 최솟값: (x²+y²)/z² ≤ 2 (x ≤ z, y ≤ z), 같음은 x = y = z ∈ [50, 70] 에서 → cos = 1/√3.
  //   이 최솟값 점들은 상자 꼭짓점도, 상자 모서리 ∩ 시야 옆면도 아니다(모서리 후보 중 가장 작은 cos 는 (50,70,70) 의 70/√12300 ≈ 0.631).
  //   오직 화면 모서리 광선 (1,1,1)·s 가 상자 면 x = 50 에 들어가는 점 (50,50,50) 만이 1/√3 ≈ 0.577 을 준다.
  const cam = { width: 200, height: 200, K: { fx: 100, fy: 100, cx: 100, cy: 100 }, R: ID, t: [0, 0, 0] };
  const v = visiblePartBound(cam, [0, 0, 0], [50, 0, 10], [100, 70, 200]);
  assert.ok(v, 'P 가 비었음');
  // 구현은 경계 판정을 상대 1e-9 넓게 받아 최솟값이 아주 조금 작아질 뿐이다(보수적) → 허용 오차 1e-7.
  assert.ok(Math.abs(v.cosMin - 1 / Math.sqrt(3)) < 1e-7, `cosMin ${v.cosMin} ≠ ${1 / Math.sqrt(3)}`);
  assert.ok(Math.abs(v.zMinM - 50) < 50e-7, `zMinM ${v.zMinM} ≠ 50`);
});
