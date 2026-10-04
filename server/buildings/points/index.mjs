// T14.5 건물 표시 옵션 '점'용 표면 표본. 좌표는 ENU, 1 unit = 1 m.
import { TowerAssetError } from '../../../contracts/tower_assets/index.mjs';

/** 표본 밀도(개/m²). 근거: 점 표시에서 건물 윤곽이 읽히려면 약 0.5 m 간격 → 4 개/m² 는 과하고, 20 m² 당 1개(0.05)면 주택 한 동도 형태가 보인다. */
export const POINT_DENSITY_PER_M2 = 0.05;
/** 동별 표본 최소 수. 근거: 육면체 꼭짓점 수(8)보다 적으면 형태가 사라진다. */
export const POINT_MIN_PER_BUILDING = 8;
/** 동별 표본 최대 수. 근거: 대형 동 한 채가 전송·그리기 예산을 독점하지 않도록 상한(2000 점 × 12 B = 24 KB). */
export const POINT_MAX_PER_BUILDING = 2000;
/** 위를 향한 삼각형(지붕) 판정 문턱: 법선 z 성분 비율이 이 값보다 크면 지붕. */
export const ROOF_NORMAL_Z_MIN = 0.5;
/** 아래를 향한 삼각형(바닥 덮개) 판정 문턱: 법선 z 성분 비율이 -이 값보다 작으면 바닥. 바닥은 보이지 않으므로 표본을 뿌리지 않는다. */
export const FLOOR_NORMAL_Z_MAX = 0.5;

export const DEFAULT_POINT_RULE = Object.freeze({
  density: POINT_DENSITY_PER_M2,
  min: POINT_MIN_PER_BUILDING,
  max: POINT_MAX_PER_BUILDING,
});

// 규칙 검증: density 는 0 이상 유한수, min·max 는 0 이상 정수이고 min <= max. 빈 객체·NaN 은 조용히 0점이 되므로 던진다.
function checkRule(rule) {
  if (!rule || !Number.isFinite(rule.density) || rule.density < 0
    || !Number.isInteger(rule.min) || !Number.isInteger(rule.max) || rule.min < 0 || rule.min > rule.max) {
    throw new TowerAssetError('points: rule 은 {density>=0 유한, min<=max 인 0 이상 정수} 여야 한다');
  }
}

/**
 * 동별 표본 수 = clamp(ceil((지붕 넓이 + 벽 넓이) × 밀도), 최소, 최대).
 * 벽 넓이는 지붕 넓이가 정사각형이라 보고 둘레 4·√지붕넓이 × 높이로 잡는다.
 * @param {number} areaM2 지붕 넓이(m²)
 * @param {number} heightM 건물 높이(m)
 * @param {{density:number,min:number,max:number}} [rule]
 */
export function samplesFor(areaM2, heightM, rule = DEFAULT_POINT_RULE) {
  checkRule(rule);
  if (!(areaM2 >= 0) || !(heightM >= 0) || !Number.isFinite(areaM2) || !Number.isFinite(heightM)) {
    throw new TowerAssetError('samplesFor: 넓이·높이는 0 이상의 유한수여야 한다');
  }
  const wall = 4 * Math.sqrt(areaM2) * heightM;
  const n = Math.ceil((areaM2 + wall) * rule.density);
  return Math.min(rule.max, Math.max(rule.min, n));
}

/** 결정적 난수(mulberry32). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** id 를 시드로 섞는다(인접 id 가 비슷한 흐름을 만들지 않도록). */
function seedOf(id) {
  let h = (id >>> 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * 메시 표면 표본. 삼각형은 넓이 비례로 고르고 삼각형 안은 균일(무게중심 좌표).
 * @param {{positions:Float32Array, indices:Uint32Array}} mesh
 * @param {number} id u32 안정 식별자(시드)
 * @param {{density:number,min:number,max:number}} [rule]
 * @returns {Float32Array} xyz 연속
 */
export function sampleBuildingPoints(mesh, id, rule = DEFAULT_POINT_RULE) {
  if (!mesh || !mesh.positions || !mesh.indices) throw new TowerAssetError('sampleBuildingPoints: mesh 가 필요하다');
  const p = mesh.positions, idx = mesh.indices;
  checkRule(rule);
  const tris = idx.length / 3;
  if (!Number.isInteger(tris) || tris < 1) throw new TowerAssetError('sampleBuildingPoints: 삼각형이 없다');
  for (let i = 0; i < p.length; i++) {
    if (!Number.isFinite(p[i])) throw new TowerAssetError('sampleBuildingPoints: 정점 좌표가 유한하지 않다');
  }
  for (let i = 0; i < idx.length; i++) {
    if (!Number.isInteger(idx[i]) || idx[i] < 0 || !(idx[i] * 3 + 2 < p.length)) throw new TowerAssetError('sampleBuildingPoints: 인덱스가 정점 범위 밖이다');
  }
  const cum = new Float64Array(tris);
  let total = 0, roof = 0, zMin = Infinity, zMax = -Infinity;
  for (let t = 0; t < tris; t++) {
    const a = idx[3 * t] * 3, b = idx[3 * t + 1] * 3, c = idx[3 * t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    // 아래 향 삼각형(바닥 덮개)은 넓이를 0 으로 세어 cum 에서 뺀다. 이진 탐색은 구간 폭 0 칸을 고르지 않는다.
    const down = len > 0 && nz / len < -FLOOR_NORMAL_Z_MAX;
    const area = down ? 0 : len / 2;
    if (len > 0 && nz / len > ROOF_NORMAL_Z_MIN) roof += area;
    total += area;
    cum[t] = total;
    for (const o of [a, b, c]) { zMin = Math.min(zMin, p[o + 2]); zMax = Math.max(zMax, p[o + 2]); }
  }
  if (!(total > 0)) throw new TowerAssetError('sampleBuildingPoints: 표면 넓이가 0 이다');
  const n = samplesFor(roof, zMax - zMin, rule);
  const rnd = mulberry32(seedOf(id));
  const out = new Float32Array(n * 3);
  for (let s = 0; s < n; s++) {
    const target = rnd() * total;
    let lo = 0, hi = tris - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] > target) hi = m; else lo = m + 1; }
    const a = idx[3 * lo] * 3, b = idx[3 * lo + 1] * 3, c = idx[3 * lo + 2] * 3;
    const r1 = Math.sqrt(rnd()), r2 = rnd();
    const wa = 1 - r1, wb = r1 * (1 - r2), wc = r1 * r2;
    for (let k = 0; k < 3; k++) out[3 * s + k] = wa * p[a + k] + wb * p[b + k] + wc * p[c + k];
  }
  return out;
}
