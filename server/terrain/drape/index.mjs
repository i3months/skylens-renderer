// T14.2 지형 드레이프: 위성 영상(rgb, bounds = ENU 범위)에서 64 m 지형 타일 범위를 잘라 밉 단계별 DrapeTile 을 만든다.
// 좌표는 GeoAnchor 기준 ENU, 1 unit = 1 m. 영상과 타일 모두 행 우선, 위(북) → 아래(남).
// 영상 픽셀 (c, r) 은 x ∈ [minX + c·sx, minX + (c+1)·sx], y ∈ [maxY − (r+1)·sy, maxY − r·sy] 를 덮는다(sx = 폭/width, sy = 높이/height).
// 밉 단계 k 의 한 변 픽셀 수 = max(1, round(N0 / 2^k)), N0 = round(64 / s). 각 타일 픽셀은 덮는 영상 영역의 면적 가중 평균(박스 필터)이다.
// 영상 밖 영역은 꾸며 채우지 않는다: 덮이지 않은 픽셀은 rgb 0 이고 coverage.mask 가 0, 타일 전체가 영상 밖이면 TowerAssetError.
import {
  TERRAIN_TILE_SIZE_M, DRAPE_MIP_COUNT, TowerAssetError, tileBounds,
} from '../../../contracts/tower_assets/index.mjs';

// 완전 피복 판정 허용(면적 비).
const FULL_EPS = 1e-9;

/** 입력 영상 검사. 결과로 픽셀 크기(m)를 돌려준다. */
function checkImage(image) {
  if (!image || typeof image !== 'object') throw new TowerAssetError('drape: image 가 없다');
  const { width, height, rgb, bounds } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new TowerAssetError('drape: image width/height 는 양의 정수');
  }
  if (!(rgb instanceof Uint8Array) || rgb.length !== width * height * 3) {
    throw new TowerAssetError('drape: image.rgb 는 width·height·3 길이의 Uint8Array');
  }
  if (!bounds || ![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite)
    || !(bounds.maxX > bounds.minX) || !(bounds.maxY > bounds.minY)) {
    throw new TowerAssetError('drape: image.bounds 가 올바르지 않다');
  }
  return { sx: (bounds.maxX - bounds.minX) / width, sy: (bounds.maxY - bounds.minY) / height };
}

function checkMip(mip) {
  if (!Number.isInteger(mip) || mip < 0 || mip >= DRAPE_MIP_COUNT) {
    throw new TowerAssetError(`drape: mip 은 0..${DRAPE_MIP_COUNT - 1} 정수`);
  }
}

/** 밉 단계별 타일 크기(픽셀). 원본 해상도에서 N0 = round(64 / 픽셀 크기)를 정하고 단계마다 절반. */
export function drapeTileSize(image, mip) {
  const { sx, sy } = checkImage(image);
  checkMip(mip);
  const w0 = Math.max(1, Math.round(TERRAIN_TILE_SIZE_M / sx));
  const h0 = Math.max(1, Math.round(TERRAIN_TILE_SIZE_M / sy));
  const d = 2 ** mip;
  return { width: Math.max(1, Math.round(w0 / d)), height: Math.max(1, Math.round(h0 / d)) };
}

/**
 * 한 축의 겹침 표: 출력 칸 o = [a0 + o·step, a0 + (o+1)·step], 원본 칸 s = [b0 + s·src, b0 + (s+1)·src] 일 때
 * 출력 칸마다 (원본 칸 번호, 겹친 길이) 목록을 만든다. 원본 범위 밖은 목록에 들어가지 않는다.
 */
function overlapTable(a0, step, n, b0, src, count) {
  const table = [];
  for (let o = 0; o < n; o++) {
    const lo = a0 + o * step;
    const hi = a0 + (o + 1) * step;
    const first = Math.max(0, Math.floor((lo - b0) / src));
    const last = Math.min(count - 1, Math.ceil((hi - b0) / src) - 1);
    const idx = [];
    const len = [];
    for (let s = first; s <= last; s++) {
      const l = Math.min(hi, b0 + (s + 1) * src) - Math.max(lo, b0 + s * src);
      if (l > 0) { idx.push(s); len.push(l); }
    }
    table.push({ idx, len });
  }
  return table;
}

/**
 * 위성 영상에서 타일 (tx, ty) 의 밉 단계 mip 드레이프를 만든다.
 * @param {{width:number,height:number,rgb:Uint8Array,bounds:{minX:number,minY:number,maxX:number,maxY:number}}} image
 * @returns DrapeTile + coverage:{ complete, fraction, mask:Uint8Array, bounds }.
 *   coverage.mask[j·width + i] = 피복 면적 비(255 = 완전, 0 = 영상 자료 없음 → rgb 0, 그 사이 = 부분, 덮인 부분만 평균).
 *   fraction = 타일 전체 피복 면적 비, bounds = 타일 ∩ 영상 범위(ENU).
 */
export function buildDrapeTile(image, tx, ty, mip) {
  const { sx, sy } = checkImage(image);
  if (!Number.isInteger(tx) || !Number.isInteger(ty)) throw new TowerAssetError('drape: tx, ty 는 정수');
  const { width, height } = drapeTileSize(image, mip);
  const tb = tileBounds(tx, ty);
  const ib = image.bounds;
  const cb = {
    minX: Math.max(tb.minX, ib.minX), minY: Math.max(tb.minY, ib.minY),
    maxX: Math.min(tb.maxX, ib.maxX), maxY: Math.min(tb.maxY, ib.maxY),
  };
  if (!(cb.maxX > cb.minX) || !(cb.maxY > cb.minY)) {
    throw new TowerAssetError(`drape: 타일 (${tx}, ${ty}) 이 영상 범위 밖`);
  }
  const pw = TERRAIN_TILE_SIZE_M / width;
  const ph = TERRAIN_TILE_SIZE_M / height;
  // x 는 서 → 동, 행은 북 → 남이므로 y 축은 영상 maxY 에서 내려간 거리로 다룬다.
  const cols = overlapTable(tb.minX, pw, width, ib.minX, sx, image.width);
  const rows = overlapTable(ib.maxY - tb.maxY, ph, height, 0, sy, image.height);
  const rgb = new Uint8Array(width * height * 3);
  const mask = new Uint8Array(width * height);
  const src = image.rgb;
  const W = image.width;
  const pixArea = pw * ph;
  let covered = 0;
  for (let j = 0; j < height; j++) {
    const R = rows[j];
    for (let i = 0; i < width; i++) {
      const C = cols[i];
      let r = 0, g = 0, b = 0, a = 0;
      for (let p = 0; p < R.idx.length; p++) {
        const rowOff = R.idx[p] * W;
        const ly = R.len[p];
        for (let q = 0; q < C.idx.length; q++) {
          const w = ly * C.len[q];
          const s = (rowOff + C.idx[q]) * 3;
          r += src[s] * w; g += src[s + 1] * w; b += src[s + 2] * w; a += w;
        }
      }
      if (a > 0) {
        // 덮인 부분만으로 평균한다(밖을 꾸며 넣지 않음).
        const o = j * width + i;
        rgb[o * 3] = Math.round(r / a);
        rgb[o * 3 + 1] = Math.round(g / a);
        rgb[o * 3 + 2] = Math.round(b / a);
        const f = a / pixArea;
        mask[o] = f >= 1 - FULL_EPS ? 255 : Math.min(254, Math.max(1, Math.round(255 * f)));
        covered += a;
      }
    }
  }
  const raw = covered / (TERRAIN_TILE_SIZE_M * TERRAIN_TILE_SIZE_M);
  const complete = raw >= 1 - FULL_EPS;
  return {
    tx, ty, mip, width, height, rgb,
    coverage: { complete, fraction: complete ? 1 : raw, mask, bounds: cb },
  };
}

/** 타일 픽셀 좌표(i 동쪽, j 남쪽; 픽셀 중심 = 정수 + 0.5) → ENU. */
export function tilePixelToEnu(tile, i, j) {
  const tb = tileBounds(tile.tx, tile.ty);
  return { x: tb.minX + i * (TERRAIN_TILE_SIZE_M / tile.width), y: tb.maxY - j * (TERRAIN_TILE_SIZE_M / tile.height) };
}

/** ENU → 타일 픽셀 좌표(연속값). */
export function enuToTilePixel(tile, x, y) {
  const tb = tileBounds(tile.tx, tile.ty);
  return { i: (x - tb.minX) / (TERRAIN_TILE_SIZE_M / tile.width), j: (tb.maxY - y) / (TERRAIN_TILE_SIZE_M / tile.height) };
}

/** 원본 영상의 누적 합 표(채널별, (H+1)·(W+1)). 연속 적분은 격자 칸 안에서 쌍선형이라 보간으로 정확한 박스 합을 준다. */
function summedArea(image) {
  const W = image.width, H = image.height, src = image.rgb, W1 = W + 1;
  const S = new Float64Array(W1 * (H + 1) * 3);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      for (let k = 0; k < 3; k++) {
        S[((r + 1) * W1 + c + 1) * 3 + k] = src[(r * W + c) * 3 + k]
          + S[(r * W1 + c + 1) * 3 + k] + S[((r + 1) * W1 + c) * 3 + k] - S[(r * W1 + c) * 3 + k];
      }
    }
  }
  return S;
}

/** 누적 합의 연속 값 (u 열, v 행; 원본 픽셀 단위, 0 ≤ u ≤ W, 0 ≤ v ≤ H). */
function integral(S, W, u, v, k) {
  const W1 = W + 1;
  const cu = Math.min(Math.floor(u), W), rv = Math.floor(v);
  const fu = u - cu, fv = v - rv;
  const cu1 = fu > 0 ? cu + 1 : cu;
  const rv1 = fv > 0 ? rv + 1 : rv;
  const at = (r, c) => S[(r * W1 + c) * 3 + k];
  return (1 - fv) * ((1 - fu) * at(rv, cu) + fu * at(rv, cu1)) + fv * ((1 - fu) * at(rv1, cu) + fu * at(rv1, cu1));
}

/**
 * 좌표 정합 오차 측정. 타일 픽셀↔ENU 사상을 (dx, dy) 타일 픽셀만큼 옮겨 가며, 원본 영상의 박스 평균(누적 합 표로 따로 계산)과
 * 타일 내용의 평균 제곱 차를 가장 작게 하는 이동량을 찾는다(±3 px, 1/32 px 까지 정밀화). 완전 피복 픽셀만 쓴다.
 * @returns {{maxMisalignPx:number, dxPx:number, dyPx:number, rms:number, samples:number}}
 *   maxMisalignPx = hypot(dx, dy) (타일 픽셀 단위), dx 는 동쪽, dy 는 남쪽(행 증가) 방향.
 */
export function measureDrapeAlignment(image, tile) {
  const { sx, sy } = checkImage(image);
  if (!tile || !(tile.rgb instanceof Uint8Array) || !Number.isInteger(tile.width) || !Number.isInteger(tile.height)
    || tile.rgb.length !== tile.width * tile.height * 3) {
    throw new TowerAssetError('drape: tile 이 올바르지 않다');
  }
  const S = summedArea(image);
  const W = image.width, H = image.height;
  const ib = image.bounds;
  const tb = tileBounds(tile.tx, tile.ty);
  const pw = TERRAIN_TILE_SIZE_M / tile.width, ph = TERRAIN_TILE_SIZE_M / tile.height;
  const mask = tile.coverage?.mask;
  const eps = 1e-9;

  const cost = (dx, dy) => {
    let sum = 0, n = 0;
    for (let j = 0; j < tile.height; j++) {
      const v0 = (ib.maxY - (tb.maxY - (j + dy) * ph)) / sy;
      const v1 = v0 + ph / sy;
      if (v0 < -eps || v1 > H + eps) continue;
      const cv0 = Math.max(0, v0), cv1 = Math.min(H, v1);
      for (let i = 0; i < tile.width; i++) {
        const o = j * tile.width + i;
        if (mask && mask[o] !== 255) continue;
        const u0 = (tb.minX + (i + dx) * pw - ib.minX) / sx;
        const u1 = u0 + pw / sx;
        if (u0 < -eps || u1 > W + eps) continue;
        const cu0 = Math.max(0, u0), cu1 = Math.min(W, u1);
        const area = (cu1 - cu0) * (cv1 - cv0);
        for (let k = 0; k < 3; k++) {
          const ref = (integral(S, W, cu1, cv1, k) - integral(S, W, cu0, cv1, k)
            - integral(S, W, cu1, cv0, k) + integral(S, W, cu0, cv0, k)) / area;
          const d = tile.rgb[o * 3 + k] - ref;
          sum += d * d;
        }
        n++;
      }
    }
    return n > 0 ? { mse: sum / (n * 3), n } : { mse: Infinity, n: 0 };
  };

  // 탐색: 작은 이동량부터 보고, 엄격히 더 작을 때만 바꾼다(동률이면 0 에 가까운 쪽 → 결정적).
  let best = { dx: 0, dy: 0, ...cost(0, 0) };
  const refine = (cx, cy, radius, step) => {
    const m = Math.round(radius / step);
    const cand = [];
    for (let a = -m; a <= m; a++) for (let b = -m; b <= m; b++) cand.push([cx + a * step, cy + b * step]);
    cand.sort((p, q) => (Math.hypot(p[0], p[1]) - Math.hypot(q[0], q[1])) || (p[1] - q[1]) || (p[0] - q[0]));
    for (const [dx, dy] of cand) {
      const c = cost(dx, dy);
      if (c.mse < best.mse - 1e-9 * (1 + best.mse)) best = { dx, dy, ...c };
    }
  };
  refine(0, 0, 3, 0.5);
  refine(best.dx, best.dy, 0.5, 0.125);
  refine(best.dx, best.dy, 0.125, 1 / 32);
  if (best.n === 0) throw new TowerAssetError('drape: 정합을 잴 완전 피복 픽셀이 없다');
  return { maxMisalignPx: Math.hypot(best.dx, best.dy), dxPx: best.dx, dyPx: best.dy, rms: Math.sqrt(best.mse), samples: best.n };
}
