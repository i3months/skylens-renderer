// F-097 ①③ 확인: 화면 모서리 리프에서도 고른 단계의 칸 변이 실제 투영으로 τ px 이하, f = max(fx, fy), 세 모듈 같은 규칙.
//
// 장면: 한 변 S = 6.4 m 정육면체 격자 점군(간격 0.2 m, 점은 칸 가운데 (i+½)·h 에 두고 두 맞모서리에 닻 점 2개).
//   닻 점으로 팔진 트리 뿌리가 정확히 [X0, X0+S]³ 가 되고 X0 는 최대 칸 변(0.8 m)의 배수라서, 리프 경계가 전역 격자선과 맞는다.
//   그래도 칸이 리프 상자 밖으로 나가는 부분(닻 점의 칸 등)은 점이 없으므로 칸을 리프 상자로 잘라 잰다.
// 카메라: R = I, t = 0(카메라 = 세계 원점, +z 를 봄). 정육면체 중심을 화면 왼쪽 위 모서리 광선(u = 0, v = 0) 위에 둔다.
// 두 설정(F-097 의 축 1a·2): ① 320×180·세로 화각 90°(fx = fy = 90), ② 960×540·fx = fy = 754.32.
// 판별력: 같은 장면에서 옛 규칙(f = fx, d = 유클리드 최소 거리, cos² 보정 없음)으로 고른 단계는 칸 변이 τ 를 넘는 리프가 있음을 함께 단언한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NOT_DRAWN, edgeOfLevel } from '../../../contracts/lod/index.mjs';
import { buildHierarchy, selectLevels } from './index.mjs';
import { screenErrorRule, screenFocalPx, cameraCenter, boxDistanceM, minCosToAxis, effectiveDistance } from './screen_error.mjs';
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
// F-102 ②: 회전(yaw 30°·pitch 20°)·t ≠ 0·fy = 2·fx·주점이 중심이 아닌 카메라.
const generalCamera = () => ({
  width: 640, height: 360, K: { fx: 400, fy: 800, cx: 200, cy: 100 }, R: rotation(30, 20), t: [1.5, -2, 3],
});

/** 카메라 좌표계에서 화면 점 (u, v) 광선 위 거리 D 의 점. */
function rayPointCam(cam, u, v, D) {
  const { fx, fy, cx, cy } = cam.K;
  const d = [(u - cx) / fx, (v - cy) / fy, 1];
  const n = Math.hypot(...d);
  return d.map((c) => (c / n) * D);
}

/** 카메라 좌표 점 → 세계 좌표(X_w = Rᵀ·(X_c − t)). */
function camToWorld({ R, t }, Xc) {
  const q = [Xc[0] - t[0], Xc[1] - t[1], Xc[2] - t[2]];
  return [0, 1, 2].map((a) => R[a] * q[0] + R[3 + a] * q[1] + R[6 + a] * q[2]);
}

/** 화면 왼쪽 위 모서리(u = 0, v = 0) 광선 위 거리 D 의 점(세계 좌표). */
const cornerPoint = (cam, D) => camToWorld(cam, rayPointCam(cam, 0, 0, D));

/** R = Rx(pitch)·Ry(yaw) (행 우선). 각은 도. */
function rotation(yawDeg, pitchDeg) {
  const y = (yawDeg * Math.PI) / 180, p = (pitchDeg * Math.PI) / 180;
  const cy = Math.cos(y), sy = Math.sin(y), cp = Math.cos(p), sp = Math.sin(p);
  const Ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const Rx = [1, 0, 0, 0, cp, -sp, 0, sp, cp];
  const m = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) m[3 * i + j] += Rx[3 * i + k] * Ry[3 * k + j];
  return m;
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

const R0 = camera(320, 180, 90), R1 = camera(960, 540, 754.32), G = generalCamera();
// center = 정육면체 중심(세계 좌표). cosBelow: cos α 가 이보다 작은 리프를 '모서리' 로 센다.
// 옛 규칙이 τ 를 넘는 장면이어야 한다(옛 규칙 최대 칸 변이 τ 초과인지는 아래에서 단언한다).
// 새 규칙 최대 칸 변의 하한 TAU/2 (측정값에 맞춘 수가 아니라 이론 하한):
//   거리표는 단계 l 마다 칸 변이 2 배(e_l = edge0·2^l)이고, 고른 단계 l 은 f·e_l/d_eff ≤ τ 를 만족하는 가장 거친 단계다
//   (최상위 단계가 아닐 때). 그래서 한 단계 더 거친 l+1 은 f·e_{l+1}/d_eff > τ, 즉 f·e_l/d_eff > τ/2 이다.
//   정면 가까이 보이는 리프에서는 투영 칸 변이 이 값에 근접하므로, 장면 전체의 최대는 τ/2 보다 작을 수 없다고 본다.
//   이 하한은 '한 단계 더 고운 단계를 고르는' 변이(최대 칸 변이 약 절반)를 잡는 용도이며, 시험이 비지 않았음도 보인다.
const SETTINGS = [
  { name: '320×180 세로 화각 90° (fx = fy = 90)', cam: R0, center: cornerPoint(R0, 150), cosBelow: 0.5, minWorstPx: TAU / 2 },
  { name: '960×540 fx = fy = 754.32', cam: R1, center: cornerPoint(R1, 700), cosBelow: 0.85, minWorstPx: TAU / 2 },
  { name: '회전 yaw 30°·pitch 20°, t ≠ 0, fx 400·fy 800, 주점 (200, 100), 왼쪽 위 모서리', cam: G, center: cornerPoint(G, 600), cosBelow: 0.9, minWorstPx: TAU / 2 },
  { name: '같은 일반 카메라, 광축을 걸친 큐브(카메라 좌표 (0, 0, 300))', cam: G, center: camToWorld(G, [0, 0, 300]), cosBelow: 1.01, minWorstPx: TAU / 2 },
];

/** 상자 8 꼭짓점의 카메라 좌표 z 최솟값·최댓값. */
function zRange({ R, t }, mn, mx) {
  let lo = Infinity, hi = -Infinity;
  for (let v = 0; v < 8; v++) {
    const X = v & 1 ? mx[0] : mn[0], Y = v & 2 ? mx[1] : mn[1], Z = v & 4 ? mx[2] : mn[2];
    const z = R[6] * X + R[7] * Y + R[8] * Z + t[2];
    lo = Math.min(lo, z); hi = Math.max(hi, z);
  }
  return [lo, hi];
}

for (const { name, cam, center, cosBelow, minWorstPx } of SETTINGS) {
  test(`화면 모서리 리프의 칸 변 ≤ τ px (실제 투영), ${name}`, (t) => {
    const h = buildHierarchy(cubeCloud(center), { edge0M: EDGE0, levelCount: LEVELS, maxLeafPoints: 64 });
    assert.ok(h.octree.leafCount >= 64, `리프 수 ${h.octree.leafCount}`);
    const node = leafNodeOf(h);
    const rule = screenErrorRule(cam, { thresholdPx: TAU, edge0M: EDGE0, levelCount: LEVELS });
    // 카메라 중심은 카메라 좌표 원점: R·C + t = 0 (C = −Rᵀt; Rᵀ→R 변이면 R ≠ I 카메라에서 어긋난다)
    const [cx0, cy0, cz0] = [0, 1, 2].map((r) => cam.R[3 * r] * rule.center[0] + cam.R[3 * r + 1] * rule.center[1] + cam.R[3 * r + 2] * rule.center[2] + cam.t[r]);
    assert.ok(Math.hypot(cx0, cy0, cz0) < 1e-9, `R·C + t = (${cx0}, ${cy0}, ${cz0})`);
    const sel = selectLevels(h, cam, { thresholdPx: TAU });
    let checked = 0, cornerChecked = 0, oldOver = 0, worstNew = 0, worstOld = 0;
    for (let k = 0; k < h.octree.leafCount; k++) {
      const l = sel.leafLevel[k];
      if (l === NOT_DRAWN || l === 0) continue; // 단계 0 은 원본(칸 없음)
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
    // 판별력: 옛 규칙이면 τ 를 넘는 칸이 생긴다(이 장면이 F-097 ① 을 실제로 드러냄).
    assert.ok(oldOver > 0 && worstOld > TAU, `옛 규칙 최대 ${worstOld.toFixed(3)} px, 넘는 리프 ${oldOver}`);
    assert.ok(worstNew <= TAU && worstNew >= minWorstPx, `새 규칙 최대 칸 변 ${worstNew} 가 [${minWorstPx}, ${TAU}] 밖`);
    t.diagnostic(`검사 리프 ${checked}(모서리 ${cornerChecked}), 새 규칙 최대 칸 변 ${worstNew.toFixed(3)} px, 옛 규칙 최대 ${worstOld.toFixed(3)} px(τ 초과 리프 ${oldOver})`);
  });
}

test('카메라 평면을 걸친 리프는 단계 0, 그 밖의 칸 변은 ≤ τ (카메라 중심이 큐브 안, 일반 카메라)', () => {
  const cam = generalCamera();
  const h = buildHierarchy(cubeCloud(camToWorld(cam, [0.3, 0.2, 0])), { edge0M: EDGE0, levelCount: LEVELS, maxLeafPoints: 64 });
  const node = leafNodeOf(h);
  const sel = selectLevels(h, cam, { thresholdPx: TAU });
  let straddle = 0, straddleDrawn = 0, inside = 0, coarse = 0;
  for (let k = 0; k < h.octree.leafCount; k++) {
    const mn = h.octree.boxMin.subarray(3 * node[k], 3 * node[k] + 3), mx = h.octree.boxMax.subarray(3 * node[k], 3 * node[k] + 3);
    const [zLo, zHi] = zRange(cam, mn, mx);
    const l = sel.leafLevel[k];
    if (zLo <= 0 && zHi > 0) {
      straddle++;
      assert.equal(minCosToAxis(cam, mn, mx) <= 0, true, `리프 ${k}: 평면을 걸쳤는데 cMin > 0`);
      assert.ok(l === NOT_DRAWN || l === 0, `리프 ${k}: 평면을 걸친 리프의 단계 ${l}`);
      if (l === 0 && boxDistanceM(cameraCenter(cam), mn, mx) > 0) straddleDrawn++; // 카메라가 든 리프는 제외(그것은 항상 단계 0)
    } else if (l !== NOT_DRAWN && l > 0) {
      coarse++;
      assert.ok(maxCellEdgePx(h, cam, node[k], k, l) <= TAU + 1e-9);
    }
    if (boxDistanceM(cameraCenter(cam), mn, mx) === 0) { inside++; assert.equal(l, 0); }
  }
  // 개수는 팔진트리 분할이 정하는 값이라 이론값이 없다(측정은 걸침 126·그려진 걸침 6). 그래서 '> 0' 만 단언한다:
  // 걸친 리프가 있어야 위 단언들이 비지 않고, 그중 카메라가 들지 않았는데도 그려진(단계 0) 것이 있어야 NOT_DRAWN 으로 통째 빠진 장면이 아니다.
  // 카메라 중심 (0.3, 0.2, 0) 은 한 리프 상자 안에 있도록 만들었으므로 카메라 포함 리프는 정확히 1 이다.
  assert.ok(straddle > 0 && straddleDrawn > 0 && inside === 1, `걸침 ${straddle}, 그려진 걸침 ${straddleDrawn}, 카메라 포함 ${inside}, 거친 ${coarse}`);
});

test('cameraCenter = −Rᵀ·t (손계산 리터럴)', () => {
  // R = z축 90° 회전 [[0,−1,0],[1,0,0],[0,0,1]], t = (1,2,3): Rᵀt = (2,−1,3) → C = (−2, 1, −3). (R·t 였다면 (2,−1,−3))
  assert.deepEqual(cameraCenter({ R: [0, -1, 0, 1, 0, 0, 0, 0, 1], t: [1, 2, 3] }), [-2, 1, -3]);
});

test('minCosToAxis 는 8 꼭짓점 전부를 본다 (손계산 리터럴; 꼭짓점 4개만 보면 틀림)', () => {
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1], F = [1, 0, 0, 0, -1, 0, 0, 0, -1]; // F: z = −Z
  const t0 = [0, 0, 0];
  // 최솟값이 Z 큰 꼭짓점: F 에서 Z ∈ [−3,−1] → z ∈ [1,3], 최소는 z=1, (1,1) → 1/√3
  assert.ok(Math.abs(minCosToAxis({ R: F, t: t0 }, [-1, -1, -3], [1, 1, -1]) - 1 / Math.sqrt(3)) < 1e-12);
  // 최솟값이 Z 작은 꼭짓점: I 에서 Z ∈ [1,3]
  assert.ok(Math.abs(minCosToAxis({ R: I, t: t0 }, [-1, -1, 1], [1, 1, 3]) - 1 / Math.sqrt(3)) < 1e-12);
  // 최솟값이 X 큰 꼭짓점: x ∈ [0.5, 2], y ∈ [−1, 1], z ∈ [1, 3] → (2, ±1, 1) → 1/√6
  assert.ok(Math.abs(minCosToAxis({ R: I, t: t0 }, [0.5, -1, 1], [2, 1, 3]) - 1 / Math.sqrt(6)) < 1e-12);
  // 최솟값이 Y 작은 꼭짓점: (1, −2, 1) → 1/√6
  assert.ok(Math.abs(minCosToAxis({ R: I, t: t0 }, [-1, -2, 1], [1, 0.5, 3]) - 1 / Math.sqrt(6)) < 1e-12);
  // 카메라 평면을 걸치면 0 이하 → effDist 0
  assert.ok(minCosToAxis({ R: I, t: t0 }, [-1, -1, -1], [1, 1, 1]) <= 0);
  const e = effectiveDistance({ R: I, t: t0 }, [0, 0, 0], [5, 5, -1], [6, 6, 1]);
  assert.equal(e.effDistM, 0);
  // d_eff = d·cMin²: 상자 [−1,1]²×[3,5] 와 C=(0,0,0): d = 3, cMin = 3/√11 → 3·9/11
  const e2 = effectiveDistance({ R: I, t: t0 }, [0, 0, 0], [-1, -1, 3], [1, 1, 5]);
  assert.ok(Math.abs(e2.effDistM - 27 / 11) < 1e-12, String(e2.effDistM));
});

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
    if (a[k] === NOT_DRAWN || b[k] === NOT_DRAWN) continue;
    both++;
    assert.ok(b[k] <= a[k], `리프 ${k}: fy=2fx 단계 ${b[k]} > ${a[k]}`);
    if (b[k] < a[k]) finer++;
    assert.ok(tb[k] <= ta[k]);
    if (tb[k] < ta[k]) finerB++;
    // 칸 키가 (리프, 칸) 이므로 그려지는 리프는 모든 단계에 대표점이 있고 progressive 가 그 리프 조각을 만든다(F-097 ②).
    assert.ok(pa.has(k) && pb.has(k), `리프 ${k}: progressive 조각 없음`);
    assert.ok(pb.get(k) <= pa.get(k));
    if (pb.get(k) < pa.get(k)) finerP++;
  }
  assert.ok(both > 0 && finer > 0 && finerB > 0 && finerP > 0, `공통 ${both}, 더 고움 select ${finer} budget ${finerB} progressive ${finerP}`);
});

test('세 모듈이 같은 리프 단계 규칙을 쓴다(모서리 장면, 예산 충분)', () => {
  for (const { cam, center } of SETTINGS) {
    const h = buildHierarchy(cubeCloud(center), { edge0M: EDGE0, levelCount: LEVELS, maxLeafPoints: 64 });
    const sel = selectLevels(h, cam, { thresholdPx: TAU });
    const bud = selectWithBudget(h, cam, { thresholdPx: TAU, budgetPoints: h.cloud.count });
    const prog = new Map();
    for (const c of progressiveChunks(h, cam, { thresholdPx: TAU })) prog.set(c.leaf, c.level);
    let drawn = 0;
    for (let k = 0; k < h.octree.leafCount; k++) {
      assert.equal(bud.leafLevel[k], sel.leafLevel[k], `budget 리프 ${k}`);
      const l = sel.leafLevel[k];
      if (l === NOT_DRAWN) { assert.ok(!prog.has(k)); continue; }
      // 칸 키가 (리프, 칸) 이라 점이 있는 리프는 어느 단계에서도 대표점이 1 개 이상이다(F-097 ②). 비면 조각이 빠진 것.
      assert.ok(h.levels[l].leafStart[k + 1] > h.levels[l].leafStart[k], `리프 ${k} 단계 ${l}: 대표점 0 개`);
      drawn++;
      assert.equal(prog.get(k), sel.leafLevel[k], `progressive 리프 ${k}`);
    }
    assert.ok(drawn > 0);
  }
});
