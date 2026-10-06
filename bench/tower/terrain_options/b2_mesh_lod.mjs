// T15.10b-B2 비교안 (iii): 면 법선 오차 상한(C1, 7.5°)을 지형 LOD 간격 선택 규칙으로 쓰는 mesh_lod 변형.
// server/terrain/mesh_lod/index.mjs 의 간격 규칙을 이 파일 안에 복사해 바꾼 것이다. 서버 코드·계약은 바꾸지 않는다.
//
// 규칙(서버와 같은 틀): LOD k 의 명목 간격 2^k(DEM 셀 단위)에서 시작해, DEM 이 덮는 타일 가운데 하나라도 상한을 넘으면
//   간격을 절반으로 줄여 다시 잰다(간격 1 = 원본이면 오차 0 이라 반드시 끝난다). 간격은 DEM 하나·LOD 하나에 전역이다(T 접합 방지, 서버와 같음).
// 상한은 두 가지를 고를 수 있다(둘 다 주면 둘 다 만족해야 한다):
//   - heightCapsM[lod]: 메시 표면 높이 오차 상한(m). 서버 TERRAIN_LOD_MAX_ERROR_M 과 같은 지표(DEM 표본점에서 잰 최대 |Δz|).
//   - normalCapDeg[lod]: 면 법선 오차 상한(도). 정의는 아래(주 정의).
//   - vertexNormalCapDeg[lod]: 보조 정의 — 보간 정점 법선 오차 상한(도). tileMinVertexNormalCos 참조.
//     결정 0046 C1 행(커밋 84113df1)의 정확한 지표 정의는 이 저장소에 없어(브랜치·커밋 부재) 재현하지 못했다. 그래서 '면 법선'을 문자 그대로 읽은 주 정의와,
//     음영이 실제로 쓰는 정점 법선 보간(결정 0046 선택지 D)으로 읽은 보조 정의를 둘 다 둔다. 상한 7.5° 는 둘 다 같고 측정값을 보고 바꾸지 않는다.
// 면 법선 오차 정의: 원본 DEM 메시(LOD 0, 대각선 (i,j)–(i+1,j+1))의 작은 삼각형 하나하나에 대해, 그 삼각형을 통째로 담는
//   거친 타일 삼각형(같은 대각선 규약)의 면 법선과 작은 삼각형 면 법선 사이 각의 최댓값(타일 안 전체).
//   서버 주석대로 작은 삼각형은 거친 삼각형 하나 안에 통째로 들어가므로(칸 변이 DEM 격자선 위, 칸 대각선이 DEM 셀 대각선을 따름)
//   이 값이 타일 표면 전체에서 '그려지는 면 법선' 과 '원본 면 법선' 의 정확한 최대 각 차다.
//   층·기준 영상은 정점 법선 보간 음영(결정 0046 선택지 D)이라 이 값은 음영 오차의 대리 지표이지 화소 색 오차 상한이 아니다.
// 출력 타일 형식은 서버 buildTerrainTile 과 같다({ tx, ty, lod, cells, heights }) — terrainTileToMesh·createTerrainLayer 에 그대로 넣는다.
import { TERRAIN_TILE_SIZE_M, TERRAIN_LOD_COUNT } from '../../../contracts/tower_assets/index.mjs';

const ALIGN_EPS = 1e-6;

function nearInt(v) {
  const r = Math.round(v);
  return Math.abs(v - r) <= ALIGN_EPS ? r : null;
}

/** 타일 한 변의 DEM 셀 수(서버 checkDem 의 정렬 조건만 복사, 입력 검사는 측정용이라 최소한만). */
function tileCells(dem) {
  const n0 = nearInt(TERRAIN_TILE_SIZE_M / dem.cellM);
  if (n0 === null || n0 < 1) throw new RangeError('타일 한 변이 cellM 의 정수배가 아니다');
  return n0;
}

function nominalStride(n0, lod) {
  let s = 1;
  while (s < (1 << lod) && n0 % (s * 2) === 0) s *= 2;
  return s;
}

function coveredTileOrigins(dem, n0) {
  const out = [];
  const t = TERRAIN_TILE_SIZE_M;
  const txMin = Math.ceil(dem.originX / t - ALIGN_EPS) + 0;
  const tyMin = Math.ceil(dem.originY / t - ALIGN_EPS) + 0;
  for (let ty = tyMin; ; ty++) {
    const j0 = nearInt((ty * t - dem.originY) / dem.cellM);
    if (j0 === null || j0 + n0 > dem.height - 1) break;
    for (let tx = txMin; ; tx++) {
      const i0 = nearInt((tx * t - dem.originX) / dem.cellM);
      if (i0 === null || i0 + n0 > dem.width - 1) break;
      out.push([i0, j0, tx, ty]);
    }
  }
  return out;
}

function tileOrigin(dem, n0, tx, ty) {
  const i0 = nearInt((tx * TERRAIN_TILE_SIZE_M - dem.originX) / dem.cellM);
  const j0 = nearInt((ty * TERRAIN_TILE_SIZE_M - dem.originY) / dem.cellM);
  if (i0 === null || j0 === null || i0 < 0 || j0 < 0 || i0 + n0 > dem.width - 1 || j0 + n0 > dem.height - 1) {
    throw new RangeError(`타일 (${tx}, ${ty}) 이 DEM 범위를 벗어나거나 격자에 맞지 않는다`);
  }
  return { i0, j0 };
}

/** 높이 오차(서버 gridError 와 같은 식, 부분 표본 정점 기준). stride 1 이면 0. */
export function tileHeightError(dem, i0, j0, n0, stride) {
  if (stride === 1) return 0;
  const n = n0 / stride;
  const w = dem.width;
  const h = dem.heights;
  const z = (ci, cj) => h[(j0 + cj * stride) * w + i0 + ci * stride];
  let max = 0;
  for (let j = 0; j <= n0; j++) {
    const cj = Math.min(Math.floor(j / stride), n - 1);
    const fy = (j - cj * stride) / stride;
    for (let i = 0; i <= n0; i++) {
      const ci = Math.min(Math.floor(i / stride), n - 1);
      const fx = (i - ci * stride) / stride;
      const z00 = z(ci, cj), z11 = z(ci + 1, cj + 1);
      const v = fx >= fy
        ? z00 + fx * (z(ci + 1, cj) - z00) + fy * (z11 - z(ci + 1, cj))
        : z00 + fy * (z(ci, cj + 1) - z00) + fx * (z11 - z(ci, cj + 1));
      const e = Math.abs(v - h[(j0 + j) * w + (i0 + i)]);
      if (e > max) max = e;
    }
  }
  return max;
}

// 기울기 (sx, sy) 인 평면 z = sx·x + sy·y 의 법선 ∝ (−sx, −sy, 1). 두 법선 사이 각의 cos.
function cosBetween(sx1, sy1, sx2, sy2) {
  const d = sx1 * sx2 + sy1 * sy2 + 1;
  return d / Math.sqrt((sx1 * sx1 + sy1 * sy1 + 1) * (sx2 * sx2 + sy2 * sy2 + 1));
}

/**
 * 타일 하나의 최소 cos(= 최대 면 법선 오차 각의 cos). stride 1 이면 1(오차 0).
 * 삼각형 규약(terrainTileToMesh): 아래 삼각형 a(i,j)·b(i+1,j)·e(i+1,j+1) → sx=(z10−z00)/c, sy=(z11−z10)/c,
 *   위 삼각형 a·e·d(i,j+1) → sx=(z11−z01)/c, sy=(z01−z00)/c.
 * 작은 칸 국소 번호 (li, lj)(거친 칸 안 0..stride−1): 작은 아래 삼각형은 li ≥ lj 면 거친 아래, 아니면 거친 위 삼각형에 들어가고,
 *   작은 위 삼각형은 li ≤ lj 면 거친 위, 아니면 거친 아래 삼각형에 들어간다.
 * minCosStop 보다 작아지면 바로 돌려준다(상한 판정용 조기 종료).
 */
export function tileMinNormalCos(dem, i0, j0, n0, stride, minCosStop = -Infinity) {
  if (stride === 1) return 1;
  const w = dem.width;
  const h = dem.heights;
  const c = dem.cellM;
  const C = c * stride;
  const n = n0 / stride;
  const at = (i, j) => h[(j0 + j) * w + i0 + i];
  let minCos = 1;
  for (let cj = 0; cj < n; cj++) {
    for (let ci = 0; ci < n; ci++) {
      const I = ci * stride, J = cj * stride;
      const Z00 = at(I, J), Z10 = at(I + stride, J), Z01 = at(I, J + stride), Z11 = at(I + stride, J + stride);
      const lsx = (Z10 - Z00) / C, lsy = (Z11 - Z10) / C; // 거친 아래 삼각형
      const usx = (Z11 - Z01) / C, usy = (Z01 - Z00) / C; // 거친 위 삼각형
      for (let lj = 0; lj < stride; lj++) {
        for (let li = 0; li < stride; li++) {
          const i = I + li, j = J + lj;
          const z00 = at(i, j), z10 = at(i + 1, j), z01 = at(i, j + 1), z11 = at(i + 1, j + 1);
          const a = li >= lj
            ? cosBetween((z10 - z00) / c, (z11 - z10) / c, lsx, lsy)
            : cosBetween((z10 - z00) / c, (z11 - z10) / c, usx, usy);
          const b = li <= lj
            ? cosBetween((z11 - z01) / c, (z01 - z00) / c, usx, usy)
            : cosBetween((z11 - z01) / c, (z01 - z00) / c, lsx, lsy);
          const m = a < b ? a : b;
          if (m < minCos) {
            minCos = m;
            if (minCos < minCosStop) return minCos;
          }
        }
      }
    }
  }
  return minCos;
}

/**
 * 보조 정의(정점 법선 오차) 준비: DEM 전체에서 간격 stride 격자의 정점 법선(단위 벡터)을 만든다.
 * 클라이언트 mesh.mjs 와 같은 방식 — 정점에 닿는 삼각형(같은 대각선 규약, 최대 6개)의 정규화 전 외적을 더해 단위화.
 * 격자는 DEM 표본 (ox + k·stride, oy + l·stride) 이다(ox, oy = 타일 원점 표본 번호를 stride 로 나눈 나머지, 타일끼리 같다).
 * 타일 경계 정점은 이웃 타일 삼각형까지 합한다(DEM 전체가 도착했다고 본 값, 층은 위치가 같은 정점 법선을 공유한다).
 */
export function vertexNormalGrid(dem, stride, ox, oy) {
  const nx = Math.floor((dem.width - 1 - ox) / stride) + 1;
  const ny = Math.floor((dem.height - 1 - oy) / stride) + 1;
  const h = dem.heights, w = dem.width, c = dem.cellM * stride;
  const z = (k, l) => h[(oy + l * stride) * w + ox + k * stride];
  const acc = new Float64Array(nx * ny * 3);
  const add = (k, l, x, y, zz) => { const p = 3 * (l * nx + k); acc[p] += x; acc[p + 1] += y; acc[p + 2] += zz; };
  for (let l = 0; l < ny - 1; l++) {
    for (let k = 0; k < nx - 1; k++) {
      const z00 = z(k, l), z10 = z(k + 1, l), z01 = z(k, l + 1), z11 = z(k + 1, l + 1);
      // 아래 삼각형 a·b·e: 외적 = (−c(z10−z00), −c(z11−z10), c²)
      let x = -c * (z10 - z00), y = -c * (z11 - z10), q = c * c;
      add(k, l, x, y, q); add(k + 1, l, x, y, q); add(k + 1, l + 1, x, y, q);
      // 위 삼각형 a·e·d: 외적 = (−c(z11−z01), −c(z01−z00), c²)
      x = -c * (z11 - z01); y = -c * (z01 - z00);
      add(k, l, x, y, q); add(k + 1, l + 1, x, y, q); add(k, l + 1, x, y, q);
    }
  }
  for (let p = 0; p < acc.length; p += 3) {
    const len = Math.hypot(acc[p], acc[p + 1], acc[p + 2]);
    acc[p] /= len; acc[p + 1] /= len; acc[p + 2] /= len;
  }
  return { nx, ny, ox, oy, stride, n: acc };
}

/**
 * 보조 정의: 타일 안 모든 DEM 표본점에서, 거친 메시의 보간 정점 법선(세 꼭짓점 단위 법선의 무게중심 보간 후 단위화 — 층 래스터와 같은 방식)과
 * 원본 메시(LOD 0)의 정점 법선 사이 각의 최소 cos. 기준 영상은 LOD 0 의 보간 정점 법선이고, DEM 표본점에서 그 값은 그 표본의 정점 법선이다.
 * 표본점에서만 재므로 표본 사이(LOD 0 삼각형 내부)의 차이는 재지 않는다.
 */
export function tileMinVertexNormalCos(fine, coarse, i0, j0, n0, stride, minCosStop = -Infinity, out = null) {
  // out: 시험용. 주면 표본점마다 cos 를 (j, i) 행 우선으로 넣는다(조기 종료와 함께 쓰지 않는다).
  if (stride === 1) return 1;
  const n = n0 / stride;
  const fn = fine.n, cn = coarse.n;
  const ck0 = (i0 - coarse.ox) / stride, cl0 = (j0 - coarse.oy) / stride;
  const cIdx = (k, l) => 3 * ((cl0 + l) * coarse.nx + ck0 + k);
  let minCos = 1;
  for (let j = 0; j <= n0; j++) {
    const cj = Math.min(Math.floor(j / stride), n - 1);
    const fy = (j - cj * stride) / stride;
    for (let i = 0; i <= n0; i++) {
      const ci = Math.min(Math.floor(i / stride), n - 1);
      const fx = (i - ci * stride) / stride;
      const a = cIdx(ci, cj), e = cIdx(ci + 1, cj + 1);
      let x, y, q;
      if (fx >= fy) {
        const b = cIdx(ci + 1, cj), wa = 1 - fx, wb = fx - fy, we = fy;
        x = wa * cn[a] + wb * cn[b] + we * cn[e]; y = wa * cn[a + 1] + wb * cn[b + 1] + we * cn[e + 1]; q = wa * cn[a + 2] + wb * cn[b + 2] + we * cn[e + 2];
      } else {
        const d = cIdx(ci, cj + 1), wa = 1 - fy, wd = fy - fx, we = fx;
        x = wa * cn[a] + wd * cn[d] + we * cn[e]; y = wa * cn[a + 1] + wd * cn[d + 1] + we * cn[e + 1]; q = wa * cn[a + 2] + wd * cn[d + 2] + we * cn[e + 2];
      }
      const f = 3 * ((j0 + j - fine.oy) * fine.nx + (i0 + i - fine.ox));
      const cos = (x * fn[f] + y * fn[f + 1] + q * fn[f + 2]) / Math.hypot(x, y, q);
      if (out) out.push(cos);
      if (cos < minCos) {
        minCos = cos;
        if (minCos < minCosStop) return minCos;
      }
    }
  }
  return minCos;
}

/** cos → 도(반올림 오차로 1 을 살짝 넘는 값은 1 로). */
export function cosToDeg(v) {
  return (Math.acos(Math.min(1, Math.max(-1, v))) * 180) / Math.PI;
}

function tileHasNonFinite(dem, i0, j0, n0) {
  for (let j = j0; j <= j0 + n0; j++) {
    for (let i = i0; i <= i0 + n0; i++) if (!Number.isFinite(dem.heights[j * dem.width + i])) return true;
  }
  return false;
}

/**
 * 변형 규칙 하나를 만든다.
 * @param {{ name:string, heightCapsM?:number[]|null, normalCapDeg?:number[]|null }} rule
 *   heightCapsM·normalCapDeg 는 길이 TERRAIN_LOD_COUNT 배열(null/undefined 면 그 지표를 쓰지 않는다). 항목이 null 이면 그 LOD 에서 쓰지 않는다.
 */
export function createLodRule(rule) {
  const { name, heightCapsM = null, normalCapDeg = null, vertexNormalCapDeg = null } = rule;
  if (!heightCapsM && !normalCapDeg && !vertexNormalCapDeg) throw new RangeError('상한이 하나도 없다');
  const cache = new WeakMap(); // heights → LOD 별 간격
  const vnCache = new WeakMap(); // heights → (stride → 정점 법선 격자)

  function normalsAt(dem, n0, stride) {
    let m = vnCache.get(dem.heights);
    if (!m) { m = new Map(); vnCache.set(dem.heights, m); }
    if (!m.has(stride)) {
      const [i0, j0] = coveredTileOrigins(dem, n0)[0];
      m.set(stride, vertexNormalGrid(dem, stride, i0 % stride, j0 % stride));
    }
    return m.get(stride);
  }

  function lodStride(dem, lod) {
    const n0 = tileCells(dem);
    let entry = cache.get(dem.heights);
    if (!entry) { entry = new Array(TERRAIN_LOD_COUNT).fill(0); cache.set(dem.heights, entry); }
    if (entry[lod]) return entry[lod];
    const hCap = heightCapsM ? heightCapsM[lod] : null;
    const nCap = normalCapDeg ? normalCapDeg[lod] : null;
    const cosCap = nCap === null || nCap === undefined ? null : Math.cos((nCap * Math.PI) / 180);
    const vCap = vertexNormalCapDeg ? vertexNormalCapDeg[lod] : null;
    const vCosCap = vCap === null || vCap === undefined ? null : Math.cos((vCap * Math.PI) / 180);
    const tiles = coveredTileOrigins(dem, n0).filter(([i0, j0]) => !tileHasNonFinite(dem, i0, j0, n0));
    let stride = nominalStride(n0, lod);
    while (stride > 1) {
      let ok = true;
      for (const [i0, j0] of tiles) {
        if (hCap !== null && hCap !== undefined && tileHeightError(dem, i0, j0, n0, stride) > hCap) { ok = false; break; }
        if (cosCap !== null && tileMinNormalCos(dem, i0, j0, n0, stride, cosCap) < cosCap) { ok = false; break; }
        if (vCosCap !== null && tileMinVertexNormalCos(normalsAt(dem, n0, 1), normalsAt(dem, n0, stride), i0, j0, n0, stride, vCosCap) < vCosCap) { ok = false; break; }
      }
      if (ok) break;
      stride /= 2;
    }
    entry[lod] = stride;
    return stride;
  }

  /** 서버 buildTerrainTile 과 같은 출력, 간격만 이 규칙으로. */
  function buildTile(dem, tx, ty, lod) {
    const n0 = tileCells(dem);
    const { i0, j0 } = tileOrigin(dem, n0, tx, ty);
    const stride = lodStride(dem, lod);
    const cells = n0 / stride + 1;
    const out = new Float32Array(cells * cells);
    for (let j = 0; j < cells; j++) {
      const row = (j0 + j * stride) * dem.width + i0;
      for (let i = 0; i < cells; i++) out[j * cells + i] = dem.heights[row + i * stride];
    }
    return { tx, ty, lod, cells, heights: out };
  }

  /** 주어진 간격에서 DEM 전체 타일의 최대 높이 오차(m)·최대 면 법선 오차(도)·최대 정점 법선 오차(도, 보조). 보고용(조기 종료 없음). */
  function strideStats(dem, stride) {
    const n0 = tileCells(dem);
    let maxH = 0, minCos = 1, minVCos = 1;
    for (const [i0, j0] of coveredTileOrigins(dem, n0)) {
      if (tileHasNonFinite(dem, i0, j0, n0)) continue;
      const e = tileHeightError(dem, i0, j0, n0, stride);
      if (e > maxH) maxH = e;
      const c = tileMinNormalCos(dem, i0, j0, n0, stride);
      if (c < minCos) minCos = c;
      const v = tileMinVertexNormalCos(normalsAt(dem, n0, 1), normalsAt(dem, n0, stride), i0, j0, n0, stride);
      if (v < minVCos) minVCos = v;
    }
    return { maxHeightErrM: maxH, maxNormalErrDeg: cosToDeg(minCos), maxVertexNormalErrDeg: cosToDeg(minVCos) };
  }

  return { name, heightCapsM, normalCapDeg, vertexNormalCapDeg, lodStride, buildTile, strideStats };
}
