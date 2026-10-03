// T08.3 거친 가림 컬링(CPU 깊이 피라미드). 계약: contracts/cull CULL_API.occlusion.
//
// 원칙: '확실히 가려질 때만 제거'(거짓 제거 0). 기준은 참조 래스터 renderPoints(원본 전체, 같은 pointSizeM)다.
//
// 1) 가림막 버퍼(서브 해상도). 화면 W×H 를 Bw×Bh 블록으로 나눈다(Bw = size·mW, mW = clamp(floor(W/size), 1, 4), Bh 도 같음).
//    픽셀 열 i 는 블록 열 floor(i·Bw/W), 피라미드 0 단계 열 floor(i·size/W) 에 속한다(정수 배이므로 블록은 칸 안에 포개진다).
//    occluder 점 p(깊이 d, 원판 반경 r = fx·s/(2d), renderPoints 와 같은 projectMany·radiusUnchecked 로 계산)가 블록을
//    '확실히 덮는다' = 블록 안 모든 픽셀 중심이 원판 안(가장 먼 모서리 픽셀 중심까지 거리 ≤ r, 즉 점 크기를 블록 반대각만큼
//    보수적으로 줄인 것). 1×1 픽셀 블록은 renderPoints 의 '중심 칸 항상 포함' 규칙도 쓴다.
//    renderPoints 는 덮인 픽셀마다 가장 가까운 깊이를 남기므로, 확실히 덮인 블록의 모든 픽셀의 최종 깊이 ≤ fround(d) 이다.
//    블록 값 = 확실히 덮은 점들의 fround(d) 최솟값. 아무 점도 통째로 덮지 못한 블록은 +∞(가림막 아님).
//    무늬 없는 영역의 빈자리는 원래 비어 있으므로 빈 블록·빈 칸은 절대 가림막으로 보지 않는다.
// 2) 피라미드. levels[0] 은 size×size 칸, 칸 값 = 칸 안 블록 값의 최댓값(하나라도 +∞ 면 +∞).
//    levels[k] 는 (size>>k)² 칸, 값 = 자식 2×2 의 최댓값. 그래서 상위 칸 값은 그 칸 안 모든 픽셀의 최종 깊이 상한이다.
// 3) 판정. 리프 상자(리프 실제 점들의 꼭 맞는 AABB. 팔진 트리 노드 상자 안에 들고 리프의 모든 점을 품는다) 8 꼭짓점을 카메라 좌표로 옮겨, 하나라도 z ≤ NEAR_M 이면 판정 포기(남김).
//    아니면 u,v 범위에 원판 반경 상한 rmax = fx·s/(2·zmin) 와 1 픽셀 여유를 더한 픽셀 사각형을 만들고,
//    그 사각형과 겹치는 0 단계 칸이 모두 zmin > 칸 값·(1+REL)+ABS 를 만족할 때만 0(제거). 피라미드 위에서부터 내려가며 본다.
//    사각형이 화면 밖으로 완전히 나가면 남긴다(시야 밖 제거는 frustum 몫).
// 퇴화 시점(NaN 카메라 등)은 예외 없이 빈 마스크(전부 0). 입력 오류는 'cull:' 오류.
//
// 가림막 수 제한(F-121): 시점마다 시야 안 리프의 점 전부를 칠하던 비용(100만 점 35~87 ms)을 두 가지로 줄인다.
//   (a) 정확한 생략(결과 동일): 블록 하나를 '확실히 덮으려면' 원판 반경이 그 블록의 모서리 픽셀 중심 사이 반대각
//       rNeed = √((wMin−1)²+(hMin−1)²)/2 이상이어야 한다(wMin·hMin = 가장 좁은 블록의 픽셀 수, 1×1 블록이 있을 수 있으면 0).
//       리프 노드 상자의 최소 카메라 깊이 zmin 으로 반경 상한 fx·s/(2·zmin) 이 rNeed 보다 작으면 그 리프의 점은 어떤 블록도
//       덮지 못하므로 투영하지 않는다. 피라미드는 생략 전과 비트 단위로 같다.
//   (b) 점 수 상한 maxOccluderPoints(기본 DEFAULT_MAX_OCCLUDER_POINTS): 남은 후보 리프를 노드 상자 최소 깊이 오름차순
//       (같으면 리프 번호)으로 보며, 넣으면 상한을 넘는 리프는 건너뛴다. 가까운 리프가 화면을 가장 넓게 덮는 가림막이다.
//   픽셀 동일 보장: 가림막은 '참조 렌더에서 실제로 그려지는 점'만 쓸 수 있다. (b) 는 단계 0 점(원본 전부, 참조 렌더가 모두 그림)의
//   부분집합만 쓰므로 블록 값은 그대로 참조 깊이의 상한이고, 덜 칠한 블록은 +∞(가림막 아님)로 남아 제거가 줄 뿐 거짓 제거는 없다.
//   occluderLevel ≥ 1 은 쓰지 않았다: 대표점도 원본 부분집합이라 안전하지만, 같은 점 지름으로 성기게 칠해 구멍이 생겨
//   100만 점 flat_boxes 320×180 시점 4·5·8 의 제거가 1882·1888·1602 → 267·194·0 으로 무너진다.
//   측정(100만 점 flat_boxes·terrain 시드 1, buildHierarchy edge0M 0.5·levelCount 3·maxLeafPoints 256, 시점 8곳, size 64,
//   시점당 3회 중 최솟값 ms, 바꾸기 전 → 후):
//     1280×720 s 0.75: 49~87 → 1.5~44 · s 0.05: 35~77 → 1.4~1.7 · 320×180 s 0.75: 45~74 → 19~37 · s 0.05: 35~75 → 20~26.
//     제거 리프(flat_boxes 1280×720 s 0.75 시점 4·6·7·8): 2012·135·322·1656 → 1982·129·319·1641, 320×180 시점 4: 1882 → 1877. 나머지 같음(terrain 은 전후 0).
import { projectMany } from '../../raster_ref/project/index.mjs';
import { radiusUnchecked } from '../../raster_ref/splat/index.mjs';
import { boxMayBeVisible } from '../../lod/select/view_check.mjs';
import { isDegenerateView } from '../degenerate/index.mjs';

const ERR = 'cull:';
/** 상자 꼭짓점이 이 깊이(m) 이하이면 가림 판정을 포기한다. */
export const NEAR_M = 1e-3;
/** 깊이 비교 여유: 상자 최소 깊이가 가림막 깊이보다 이만큼 확실히 멀어야 제거한다(float32 반올림·계산 순서 차이 흡수). */
const REL = 1e-6;
const ABS = 1e-6;
/** renderPoints 기본 점 지름(m). */
export const DEFAULT_POINT_SIZE_M = 0.05;
const MAX_SUB = 4;
/** 가림막으로 투영할 점 수 기본 상한(2^18). 측정 전에 정한 값: 20만 점 시험 장면은 상한에 닿지 않아 결과가 그대로다. */
export const DEFAULT_MAX_OCCLUDER_POINTS = 262144;

const isNum = (x) => typeof x === 'number';

// ---- 입력 검사 ---------------------------------------------------------------------------

function assertHierarchy(h) {
  if (!h || typeof h !== 'object') throw new Error(`${ERR} 계층이 객체가 아님`);
  const oc = h.octree;
  if (!oc || typeof oc !== 'object') throw new Error(`${ERR} hierarchy.octree 가 없음`);
  const { nodeCount, leafCount, leafIndex, boxMin, boxMax } = oc;
  if (!Number.isInteger(nodeCount) || nodeCount < 1 || !Number.isInteger(leafCount) || leafCount < 1 || leafCount > nodeCount) {
    throw new Error(`${ERR} octree.nodeCount/leafCount 가 올바르지 않음`);
  }
  if (!(leafIndex instanceof Int32Array) || leafIndex.length !== nodeCount) throw new Error(`${ERR} octree.leafIndex 길이가 nodeCount 가 아님`);
  if (!(boxMin instanceof Float32Array) || boxMin.length !== 3 * nodeCount) throw new Error(`${ERR} octree.boxMin 길이가 3·nodeCount 가 아님`);
  if (!(boxMax instanceof Float32Array) || boxMax.length !== 3 * nodeCount) throw new Error(`${ERR} octree.boxMax 길이가 3·nodeCount 가 아님`);
  if (!Array.isArray(h.levels) || h.levels.length < 1) throw new Error(`${ERR} hierarchy.levels 가 비었음`);
  for (const lv of h.levels) {
    if (!lv || !(lv.positions instanceof Float32Array) || !(lv.leafStart instanceof Uint32Array) || lv.leafStart.length !== leafCount + 1
      || lv.positions.length !== 3 * lv.leafStart[leafCount]) {
      throw new Error(`${ERR} hierarchy.levels 의 positions/leafStart 가 올바르지 않음`);
    }
  }
}

/** 리프 번호 → 노드 번호. */
function leafNodes(oc) {
  const out = new Int32Array(oc.leafCount).fill(-1);
  for (let node = 0; node < oc.nodeCount; node++) {
    const k = oc.leafIndex[node];
    if (k >= 0) {
      if (k >= oc.leafCount || out[k] !== -1) throw new Error(`${ERR} octree.leafIndex 가 리프 번호를 한 번씩 쓰지 않음`);
      out[k] = node;
    }
  }
  for (let k = 0; k < oc.leafCount; k++) if (out[k] < 0) throw new Error(`${ERR} 리프 ${k} 의 노드가 없음`);
  return out;
}

/**
 * 카메라 구조 검사. 구조가 틀리면 'cull:' 오류, 값이 퇴화(NaN·비정수/과대 해상도·R 비회전 등)면 true.
 * 퇴화 판정은 server/cull/degenerate 의 isDegenerateView 하나만 쓴다(규칙 중복 없음).
 */
export function degenerateCamera(camera) {
  if (!camera || typeof camera !== 'object') throw new Error(`${ERR} 카메라가 객체가 아님`);
  const { width, height, K, R, t } = camera;
  if (!K || typeof K !== 'object') throw new Error(`${ERR} 카메라 K 가 객체가 아님`);
  if (!Array.isArray(R) || R.length !== 9) throw new Error(`${ERR} 카메라 R 은 길이 9 배열이어야 함`);
  if (!Array.isArray(t) || t.length !== 3) throw new Error(`${ERR} 카메라 t 는 길이 3 배열이어야 함`);
  const nums = [width, height, K.fx, K.fy, K.cx, K.cy, ...R, ...t];
  if (!nums.every(isNum)) throw new Error(`${ERR} 카메라 값은 수여야 함`);
  return isDegenerateView(camera);
}

function readSize(size) {
  if (!Number.isInteger(size) || size < 1 || size > 4096 || (size & (size - 1)) !== 0) {
    throw new Error(`${ERR} size 는 1..4096 의 2 거듭제곱 정수여야 함: ${String(size)}`);
  }
  return size;
}

function readPointSize(s) {
  if (!isNum(s) || !Number.isFinite(s) || !(s > 0)) throw new Error(`${ERR} pointSizeM 은 양의 유한 수여야 함: ${String(s)}`);
  return s;
}

// 리프마다 실제 점(단계 0 = 원본 전부)의 꼭 맞는 상자. 팔진 트리 노드 상자(정육면체)보다 작아 판정이 덜 헐겁다.
// 리프의 모든 점(그리고 그 부분집합인 거친 단계 대표점)이 이 상자 안에 있다. 점이 없는 리프는 빈 상자(min > max).
const tightCache = new WeakMap();
function tightLeafBoxes(h) {
  let tb = tightCache.get(h);
  if (tb) return tb;
  const L = h.octree.leafCount, lv = h.levels[0], pos = lv.positions;
  const mn = new Float32Array(3 * L).fill(Infinity), mx = new Float32Array(3 * L).fill(-Infinity);
  for (let k = 0; k < L; k++) {
    for (let s = lv.leafStart[k]; s < lv.leafStart[k + 1]; s++) {
      for (let d = 0; d < 3; d++) {
        const x = pos[3 * s + d];
        if (!Number.isFinite(x)) throw new Error(`${ERR} 리프 ${k} 의 점 좌표가 유한하지 않음`);
        if (x < mn[3 * k + d]) mn[3 * k + d] = x;
        if (x > mx[3 * k + d]) mx[3 * k + d] = x;
      }
    }
  }
  tb = { mn, mx };
  tightCache.set(h, tb);
  return tb;
}

const camKey = (c) => JSON.stringify([c.width, c.height, c.K.fx, c.K.fy, c.K.cx, c.K.cy, c.R, c.t]);

// ---- 피라미드 ----------------------------------------------------------------------------

/** 0 단계 칸 값에서 상위 단계를 만든다(부모 = 자식 2×2 의 최댓값; 변이 시험용 _mut.pyramidMin 이면 최솟값). */
function buildUpper(level0, size, mut) {
  const levels = [level0];
  for (let s = size >> 1, prev = level0, ps = size; s >= 1; ps = s, s >>= 1) {
    const cur = new Float32Array(s * s);
    for (let b = 0; b < s; b++) {
      for (let a = 0; a < s; a++) {
        const c00 = prev[(2 * b) * ps + 2 * a], c01 = prev[(2 * b) * ps + 2 * a + 1];
        const c10 = prev[(2 * b + 1) * ps + 2 * a], c11 = prev[(2 * b + 1) * ps + 2 * a + 1];
        cur[b * s + a] = mut.pyramidMin ? Math.min(c00, c01, c10, c11) : Math.max(c00, c01, c10, c11);
      }
    }
    levels.push(cur);
    prev = cur;
  }
  return levels;
}

/** 열(행) 픽셀 → 블록 번호, 블록의 첫·끝 픽셀. */
function blockMap(W, Bw) {
  const of = new Int32Array(W);
  const start = new Int32Array(Bw).fill(-1), end = new Int32Array(Bw).fill(-2);
  for (let i = 0; i < W; i++) {
    const a = Math.floor((i * Bw) / W);
    of[i] = a;
    if (start[a] < 0) start[a] = i;
    end[a] = i;
  }
  return { of, start, end };
}

/**
 * 원판이 블록 하나를 '확실히 덮으려면' 필요한 최소 반경(픽셀). 블록 a×b 픽셀의 가장 먼 픽셀 중심까지 거리는
 * 적어도 √((a−1)²+(b−1)²)/2 이다. 가장 좁은 열·행 블록으로 하한을 잡는다. 1×1 블록이 있을 수 있으면('중심 칸' 규칙) 0.
 */
function minCoverRadius(cols, Bw, rows, Bh) {
  let wMin = Infinity, hMin = Infinity;
  for (let a = 0; a < Bw; a++) if (cols.start[a] >= 0) wMin = Math.min(wMin, cols.end[a] - cols.start[a] + 1);
  for (let b = 0; b < Bh; b++) if (rows.start[b] >= 0) hMin = Math.min(hMin, rows.end[b] - rows.start[b] + 1);
  if (!Number.isFinite(wMin) || !Number.isFinite(hMin)) return 0;
  return Math.sqrt((wMin - 1) ** 2 + (hMin - 1) ** 2) / 2;
}

/**
 * 깊이 피라미드를 만든다. opts: size(기본 64, 2 거듭제곱), pointSizeM(기본 0.05, renderPoints 와 같게),
 * occluderLevel(기본 0, 가림막 점을 고를 LOD 단계), occluderMask(길이 leafCount 0/1, 1 인 리프만 가림막. 기본 시야 안 리프 전부),
 * maxOccluderPoints(기본 DEFAULT_MAX_OCCLUDER_POINTS, 투영할 가림막 점 수 상한. 가까운 리프부터. Infinity 면 상한 없음).
 * occluder 는 원본의 부분집합이므로 원본 전체 렌더에서도 그 점들이 그려진다(새 점 없음).
 * @returns {{size:number, levels:Float32Array[], width:number, height:number, pointSizeM:number, cameraKey:string, degenerate:boolean, blocks:{w:number,h:number}, occluderPoints:number}}
 *   occluderPoints = 실제로 투영한 가림막 점 수(정확한 생략·상한 뒤).
 */
export function buildDepthPyramid(hierarchy, camera, opts = {}) {
  return buildDepthPyramidWith(hierarchy, camera, opts, {});
}

/** 변이 주입용 핵심 구현(시험 전용 _mut). 일반 사용은 buildDepthPyramid. */
export function buildDepthPyramidWith(hierarchy, camera, opts = {}, mut = {}) {
  assertHierarchy(hierarchy);
  if (opts === null || typeof opts !== 'object') throw new Error(`${ERR} opts 는 객체여야 함`);
  const size = readSize(opts.size ?? 64);
  const pointSizeM = readPointSize(opts.pointSizeM ?? DEFAULT_POINT_SIZE_M);
  const oc = hierarchy.octree;
  const occLevel = opts.occluderLevel ?? 0;
  if (!Number.isInteger(occLevel) || occLevel < 0 || occLevel >= hierarchy.levels.length) throw new Error(`${ERR} occluderLevel 이 범위 밖: ${String(occLevel)}`);
  const occMask = opts.occluderMask;
  if (occMask !== undefined && (!(occMask instanceof Uint8Array) || occMask.length !== oc.leafCount)) throw new Error(`${ERR} occluderMask 는 길이 leafCount 의 Uint8Array`);
  const maxOcc = opts.maxOccluderPoints ?? DEFAULT_MAX_OCCLUDER_POINTS;
  if (!(maxOcc === Infinity || (Number.isInteger(maxOcc) && maxOcc >= 0))) throw new Error(`${ERR} maxOccluderPoints 는 0 이상 정수 또는 Infinity: ${String(maxOcc)}`);
  const degenerate = degenerateCamera(camera);
  const empty = () => buildUpper(new Float32Array(size * size).fill(Infinity), size, {});
  if (degenerate) return { size, levels: empty(), width: 0, height: 0, pointSizeM, cameraKey: '', degenerate: true, blocks: { w: 0, h: 0 }, occluderPoints: 0 };

  const W = camera.width, H = camera.height;
  const Bw = size * Math.min(MAX_SUB, Math.max(1, Math.floor(W / size)));
  const Bh = size * Math.min(MAX_SUB, Math.max(1, Math.floor(H / size)));
  const buf = new Float32Array(Bw * Bh).fill(Infinity);
  const cols = blockMap(W, Bw), rows = blockMap(H, Bh);
  const fx = camera.K.fx;
  const lv = hierarchy.levels[occLevel];
  const nodes = leafNodes(oc);
  const rNeed = minCoverRadius(cols, Bw, rows, Bh);
  const { R, t } = camera;
  // 후보 리프와 노드 상자 최소 카메라 깊이(가까운 순 정렬 키·반경 상한용).
  const cand = [], key = new Float64Array(oc.leafCount);
  for (let k = 0; k < oc.leafCount; k++) {
    if (occMask && occMask[k] !== 1) continue;
    const node = nodes[k];
    const mn = oc.boxMin.subarray(3 * node, 3 * node + 3), mx = oc.boxMax.subarray(3 * node, 3 * node + 3);
    if (!boxMayBeVisible(camera, mn, mx)) continue;
    if (lv.leafStart[k + 1] === lv.leafStart[k]) continue;
    let zmin = Infinity;
    for (let c = 0; c < 8; c++) {
      const X = c & 1 ? mx[0] : mn[0], Y = c & 2 ? mx[1] : mn[1], Z = c & 4 ? mx[2] : mn[2];
      const z = R[6] * X + R[7] * Y + R[8] * Z + t[2];
      if (z < zmin) zmin = z;
    }
    // (a) 정확한 생략: 상자의 모든 점은 깊이 ≥ zmin 이라 반경 ≤ fx·s/(2·zmin). 그것이 rNeed 보다 확실히 작으면 덮는 블록이 없다.
    if (!mut.noExactSkip && !mut.noShrink && zmin > 0 && rNeed > 0 && ((fx * pointSizeM) / (2 * zmin)) * (1 + 1e-6) < rNeed) continue;
    key[k] = zmin > 0 ? zmin : 0;
    cand.push(k);
  }
  cand.sort((a, b) => key[a] - key[b] || a - b);
  let budget = maxOcc, occluderPoints = 0;
  let proj = new Float64Array(0);
  for (const k of cand) {
    const s0 = lv.leafStart[k], s1 = lv.leafStart[k + 1];
    if (s1 - s0 > budget) continue; // (b) 상한을 넘기는 리프는 건너뛴다(가림막을 덜 쓰는 쪽 = 보수적)
    budget -= s1 - s0;
    occluderPoints += s1 - s0;
    const pos = lv.positions.subarray(3 * s0, 3 * s1);
    if (proj.length < pos.length) proj = new Float64Array(pos.length);
    projectMany(camera, pos, proj);
    for (let p = 0; p < s1 - s0; p++) {
      const u = proj[3 * p], v = proj[3 * p + 1], d = proj[3 * p + 2];
      if (!(d > 0) || !Number.isFinite(u) || !Number.isFinite(v)) continue;
      const dS = Math.fround(d);
      if (!(dS > 0) || !Number.isFinite(dS)) continue;
      const r = radiusUnchecked(fx, d, pointSizeM);
      const r2 = r * r;
      if (mut.noShrink) {
        // 변이: 점 중심이 든 블록을 통째로 덮였다고 본다(줄이지 않음).
        const ci = Math.floor(u), cj = Math.floor(v);
        if (ci < 0 || cj < 0 || ci >= W || cj >= H) continue;
        const bi = rows.of[cj] * Bw + cols.of[ci];
        if (dS < buf[bi]) buf[bi] = dS;
        continue;
      }
      // 원판과 겹칠 수 있는 픽셀 범위(중심 칸 포함)
      const ci = Math.floor(u), cj = Math.floor(v);
      const pc0 = Math.max(0, Math.min(ci, Math.ceil(u - r - 0.5))), pc1 = Math.min(W - 1, Math.max(ci, Math.floor(u + r - 0.5)));
      const pr0 = Math.max(0, Math.min(cj, Math.ceil(v - r - 0.5))), pr1 = Math.min(H - 1, Math.max(cj, Math.floor(v + r - 0.5)));
      if (pc0 > pc1 || pr0 > pr1) continue;
      for (let b = rows.of[pr0]; b <= rows.of[pr1]; b++) {
        const js = rows.start[b], je = rows.end[b];
        if (js < 0) continue;
        const dy = Math.max(Math.abs(js + 0.5 - v), Math.abs(je + 0.5 - v));
        for (let a = cols.of[pc0]; a <= cols.of[pc1]; a++) {
          const is = cols.start[a], ie = cols.end[a];
          if (is < 0) continue;
          const dx = Math.max(Math.abs(is + 0.5 - u), Math.abs(ie + 0.5 - u));
          const centerOnly = is === ie && js === je && is === ci && js === cj;
          if (dx * dx + dy * dy <= r2 || centerOnly) {
            const bi = b * Bw + a;
            if (dS < buf[bi]) buf[bi] = dS;
          }
        }
      }
    }
  }
  // 0 단계: 칸 안 블록 값의 최댓값(하나라도 +∞ 면 +∞). 블록은 칸에 mW×mH 개씩 포개진다.
  const mW = Bw / size, mH = Bh / size;
  const level0 = new Float32Array(size * size);
  for (let cb = 0; cb < size; cb++) {
    for (let ca = 0; ca < size; ca++) {
      let m = -Infinity, anyFilled = false, anyEmpty = false;
      for (let y = 0; y < mH; y++) {
        for (let x = 0; x < mW; x++) {
          const a = ca * mW + x, b = cb * mH + y;
          const val = cols.start[a] < 0 || rows.start[b] < 0 ? Infinity : buf[b * Bw + a];
          if (val === Infinity) anyEmpty = true; else anyFilled = true;
          if (val > m) m = val;
        }
      }
      // 변이: 빈 블록을 무시하고 채워진 블록만으로 칸 값을 정한다(빈자리를 가림막으로 보는 잘못).
      if (mut.emptyAsOccluder && anyEmpty && anyFilled) {
        m = -Infinity;
        for (let y = 0; y < mH; y++) for (let x = 0; x < mW; x++) {
          const val = buf[(cb * mH + y) * Bw + ca * mW + x];
          if (val !== Infinity && val > m) m = val;
        }
      }
      level0[cb * size + ca] = m;
    }
  }
  return { size, levels: buildUpper(level0, size, mut), width: W, height: H, pointSizeM, cameraKey: camKey(camera), degenerate: false, blocks: { w: Bw, h: Bh }, occluderPoints };
}

function assertPyramid(pyr, camera) {
  if (!pyr || typeof pyr !== 'object' || !Array.isArray(pyr.levels)) throw new Error(`${ERR} pyramid 가 {size, levels} 객체가 아님`);
  const size = readSize(pyr.size);
  const L = Math.log2(size) + 1;
  if (pyr.levels.length !== L) throw new Error(`${ERR} pyramid.levels 길이는 ${L} 이어야 함`);
  for (let k = 0; k < L; k++) {
    const s = size >> k;
    if (!(pyr.levels[k] instanceof Float32Array) || pyr.levels[k].length !== s * s) throw new Error(`${ERR} pyramid.levels[${k}] 는 길이 ${s * s} Float32Array`);
  }
  readPointSize(pyr.pointSizeM);
  if (pyr.cameraKey !== camKey(camera)) throw new Error(`${ERR} pyramid 가 이 카메라로 만든 것이 아님`);
}

// ---- 판정 --------------------------------------------------------------------------------

/**
 * 가림 컬링. 리프 상자 전체가 가림막 뒤일 때만 0. pyramid 를 주지 않으면 buildDepthPyramid(hierarchy, camera) 로 만든다.
 * @returns {Uint8Array} 길이 leafCount (1 = 남김, 0 = 제거). 퇴화 시점이면 전부 0.
 */
export function occlusionCull(hierarchy, camera, pyramid) {
  return occlusionCullWith(hierarchy, camera, pyramid, {});
}

/** 변이 주입용 핵심 구현(시험 전용 _mut). */
export function occlusionCullWith(hierarchy, camera, pyramid, mut = {}) {
  assertHierarchy(hierarchy);
  const oc = hierarchy.octree;
  if (degenerateCamera(camera)) return new Uint8Array(oc.leafCount);
  const pyr = pyramid ?? buildDepthPyramidWith(hierarchy, camera, {}, mut);
  assertPyramid(pyr, camera);
  const { size, levels, pointSizeM } = pyr;
  const top = levels.length - 1;
  const { R, t, K, width: W, height: H } = camera;
  const mask = new Uint8Array(oc.leafCount).fill(1);
  let ca0, ca1, cb0, cb1, thresholdZ;
  // 칸 (a,b) @ level 이 덮는 0 단계 칸 범위가 사각형과 겹치는 부분이 모두 가려졌는가
  const hidden = (level, a, b) => {
    const s = size >> level;
    const val = levels[level][b * s + a];
    if (val !== Infinity && thresholdZ > val * (1 + REL) + ABS) return true;
    if (level === 0) return false;
    const L1 = level - 1, span = 1 << L1;
    for (let y = 2 * b; y <= 2 * b + 1; y++) {
      if (y * span > cb1 || (y + 1) * span - 1 < cb0) continue;
      for (let x = 2 * a; x <= 2 * a + 1; x++) {
        if (x * span > ca1 || (x + 1) * span - 1 < ca0) continue;
        if (!hidden(L1, x, y)) return false;
      }
    }
    return true;
  };
  const tb = tightLeafBoxes(hierarchy);
  for (let k = 0; k < oc.leafCount; k++) {
    if (!(tb.mn[3 * k] <= tb.mx[3 * k])) continue; // 점 없는 리프: 이 단계가 판단하지 않는다(남김)
    let zmin = Infinity, umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity, nearHit = false;
    for (let c = 0; c < 8; c++) {
      const X = c & 1 ? tb.mx[3 * k] : tb.mn[3 * k];
      const Y = c & 2 ? tb.mx[3 * k + 1] : tb.mn[3 * k + 1];
      const Z = c & 4 ? tb.mx[3 * k + 2] : tb.mn[3 * k + 2];
      const x = R[0] * X + R[1] * Y + R[2] * Z + t[0];
      const y = R[3] * X + R[4] * Y + R[5] * Z + t[1];
      const z = R[6] * X + R[7] * Y + R[8] * Z + t[2];
      if (!(z > NEAR_M)) { nearHit = true; break; }
      const u = (K.fx * x) / z + K.cx, v = (K.fy * y) / z + K.cy;
      if (z < zmin) zmin = z;
      if (u < umin) umin = u; if (u > umax) umax = u;
      if (v < vmin) vmin = v; if (v > vmax) vmax = v;
    }
    if (nearHit || !Number.isFinite(umin + umax + vmin + vmax)) continue; // 판정 포기 = 남김
    const rmax = mut.noSplatMargin ? 0 : (K.fx * pointSizeM) / (2 * zmin) + 1;
    const i0 = Math.max(0, Math.floor(umin - rmax - 0.5)), i1 = Math.min(W - 1, Math.floor(umax + rmax));
    const j0 = Math.max(0, Math.floor(vmin - rmax - 0.5)), j1 = Math.min(H - 1, Math.floor(vmax + rmax));
    if (i0 > i1 || j0 > j1) continue; // 화면 밖: 시야 컬링 몫이므로 남김
    ca0 = Math.floor((i0 * size) / W); ca1 = Math.floor((i1 * size) / W);
    cb0 = Math.floor((j0 * size) / H); cb1 = Math.floor((j1 * size) / H);
    thresholdZ = zmin;
    if (hidden(top, 0, 0)) mask[k] = 0;
  }
  return mask;
}
