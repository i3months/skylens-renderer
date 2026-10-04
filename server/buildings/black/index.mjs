// T14.6 검정 텍스처 건물: 입력 프리즘 메시를 그대로 돌려주고 모서리 선 자산을 만든다.
// 같은 평면 안의 삼각분할 대각선은 이웃 삼각형 법선 각이 임계 이하이므로 제외한다.

import { TowerAssetError } from '../../../contracts/tower_assets/index.mjs';

/** 이웃 삼각형 법선 사이 각 임계(도). 이 값 이하이면 같은 평면으로 보고 선에서 제외. */
export const EDGE_ANGLE_THRESHOLD_DEG = 5;
/** 정점 위치 일치 판정 격자(m). 벽·지붕이 정점을 따로 가져도 같은 점으로 묶는다. */
export const POSITION_QUANT_M = 1e-4;

const COS_THRESHOLD = Math.cos((EDGE_ANGLE_THRESHOLD_DEG * Math.PI) / 180);

function triNormal(p, a, b, c) {
  const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
  const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
  const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  const len = Math.hypot(n[0], n[1], n[2]);
  return len > 0 ? [n[0] / len, n[1] / len, n[2] / len] : null; // 퇴화 삼각형은 null
}

// 입력 검증: 형태·유한성·인덱스 범위. 어기면 TowerAssetError.
function validateMesh(mesh) {
  if (!mesh || typeof mesh !== 'object') throw new TowerAssetError('buildBlackBuilding: mesh 가 객체가 아님');
  const { positions: p, indices: idx } = mesh;
  if (!p || typeof p.length !== 'number' || p.length % 3 !== 0) throw new TowerAssetError('buildBlackBuilding: positions 길이가 3의 배수가 아님');
  if (!idx || typeof idx.length !== 'number' || idx.length % 3 !== 0) throw new TowerAssetError('buildBlackBuilding: indices 길이가 3의 배수가 아님');
  for (let i = 0; i < p.length; i++) {
    if (!Number.isFinite(p[i])) throw new TowerAssetError(`buildBlackBuilding: positions[${i}] 가 유한수가 아님`);
  }
  const nv = p.length / 3;
  for (let i = 0; i < idx.length; i++) {
    if (!Number.isInteger(idx[i]) || idx[i] < 0 || idx[i] >= nv) throw new TowerAssetError(`buildBlackBuilding: indices[${i}] 가 범위 밖`);
  }
}

/**
 * @param {{positions:Float32Array, indices:Uint32Array}} mesh
 * @returns {{mesh: object, edgeLines: Float32Array}} edgeLines = xyz 쌍 연속(선당 6 float)
 */
export function buildBlackBuilding(mesh) {
  validateMesh(mesh);
  const { positions: p, indices: idx } = mesh;
  // 위치 격자 키 → 대표 점 id
  const pointId = new Map();
  const vertPoint = new Int32Array(p.length / 3);
  const pts = []; // [x,y,z] 정수 격자
  for (let v = 0; v < vertPoint.length; v++) {
    const q = [0, 1, 2].map((k) => Math.round(p[v * 3 + k] / POSITION_QUANT_M));
    const key = q.join(',');
    let id = pointId.get(key);
    if (id === undefined) { id = pts.length; pointId.set(key, id); pts.push(q); }
    vertPoint[v] = id;
  }
  // 변 → 접한 삼각형 법선 목록
  const edges = new Map();
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const n = triNormal(p, a, b, c);
    if (!n) continue;
    const ids = [vertPoint[a], vertPoint[b], vertPoint[c]];
    for (let k = 0; k < 3; k++) {
      const u = ids[k], w = ids[(k + 1) % 3];
      if (u === w) continue;
      const key = u < w ? `${u}_${w}` : `${w}_${u}`;
      let e = edges.get(key);
      if (!e) { e = { u: Math.min(u, w), w: Math.max(u, w), normals: [] }; edges.set(key, e); }
      e.normals.push(n);
    }
  }
  const lines = [];
  for (const e of edges.values()) {
    const ns = e.normals;
    let sharp = ns.length === 1; // 열린 변(한 삼각형만 접함)은 외곽으로 본다
    for (let i = 0; i < ns.length && !sharp; i++) {
      for (let j = i + 1; j < ns.length; j++) {
        const dot = ns[i][0] * ns[j][0] + ns[i][1] * ns[j][1] + ns[i][2] * ns[j][2];
        if (dot < COS_THRESHOLD) { sharp = true; break; }
      }
    }
    if (sharp) lines.push(e);
  }
  // 결정적 순서: 점 좌표 사전순 정렬
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const keyed = lines.map((e) => {
    const [A, B] = [pts[e.u], pts[e.w]].sort(cmp);
    return [A, B];
  }).sort((l, m) => cmp(l[0], m[0]) || cmp(l[1], m[1]));
  const edgeLines = new Float32Array(keyed.length * 6);
  keyed.forEach(([A, B], i) => {
    for (let k = 0; k < 3; k++) {
      edgeLines[i * 6 + k] = A[k] * POSITION_QUANT_M;
      edgeLines[i * 6 + 3 + k] = B[k] * POSITION_QUANT_M;
    }
  });
  return { mesh, edgeLines };
}
