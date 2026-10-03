// 조각 우선순위(T08.6). 남은 리프를 '화면에 기여하는 정도' 큰 순서로 늘어놓는다(먼저 보낼수록 화면이 빨리 차오른다).
// 새 점을 만들지 않고 리프 번호만 다룬다. 좌표는 GeoAnchor 기준 ENU, 1 unit = 1 m. 카메라는 contracts/raster 의 Camera.
//
// 점수 식(근거). 상자 투영 면적만으로는 가려진 리프(높은 상자 밑 바닥)와 성긴 리프를 못 가려 top_down 에서 순위상관이 0.1~0.5 에 그쳤다(실측).
//   그래서 '가려짐까지 반영한 예상 차지 픽셀'을 단계 0 점으로 구한다(거친 단계 대표점은 성긴 곳을 빈 곳으로 오판해 합성 3종×8시점 순위상관 최저 0.47~0.68 이었고, 단계 0 + 1/2 해상도에서 최저 0.73):
//   점을 1/2 해상도(SCALE)로 투영해 거친 깊이 버퍼에 원판으로 그리고(가까운 점이 이김, 동률은 번호 작은 점),
//   리프마다 이긴 칸 수 ÷ SCALE² 를 '예상 차지 픽셀' 로 삼는다. 카메라 뒤·시야 밖 점은 건너뛰므로 그 리프는 0 이고,
//   가까울수록 원판이 커서 많이 차지하며, 화면 가장자리는 잘려 줄어든다. 원판 반지름은 단계 0 칸 한 변(edge0M)의 투영 반폭(최소 0.5 칸). 비용: 점 수에 비례(점마다 투영 1회).
//   새 점은 만들지 않는다(기존 대표점만 쓴다).
//   동률 완화: 예상 차지 픽셀이 같은 리프(대개 0)는 상자 투영 경계상자 ∩ 화면 면적 A 로 가른다(보조 항, 항상 < 0.5 px 상당).
//   상자는 근평면으로 잘라 카메라 뒤로 걸친 경우도 보이는 부분만 센다.
// 퇴화 시점(카메라가 유한하지 않거나 해상도·초점거리 ≤ 0): 던지지 않고 전부 0 점수 / 빈 목록.
// 입력 오류(계층·마스크)는 'cull:' 오류.

import { degenerateCamera } from '../degenerate/index.mjs';

const ERR = 'cull:';
const NEAR_M = 0.01;
const SCALE = 0.5; // 거친 깊이 버퍼 해상도 비율(기본)
const MAX_COARSE_CELLS = 4_000_000; // 거친 버퍼 칸 수 상한: 큰 해상도에서는 비율을 줄여 시간·메모리를 묶는다(F-120)

function assertHierarchy(h) {
  const oc = h?.octree;
  if (!oc || !Number.isInteger(oc.leafCount) || oc.leafCount < 0 || !(oc.leafStart instanceof Uint32Array)
    || !oc.leafIndex || !oc.boxMin || !oc.boxMax || oc.leafStart.length !== oc.leafCount + 1) {
    throw new Error(`${ERR} 계층(octree)이 올바르지 않음`);
  }
}

/** 리프 상자 8 꼭짓점의 카메라 좌표 → 근평면 절단 → 투영 경계상자 ∩ 화면 면적. 안 보이면 0. */
function clippedArea(camera, mn, mx, out) {
  const { K, R, t, width: W, height: H } = camera;
  const P = out;
  for (let k = 0; k < 8; k++) {
    const X = k & 1 ? mx[0] : mn[0], Y = k & 2 ? mx[1] : mn[1], Z = k & 4 ? mx[2] : mn[2];
    P[3 * k] = R[0] * X + R[1] * Y + R[2] * Z + t[0];
    P[3 * k + 1] = R[3] * X + R[4] * Y + R[5] * Z + t[1];
    P[3 * k + 2] = R[6] * X + R[7] * Y + R[8] * Z + t[2];
  }
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  const add = (x, y, z) => {
    const u = K.fx * x / z + K.cx, v = K.fy * y / z + K.cy;
    if (u < u0) u0 = u; if (u > u1) u1 = u;
    if (v < v0) v0 = v; if (v > v1) v1 = v;
  };
  for (let k = 0; k < 8; k++) if (P[3 * k + 2] >= NEAR_M) add(P[3 * k], P[3 * k + 1], P[3 * k + 2]);
  for (let a = 0; a < 8; a++) {
    for (let bit = 1; bit <= 4; bit <<= 1) {
      if (a & bit) continue;
      const b = a | bit;
      const za = P[3 * a + 2], zb = P[3 * b + 2];
      if ((za >= NEAR_M) === (zb >= NEAR_M)) continue;
      const s = (NEAR_M - za) / (zb - za);
      add(P[3 * a] + s * (P[3 * b] - P[3 * a]), P[3 * a + 1] + s * (P[3 * b + 1] - P[3 * a + 1]), NEAR_M);
    }
  }
  if (!(u1 >= u0)) return 0; // 근평면 앞 부분 없음
  const w = Math.min(u1, W) - Math.max(u0, 0), h = Math.min(v1, H) - Math.max(v0, 0);
  return w > 0 && h > 0 ? w * h : 0;
}

function coarseScale(camera) {
  const cells = camera.width * camera.height * SCALE * SCALE;
  return cells <= MAX_COARSE_CELLS ? SCALE : SCALE * Math.sqrt(MAX_COARSE_CELLS / cells);
}

/** 단계 0 점을 거친 깊이 버퍼에 그려 리프별 이긴 칸 수(원 해상도 px 환산)를 센다. */
function coarseWins(hierarchy, camera) {
  const oc = hierarchy.octree;
  const wins = new Float64Array(oc.leafCount);
  const lv = hierarchy.levels[0];
  const { K, R, t } = camera;
  const scale = coarseScale(camera);
  const w = Math.max(1, Math.round(camera.width * scale)), h = Math.max(1, Math.round(camera.height * scale));
  const sx = w / camera.width, sy = h / camera.height;
  const depth = new Float32Array(w * h).fill(Infinity);
  const owner = new Int32Array(w * h).fill(-1);
  const pos = lv.positions;
  for (let k = 0; k < oc.leafCount; k++) {
    for (let s = lv.leafStart[k]; s < lv.leafStart[k + 1]; s++) {
      const X = pos[3 * s], Y = pos[3 * s + 1], Z = pos[3 * s + 2];
      const z = R[6] * X + R[7] * Y + R[8] * Z + t[2];
      if (!(z > 0)) continue;
      const u = (K.fx * (R[0] * X + R[1] * Y + R[2] * Z + t[0]) / z + K.cx) * sx;
      const v = (K.fy * (R[3] * X + R[4] * Y + R[5] * Z + t[1]) / z + K.cy) * sy;
      const r = Math.max(0.5, 0.5 * lv.edgeM * Math.max(K.fx * sx, K.fy * sy) / z);
      if (!Number.isFinite(u) || !Number.isFinite(v) || u + r < 0 || v + r < 0 || u - r > w || v - r > h) continue;
      const x0 = Math.max(0, Math.floor(u - r)), x1 = Math.min(w - 1, Math.floor(u + r));
      const y0 = Math.max(0, Math.floor(v - r)), y1 = Math.min(h - 1, Math.floor(v + r));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const q = y * w + x;
          if (z < depth[q]) { depth[q] = z; owner[q] = k; }
        }
      }
    }
  }
  for (let q = 0; q < w * h; q++) if (owner[q] >= 0) wins[owner[q]]++;
  const px = 1 / (sx * sy); // 칸 하나 = 원 해상도 px 수
  for (let k = 0; k < wins.length; k++) wins[k] *= px;
  return wins;
}

/**
 * 리프별 화면 기여 점수(클수록 먼저). 시야 밖·카메라 뒤 리프는 0. 퇴화 카메라면 전부 0.
 * @returns {Float64Array} 길이 leafCount
 */
export function leafPriority(hierarchy, camera) {
  assertHierarchy(hierarchy);
  const oc = hierarchy.octree;
  const out = new Float64Array(oc.leafCount);
  if (degenerateCamera(camera)) return out;
  const node = new Int32Array(oc.leafCount).fill(-1);
  for (let i = 0; i < oc.nodeCount; i++) if (oc.leafIndex[i] >= 0) node[oc.leafIndex[i]] = i;
  const wins = coarseWins(hierarchy, camera);
  const P = new Float64Array(24);
  for (let k = 0; k < oc.leafCount; k++) {
    const nd = node[k];
    if (nd < 0 || oc.leafStart[k + 1] === oc.leafStart[k]) continue;
    const A = clippedArea(camera, [oc.boxMin[3 * nd], oc.boxMin[3 * nd + 1], oc.boxMin[3 * nd + 2]], [oc.boxMax[3 * nd], oc.boxMax[3 * nd + 1], oc.boxMax[3 * nd + 2]], P);
    const s = wins[k] + 0.5 * (A / (1 + A));
    out[k] = Number.isFinite(s) ? s : 0;
  }
  return out;
}

/**
 * mask 가 1 인 리프를 점수 내림차순으로(동률은 번호 작은 쪽). 결정적.
 * @returns {Uint32Array}
 */
export function orderChunks(hierarchy, camera, mask) {
  assertHierarchy(hierarchy);
  const n = hierarchy.octree.leafCount;
  if (!(mask instanceof Uint8Array) || mask.length !== n) throw new Error(`${ERR} 마스크는 길이 ${n} 의 Uint8Array 여야 함`);
  for (let i = 0; i < n; i++) if (mask[i] !== 0 && mask[i] !== 1) throw new Error(`${ERR} 마스크[${i}] = ${mask[i]} 는 0/1 이 아님`);
  if (degenerateCamera(camera)) return new Uint32Array(0); // 퇴화 시점: 계약(T08.10)상 아무것도 남기지 않는다
  const score = leafPriority(hierarchy, camera);
  const ids = [];
  for (let i = 0; i < n; i++) if (mask[i]) ids.push(i);
  ids.sort((a, b) => score[b] - score[a] || a - b);
  return Uint32Array.from(ids);
}
