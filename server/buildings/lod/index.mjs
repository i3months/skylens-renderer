// T14.4 건물 LOD: 먼 곳의 건물을 이웃끼리 축 정렬 상자(AABB)로 합쳐 면 수를 줄인다.
// 좌표는 ENU, 1 unit = 1 m. 입력 메시는 계약의 Mesh(positions xyz, indices 삼각형).
//
// 동작 요약
//  1) cameraDistM < BUILDING_LOD_FAR_DIST_M 이면 가까운 곳: 모든 건물을 원본 메시 그대로 한 동 한 그룹으로 돌려준다.
//  2) 먼 곳이면 허용 오차 tol = cameraDistM × BUILDING_LOD_MAX_ANGLE_RAD (m) 를 정하고,
//     - 건물마다 "자기 AABB 로 바꿨을 때의 기하 오차"가 tol 이하인 것만 상자 후보가 된다(넘으면 원본 유지).
//     - 상자 후보는 BUILDING_LOD_CELL_M 격자 칸(이웃 단위) 안에서, 합친 AABB 의 오차가 tol 이하인 쌍을
//       오차가 작은 순으로 탐욕적으로 합친다(응집 군집).
//     - 한 칸의 상자 후보 전체가 한 출력 그룹이 되고, 그 메시는 군집별 상자(벽 8 + 지붕 2 = 삼각형 10개)를 이어 붙인 것이다.
//  3) 모든 입력 id 는 정확히 한 출력 그룹에 속한다(동 보존). 출력 순서는 그룹의 첫 건물 입력 순서. 결정적.
//
// 오차 정의(수평): 상자 윗면(xy 직사각형) 위 표본점에서 원본 건물들의 xy 투영(삼각형 합집합)까지 거리의 최댓값.
//   표본은 직사각형 위 (ERROR_SAMPLES × ERROR_SAMPLES) 균등 격자(모서리 포함)라 정확한 하우스도르프 거리의 근사다.
//   볼록 다각형과 L 자형처럼 최댓값이 직사각형 모서리에서 나는 경우에는 정확하다.
// 오차 정의(수직): 군집 안 건물 꼭대기 높이의 최대 − 최소(상자는 최대 높이를 쓴다).
import { TowerAssetError } from '../../../contracts/tower_assets/index.mjs';

/** 기준 화면의 한 픽셀 각(rad): 세로 시야 60°, 세로 1080 px 화면. 관제탑 표준 화면을 가정한 값. */
export const BUILDING_LOD_REF_PIXEL_RAD = (Math.PI / 3) / 1080;
/** 상자 대체로 생기는 기하 오차의 화면 상한(px, 기준 화면). 2 px 이하면 테두리 앤티에일리어싱 폭 안이라 눈에 띄지 않는다고 본다. */
export const BUILDING_LOD_MAX_ERROR_PX = 2;
/** 허용 오차 각(rad). tol(m) = 거리 × 이 값. */
export const BUILDING_LOD_MAX_ANGLE_RAD = BUILDING_LOD_REF_PIXEL_RAD * BUILDING_LOD_MAX_ERROR_PX;
/**
 * 먼 곳의 거리 기준(m). 이보다 가까우면 합치지 않고 원본을 그대로 둔다.
 * 근거: 500 m 에서 허용 오차는 약 0.97 m 로, 건물 외곽선(지적·수치지도) 자체의 위치 정밀도(대략 1 m)와 같은 수준이다.
 * 그보다 가까우면 줄일 수 있는 면이 거의 없고, 관제탑 바로 앞 전경은 원형 그대로가 낫다.
 */
export const BUILDING_LOD_FAR_DIST_M = 500;
/** 이웃 묶음 격자 칸 한 변(m). 지형 타일(64 m)과 같게 해 타일 단위로 함께 스트리밍되게 한다. */
export const BUILDING_LOD_CELL_M = 64;

const ERROR_SAMPLES = 9;

function fail(msg) { throw new TowerAssetError(`buildBuildingLod: ${msg}`); }

// 건물 하나의 요약: AABB, 꼭대기 높이, xy 투영 삼각형(평탄화 배열 [ax,ay,bx,by,cx,cy,...]).
function summarize(b, index) {
  if (!b || typeof b !== 'object') fail(`buildings[${index}] 가 객체가 아니다`);
  const { id, mesh } = b;
  if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) fail(`buildings[${index}].id 가 u32 가 아니다`);
  if (!mesh || !(mesh.positions instanceof Float32Array) || !(mesh.indices instanceof Uint32Array)) {
    fail(`buildings[${index}].mesh 는 { positions: Float32Array, indices: Uint32Array } 여야 한다`);
  }
  const p = mesh.positions;
  const idx = mesh.indices;
  if (p.length % 3 !== 0 || idx.length % 3 !== 0) fail(`buildings[${index}].mesh 길이가 3의 배수가 아니다`);
  const nv = p.length / 3;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < idx.length; i++) {
    const v = idx[i];
    if (v >= nv) fail(`buildings[${index}].mesh 인덱스가 범위를 벗어났다`);
    const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) fail(`buildings[${index}].mesh 좌표가 유한하지 않다`);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const tris = new Float64Array((idx.length / 3) * 6);
  for (let t = 0; t < idx.length / 3; t++) {
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k];
      tris[t * 6 + k * 2] = p[v * 3];
      tris[t * 6 + k * 2 + 1] = p[v * 3 + 1];
    }
  }
  return { order: index, id, mesh, empty: idx.length === 0, minX, minY, minZ, maxX, maxY, maxZ, tris };
}

function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const qx = ax + t * dx - px, qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}

// 점에서 xy 투영 삼각형 하나까지 거리²(안이면 0). 퇴화(벽처럼 선분으로 눌린) 삼각형은 변까지 거리로 처리.
function triDist2(px, py, t, o) {
  const ax = t[o], ay = t[o + 1], bx = t[o + 2], by = t[o + 3], cx = t[o + 4], cy = t[o + 5];
  const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
  if (Math.abs(area) > 1e-9) {
    const s = Math.sign(area);
    const e0 = ((bx - ax) * (py - ay) - (px - ax) * (by - ay)) * s;
    const e1 = ((cx - bx) * (py - by) - (px - bx) * (cy - by)) * s;
    const e2 = ((ax - cx) * (py - cy) - (px - cx) * (ay - cy)) * s;
    if (e0 >= 0 && e1 >= 0 && e2 >= 0) return 0;
  }
  return Math.min(segDist2(px, py, ax, ay, bx, by), segDist2(px, py, bx, by, cx, cy), segDist2(px, py, cx, cy, ax, ay));
}

function clusterBox(members) {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity, minTop = Infinity;
  for (const m of members) {
    if (m.minX < minX) minX = m.minX; if (m.maxX > maxX) maxX = m.maxX;
    if (m.minY < minY) minY = m.minY; if (m.maxY > maxY) maxY = m.maxY;
    if (m.minZ < minZ) minZ = m.minZ; if (m.maxZ > maxZ) maxZ = m.maxZ;
    if (m.maxZ < minTop) minTop = m.maxZ;
  }
  return { minX, minY, minZ, maxX, maxY, maxZ, minTop };
}

// 군집을 AABB 하나로 바꿀 때의 오차(m). limit 를 넘는 순간 일찍 끝낸다(그때 결과는 "limit 초과"라는 뜻만 있다).
function clusterError(members, limit) {
  const b = clusterBox(members);
  let err = b.maxZ - b.minTop;
  if (err > limit) return err;
  const n = ERROR_SAMPLES;
  for (let j = 0; j < n; j++) {
    const y = b.minY + ((b.maxY - b.minY) * j) / (n - 1);
    for (let i = 0; i < n; i++) {
      const x = b.minX + ((b.maxX - b.minX) * i) / (n - 1);
      let best = Infinity;
      for (const m of members) {
        // 건물 AABB 까지 거리가 이미 찾은 최솟값 이상이면 그 건물은 볼 필요가 없다.
        const ox = Math.max(m.minX - x, 0, x - m.maxX), oy = Math.max(m.minY - y, 0, y - m.maxY);
        if (ox * ox + oy * oy >= best) continue;
        const t = m.tris;
        for (let o = 0; o < t.length; o += 6) {
          const d = triDist2(x, y, t, o);
          if (d < best) { best = d; if (d === 0) break; }
        }
        if (best === 0) break;
      }
      const d = Math.sqrt(best);
      if (d > err) { err = d; if (err > limit) return err; }
    }
  }
  return err;
}

// 상자 여러 개를 메시 하나로. 상자마다 정점 8개, 벽 8 + 지붕 2 = 삼각형 10개(바닥은 지면에 붙어 보이지 않으므로 생략).
// 감김은 바깥에서 볼 때 반시계(지붕은 위에서 볼 때 반시계, 계약과 같음).
function boxesToMesh(boxes) {
  const positions = new Float32Array(boxes.length * 8 * 3);
  const indices = new Uint32Array(boxes.length * 10 * 3);
  const QUADS = [
    [0, 1, 5, 4], // 남(-Y)
    [1, 2, 6, 5], // 동(+X)
    [2, 3, 7, 6], // 북(+Y)
    [3, 0, 4, 7], // 서(-X)
    [4, 5, 6, 7], // 지붕(+Z)
  ];
  let pi = 0, ii = 0;
  boxes.forEach((b, k) => {
    const base = k * 8;
    const corners = [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]];
    for (const z of [b.minZ, b.maxZ]) for (const [x, y] of corners) { positions[pi++] = x; positions[pi++] = y; positions[pi++] = z; }
    for (const [a, c, d, e] of QUADS) {
      indices[ii++] = base + a; indices[ii++] = base + c; indices[ii++] = base + d;
      indices[ii++] = base + a; indices[ii++] = base + d; indices[ii++] = base + e;
    }
  });
  return { positions, indices };
}

/**
 * 건물 LOD.
 * @param {Array<{id:number, mesh:{positions:Float32Array, indices:Uint32Array}}>} buildings
 * @param {number} cameraDistM 카메라에서 이 건물 묶음까지 거리(m). 호출자가 타일·묶음 단위로 잰다.
 * @returns {Array<{ids:number[], mesh:{positions:Float32Array, indices:Uint32Array}}>}
 */
export function buildBuildingLod(buildings, cameraDistM) {
  if (!Array.isArray(buildings)) fail('buildings 는 배열이어야 한다');
  if (typeof cameraDistM !== 'number' || !Number.isFinite(cameraDistM) || cameraDistM < 0) fail('cameraDistM 은 0 이상 유한수여야 한다');
  const items = buildings.map(summarize);
  const seen = new Set();
  for (const it of items) {
    if (seen.has(it.id)) fail(`id ${it.id} 가 중복된다`);
    seen.add(it.id);
  }

  // 가까운 곳: 원본 그대로.
  if (cameraDistM < BUILDING_LOD_FAR_DIST_M) return items.map((it) => ({ ids: [it.id], mesh: it.mesh }));

  const tol = cameraDistM * BUILDING_LOD_MAX_ANGLE_RAD;
  const groups = []; // { order, ids, mesh }
  const cells = new Map(); // 칸 키 → 상자 후보 목록(입력 순서)
  for (const it of items) {
    if (it.empty || clusterError([it], tol) > tol) { groups.push({ order: it.order, ids: [it.id], mesh: it.mesh }); continue; }
    const cx = Math.floor((it.minX + it.maxX) / 2 / BUILDING_LOD_CELL_M);
    const cy = Math.floor((it.minY + it.maxY) / 2 / BUILDING_LOD_CELL_M);
    const key = `${cx},${cy}`;
    let list = cells.get(key);
    if (!list) { list = []; cells.set(key, list); }
    list.push(it);
  }

  for (const list of cells.values()) {
    // 응집 군집: 합친 오차가 가장 작은 쌍부터(동률이면 앞선 쌍) tol 이하인 동안 합친다.
    let clusters = list.map((it) => [it]);
    for (;;) {
      let bestErr = Infinity, bi = -1, bj = -1;
      for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) {
          const e = clusterError(clusters[i].concat(clusters[j]), Math.min(tol, bestErr));
          if (e <= tol && e < bestErr) { bestErr = e; bi = i; bj = j; }
        }
      }
      if (bi < 0) break;
      const merged = clusters[bi].concat(clusters[bj]).sort((a, b) => a.order - b.order);
      clusters = clusters.filter((_, k) => k !== bi && k !== bj);
      clusters.push(merged);
      clusters.sort((a, b) => a[0].order - b[0].order);
    }
    groups.push({ order: list[0].order, ids: list.map((it) => it.id), mesh: boxesToMesh(clusters.map(clusterBox)) });
  }

  groups.sort((a, b) => a.order - b.order);
  return groups.map(({ ids, mesh }) => ({ ids, mesh }));
}
