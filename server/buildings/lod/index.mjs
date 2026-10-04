// T14.4 건물 LOD: 먼 곳의 건물을 이웃끼리 방향 상자(OBB)로 합쳐 면 수를 줄인다.
// 좌표는 ENU, 1 unit = 1 m. 입력 메시는 계약의 Mesh(positions xyz, indices 삼각형).
//
// 동작 요약
//  1) cameraDistM < BUILDING_LOD_FAR_DIST_M 이면 가까운 곳: 모든 건물을 원본 메시 그대로 한 동 한 그룹으로 돌려준다.
//  2) 먼 곳이면 허용 오차 tol = cameraDistM × BUILDING_LOD_MAX_ANGLE_RAD (m) 를 정하고,
//     - 건물마다 벽(xy 투영이 선분으로 눌린 삼각형)의 지배 방향 θ(90° 주기, 벽 길이 가중 평균)를 구한다.
//       모든 벽이 θ 와 BUILDING_LOD_MAX_WALL_ANGLE_RAD 이내로 평행·직교한 건물만 상자 후보가 된다
//       (다각 원통처럼 벽 방향이 여럿이면 상자로 바꿀 때 벽 법선이 크게 바뀌어 음영이 달라진다).
//     - 상자 후보는 BUILDING_LOD_CELL_M 격자 칸(이웃 단위)으로 나누고, 칸 안에서 θ 를 1차원으로 묶어
//       방향 묶음(묶음 안 모든 θ 가 묶음 기준 방향 φ 와 허용각 이내)을 만든다. 상자는 φ 방향 좌표계의 AABB 다.
//       따라서 상자의 벽 법선은 원래 벽 법선과 허용각 넘게 다르지 않다(음영 오차 상한).
//     - 건물마다 "φ 좌표계의 자기 상자로 바꿨을 때의 기하 오차"가 tol 이하인 것만 실제 상자 후보로 남는다(넘으면 원본 유지).
//     - 같은 방향 묶음 안에서, 두 상자 사이 틈과 높이 차가 모두 BUILDING_LOD_MAX_GAP_PX 이하이고, 합친 상자가 새로 덮는 빈 땅(틈 칸)의
//       메워지는 폭(끼인 틈은 틈 폭, 바깥으로 열린 홈·모서리는 깊이; gapCellError)이 hideTol 이하이며, 합친 상자의 오차가 tol 이하인 이웃 쌍을
//       오차 하한이 작은 순으로 탐욕적으로 합친다(응집 군집). 우선순위 큐에 인접 후보 쌍만 넣고, 꺼낸 쌍만 오차를 재며,
//       합칠 때마다 새 군집과 남은 군집 사이 쌍만 새로 넣는다.
//     - 다 합친 군집은 구성 건물 θ 범위의 가운데 방향으로 같은 병합 순서를 다시 재어 tol 안이면 그 방향 상자를 쓴다
//       (혼자 남은 건물은 자기 θ 방향 상자가 되어 원래 벽과 평행하다).
//     - 한 칸의 상자 후보 전체가 한 출력 그룹이 되고, 그 메시는 군집별 상자(벽 8 + 지붕 2 = 삼각형 10개)를 이어 붙인 것이다.
//  3) 모든 입력 id 는 정확히 한 출력 그룹에 속한다(동 보존). 출력 순서는 그룹의 첫 건물 입력 순서. 결정적.
//
// 오차 정의(수평): 상자 윗면(φ 좌표계 직사각형) 위 점에서 원본 건물들의 xy 투영(삼각형 합집합)까지 거리 최댓값의 상한.
//   직사각형을 표본 격자(간격 ≤ tol/2 균등 격자 + 구성 건물 상자 경계 좌표 + 이웃 좌표 사이 중점)로 덮고,
//   거리 함수가 1-립시츠라는 성질로 "표본 최댓값 + 가장 큰 격자 칸의 반대각선"을 쓴다(과소평가하지 않는다).
//   두 군집 A, B 를 합친 상자의 오차는 max(오차(A), 오차(B), 남는 영역 오차) 로 잰다. 합친 상자 중 A 상자 안의 점은
//   A 까지 거리가 오차(A) 이하이고 B 도 같으므로, 두 상자 밖 영역(틈 칸)만 새로 표본하면 된다(같은 φ 좌표계라 성립).
//   틈 칸은 어느 구성 건물에도 속하지 않는 빈 땅이므로 tol 이 아니라 hideTol 이하여야 한다(아래 "지워지는 세부").
//   tol 까지 허용되는 것은 한 건물을 자기 상자로 바꿀 때(L 자 홈 등)뿐이다.
// 오차 정의(수직): 상자 지붕 높이(군집 최대 높이) − 군집 안 윗면(위를 향한 삼각형) 최저 높이. 건물 사이 높이 차뿐 아니라
//   한 메시 안의 높이 차(기단 위 탑, 경사 지붕)도 포함한다.
// 음영 오차: 상자 벽 법선과 원래 벽 법선의 각 차 ≤ BUILDING_LOD_MAX_WALL_ANGLE_RAD.
// 지워지는 세부: 틈(상자 사이 거리)과 높이 계단(수직 오차)은 화면에서 옮겨지는 테두리가 아니라 통째로 사라지는 선·면이다.
//   그래서 2 px 테두리 허용(tol)이 아니라 BUILDING_LOD_MAX_GAP_PX(hideTol = 거리 × 픽셀 각 × px) 이하일 때만 지운다.
//   틈은 상자 사이 거리(mayMerge)만이 아니라 합친 상자가 새로 덮는 빈 땅 전체로 잰다: the filled-in width of every gap-cell
//   point, min(2 × distance to the members, distance to the members + distance to the merged box boundary), must be
//   ≤ hideTol. A gap trapped between buildings is thus limited to width hideTol (1/4 px), an open notch or corner to depth
//   hideTol. (Until F-334 the rule was "distance to the members ≤ hideTol", which let trapped gaps up to 2 × hideTol
//   through when the pair was joined via a third building.) 상자 사이 거리만 보면 앞뒤 면이 들쭉날쭉한 줄이나 대각 배치에서 tol(= 8 × hideTol)까지
//   빈 땅이 메워져, 줄 사이 틈의 벽 띠가 지붕으로 덮였다(이전 시드 180 top-high 건물 영역 SSIM 0.9496, F-326·F-331).
// 계산량: 한 칸 k 동에 대해 쌍 선검사 O(k²)(값싼 상자 비교), 오차 평가는 꺼낸 쌍만, 틈 칸만 표본한다.
import { TowerAssetError } from '../../../contracts/tower_assets/index.mjs';

/** 기준 화면의 한 픽셀 각(rad): 세로 시야 60°, 세로 1080 px 화면. 관제탑 표준 화면을 가정한 값. */
export const BUILDING_LOD_REF_PIXEL_RAD = (Math.PI / 3) / 1080;
/** 상자 대체로 생기는 기하 오차의 화면 상한(px, 기준 화면). 2 px 이하면 테두리 앤티에일리어싱 폭 안이라 눈에 띄지 않는다고 본다. */
export const BUILDING_LOD_MAX_ERROR_PX = 2;
/** 허용 오차 각(rad). tol(m) = 거리 × 이 값. */
export const BUILDING_LOD_MAX_ANGLE_RAD = BUILDING_LOD_REF_PIXEL_RAD * BUILDING_LOD_MAX_ERROR_PX;
/**
 * 상자 벽 법선이 원래 벽 법선과 다를 수 있는 각 상한(rad, 3°).
 * 근거: 램버트 음영 n·L 의 변화는 |Δn| = 2 sin(Δ/2) ≤ Δ 이하라 3° 면 확산 음영 범위의 5.2% 이하다.
 * 지적·수치지도 외곽선은 직각·평행이 1~2° 어긋나는 일이 흔하므로 이 정도는 같은 방향으로 본다.
 * 다각 원통(12각 이상)은 벽 방향 간격이 7.5° 이상이라 후보가 되지 않는다.
 */
export const BUILDING_LOD_MAX_WALL_ANGLE_RAD = (3 * Math.PI) / 180;
/**
 * 상자로 바꾸며 통째로 지워도 되는 세부(이웃 사이 틈, 지붕 높이 계단)의 화면 크기 상한(px, 기준 화면).
 * hideTol(m) = 거리 × 기준 픽셀 각 × 이 값. 크기 s 인 세부의 화면 각은 시점 고도와 무관하게 s / 거리 이하다.
 * 근거: 테두리를 옮기는 오차(2 px)는 앞쪽 경계가 앞뒤로 움직일 뿐이지만, 틈을 메우거나 높이 계단을 지우면 그 틈의 지면 선,
 * 계단의 벽 띠(지붕과 음영이 다른 면)가 군집 폭 전체에서 사라진다. 8×8 블록 SSIM 은 균일한 지붕 위의 선·띠 유무에 민감하므로
 * 이런 세부는 한 픽셀을 덮는 비율이 1/4 이하(점 표본에서 네 화소 중 하나 꼴로만 보이는 크기)일 때만 지운다.
 * 이전에는 높이 계단을 2 px(tol)까지 지웠다. 그 결과 S-far-high(3 km, 고도각 11°)에서 한 층(3 m) 차이 연립 줄들이 한 상자로
 * 합쳐져 계단 벽 띠가 사라졌고, 시드 2·3·42·1234·2026 의 건물 영역 SSIM 이 0.914~0.946 으로 떨어졌다(lod.test.mjs DENSE 다중 시드).
 * 1/4 px 는 5 km 에서 약 1.2 m 라 그 거리의 1 m 틈 쌍은 합쳐진다. 맞붙은 같은 높이 건물(맞벽)은 틈·계단 0 이라 언제나 후보다.
 */
export const BUILDING_LOD_MAX_GAP_PX = 0.25;
/**
 * 먼 곳의 거리 기준(m). 이보다 가까우면 합치지 않고 원본을 그대로 둔다.
 * 근거: 500 m 에서 허용 오차는 약 0.97 m 로, 건물 외곽선(지적·수치지도) 자체의 위치 정밀도(대략 1 m)와 같은 수준이다.
 * 그보다 가까우면 줄일 수 있는 면이 거의 없고, 관제탑 바로 앞 전경은 원형 그대로가 낫다.
 */
export const BUILDING_LOD_FAR_DIST_M = 500;
/** 이웃 묶음 격자 칸 한 변(m). 지형 타일(64 m)과 같게 해 타일 단위로 함께 스트리밍되게 한다. */
export const BUILDING_LOD_CELL_M = 64;

/** 한 축 균등 표본 수 하한(작은 직사각형도 이만큼은 본다). */
const ERROR_SAMPLES = 9;
/**
 * 한 축 균등 표본 수 상한(계산량 제한). 넘으면 칸이 커져 상한 추정이 더 보수적이 될 뿐 과소평가는 없다.
 * Used only by singleError (one building against its own box, limit tol). A side longer than (MAX_GRID − 1) × tol/2
 * gets spacing above tol/2 and a larger Lipschitz margin, so very long buildings may stay original (safe side).
 * Gap cells do not use this grid (gapCellError).
 */
const MAX_GRID = 129;
const QUARTER = Math.PI / 2;

function fail(msg) { throw new TowerAssetError(`buildBuildingLod: ${msg}`); }

// 각을 90° 주기로 [-45°, 45°) 에 접는다.
function fold90(a) {
  let r = (a + Math.PI / 4) % QUARTER;
  if (r < 0) r += QUARTER;
  return r - Math.PI / 4;
}

// 건물 하나의 요약: 월드 AABB, 꼭대기 높이, xy 투영 삼각형(평탄화 배열 [ax,ay,bx,by,cx,cy,...]), 벽 지배 방향.
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
  // 벽 방향: xy 투영이 선분으로 눌린 삼각형(벽)의 가장 긴 변 방향. 90° 주기 방향이라 4배 각의 길이 가중 평균으로
  // 지배 방향 θ 를 구하고, 모든 벽이 θ 와 허용각 이내인지(wallDev) 본다.
  const wallAngles = [];
  let sc = 0, ss = 0;
  for (let o = 0; o < tris.length; o += 6) {
    const ax = tris[o], ay = tris[o + 1], bx = tris[o + 2], by = tris[o + 3], cx = tris[o + 4], cy = tris[o + 5];
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(area) > 1e-6) continue; // 지붕·바닥 삼각형
    let dx = 0, dy = 0, len = 0;
    for (const [ux, uy, vx, vy] of [[ax, ay, bx, by], [bx, by, cx, cy], [cx, cy, ax, ay]]) {
      const l = Math.hypot(vx - ux, vy - uy);
      if (l > len) { len = l; dx = vx - ux; dy = vy - uy; }
    }
    if (len < 1e-6) continue;
    const a = Math.atan2(dy, dx);
    wallAngles.push(a);
    sc += len * Math.cos(4 * a); ss += len * Math.sin(4 * a);
  }
  const theta = wallAngles.length ? fold90(Math.atan2(ss, sc) / 4) : 0;
  // 윗면 최저 높이: 위를 향한(xy 투영이 반시계, 넓이 있는) 삼각형 꼭짓점 z 의 최솟값. 상자 지붕은 maxZ 이므로
  // 한 메시 안의 높이 차(낮은 기단 위 탑, 경사 지붕)도 수직 오차 maxZ − roofMin 으로 잡힌다.
  // 위를 향한 삼각형이 없으면(벽만 있는 퇴화 입력) 지붕이 낮아지는 곳이 없으므로 maxZ 로 둔다.
  // 감김이 계약과 반대면 바닥이 위를 향한 것으로 보여 오차가 커지고 원본이 유지된다(보수적).
  let roofMin = Infinity;
  for (let t = 0; t < idx.length / 3; t++) {
    const o = t * 6;
    const area = (tris[o + 2] - tris[o]) * (tris[o + 5] - tris[o + 1]) - (tris[o + 4] - tris[o]) * (tris[o + 3] - tris[o + 1]);
    if (area <= 1e-6) continue;
    for (let k = 0; k < 3; k++) roofMin = Math.min(roofMin, p[idx[t * 3 + k] * 3 + 2]);
  }
  if (roofMin === Infinity) roofMin = maxZ;
  let wallDev = 0;
  for (const a of wallAngles) wallDev = Math.max(wallDev, Math.abs(fold90(a - theta)));
  return {
    order: index, id, mesh, empty: idx.length === 0, minX, minY, minZ, maxX, maxY, maxZ, roofMin, tris, theta,
    dirOk: wallDev <= BUILDING_LOD_MAX_WALL_ANGLE_RAD,
  };
}

function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const qx = ax + t * dx - px, qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}

// 점이 넓이 있는 xy 투영 삼각형 안(경계 포함)인지.
function inTri(px, py, t, o) {
  const ax = t[o], ay = t[o + 1], bx = t[o + 2], by = t[o + 3], cx = t[o + 4], cy = t[o + 5];
  const s = Math.sign((bx - ax) * (cy - ay) - (cx - ax) * (by - ay));
  return ((bx - ax) * (py - ay) - (px - ax) * (by - ay)) * s >= 0
    && ((cx - bx) * (py - by) - (px - bx) * (cy - by)) * s >= 0
    && ((ax - cx) * (py - cy) - (px - cx) * (ay - cy)) * s >= 0;
}

// 건물을 방향 φ 좌표계(u = x cosφ + y sinφ, v = −x sinφ + y cosφ)로 옮긴 요소: 그 좌표계 AABB,
// 넓이 있는 삼각형(fill, 안 판정용)과 모든 삼각형 변의 중복 없는 선분(segs, 거리용; 퇴화한 벽 삼각형은 선분으로 남는다).
function toFrame(it, phi) {
  const c = Math.cos(phi), s = Math.sin(phi);
  const src = it.tris, tris = new Float64Array(src.length);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let o = 0; o < src.length; o += 2) {
    const u = src[o] * c + src[o + 1] * s, v = -src[o] * s + src[o + 1] * c;
    tris[o] = u; tris[o + 1] = v;
    if (u < minX) minX = u; if (u > maxX) maxX = u;
    if (v < minY) minY = v; if (v > maxY) maxY = v;
  }
  const fill = [], segs = [], seen = new Set();
  for (let o = 0; o < tris.length; o += 6) {
    const ax = tris[o], ay = tris[o + 1], bx = tris[o + 2], by = tris[o + 3], cx = tris[o + 4], cy = tris[o + 5];
    if (Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) > 1e-9) fill.push(ax, ay, bx, by, cx, cy);
    for (const [px, py, qx, qy] of [[ax, ay, bx, by], [bx, by, cx, cy], [cx, cy, ax, ay]]) {
      const fwd = px < qx || (px === qx && py <= qy);
      const key = fwd ? `${px},${py},${qx},${qy}` : `${qx},${qy},${px},${py}`;
      if (seen.has(key)) continue;
      seen.add(key);
      segs.push(px, py, qx, qy);
    }
  }
  return {
    it, order: it.order, minX, minY, maxX, maxY, minZ: it.minZ, maxZ: it.maxZ, roofMin: it.roofMin, err: 0,
    fill: Float64Array.from(fill), segs: Float64Array.from(segs),
  };
}

// 한 축의 표본 좌표: 균등 격자 + (lo, hi) 안의 구성 건물 상자 경계 + 이웃 경계 좌표 사이 중점.
// 틈의 최대 오차는 틈 한가운데(경계 사이 중점)에서 나므로 균등 격자만으로는 놓칠 수 있다.
// gap 은 이웃 표본 좌표 사이 최대 간격(립시츠 여유 계산용).
function sampleCoords(lo, hi, members, kLo, kHi, step, minSamples) {
  const n = Math.min(MAX_GRID, Math.max(minSamples, Math.ceil((hi - lo) / step) + 1));
  const edges = [lo, hi];
  for (const m of members) {
    if (m[kLo] > lo && m[kLo] < hi) edges.push(m[kLo]);
    if (m[kHi] > lo && m[kHi] < hi) edges.push(m[kHi]);
  }
  edges.sort((p, q) => p - q);
  const v = [...edges];
  for (let i = 1; i < edges.length; i++) v.push((edges[i - 1] + edges[i]) / 2);
  for (let i = 1; i + 1 < n; i++) v.push(lo + ((hi - lo) * i) / (n - 1));
  v.sort((p, q) => p - q);
  const coords = [v[0]];
  let gap = 0;
  for (let i = 1; i < v.length; i++) {
    const last = coords[coords.length - 1];
    if (v[i] === last) continue;
    if (v[i] - last > gap) gap = v[i] - last;
    coords.push(v[i]);
  }
  return { coords, gap };
}

// 점 (x, y) 에서 건물 m 의 xy 투영(삼각형 합집합)까지 거리², best 이상이면 그 값은 의미가 없다.
// 합집합까지 거리 = (어느 넓이 있는 삼각형 안이면 0) 아니면 모든 삼각형 변까지 거리의 최솟값이다.
// 변은 toFrame 에서 중복을 지워 두었다(벽 두 장이 같은 선분으로 눌리고, 지붕 삼각형끼리 변을 공유한다).
function memberDist2(x, y, m, best) {
  if (x >= m.minX && x <= m.maxX && y >= m.minY && y <= m.maxY) {
    const t = m.fill;
    for (let o = 0; o < t.length; o += 6) if (inTri(x, y, t, o)) return 0;
  }
  const s = m.segs;
  for (let o = 0; o < s.length; o += 4) {
    const d = segDist2(x, y, s[o], s[o + 1], s[o + 2], s[o + 3]);
    if (d < best) best = d;
  }
  return best;
}

// 직사각형 [x0,x1]×[y0,y1] 위 점에서 members 의 xy 투영 합집합까지 거리 최댓값의 상한(m).
// limit 를 넘는 순간 일찍 끝낸다(그때 결과는 "limit 초과"라는 뜻만 있다). floor 는 호출자가 이미 아는 오차로,
// 결과는 max(floor, 이 직사각형 오차) 다(floor 이하로 끝나는 표본은 정확한 거리를 끝까지 구하지 않는다).
// minSamples: 한 축 균등 표본 수 하한.
function rectError(x0, y0, x1, y1, members, limit, tol, floor = 0, minSamples = ERROR_SAMPLES) {
  // 직사각형에서 limit 보다 먼 건물은 limit 이하 거리를 줄 수 없으므로 볼 필요가 없다.
  const near = [];
  const inside = []; // 직사각형 안쪽과 겹치는 건물(경계 좌표를 표본에 더한다)
  for (const m of members) {
    const ox = Math.max(m.minX - x1, 0, x0 - m.maxX), oy = Math.max(m.minY - y1, 0, y0 - m.maxY);
    if (ox * ox + oy * oy > limit * limit) continue;
    near.push(m);
    if (m.minX < x1 && m.maxX > x0 && m.minY < y1 && m.maxY > y0) inside.push(m);
  }
  if (near.length === 0) return Infinity;
  const xs = sampleCoords(x0, x1, inside, 'minX', 'maxX', tol / 2, minSamples);
  const ys = sampleCoords(y0, y1, inside, 'minY', 'maxY', tol / 2, minSamples);
  // 1-립시츠: 표본 칸 안의 임의 점은 그 칸 모서리 표본 하나에서 반대각선 h 이내.
  const h = 0.5 * Math.hypot(xs.gap, ys.gap);
  let err = floor;
  if (h > limit) return h;
  const box2 = new Float64Array(near.length);
  for (const y of ys.coords) {
    for (const x of xs.coords) {
      // 이 표본이 err 를 올리려면 거리 > err − h 여야 한다. 그 이하인 건물을 하나라도 찾으면 더 볼 필요가 없다.
      const enough = err - h > 0 ? (err - h) * (err - h) : -1;
      // 먼저 AABB 가 가장 가까운 건물로 best 를 잡고, 나머지는 AABB 거리가 best 보다 작은 것만 본다.
      let first = 0;
      for (let i = 0; i < near.length; i++) {
        const m = near[i];
        const ox = Math.max(m.minX - x, 0, x - m.maxX), oy = Math.max(m.minY - y, 0, y - m.maxY);
        box2[i] = ox * ox + oy * oy;
        if (box2[i] < box2[first]) first = i;
      }
      let best = memberDist2(x, y, near[first], Infinity);
      for (let i = 0; i < near.length && best > enough && best > 0; i++) {
        if (i === first || box2[i] >= best) continue;
        best = memberDist2(x, y, near[i], best);
      }
      if (best <= enough) continue;
      const d = Math.sqrt(best) + h;
      if (d > err) { err = d; if (err > limit) return err; }
    }
  }
  return err;
}

// 군집을 다른 방향 φ2 좌표계로 다시 잰다. 같은 병합 순서(이진 트리)를 φ2 에서 다시 밟아 mergeError 로 오차를 구하므로
// 비용은 병합 한 번과 같은 수준이다. 어느 단계든 tol 을 넘으면 null.
function reframe(c, phi2, tol, hideTol) {
  if (!c.left) {
    const m = toFrame(c.members[0].it, phi2);
    m.err = singleError(m, tol, hideTol);
    return m.err <= tol ? makeCluster([m], m.err) : null;
  }
  const L = reframe(c.left, phi2, tol, hideTol);
  if (!L) return null;
  const R = reframe(c.right, phi2, tol, hideTol);
  if (!R) return null;
  const err = mergeError(L, R, tol, hideTol);
  return err <= tol ? makeCluster(L.members.concat(R.members), err, L, R) : null;
}

// 건물 하나를 자기 φ 좌표계 상자로 바꿀 때의 오차. 메시 안 높이 차(maxZ − roofMin)가 hideTol 을 넘으면 Infinity(원본 유지):
// 지붕을 maxZ 로 평평하게 하면 그 높이 차의 벽(계단)이 통째로 사라진다. 수평 오차는 그 수직 오차에서 시작한다.
function singleError(m, tol, hideTol) {
  const step = m.maxZ - m.roofMin;
  if (step > hideTol) return Infinity;
  return rectError(m.minX, m.minY, m.maxX, m.maxY, [m], tol, tol, step);
}

function makeCluster(members, err, left = null, right = null) {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity, minTop = Infinity, first = Infinity;
  for (const m of members) {
    if (m.minX < minX) minX = m.minX; if (m.maxX > maxX) maxX = m.maxX;
    if (m.minY < minY) minY = m.minY; if (m.maxY > maxY) maxY = m.maxY;
    if (m.minZ < minZ) minZ = m.minZ; if (m.maxZ > maxZ) maxZ = m.maxZ;
    if (m.roofMin < minTop) minTop = m.roofMin;
    if (m.order < first) first = m.order;
  }
  return { members, minX, minY, minZ, maxX, maxY, maxZ, minTop, first, err, alive: true, left, right };
}

// 두 군집을 합칠 후보인지(값싼 조건): 두 상자 사이 틈 ≤ hideTol 이고 높이 차(계단) ≤ hideTol.
// The height-step limit lives only here. mergeError does not repeat it: agglomerate calls mergeError only for pairs that
// passed mayMerge, and reframe replays an already accepted merge tree in another frame, where maxZ and minTop do not
// depend on the frame, so the step is the same value that passed here.
function mayMerge(A, B, hideTol) {
  const gx = Math.max(0, A.minX - B.maxX, B.minX - A.maxX), gy = Math.max(0, A.minY - B.maxY, B.minY - A.maxY);
  if (gx * gx + gy * gy > hideTol * hideTol) return false;
  return Math.max(A.maxZ, B.maxZ) - Math.min(A.minTop, B.minTop) <= hideTol;
}

/** Cell budget of one gap-cell branch-and-bound call. Running out rejects the merge (safe side: keep two boxes). */
const GAP_MAX_CELLS = 1 << 14;

// Gap-cell measure for the empty rectangle [x0,x1]×[y0,y1] that the merged box `box` (minX..maxY) newly covers.
// For an empty point p let e(p) = distance to the members' xy union and x(p) = distance to the merged box boundary.
// The filled-in width at p is w(p) = min(2·e(p), e(p) + x(p)):
//  - in a gap trapped between buildings (x ≥ e) the point is e from the nearer side, so the gap there is at least 2·e wide;
//    a gap of width w has w(p) = w on its centre line (F-334: the old limit e ≤ hideTol let trapped gaps up to 2·hideTol through);
//  - in an open notch or corner (the empty land reaches the box boundary) the land that turns into roof is e + x deep,
//    which equals the old "distance to the members" at the boundary, so staggered and diagonal pairs keep their old limit.
// The merge is accepted only when max w(p) ≤ limit (= hideTol). The maximum is found by branch and bound on sub-rectangles:
//  - upper bound of e on a cell: min over member edges S of max over the four cell corners of dist(corner, S)
//    (distance to one segment is convex, so its maximum on a rectangle is at a corner, and e ≤ distance to any edge),
//    and also e(centre) + half diagonal (1-Lipschitz);
//  - upper bound of x on a cell: the minimum over the four box sides of the largest distance of the cell to that side;
//  - lower bound: w(centre) exactly. Above the limit means reject.
// Because the edge bound does not grow with the cell length along a wall, a long thin gap needs only a few cells along its
// length; precision is set by the cell width across the gap, not by a fixed sample cap (F-335: the old uniform grid capped
// at MAX_GRID samples per axis lost precision on gap cells longer than 16·hideTol and rejected small real gaps).
// Returns { e, w } upper bounds (e feeds the geometric error), or null when the limit is exceeded or the budget runs out.
function gapCellError(x0, y0, x1, y1, members, limit, box, budget) {
  const near = [];
  for (const m of members) {
    const ox = Math.max(m.minX - x1, 0, x0 - m.maxX), oy = Math.max(m.minY - y1, 0, y0 - m.maxY);
    if (ox * ox + oy * oy <= limit * limit) near.push(m);
  }
  if (near.length === 0) return null;
  let eMax = 0, wMax = 0;
  const stack = [x0, y0, x1, y1];
  const minDiag = limit * 1e-6;
  while (stack.length) {
    const cy1 = stack.pop(), cx1 = stack.pop(), cy0 = stack.pop(), cx0 = stack.pop();
    if (--budget.cells < 0) return null;
    const mx = (cx0 + cx1) / 2, my = (cy0 + cy1) / 2;
    const half = 0.5 * Math.hypot(cx1 - cx0, cy1 - cy0);
    let c2 = Infinity;
    for (const m of near) c2 = memberDist2(mx, my, m, c2);
    const eC = Math.sqrt(c2);
    const xC = Math.min(mx - box.minX, box.maxX - mx, my - box.minY, box.maxY - my);
    if (Math.min(2 * eC, eC + xC) > limit) return null;
    // Edge bound: min over edges of the farthest corner distance. A member whose AABB is farther from the cell than the
    // current bound cannot lower it.
    let eUb2 = (eC + half) * (eC + half);
    for (const m of near) {
      const ox = Math.max(m.minX - cx1, 0, cx0 - m.maxX), oy = Math.max(m.minY - cy1, 0, cy0 - m.maxY);
      if (ox * ox + oy * oy >= eUb2) continue;
      const s = m.segs;
      for (let o = 0; o < s.length; o += 4) {
        const ax = s[o], ay = s[o + 1], bx = s[o + 2], by = s[o + 3];
        let far = segDist2(cx0, cy0, ax, ay, bx, by);
        if (far >= eUb2) continue;
        far = Math.max(far, segDist2(cx1, cy0, ax, ay, bx, by));
        if (far >= eUb2) continue;
        far = Math.max(far, segDist2(cx0, cy1, ax, ay, bx, by));
        if (far >= eUb2) continue;
        far = Math.max(far, segDist2(cx1, cy1, ax, ay, bx, by));
        if (far < eUb2) eUb2 = far;
      }
    }
    const eUb = Math.sqrt(eUb2);
    const xUb = Math.min(cx1 - box.minX, box.maxX - cx0, cy1 - box.minY, box.maxY - cy0);
    const wUb = Math.min(2 * eUb, eUb + xUb);
    if (wUb <= limit) {
      if (eUb > eMax) eMax = eUb;
      if (wUb > wMax) wMax = wUb;
      continue;
    }
    if (half < minDiag) return null;
    stack.push(cx0, cy0, mx, my, mx, cy0, cx1, my, cx0, my, mx, cy1, mx, my, cx1, cy1);
  }
  return { e: eMax, w: wMax };
}

// 같은 φ 좌표계의 두 군집 A, B 를 상자 하나로 합칠 때의 오차 상한(m). tol 초과면 tol 초과라는 뜻만 있다.
// Precondition: the height step max(maxZ) − min(minTop) ≤ hideTol was already checked by mayMerge (see there); it still
// enters the error as the vertical part.
// 틈 칸(A·B 어느 상자에도 들지 않는 칸)은 어느 구성 건물에도 속하지 않는 빈 땅이라, 메우면 테두리가 옮겨지는 것이 아니라
// 그 땅(과 그 너머로 보이던 벽)이 통째로 지붕이 된다. 그래서 틈 칸은 tol 이 아니라 hideTol 로 잰다: 메워지는 폭
// w(p) = min(2·e, e + x) (gapCellError) 가 hideTol 이하여야 한다(넘으면 Infinity, 합치지 않는다).
// Scope of the invariant: only the new gap cells are measured. Empty land inside a member's own box (an L-shaped
// building's notch) is bounded by singleError at tol, not by hideTol. Empty land inside an earlier cluster box was
// measured against that earlier box; when a later merge closes such an open notch into a trapped gap, the part of the
// gap that lies inside the earlier box is not measured again, so a gap formed that way can exceed hideTol by up to the
// earlier notch depth (≤ hideTol). The direct case of F-334 (the gap centre line lies in the new gap cells) is measured.
function mergeError(A, B, tol, hideTol) {
  const step = Math.max(A.maxZ, B.maxZ) - Math.min(A.minTop, B.minTop);
  const err = Math.max(A.err, B.err, step);
  if (err > tol) return err;
  const uniq = (a) => a.sort((p, q) => p - q).filter((x, i) => i === 0 || x !== a[i - 1]);
  const xs = uniq([A.minX, A.maxX, B.minX, B.maxX]);
  const ys = uniq([A.minY, A.maxY, B.minY, B.maxY]);
  const inBox = (C, x, y) => x > C.minX && x < C.maxX && y > C.minY && y < C.maxY;
  const box = { minX: xs[0], maxX: xs[xs.length - 1], minY: ys[0], maxY: ys[ys.length - 1] };
  const budget = { cells: GAP_MAX_CELLS };
  let members = null;
  let gapErr = 0;
  for (let j = 0; j + 1 < ys.length; j++) {
    for (let i = 0; i + 1 < xs.length; i++) {
      const mx = (xs[i] + xs[i + 1]) / 2, my = (ys[j] + ys[j + 1]) / 2;
      if (inBox(A, mx, my) || inBox(B, mx, my)) continue;
      if (!members) members = A.members.concat(B.members);
      const g = gapCellError(xs[i], ys[j], xs[i + 1], ys[j + 1], members, hideTol, box, budget);
      if (!g) return Infinity;
      if (g.e > gapErr) gapErr = g.e;
    }
  }
  return Math.max(err, gapErr);
}

// 결정적 최소 힙: (오차, 앞 군집 첫 순서, 뒤 군집 첫 순서) 사전순.
function less(p, q) {
  if (p.err !== q.err) return p.err < q.err;
  if (p.k0 !== q.k0) return p.k0 < q.k0;
  return p.k1 < q.k1;
}
function heapPush(h, e) {
  h.push(e);
  let i = h.length - 1;
  while (i > 0) {
    const up = (i - 1) >> 1;
    if (!less(h[i], h[up])) break;
    [h[i], h[up]] = [h[up], h[i]]; i = up;
  }
}
function heapPop(h) {
  const top = h[0], last = h.pop();
  if (h.length) {
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < h.length && less(h[l], h[m])) m = l;
      if (r < h.length && less(h[r], h[m])) m = r;
      if (m === i) break;
      [h[i], h[m]] = [h[m], h[i]]; i = m;
    }
  }
  return top;
}

function pairEntry(A, B, err) {
  return A.first < B.first ? { err, k0: A.first, k1: B.first, a: A, b: B } : { err, k0: B.first, k1: A.first, a: B, b: A };
}

// 쌍의 우선순위: 합친 상자 오차의 값싼 하한. mergeError 는 오차(A)·오차(B)·수직 오차 이상이고,
// 두 상자 사이 거리가 g 면 가장 가까운 두 점의 중점이 합친 상자 안에 있어 오차 ≥ g/2 다.
function pairKey(A, B) {
  const gx = Math.max(0, A.minX - B.maxX, B.minX - A.maxX), gy = Math.max(0, A.minY - B.maxY, B.minY - A.maxY);
  return Math.max(A.err, B.err, Math.max(A.maxZ, B.maxZ) - Math.min(A.minTop, B.minTop), 0.5 * Math.hypot(gx, gy));
}

// 응집 군집: 오차 하한(pairKey)이 가장 작은 쌍부터(동률이면 앞선 쌍) 꺼내, 합친 상자 오차(mergeError)가 tol 이하면 합친다.
// 인접 후보 쌍(mayMerge)만 큐에 넣고, 합칠 때마다 새 군집과 남은 군집 사이 쌍만 넣는다(죽은 군집의 쌍은 꺼낼 때 버린다).
// 오차는 꺼낸 쌍만 잰다. 넘는 쌍은 버리고, 그 군집이 다른 군집과 합쳐지면 새 쌍으로 다시 들어온다.
function agglomerate(singles, tol, hideTol) {
  let list = singles.map((m) => makeCluster([m], m.err));
  const heap = [];
  const push = (A, B) => { if (mayMerge(A, B, hideTol)) heapPush(heap, pairEntry(A, B, pairKey(A, B))); };
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) push(list[i], list[j]);
  while (heap.length) {
    const top = heapPop(heap);
    if (!top.a.alive || !top.b.alive) continue;
    const err = mergeError(top.a, top.b, tol, hideTol);
    if (err > tol) continue;
    top.a.alive = false; top.b.alive = false;
    const C = makeCluster(top.a.members.concat(top.b.members), err, top.a, top.b);
    list = list.filter((c) => c.alive);
    for (const D of list) push(C, D);
    list.push(C);
  }
  return list;
}

// 한 칸의 상자 후보를 벽 방향으로 묶는다. 90° 주기 원 위에서 가장 큰 빈 구간을 끊고 펼친 뒤,
// 앞에서부터 폭 2 × 허용각 이하로 묶고 묶음 기준 방향 φ 는 양 끝 가운데로 한다(묶음 안 θ 는 모두 φ 와 허용각 이내).
function directionBins(list) {
  const s = [...list].sort((a, b) => a.theta - b.theta || a.order - b.order);
  let cut = 0, bestGap = -1;
  for (let i = 0; i < s.length; i++) {
    const next = i + 1 < s.length ? s[i + 1].theta : s[0].theta + QUARTER;
    if (next - s[i].theta > bestGap) { bestGap = next - s[i].theta; cut = (i + 1) % s.length; }
  }
  const bins = [];
  let cur = null;
  for (let k = 0; k < s.length; k++) {
    const i = (cut + k) % s.length;
    const t = s[i].theta + (i < cut ? QUARTER : 0);
    if (!cur || t - cur.t0 > 2 * BUILDING_LOD_MAX_WALL_ANGLE_RAD) { cur = { t0: t, t1: t, items: [] }; bins.push(cur); }
    cur.t1 = t; cur.items.push(s[i]);
  }
  return bins.map((b) => ({ phi: (b.t0 + b.t1) / 2, items: b.items.sort((p, q) => p.order - q.order) }));
}

// 방향 상자 여러 개를 메시 하나로. 상자마다 정점 8개, 벽 8 + 지붕 2 = 삼각형 10개(바닥은 지면에 붙어 보이지 않으므로 생략).
// 상자는 φ 좌표계 AABB(minX..maxY 는 u·v 범위)이고 꼭짓점을 월드로 되돌린다(회전이라 감김 방향은 그대로).
// 감김은 바깥에서 볼 때 반시계(지붕은 위에서 볼 때 반시계, 계약과 같음).
function boxesToMesh(boxes) {
  const positions = new Float32Array(boxes.length * 8 * 3);
  const indices = new Uint32Array(boxes.length * 10 * 3);
  const QUADS = [
    [0, 1, 5, 4], // 남(-v)
    [1, 2, 6, 5], // 동(+u)
    [2, 3, 7, 6], // 북(+v)
    [3, 0, 4, 7], // 서(-u)
    [4, 5, 6, 7], // 지붕(+Z)
  ];
  let pi = 0, ii = 0;
  boxes.forEach((b, k) => {
    const base = k * 8;
    const c = Math.cos(b.phi), s = Math.sin(b.phi);
    const corners = [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]];
    for (const z of [b.minZ, b.maxZ]) {
      for (const [u, v] of corners) { positions[pi++] = u * c - v * s; positions[pi++] = u * s + v * c; positions[pi++] = z; }
    }
    for (const [a, q, d, e] of QUADS) {
      indices[ii++] = base + a; indices[ii++] = base + q; indices[ii++] = base + d;
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
  // 지워지는 세부(틈, 높이 계단)의 크기 상한(m). 화면 크기는 크기/거리 이하(시선과 수직일 때 최대)라 거리 × 픽셀 각 × px.
  const hideTol = cameraDistM * BUILDING_LOD_REF_PIXEL_RAD * BUILDING_LOD_MAX_GAP_PX;
  const groups = []; // { order, ids, mesh }
  const keepOriginal = (it) => groups.push({ order: it.order, ids: [it.id], mesh: it.mesh });
  const cells = new Map(); // 칸 키 → 벽 방향 후보 목록(입력 순서)
  for (const it of items) {
    if (it.empty || !it.dirOk) { keepOriginal(it); continue; }
    const cx = Math.floor((it.minX + it.maxX) / 2 / BUILDING_LOD_CELL_M);
    const cy = Math.floor((it.minY + it.maxY) / 2 / BUILDING_LOD_CELL_M);
    const key = `${cx},${cy}`;
    let list = cells.get(key);
    if (!list) { list = []; cells.set(key, list); }
    list.push(it);
  }

  for (const list of cells.values()) {
    const boxes = [];
    const members = [];
    for (const { phi, items: binItems } of directionBins(list)) {
      const singles = [];
      for (const it of binItems) {
        const m = toFrame(it, phi);
        m.err = singleError(m, tol, hideTol);
        if (m.err > tol) keepOriginal(it); else singles.push(m);
      }
      for (const c of agglomerate(singles, tol, hideTol)) {
        // 혼자 남은 건물의 원본이 상자(삼각형 10개)보다 작으면(벽만 있는 퇴화 입력 등) 바꿔도 줄지 않으므로 원본 유지.
        if (c.members.length === 1 && c.members[0].it.mesh.indices.length / 3 < 10) {
          keepOriginal(c.members[0].it);
          c.members[0].kept = true;
          continue;
        }
        // 군집은 구성 건물 θ 범위의 가운데 방향 상자가 허용 오차 안이면 그것을 쓴다(묶음 기준 방향보다 원래 벽에 가깝다).
        // 혼자 남은 건물이면 자기 지배 방향이 된다. 넘으면 합칠 때 검사한 묶음 기준 방향 상자를 쓴다.
        let lo = Infinity, hi = -Infinity;
        for (const m of c.members) {
          const t = phi + fold90(m.it.theta - phi);
          if (t < lo) lo = t; if (t > hi) hi = t;
        }
        const own = (lo + hi) / 2;
        const oc = own !== phi ? reframe(c, own, tol, hideTol) : null;
        if (oc) boxes.push({ ...oc, phi: own });
        else boxes.push({ ...c, phi });
      }
      members.push(...singles.filter((m) => !m.kept));
    }
    if (!boxes.length) continue;
    boxes.sort((a, b) => a.first - b.first);
    members.sort((a, b) => a.order - b.order);
    groups.push({ order: members[0].order, ids: members.map((m) => m.it.id), mesh: boxesToMesh(boxes) });
  }

  groups.sort((a, b) => a.order - b.order);
  return groups.map(({ ids, mesh }) => ({ ids, mesh }));
}
