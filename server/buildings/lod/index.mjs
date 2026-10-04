// T14.4 건물 LOD: 먼 곳의 건물을 이웃끼리 축 정렬 상자(AABB)로 합쳐 면 수를 줄인다.
// 좌표는 ENU, 1 unit = 1 m. 입력 메시는 계약의 Mesh(positions xyz, indices 삼각형).
//
// 동작 요약
//  1) cameraDistM < BUILDING_LOD_FAR_DIST_M 이면 가까운 곳: 모든 건물을 원본 메시 그대로 한 동 한 그룹으로 돌려준다.
//  2) 먼 곳이면 허용 오차 tol = cameraDistM × BUILDING_LOD_MAX_ANGLE_RAD (m) 를 정하고,
//     - 벽 방향이 x·y 축과 평행한 건물만 상자 후보가 된다(회전·다각형 벽은 상자로 바꾸면 법선이 바뀌어 음영이 달라진다).
//     - 건물마다 "자기 AABB 로 바꿨을 때의 기하 오차"가 tol 이하인 것만 상자 후보가 된다(넘으면 원본 유지).
//     - 상자 후보는 BUILDING_LOD_CELL_M 격자 칸(이웃 단위) 안에서, 합친 AABB 의 오차가 tol 이하인 쌍을
//       오차가 작은 순으로 탐욕적으로 합친다(응집 군집).
//     - 한 칸의 상자 후보 전체가 한 출력 그룹이 되고, 그 메시는 군집별 상자(벽 8 + 지붕 2 = 삼각형 10개)를 이어 붙인 것이다.
//  3) 모든 입력 id 는 정확히 한 출력 그룹에 속한다(동 보존). 출력 순서는 그룹의 첫 건물 입력 순서. 결정적.
//
// 오차 정의(수평): 상자 윗면(xy 직사각형) 위 표본점에서 원본 건물들의 xy 투영(삼각형 합집합)까지 거리의 최댓값.
//   표본은 직사각형 위 (ERROR_SAMPLES × ERROR_SAMPLES) 균등 격자(모서리 포함)에 구성 AABB 경계 좌표와 그 사이 중점을 더한
//   격자라 정확한 하우스도르프 거리의 근사다(축 정렬 구성 상자 사이 틈의 최대 오차는 이 표본에 들어간다).
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
/** 한 축 균등 표본 수 상한(계산량 제한). 넘으면 칸이 커져 상한 추정이 더 보수적이 될 뿐 과소평가는 없다. */
const MAX_GRID = 129;

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
  // 벽 방향 검사: xy 투영이 선분으로 눌린 삼각형(벽)의 방향이 x 축 또는 y 축과 평행한지.
  // 회전 직사각형·다각 원통을 축 정렬 상자로 바꾸면 벽 법선이 바뀌어 음영이 크게 달라지므로 상자 후보에서 뺀다.
  let axisAligned = true;
  for (let o = 0; o < tris.length && axisAligned; o += 6) {
    const ax = tris[o], ay = tris[o + 1], bx = tris[o + 2], by = tris[o + 3], cx = tris[o + 4], cy = tris[o + 5];
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(area) > 1e-6) continue; // 지붕·바닥 삼각형
    for (const [ux, uy, vx, vy] of [[ax, ay, bx, by], [bx, by, cx, cy], [cx, cy, ax, ay]]) {
      const dx = Math.abs(vx - ux), dy = Math.abs(vy - uy);
      if (Math.hypot(dx, dy) < 1e-6) continue;
      if (Math.min(dx, dy) > 1e-4 * Math.max(dx, dy)) { axisAligned = false; break; }
    }
  }
  return { order: index, id, mesh, empty: idx.length === 0, minX, minY, minZ, maxX, maxY, maxZ, tris, axisAligned };
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

// 한 축의 표본 좌표: 균등 격자(ERROR_SAMPLES) + 구성 건물 AABB 경계 + 이웃 좌표 사이 중점.
// 군집 사이 틈의 최대 오차는 틈 한가운데(경계 사이 중점)에서 나므로 균등 격자만으로는 놓칠 수 있다.
function sampleCoords(lo, hi, members, kLo, kHi, n) {
  const uniq = (a) => a.sort((p, q) => p - q).filter((x, i) => i === 0 || x !== a[i - 1]);
  // 경계 좌표끼리의 중점(틈 한가운데). 균등 격자와 섞기 전에 따로 구해야 틈 중점이 빠지지 않는다.
  const edges = uniq([lo, hi, ...members.flatMap((m) => [m[kLo], m[kHi]])]);
  const v = [...edges];
  for (let i = 1; i < edges.length; i++) v.push((edges[i - 1] + edges[i]) / 2);
  for (let i = 0; i < n; i++) v.push(lo + ((hi - lo) * i) / (n - 1));
  return uniq(v);
}

// 군집을 AABB 하나로 바꿀 때의 오차(m). limit 를 넘는 순간 일찍 끝낸다(그때 결과는 "limit 초과"라는 뜻만 있다).
function clusterError(members, limit, tol) {
  const b = clusterBox(members);
  let err = b.maxZ - b.minTop;
  if (err > limit) return err;
  // 균등 격자 간격을 tol/2 이하(상한 MAX_GRID 칸)로 잡고, 거리 함수가 1-립시츠라는 성질로
  // "표본 최댓값 + 격자 칸 반대각선"을 참 오차의 상한으로 쓴다(표본이 틈을 놓쳐도 과소평가하지 않는다).
  const nOf = (ext) => Math.min(MAX_GRID, Math.max(ERROR_SAMPLES, Math.ceil(ext / (tol / 2)) + 1));
  const nx = nOf(b.maxX - b.minX), ny = nOf(b.maxY - b.minY);
  const h = 0.5 * Math.hypot((b.maxX - b.minX) / (nx - 1), (b.maxY - b.minY) / (ny - 1));
  if (h > limit) return h;
  const xs = sampleCoords(b.minX, b.maxX, members, 'minX', 'maxX', nx);
  const ys = sampleCoords(b.minY, b.maxY, members, 'minY', 'maxY', ny);
  for (const y of ys) {
    for (const x of xs) {
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
      const d = Math.sqrt(best) + h;
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
    if (it.empty || !it.axisAligned || clusterError([it], tol, tol) > tol) { groups.push({ order: it.order, ids: [it.id], mesh: it.mesh }); continue; }
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
          const e = clusterError(clusters[i].concat(clusters[j]), Math.min(tol, bestErr), tol);
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
