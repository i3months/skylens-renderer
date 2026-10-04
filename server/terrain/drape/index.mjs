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
/** 타일 한 변 픽셀 상한(밉 0). 0.015625 m/px 보다 촘촘한 영상은 타일 하나가 4096² 를 넘으므로 거부한다(메모리 폭주 방지). */
export const MAX_DRAPE_TILE_PX = 4096;

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
  if (w0 > MAX_DRAPE_TILE_PX || h0 > MAX_DRAPE_TILE_PX) {
    throw new TowerAssetError(`drape: 타일 한 변 ${Math.max(w0, h0)} px 가 상한 ${MAX_DRAPE_TILE_PX} px 초과(영상 픽셀이 너무 촘촘함)`);
  }
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
  checkTile(tile);
  const tb = tileBounds(tile.tx, tile.ty);
  return { x: tb.minX + i * (TERRAIN_TILE_SIZE_M / tile.width), y: tb.maxY - j * (TERRAIN_TILE_SIZE_M / tile.height) };
}

/** ENU → 타일 픽셀 좌표(연속값). */
export function enuToTilePixel(tile, x, y) {
  checkTile(tile);
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

/** 정합 측정 블록 한 변(타일 픽셀). */
export const ALIGN_BLOCK_PX = 16;
// 전역 이동량 탐색 반경 상한(타일 픽셀). 실제 반경 = clamp(타일 짧은 변 / 8, 2, 8):
// 픽셀이 적은 높은 밉에서 큰 반경은 무늬 주기 일치(가짜 최소)를 부른다.
const GLOBAL_SEARCH_PX = 8;
// 블록별 이동량 탐색 반경(타일 픽셀). 전역 이동량을 중심으로 이만큼 더 찾는다.
// 무늬 주기와 겹치는 큰 반경은 엉뚱한 주기 일치를 부르므로 전역값 기준 작은 범위만 본다.
const BLOCK_SEARCH_PX = 4;

/** 측정용 타일 검사: 크기·rgb 길이·tx/ty 정수. */
function checkTile(tile) {
  if (!tile || !(tile.rgb instanceof Uint8Array) || !Number.isInteger(tile.width) || !Number.isInteger(tile.height)
    || tile.width <= 0 || tile.height <= 0 || tile.rgb.length !== tile.width * tile.height * 3) {
    throw new TowerAssetError('drape: tile 이 올바르지 않다');
  }
  if (!Number.isInteger(tile.tx) || !Number.isInteger(tile.ty)) throw new TowerAssetError('drape: tile.tx, tile.ty 는 정수');
}

/**
 * 좌표 정합 오차 측정. 타일 픽셀↔ENU 사상을 (dx, dy) 타일 픽셀만큼 옮겨 가며, 원본 영상의 박스 평균(누적 합 표로 따로 계산)과
 * 타일 내용의 평균 제곱 차를 가장 작게 하는 이동량을 찾는다. 완전 피복 픽셀만 쓴다.
 * 1) 타일 전체의 전역 이동량(±clamp(짧은 변/8, 2, 8) px, 1/32 px 까지 정밀화).
 * 2) 타일을 ALIGN_BLOCK_PX² 블록으로 나눠 블록마다 이동량을 따로 찾는다(전역값 중심 ±min(4, 전역 반경) px, 1/32 px 까지).
 *    전역 이동 하나로는 축척·회전·국소 왜곡이 평균되어 사라지므로 블록 단위로 잰다.
 * 3) 블록 이동량에 '이동 + 두 축 축척' 모형 d(i) = a + k·(i − 중심) 을 최소제곱으로 맞춰 타일 가장자리(모서리) 변위를 구한다.
 * maxMisalignPx = max(블록 이동량 크기의 최댓값, 모형의 네 모서리 변위 최댓값).
 * @returns {{maxMisalignPx:number, dxPx:number, dyPx:number, rms:number, samples:number,
 *   blockMaxPx:number, edgeMaxPx:number, scaleX:number, scaleY:number, blocks:Array<{i0:number,j0:number,dx:number,dy:number,n:number}>}}
 *   dxPx·dyPx·rms·samples 는 전역 이동량 기준(타일 픽셀 단위), dx 는 동쪽, dy 는 남쪽(행 증가) 방향.
 *   scaleX·scaleY = 모형의 픽셀당 변위 기울기(0 = 축척 오류 없음).
 */
export function measureDrapeAlignment(image, tile) {
  const { sx, sy } = checkImage(image);
  checkTile(tile);
  const S = summedArea(image);
  const W = image.width, H = image.height;
  const ib = image.bounds;
  const tb = tileBounds(tile.tx, tile.ty);
  const pw = TERRAIN_TILE_SIZE_M / tile.width, ph = TERRAIN_TILE_SIZE_M / tile.height;
  const mask = tile.coverage?.mask;
  const eps = 1e-9;

  // 누적 합의 연속 값을 세 채널 한꺼번에 더한다: out += sign · ∫(u, v). 칸 안에서 쌍선형 보간.
  const W1 = W + 1;
  const ref = new Float64Array(3);
  const addIntegral = (u, v, sign) => {
    const cu = Math.min(Math.floor(u), W), rv = Math.min(Math.floor(v), H);
    const fu = u - cu, fv = v - rv;
    const cu1 = fu > 0 ? cu + 1 : cu, rv1 = fv > 0 ? rv + 1 : rv;
    const w00 = sign * (1 - fv) * (1 - fu), w01 = sign * (1 - fv) * fu, w10 = sign * fv * (1 - fu), w11 = sign * fv * fu;
    const o00 = (rv * W1 + cu) * 3, o01 = (rv * W1 + cu1) * 3, o10 = (rv1 * W1 + cu) * 3, o11 = (rv1 * W1 + cu1) * 3;
    for (let k = 0; k < 3; k++) ref[k] += w00 * S[o00 + k] + w01 * S[o01 + k] + w10 * S[o10 + k] + w11 * S[o11 + k];
  };

  // 픽셀 범위 [i0, i1) × [j0, j1) 에서의 평균 제곱 차.
  const cost = (i0, i1, j0, j1, dx, dy) => {
    let sum = 0, n = 0;
    for (let j = j0; j < j1; j++) {
      const v0 = (ib.maxY - (tb.maxY - (j + dy) * ph)) / sy;
      const v1 = v0 + ph / sy;
      if (v0 < -eps || v1 > H + eps) continue;
      const cv0 = Math.max(0, v0), cv1 = Math.min(H, v1);
      for (let i = i0; i < i1; i++) {
        const o = j * tile.width + i;
        if (mask && mask[o] !== 255) continue;
        const u0 = (tb.minX + (i + dx) * pw - ib.minX) / sx;
        const u1 = u0 + pw / sx;
        if (u0 < -eps || u1 > W + eps) continue;
        const cu0 = Math.max(0, u0), cu1 = Math.min(W, u1);
        const area = (cu1 - cu0) * (cv1 - cv0);
        ref[0] = 0; ref[1] = 0; ref[2] = 0;
        addIntegral(cu1, cv1, 1); addIntegral(cu0, cv1, -1); addIntegral(cu1, cv0, -1); addIntegral(cu0, cv0, 1);
        for (let k = 0; k < 3; k++) {
          const d = tile.rgb[o * 3 + k] - ref[k] / area;
          sum += d * d;
        }
        n++;
      }
    }
    return n > 0 ? { mse: sum / (n * 3), n } : { mse: Infinity, n: 0 };
  };

  // 탐색: 시작점에 가까운 이동량부터 보고, 엄격히 더 작을 때만 바꾼다(동률이면 가까운 쪽 → 결정적).
  // minN 보다 적은 픽셀로 잰 후보는 버린다(영상 밖으로 밀려 표본이 줄어든 후보가 우연히 이기는 것을 막음).
  const search = (i0, i1, j0, j1, cx, cy, stages, minN) => {
    let best = { dx: cx, dy: cy, ...cost(i0, i1, j0, j1, cx, cy) };
    if (best.n < minN) best = { dx: cx, dy: cy, mse: Infinity, n: 0 };
    for (const [radius, step] of stages) {
      const ox = best.n > 0 ? best.dx : cx, oy = best.n > 0 ? best.dy : cy;
      const m = Math.round(radius / step);
      const cand = [];
      for (let a = -m; a <= m; a++) for (let b = -m; b <= m; b++) cand.push([ox + a * step, oy + b * step]);
      cand.sort((p, q) => (Math.hypot(p[0] - cx, p[1] - cy) - Math.hypot(q[0] - cx, q[1] - cy)) || (p[1] - q[1]) || (p[0] - q[0]));
      for (const [dx, dy] of cand) {
        const c = cost(i0, i1, j0, j1, dx, dy);
        if (c.n >= minN && c.mse < best.mse - 1e-9 * (1 + best.mse)) best = { dx, dy, ...c };
      }
    }
    return best;
  };

  const radius = Math.min(GLOBAL_SEARCH_PX, Math.max(2, Math.floor(Math.min(tile.width, tile.height) / 8)));
  const best = search(0, tile.width, 0, tile.height, 0, 0, [[radius, 1], [1, 0.25], [0.25, 1 / 32]], 1);
  if (best.n === 0) throw new TowerAssetError('drape: 정합을 잴 완전 피복 픽셀이 없다');

  // 블록별 이동량. 이동 0 에서 완전 피복 픽셀이 블록 면적의 절반 미만인 블록은 건너뛴다.
  const B = ALIGN_BLOCK_PX;
  const blocks = [];
  for (let j0 = 0; j0 < tile.height; j0 += B) {
    for (let i0 = 0; i0 < tile.width; i0 += B) {
      const i1 = Math.min(tile.width, i0 + B), j1 = Math.min(tile.height, j0 + B);
      const base = cost(i0, i1, j0, j1, best.dx, best.dy).n;
      if (base * 2 < (i1 - i0) * (j1 - j0)) continue;
      const minN = Math.ceil(base / 2);
      const r = search(i0, i1, j0, j1, best.dx, best.dy, [[Math.min(BLOCK_SEARCH_PX, radius), 1], [1, 0.25], [0.25, 1 / 32]], minN);
      if (r.n === 0) continue;
      blocks.push({ i0, j0, ci: (i0 + i1) / 2, cj: (j0 + j1) / 2, dx: r.dx, dy: r.dy, n: r.n });
    }
  }
  const blockMaxPx = blocks.reduce((m, b) => Math.max(m, Math.hypot(b.dx, b.dy)), Math.hypot(best.dx, best.dy));

  // 이동 + 두 축 축척 모형: dx = ax + kx·(ci − W/2), dy = ay + ky·(cj − H/2). 블록 중심이 한 값뿐인 축은 기울기 0.
  const fit = (pos, val, c) => {
    const n = pos.length;
    const mp = pos.reduce((s, p) => s + p - c, 0) / n;
    const mv = val.reduce((s, v) => s + v, 0) / n;
    let sxx = 0, sxy = 0;
    for (let q = 0; q < n; q++) { sxx += (pos[q] - c - mp) ** 2; sxy += (pos[q] - c - mp) * (val[q] - mv); }
    const k = sxx > 1e-12 ? sxy / sxx : 0;
    return { a: mv - k * mp, k };
  };
  let edgeMaxPx = 0, scaleX = 0, scaleY = 0;
  if (blocks.length > 0) {
    const fx = fit(blocks.map((b) => b.ci), blocks.map((b) => b.dx), tile.width / 2);
    const fy = fit(blocks.map((b) => b.cj), blocks.map((b) => b.dy), tile.height / 2);
    scaleX = fx.k; scaleY = fy.k;
    for (const ex of [-tile.width / 2, tile.width / 2]) {
      for (const ey of [-tile.height / 2, tile.height / 2]) {
        edgeMaxPx = Math.max(edgeMaxPx, Math.hypot(fx.a + fx.k * ex, fy.a + fy.k * ey));
      }
    }
  }
  return {
    maxMisalignPx: Math.max(blockMaxPx, edgeMaxPx),
    dxPx: best.dx, dyPx: best.dy, rms: Math.sqrt(best.mse), samples: best.n,
    blockMaxPx, edgeMaxPx, scaleX, scaleY,
    blocks: blocks.map(({ i0, j0, dx, dy, n }) => ({ i0, j0, dx, dy, n })),
  };
}
