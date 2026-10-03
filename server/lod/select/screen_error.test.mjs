// F-097 ①③ 확인: 화면 모서리 리프에서도 고른 단계의 칸 변이 실제 투영으로 τ px 이하, f = max(fx, fy), 세 모듈 같은 규칙.
//
// 장면: 한 변 S = 6.4 m 정육면체 격자 점군(간격 0.2 m, 점은 칸 가운데 (i+½)·h 에 두고 두 맞모서리에 닻 점 2개).
//   닻 점으로 팔진 트리 뿌리가 정확히 [X0, X0+S]³ 가 되고 X0 는 최대 칸 변(0.8 m)의 배수라서, 리프 경계가 전역 격자선과 맞는다.
//   그래도 칸이 리프 상자 밖으로 나가는 부분(닻 점의 칸 등)은 점이 없으므로 칸을 리프 상자로 잘라 잰다.
// 카메라: R = I, t = 0(카메라 = 세계 원점, +z 를 봄). 정육면체 중심을 화면 왼쪽 위 모서리 광선(u = 0, v = 0) 위에 둔다.
// 두 설정(F-097 의 축 1a·2): ① 320×180·세로 화각 90°(fx = fy = 90), ② 960×540·fx = fy = 754.32.
// 세 번째 설정(F-102 ②): 회전(yaw 30°·pitch 20°)·t ≠ 0·fy = 2·fx·주점 cx, cy 가 화면 가운데가 아닌 카메라. 정육면체를 화면 모서리 광선 위(모서리 리프),
//   광축 위(광축을 걸친 리프), 카메라 평면 위(평면을 걸친 리프, 별도 시험)에 둔다. R = I 만 쓰면 minCosToAxis 의 꼭짓점 처리와
//   cameraCenter 의 Rᵀ 가 시험되지 않는다.
// 판별력: 같은 장면에서 옛 규칙(f = fx, d = 유클리드 최소 거리, cos² 보정 없음)으로 고른 단계는 칸 변이 τ 를 넘는 리프가 있음을 함께 단언한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NOT_DRAWN, edgeOfLevel } from '../../../contracts/lod/index.mjs';
import { buildHierarchy, selectLevels } from './index.mjs';
import { screenErrorRule, screenFocalPx, cameraCenter, boxDistanceM, minCosToAxis } from './screen_error.mjs';
import { leafTargets, selectWithBudget } from '../budget/index.mjs';
import { progressiveChunks } from '../progressive/index.mjs';
import { buildDistanceTable, levelForDistance } from '../distance_table/index.mjs';

const TAU = 0.5;
const EDGE0 = 0.05;
const LEVELS = 5; // 칸 변 0.05·0.1·0.2·0.4·0.8 m
const S = 6.4;
const H = 0.2;

function cubeCloud(center) {
  const cell = edgeOfLevel(EDGE0, LEVELS - 1);
  const X0 = center.map((c) => Math.round((c - S / 2) / cell) * cell);
  const m = Math.round(S / H);
  const pts = [];
  for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) for (let k = 0; k < m; k++) {
    pts.push(X0[0] + (i + 0.5) * H, X0[1] + (j + 0.5) * H, X0[2] + (k + 0.5) * H);
  }
  pts.push(X0[0], X0[1], X0[2], X0[0] + S, X0[1] + S, X0[2] + S);
  const n = pts.length / 3;
  const normals = new Float32Array(3 * n), colors = new Uint8Array(3 * n);
  for (let i = 0; i < n; i++) { normals[3 * i + 2] = 1; colors[3 * i] = i % 256; }
  return { format: 1, count: n, positions: Float32Array.from(pts), normals, colors };
}

const camera = (width, height, fx, fy = fx) => ({
  width, height, K: { fx, fy, cx: width / 2, cy: height / 2 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0],
});

/** R = Rx(pitch)·Ry(yaw) (행 우선), X_c = R·X_w + t. 주점 (cx, cy) 는 화면 가운데가 아니다. */
function generalCamera() {
  const yaw = (30 * Math.PI) / 180, pitch = (20 * Math.PI) / 180;
  const cy_ = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const Ry = [cy_, 0, sy, 0, 1, 0, -sy, 0, cy_];
  const Rx = [1, 0, 0, 0, cp, -sp, 0, sp, cp];
  const R = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) R[3 * i + j] += Rx[3 * i + k] * Ry[3 * k + j];
  return { width: 640, height: 360, K: { fx: 500, fy: 1000, cx: 400, cy: 120 }, R, t: [0.7, -1.3, 2.1] };
}

/** 화면 픽셀 (u, v) 광선 위 카메라에서 거리 D 인 점의 세계 좌표: X_w = Rᵀ·(D·d̂ − t). 기본은 왼쪽 위 모서리 (0, 0). */
function cornerPoint(cam, D, [u, v] = [0, 0]) {
  const { fx, fy, cx, cy } = cam.K;
  const d = [(u - cx) / fx, (v - cy) / fy, 1];
  const n = Math.hypot(...d);
  const Xc = d.map((c, i) => (c / n) * D - cam.t[i]);
  const { R } = cam;
  return [0, 1, 2].map((a) => R[a] * Xc[0] + R[3 + a] * Xc[1] + R[6 + a] * Xc[2]);
}

function project(cam, X) {
  const { R, t, K } = cam;
  const x = R[0] * X[0] + R[1] * X[1] + R[2] * X[2] + t[0];
  const y = R[3] * X[0] + R[4] * X[1] + R[5] * X[2] + t[1];
  const z = R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + t[2];
  assert.ok(z > 0, '칸 꼭짓점이 카메라 앞');
  return [(K.fx * x) / z + K.cx, (K.fy * y) / z + K.cy];
}

const EDGES = [];
for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) { const x = a ^ b; if (x === 1 || x === 2 || x === 4) EDGES.push([a, b]); }

/** 리프 k 를 단계 l 로 그릴 때, 그 리프 대표점들의 칸(리프 상자로 자름) 변의 최대 화면 길이(px). */
function maxCellEdgePx(h, cam, node, k, l) {
  const lv = h.levels[l];
  const e = lv.edgeM;
  const bmin = h.octree.boxMin.subarray(3 * node, 3 * node + 3);
  const bmax = h.octree.boxMax.subarray(3 * node, 3 * node + 3);
  let worst = 0;
  for (let s = lv.leafStart[k]; s < lv.leafStart[k + 1]; s++) {
    const i = lv.indices[s];
    const lo = [0, 0, 0], hi = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      const c = Math.floor(h.cloud.positions[3 * i + a] / e);
      lo[a] = Math.max(c * e, bmin[a]);
      hi[a] = Math.min((c + 1) * e, bmax[a]);
    }
    const P = [];
    for (let v = 0; v < 8; v++) P.push(project(cam, [v & 1 ? hi[0] : lo[0], v & 2 ? hi[1] : lo[1], v & 4 ? hi[2] : lo[2]]));
    for (const [a, b] of EDGES) worst = Math.max(worst, Math.hypot(P[a][0] - P[b][0], P[a][1] - P[b][1]));
  }
  return worst;
}

/** 리프 상자가 광축 위 거리 [D − S, D + S] 구간의 점 하나라도 포함하는가(광축을 걸친 리프). */
function containsAxis(h, n, cam, D) {
  const mn = h.octree.boxMin.subarray(3 * n, 3 * n + 3), mx = h.octree.boxMax.subarray(3 * n, 3 * n + 3);
  for (let q = -S; q <= S; q += 0.05) {
    const P = cornerPoint(cam, D + q, [cam.K.cx, cam.K.cy]);
    if ([0, 1, 2].every((a) => P[a] >= mn[a] && P[a] <= mx[a])) return true;
  }
  return false;
}

function leafNodeOf(h) {
  const m = new Int32Array(h.octree.leafCount);
  for (let n = 0; n < h.octree.nodeCount; n++) if (h.octree.leafIndex[n] >= 0) m[h.octree.leafIndex[n]] = n;
  return m;
}

/** 옛 규칙(F-097 이전): f = fx, d = 상자 최소 거리, 보정 없음. */
function oldLevel(h, cam, node) {
  const table = buildDistanceTable({ fx: cam.K.fx, thresholdPx: TAU, edge0M: EDGE0, levelCount: LEVELS });
  const mn = h.octree.boxMin.subarray(3 * node, 3 * node + 3), mx = h.octree.boxMax.subarray(3 * node, 3 * node + 3);
  const d = boxDistanceM(cameraCenter(cam), mn, mx);
  return d > 0 ? levelForDistance(table, d) : 0;
}

const GEN = generalCamera();
const SETTINGS = [
  { name: '320×180 세로 화각 90° (fx = fy = 90)', cam: camera(320, 180, 90), D: 150, cosBelow: 0.5 },
  { name: '960×540 fx = fy = 754.32', cam: camera(960, 540, 754.32), D: 700, cosBelow: 0.85 },
  { name: '회전 yaw 30°·pitch 20°, t ≠ 0, fy = 2fx, 주점 비중심: 모서리 (0, 360)', cam: GEN, D: 700, cosBelow: 0.8, pixel: [0, 360] },
  { name: '같은 일반 카메라: 광축을 걸친 리프', cam: GEN, D: 400, cosBelow: 1.01, pixel: [400, 120], axis: true },
];

for (const { name, cam, D, cosBelow, pixel, axis } of SETTINGS) {
  test(`화면 모서리 리프의 칸 변 ≤ τ px (실제 투영), ${name}`, (t) => {
    const aim = cornerPoint(cam, D, pixel);
    const h = buildHierarchy(cubeCloud(aim), { edge0M: EDGE0, levelCount: LEVELS, maxLeafPoints: 64 });
    assert.ok(h.octree.leafCount >= 64, `리프 수 ${h.octree.leafCount}`);
    const node = leafNodeOf(h);
    const rule = screenErrorRule(cam, { thresholdPx: TAU, edge0M: EDGE0, levelCount: LEVELS });
    const sel = selectLevels(h, cam, { thresholdPx: TAU });
    let onAxis = 0, checked = 0, cornerChecked = 0, oldOver = 0, worstNew = 0, worstOld = 0;
    for (let k = 0; k < h.octree.leafCount; k++) {
      const l = sel.leafLevel[k];
      if (l === NOT_DRAWN || l === 0) continue; // 단계 0 은 원본(칸 없음)
      if (axis) onAxis += containsAxis(h, node[k], cam, D) ? 1 : 0;
      const n = node[k];
      const px = maxCellEdgePx(h, cam, n, k, l);
      worstNew = Math.max(worstNew, px);
      assert.ok(px <= TAU + 1e-9, `리프 ${k} 단계 ${l}: 칸 변 ${px.toFixed(4)} px > τ ${TAU}`);
      checked++;
      const { cosMin } = rule.leaf(h.octree.boxMin.subarray(3 * n, 3 * n + 3), h.octree.boxMax.subarray(3 * n, 3 * n + 3));
      if (cosMin < cosBelow) cornerChecked++;
      const lo = oldLevel(h, cam, n);
      if (lo > 0) {
        const pxOld = maxCellEdgePx(h, cam, n, k, lo);
        worstOld = Math.max(worstOld, pxOld);
        if (pxOld > TAU) oldOver++;
      }
    }
    assert.ok(cornerChecked >= 8, `모서리(cos α < ${cosBelow}) 리프 중 단계 ≥ 1 로 검사한 수 ${cornerChecked}`);
    assert.ok(checked >= cornerChecked);
    if (axis) assert.ok(onAxis >= 1, `광축 선분 위에 상자가 걸친 채 단계 ≥ 1 로 검사한 리프 ${onAxis}`);
    // 판별력: 옛 규칙이면 τ 를 넘는 칸이 생긴다(이 장면이 F-097 ① 을 실제로 드러냄).
    assert.ok(oldOver > 0 && worstOld > TAU, `옛 규칙 최대 ${worstOld.toFixed(3)} px, 넘는 리프 ${oldOver}`);
    assert.ok(worstNew <= TAU);
    t.diagnostic(`검사 리프 ${checked}(모서리 ${cornerChecked}), 새 규칙 최대 칸 변 ${worstNew.toFixed(3)} px, 옛 규칙 최대 ${worstOld.toFixed(3)} px(τ 초과 리프 ${oldOver})`);
  });
}

test('fy = 2·fx 카메라가 fx = fy 카메라보다 더 고운 단계를 고른다(select·budget·progressive)', () => {
  const base = camera(320, 180, 90);
  const tall = { ...base, K: { ...base.K, fy: 180 } };
  assert.equal(screenFocalPx(tall.K), 180);
  const h = buildHierarchy(cubeCloud([0, 0, 200]), { edge0M: EDGE0, levelCount: LEVELS, maxLeafPoints: 64 });
  const a = selectLevels(h, base, { thresholdPx: TAU }).leafLevel;
  const b = selectLevels(h, tall, { thresholdPx: TAU }).leafLevel;
  const ta = leafTargets(h, base, TAU).target, tb = leafTargets(h, tall, TAU).target;
  const lastLevel = (chunks) => { const m = new Map(); for (const c of chunks) m.set(c.leaf, c.level); return m; };
  const pa = lastLevel(progressiveChunks(h, base, { thresholdPx: TAU })), pb = lastLevel(progressiveChunks(h, tall, { thresholdPx: TAU }));
  let both = 0, finer = 0, finerB = 0, finerP = 0;
  for (let k = 0; k < h.octree.leafCount; k++) {
    assert.notEqual(a[k], NOT_DRAWN, `리프 ${k} fx = fy 카메라에서 그려짐`);
    assert.notEqual(b[k], NOT_DRAWN, `리프 ${k} fy = 2fx 카메라에서 그려짐`);
    both++;
    assert.ok(b[k] <= a[k], `리프 ${k}: fy=2fx 단계 ${b[k]} > ${a[k]}`);
    if (b[k] < a[k]) finer++;
    assert.ok(tb[k] <= ta[k]);
    if (tb[k] < ta[k]) finerB++;
    // 칸 키가 (리프, 칸) 이라 어떤 단계든 리프마다 대표점이 있고 progressive 조각이 있다(F-097 ②).
    assert.ok(pa.has(k) && pb.has(k), `리프 ${k}: progressive 조각 없음`);
    assert.ok(pb.get(k) <= pa.get(k));
    if (pb.get(k) < pa.get(k)) finerP++;
  }
  assert.ok(both > 0 && finer > 0 && finerB > 0 && finerP > 0, `공통 ${both}, 더 고움 select ${finer} budget ${finerB} progressive ${finerP}`);
});

test('세 모듈이 같은 리프 단계 규칙을 쓴다(모서리 장면, 예산 충분)', () => {
  for (const { cam, D } of SETTINGS) {
    const h = buildHierarchy(cubeCloud(cornerPoint(cam, D)), { edge0M: EDGE0, levelCount: LEVELS, maxLeafPoints: 64 });
    const sel = selectLevels(h, cam, { thresholdPx: TAU });
    const bud = selectWithBudget(h, cam, { thresholdPx: TAU, budgetPoints: h.cloud.count });
    const prog = new Map();
    for (const c of progressiveChunks(h, cam, { thresholdPx: TAU })) prog.set(c.leaf, c.level);
    let drawn = 0;
    for (let k = 0; k < h.octree.leafCount; k++) {
      assert.equal(bud.leafLevel[k], sel.leafLevel[k], `budget 리프 ${k}`);
      const l = sel.leafLevel[k];
      if (l === NOT_DRAWN) { assert.ok(!prog.has(k)); continue; }
      // 칸 키가 (리프, 칸) 이므로 그려지는 리프는 그 단계에 대표점이 하나 이상 있다(F-097 ②). 비면 빈자리.
      assert.ok(h.levels[l].leafStart[k + 1] > h.levels[l].leafStart[k], `리프 ${k} 단계 ${l} 대표점 0 개`);
      drawn++;
      assert.equal(prog.get(k), sel.leafLevel[k], `progressive 리프 ${k}`);
    }
    assert.ok(drawn > 0);
  }
});

test('카메라 평면(z_c = 0)을 걸친 리프는 원본 단계 0 이고, 앞쪽 리프의 칸 변은 ≤ τ (일반 카메라)', (ctx) => {
  const cam = GEN;
  // 카메라 좌표 (300, 0, 0) 가 정육면체 중심: 평면 z_c = 0 이 정육면체를 가른다.
  const { R, t } = cam;
  const Xc = [300 - t[0], -t[1], -t[2]];
  const center = [0, 1, 2].map((a) => R[a] * Xc[0] + R[3 + a] * Xc[1] + R[6 + a] * Xc[2]);
  const h = buildHierarchy(cubeCloud(center), { edge0M: EDGE0, levelCount: LEVELS, maxLeafPoints: 64 });
  const node = leafNodeOf(h);
  const sel = selectLevels(h, cam, { thresholdPx: TAU });
  const rule = screenErrorRule(cam, { thresholdPx: TAU, edge0M: EDGE0, levelCount: LEVELS });
  let straddle = 0, front = 0;
  for (let k = 0; k < h.octree.leafCount; k++) {
    const n = node[k];
    const mn = h.octree.boxMin.subarray(3 * n, 3 * n + 3), mx = h.octree.boxMax.subarray(3 * n, 3 * n + 3);
    let zMin = Infinity, zMax = -Infinity;
    for (let v = 0; v < 8; v++) {
      const z = R[6] * (v & 1 ? mx[0] : mn[0]) + R[7] * (v & 2 ? mx[1] : mn[1]) + R[8] * (v & 4 ? mx[2] : mn[2]) + t[2];
      zMin = Math.min(zMin, z); zMax = Math.max(zMax, z);
    }
    const l = sel.leafLevel[k];
    if (zMin <= 0 && zMax > 0) {
      straddle++;
      // 시야 밖이면 select 가 NOT_DRAWN 으로 거르므로, 규칙 자체(rule.leaf)도 따로 본다.
      assert.equal(rule.leaf(mn, mx).level, 0, `평면을 걸친 리프 ${k}: 규칙 단계 (z_c in [${zMin.toFixed(2)}, ${zMax.toFixed(2)}])`);
      assert.ok(l === 0 || l === NOT_DRAWN, `평면을 걸친 리프 ${k}: select 단계 ${l}`);
    } else if (zMin > 0 && l !== NOT_DRAWN && l > 0) {
      front++;
      const px = maxCellEdgePx(h, cam, n, k, l);
      assert.ok(px <= TAU + 1e-9, `앞쪽 리프 ${k} 단계 ${l}: 칸 변 ${px.toFixed(4)} px > tau`);
    }
  }
  assert.ok(straddle >= 1, `평면을 걸친 리프 ${straddle}`);
  ctx.diagnostic(`걸친 ${straddle}, 앞쪽 단계>0 ${front}`);
});

/** 구현과 따로 쓴 기준: 상자 8 꼭짓점의 cos α = z_c / |p_c| 최솟값(어느 꼭짓점이든 z_c <= 0 이면 0). */
function bruteMinCos({ R, t }, mn, mx) {
  let c = Infinity;
  for (let v = 0; v < 8; v++) {
    const X = [v & 1 ? mx[0] : mn[0], v & 2 ? mx[1] : mn[1], v & 4 ? mx[2] : mn[2]];
    const p = [0, 1, 2].map((r) => R[3 * r] * X[0] + R[3 * r + 1] * X[1] + R[3 * r + 2] * X[2] + t[r]);
    if (!(p[2] > 0)) return 0;
    c = Math.min(c, p[2] / Math.hypot(...p));
  }
  return c;
}

test('회전·이동 카메라: cameraCenter 는 카메라 원점의 세계 좌표(R·C + t = 0), minCosToAxis 는 8 꼭짓점 최솟값', () => {
  for (const { name, cam, D, pixel } of SETTINGS) {
    const C = cameraCenter(cam);
    const o = [0, 1, 2].map((r) => cam.R[3 * r] * C[0] + cam.R[3 * r + 1] * C[1] + cam.R[3 * r + 2] * C[2] + cam.t[r]);
    for (const v of o) assert.ok(Math.abs(v) < 1e-12, `${name}: R·C + t = ${o}`);
    const h = buildHierarchy(cubeCloud(cornerPoint(cam, D, pixel)), { edge0M: EDGE0, levelCount: LEVELS, maxLeafPoints: 64 });
    const node = leafNodeOf(h);
    let positive = 0;
    for (let k = 0; k < h.octree.leafCount; k++) {
      const mn = h.octree.boxMin.subarray(3 * node[k], 3 * node[k] + 3), mx = h.octree.boxMax.subarray(3 * node[k], 3 * node[k] + 3);
      const got = minCosToAxis(cam, mn, mx), want = bruteMinCos(cam, mn, mx);
      assert.ok(Math.abs(got - want) < 1e-12, `${name} 리프 ${k}: cMin ${got} != ${want}`);
      // 상자 안 점의 cos α 는 cMin 이상(원뿔의 볼록성).
      for (let q = 0; q < 8; q++) {
        const X = [0, 1, 2].map((a) => mn[a] + ((q * 0.37 + a * 0.29 + 0.11) % 1) * (mx[a] - mn[a]));
        const p = [0, 1, 2].map((r) => cam.R[3 * r] * X[0] + cam.R[3 * r + 1] * X[1] + cam.R[3 * r + 2] * X[2] + cam.t[r]);
        if (got > 0) assert.ok(p[2] / Math.hypot(...p) >= got - 1e-12);
      }
      if (want > 0) positive++;
    }
    assert.ok(positive > 0, name);
  }
});
