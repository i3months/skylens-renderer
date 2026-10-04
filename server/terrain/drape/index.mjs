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
  // 범위는 겹치지만(예: 겹친 폭 1e-300 m) 어느 원본 칸과도 양의 면적으로 겹치지 않으면 빈 타일 — 꾸며 내보내지 않고 오류.
  if (!(covered > 0)) throw new TowerAssetError(`drape: 타일 (${tx}, ${ty}) 이 영상과 양의 면적으로 겹치지 않는다(빈 타일)`);
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

// 누적 합 표 캐시. 키 = 영상 rgb 배열(bounds 만 바꾼 사본도 같은 표를 쓴다), 값 = { width, height, sig, S }.
// sig(rgb 내용 지문)가 다르면 다시 만든다 → 호출 사이에 rgb 를 고쳐도 낡은 표를 쓰지 않는다.
const tableCache = new WeakMap();
let tableBuilds = 0;

/** 누적 합 표를 새로 만든 횟수(시험용: 같은 영상으로 여러 번 재도 1회여야 한다). */
export function drapeTableBuildCount() {
  return tableBuilds;
}

/** rgb 내용 지문(FNV-1a 32비트). 표 생성보다 훨씬 싸다. */
function rgbSignature(rgb) {
  let h = 0x811c9dc5;
  for (let i = 0; i < rgb.length; i++) h = Math.imul(h ^ rgb[i], 0x01000193);
  return h >>> 0;
}

/**
 * 원본 영상의 누적 합 표(채널별, (H+1)·(W+1)). 연속 적분은 격자 칸 안에서 쌍선형이라 보간으로 정확한 박스 합을 준다.
 * 영상당 한 번만 만든다(캐시). 합이 2^32 미만이면 Uint32(정확한 정수, Float64 의 절반 메모리).
 */
function summedArea(image) {
  const W = image.width, H = image.height, src = image.rgb, W1 = W + 1;
  const sig = rgbSignature(src);
  const hit = tableCache.get(src);
  if (hit && hit.width === W && hit.height === H && hit.sig === sig) return hit.S;
  const n = W1 * (H + 1) * 3;
  const S = 255 * W * H < 2 ** 32 ? new Uint32Array(n) : new Float64Array(n);
  for (let r = 0; r < H; r++) {
    let s0 = 0, s1 = 0, s2 = 0;
    const up = r * W1 * 3, cur = (r + 1) * W1 * 3, row = r * W * 3;
    for (let c = 0; c < W; c++) {
      s0 += src[row + c * 3]; s1 += src[row + c * 3 + 1]; s2 += src[row + c * 3 + 2];
      const o = (c + 1) * 3;
      S[cur + o] = S[up + o] + s0; S[cur + o + 1] = S[up + o + 1] + s1; S[cur + o + 2] = S[up + o + 2] + s2;
    }
  }
  tableBuilds++;
  tableCache.set(src, { width: W, height: H, sig, S });
  return S;
}

/** 정합 측정 블록: 타일 한 변을 최대 ALIGN_BLOCKS_PER_SIDE 개로 나눈다(블록 한 변은 타일 크기에 비례, 최소 ALIGN_MIN_BLOCK_PX). */
export const ALIGN_BLOCKS_PER_SIDE = 8;
export const ALIGN_MIN_BLOCK_PX = 4;
// 전역 이동량 탐색 반경 상한(타일 픽셀). 실제 반경 = clamp(타일 짧은 변 / 8, 2, 8):
// 픽셀이 적은 높은 밉에서 큰 반경은 무늬 주기 일치(가짜 최소)를 부른다.
const GLOBAL_SEARCH_PX = 8;
// 블록별 이동량 탐색 반경(타일 픽셀). 전역 이동량을 중심으로 이만큼 더 찾는다.
// 무늬 주기와 겹치는 큰 반경은 엉뚱한 주기 일치를 부르므로 전역값 기준 작은 범위만 본다.
const BLOCK_SEARCH_PX = 4;
// 표본 예산(픽셀 수). 큰 타일은 등간격으로 솎아 잰다 → 타일 크기와 거의 무관한 시간(4096² 타일도 수 초 안).
// 전역 정수 탐색 64², 전역 정밀화·아핀 검증 128², 블록 16²(128 px 타일의 16 px 블록은 솎지 않음).
const GLOBAL_COARSE_BUDGET = 64 * 64;
const GLOBAL_SAMPLE_BUDGET = 128 * 128;
const BLOCK_SAMPLE_BUDGET = 16 * 16;
// 정수 탐색 뒤 정밀화 단계 [반경, 간격]: 간격을 반씩 줄이며 ±2 간격을 본다(1/2 → 1/32 px, 후보 5×25).
const REFINE_STAGES = [[1, 0.5], [0.5, 0.25], [0.25, 0.125], [0.125, 1 / 16], [1 / 16, 1 / 32]];
// 블록 첫 탐색은 1/4 px 까지만(아핀 예측 근처에서 REFINE_STAGES 로 다시 찾는다).
const BLOCK_COARSE_STAGES = REFINE_STAGES.slice(0, 2);

/** 측정용 타일 검사: 크기·rgb 길이·tx/ty 정수. */
function checkTile(tile) {
  if (!tile || !(tile.rgb instanceof Uint8Array) || !Number.isInteger(tile.width) || !Number.isInteger(tile.height)
    || tile.width <= 0 || tile.height <= 0 || tile.rgb.length !== tile.width * tile.height * 3) {
    throw new TowerAssetError('drape: tile 이 올바르지 않다');
  }
  if (!Number.isInteger(tile.tx) || !Number.isInteger(tile.ty)) throw new TowerAssetError('drape: tile.tx, tile.ty 는 정수');
}

/** 한 축 n 픽셀을 블록 경계로 나눈다: 블록 수 = clamp(floor(n / 최소 블록), 1, 8), 경계 = round(k·n / 블록 수). */
function blockEdges(n) {
  const nb = Math.max(1, Math.min(ALIGN_BLOCKS_PER_SIDE, Math.floor(n / ALIGN_MIN_BLOCK_PX)));
  const e = [];
  for (let k = 0; k <= nb; k++) e.push(Math.round((k * n) / nb));
  return e;
}

/** [lo, hi) 에서 stride 간격 표본 픽셀 번호(가운데 정렬). */
function sampleIdx(lo, hi, stride) {
  const out = [];
  for (let i = lo + ((stride - 1) >> 1); i < hi; i += stride) out.push(i);
  return Int32Array.from(out);
}

/** w×h 영역을 budget 표본 이하로 솎는 간격. */
function strideFor(w, h, budget) {
  return Math.max(1, Math.ceil(Math.sqrt((w * h) / budget)));
}

/**
 * 좌표 정합 오차 측정. 타일 픽셀↔ENU 사상을 (dx, dy) 타일 픽셀만큼 옮겨 가며, 원본 영상의 박스 평균(누적 합 표로 따로 계산)과
 * 타일 내용의 평균 제곱 차를 가장 작게 하는 이동량을 찾는다. 완전 피복 픽셀만 쓴다. 누적 합 표는 영상(rgb)당 한 번 만들고,
 * 큰 타일은 등간격 표본으로 솎아 잰다(시간이 타일 크기와 거의 무관; 1024² 타일 1 s 안팎).
 * 1) 타일 전체의 전역 이동량(±clamp(짧은 변/8, 2, 8) px 정수 탐색 → 1/32 px 까지 정밀화). 정수 격자의 다른 국소 최소 중
 *    평균 제곱 차가 최소의 2배 이내인 것(최대 2개)도 가설로 둔다(대각 주기 무늬가 높은 밉에서 한 주기 어긋나는 것 대비).
 * 2) 타일을 축마다 clamp(floor(n/4), 1, 8) 개 블록으로 나눠(블록 한 변 ∝ 타일 크기, 최소 4 px) 블록마다 이동량을 따로 찾는다
 *    (전역값 중심 ±min(4, 전역 반경) px). 전역 이동 하나로는 축척·회전·국소 왜곡이 평균되어 사라진다.
 * 3) 블록 이동량에 완전 아핀 모형을 최소제곱으로 맞춘다(di = 블록 중심 i − W/2, dj = 블록 중심 j − H/2):
 *      dx = ax + kxx·di + kxy·dj,  dy = ay + kyx·di + kyy·dj
 *    축척(kxx, kyy)과 회전·전단(kxy, kyx)을 모두 담는다. 잔차 > 0.5 px 블록은 하나씩 빼며 다시 맞추고(절반 넘게 빠지면 측정 불가),
 *    모든 블록을 모형 예측 ±1 px 에서 1/32 px 까지 다시 찾아 무늬 주기 일치(가짜 최소)를 바로잡는다. 예측 근처 최소가 블록 자체
 *    최소보다 1.5배 넘게 나쁜 블록은 아핀으로 설명되지 않는 진짜 국소 어긋남(local)으로 남긴다.
 *    전역 가설이 여럿이면 아핀 변위장 아래 타일 전체 평균 제곱 차가 가장 작은 가설을 고른다.
 * 4) edgeMaxPx = 피복 범위(tile.coverage.bounds 를 타일로 자른 사각형, 없으면 타일 전체 ±W/2, ±H/2) 네 모서리의 모형 변위
 *    최댓값(아핀 변위장의 크기는 볼록이라 사각형 안 최댓값은 모서리; 영상 자료가 없는 곳까지 외삽하지 않음),
 *    localMaxPx = local 블록 실측 이동량 크기 최댓값, maxMisalignPx = max(edgeMaxPx, localMaxPx).
 *    다음이면 status = 'unmeasurable' 이고 maxMisalignPx·edgeMaxPx·축척 등은 NaN 이다(0 으로 보고하지 않는다; NaN 은 어떤
 *    `<= 허용` 판정도 통과하지 못한다): 전역 비용면이 ±1 px 이동에 평평함(균일한 색 등), 아핀에 여분이 없음(블록 6개 미만이면서
 *    2×2 이상 블록 격자 전체 피복도 아님 — 3~5블록 정확 적합은 잡음을 모서리 외삽으로 부풀림), 블록 중심이 한 직선 위,
 *    이상치 제거 뒤 남은 블록이 그 하한 미만. 비용면이 한 축이라도 평평한 블록은 블록 측정에서 뺀다.
 * @returns {{status:'measured'|'unmeasurable', reason?:string, maxMisalignPx:number, dxPx:number, dyPx:number, rms:number,
 *   samples:number, globalDxPx:number, globalDyPx:number, blockMaxPx:number, residualMaxPx:number, edgeMaxPx:number,
 *   localMaxPx:number, scaleX:number, scaleY:number, rotationRad:number,
 *   affine:{ax:number,kxx:number,kxy:number,ay:number,kyx:number,kyy:number}|null,
 *   blockPx:{width:number,height:number}, blocks:Array<{i0:number,j0:number,dx:number,dy:number,n:number,local:boolean}>}}
 *   dxPx·dyPx·rms·samples 는 타일 전체 단일 이동량(1 의 첫 가설) 기준(타일 픽셀 단위), dx 는 동쪽, dy 는 남쪽(행 증가) 방향.
 *   globalDxPx·globalDyPx = 고른 가설의 전역 이동량. scaleX = kxx, scaleY = kyy(0 = 축척 오류 없음; 축척 1+f 로 만든 타일은
 *   −f/(1+f)). rotationRad = (kxy − kyx)/2(내용이 ENU 반시계로 θ 돌아간 타일이면 sin θ). blockMaxPx = 블록 이동량 크기 최댓값,
 *   residualMaxPx = 블록 실측과 아핀 모형의 차 최댓값.
 */
export function measureDrapeAlignment(image, tile) {
  const { sx, sy } = checkImage(image);
  checkTile(tile);
  const S = summedArea(image);
  const W = image.width, H = image.height, W1 = W + 1;
  const ib = image.bounds;
  const tb = tileBounds(tile.tx, tile.ty);
  const TW = tile.width, TH = tile.height;
  const pw = TERRAIN_TILE_SIZE_M / TW, ph = TERRAIN_TILE_SIZE_M / TH;
  const mask = tile.coverage?.mask;
  const trgb = tile.rgb;
  const eps = 1e-9;
  const uw = pw / sx, vh = ph / sy;

  // 열 표본별 보간 자료(후보마다 다시 채운다).
  const colOk = new Uint8Array(TW);
  const ca0 = new Int32Array(TW), cb0 = new Int32Array(TW), cf0 = new Float64Array(TW);
  const ca1 = new Int32Array(TW), cb1 = new Int32Array(TW), cf1 = new Float64Array(TW);
  const cw = new Float64Array(TW);

  // 표본 픽셀(xs × ys)의 평균 제곱 차. 박스 [u0,u1]×[v0,v1] 의 합 = I(u1,v1) − I(u0,v1) − I(u1,v0) + I(u0,v0),
  // I 는 누적 합 표의 쌍선형 보간.
  const cost = (xs, ys, dx, dy) => {
    const nc = xs.length;
    for (let q = 0; q < nc; q++) {
      const u0 = (tb.minX + (xs[q] + dx) * pw - ib.minX) / sx;
      const u1 = u0 + uw;
      if (u0 < -eps || u1 > W + eps) { colOk[q] = 0; continue; }
      colOk[q] = 1;
      const a = Math.max(0, u0), b = Math.min(W, u1);
      const c0 = Math.min(Math.floor(a), W), f0 = a - c0;
      const c1 = Math.min(Math.floor(b), W), f1 = b - c1;
      ca0[q] = c0 * 3; cb0[q] = (f0 > 0 ? c0 + 1 : c0) * 3; cf0[q] = f0;
      ca1[q] = c1 * 3; cb1[q] = (f1 > 0 ? c1 + 1 : c1) * 3; cf1[q] = f1;
      cw[q] = b - a;
    }
    let sum = 0, n = 0;
    for (let p = 0; p < ys.length; p++) {
      const j = ys[p];
      const v0 = (ib.maxY - (tb.maxY - (j + dy) * ph)) / sy;
      const v1 = v0 + vh;
      if (v0 < -eps || v1 > H + eps) continue;
      const a = Math.max(0, v0), b = Math.min(H, v1);
      const r0 = Math.min(Math.floor(a), H), g0 = a - r0;
      const r1 = Math.min(Math.floor(b), H), g1 = b - r1;
      const ra0 = r0 * W1 * 3, rb0 = (g0 > 0 ? r0 + 1 : r0) * W1 * 3;
      const ra1 = r1 * W1 * 3, rb1 = (g1 > 0 ? r1 + 1 : r1) * W1 * 3;
      const h0 = 1 - g0, h1 = 1 - g1;
      const rowH = b - a;
      const rowOff = j * TW;
      for (let q = 0; q < nc; q++) {
        if (!colOk[q]) continue;
        const o = rowOff + xs[q];
        if (mask && mask[o] !== 255) continue;
        const inv = 1 / (cw[q] * rowH);
        const xa0 = ca0[q], xb0 = cb0[q], xa1 = ca1[q], xb1 = cb1[q];
        const f0 = cf0[q], e0 = 1 - f0, f1 = cf1[q], e1 = 1 - f1;
        for (let k = 0; k < 3; k++) {
          const i11 = h1 * (e1 * S[ra1 + xa1 + k] + f1 * S[ra1 + xb1 + k]) + g1 * (e1 * S[rb1 + xa1 + k] + f1 * S[rb1 + xb1 + k]);
          const i01 = h1 * (e0 * S[ra1 + xa0 + k] + f0 * S[ra1 + xb0 + k]) + g1 * (e0 * S[rb1 + xa0 + k] + f0 * S[rb1 + xb0 + k]);
          const i10 = h0 * (e1 * S[ra0 + xa1 + k] + f1 * S[ra0 + xb1 + k]) + g0 * (e1 * S[rb0 + xa1 + k] + f1 * S[rb0 + xb1 + k]);
          const i00 = h0 * (e0 * S[ra0 + xa0 + k] + f0 * S[ra0 + xb0 + k]) + g0 * (e0 * S[rb0 + xa0 + k] + f0 * S[rb0 + xb0 + k]);
          const d = trgb[o * 3 + k] - (i11 - i01 - i10 + i00) * inv;
          sum += d * d;
        }
        n++;
      }
    }
    return n > 0 ? { mse: sum / (n * 3), n } : { mse: Infinity, n: 0 };
  };

  // 아핀 변위장 아래 표본 픽셀의 평균 제곱 차(픽셀마다 자기 위치의 모형 이동량만큼 옮긴 박스 평균과 비교).
  const costAffine = (xs, ys, at) => {
    let sum = 0, n = 0;
    for (let p = 0; p < ys.length; p++) {
      const j = ys[p];
      for (let q = 0; q < xs.length; q++) {
        const i = xs[q];
        const o = j * TW + i;
        if (mask && mask[o] !== 255) continue;
        const [dx, dy] = at(i + 0.5 - TW / 2, j + 0.5 - TH / 2);
        const u0 = (tb.minX + (i + dx) * pw - ib.minX) / sx, u1 = u0 + uw;
        const v0 = (ib.maxY - (tb.maxY - (j + dy) * ph)) / sy, v1 = v0 + vh;
        if (u0 < -eps || u1 > W + eps || v0 < -eps || v1 > H + eps) continue;
        const ua = Math.max(0, u0), ub = Math.min(W, u1), va = Math.max(0, v0), vb = Math.min(H, v1);
        const inv = 1 / ((ub - ua) * (vb - va));
        for (let k = 0; k < 3; k++) {
          const d = trgb[o * 3 + k] - (integral(ub, vb, k) - integral(ua, vb, k) - integral(ub, va, k) + integral(ua, va, k)) * inv;
          sum += d * d;
        }
        n++;
      }
    }
    return n > 0 ? sum / (n * 3) : Infinity;
  };
  // 누적 합 표의 연속 값(채널 k) — 쌍선형 보간.
  const integral = (u, v, k) => {
    const c = Math.min(Math.floor(u), W), r = Math.min(Math.floor(v), H);
    const f = u - c, g = v - r;
    const c1 = f > 0 ? c + 1 : c, r1 = g > 0 ? r + 1 : r;
    return (1 - g) * ((1 - f) * S[(r * W1 + c) * 3 + k] + f * S[(r * W1 + c1) * 3 + k])
      + g * ((1 - f) * S[(r1 * W1 + c) * 3 + k] + f * S[(r1 * W1 + c1) * 3 + k]);
  };

  // 탐색: 시작점에 가까운 이동량부터 보고, 엄격히 더 작을 때만 바꾼다(동률이면 가까운 쪽 → 결정적).
  // minN 보다 적은 픽셀로 잰 후보는 버린다(영상 밖으로 밀려 표본이 줄어든 후보가 우연히 이기는 것을 막음).
  // record 가 있으면 첫 단계의 후보별 결과를 넘긴다(전역 가설 고르기용).
  const search = (xs, ys, cx, cy, stages, minN, record) => {
    let best = { dx: cx, dy: cy, ...cost(xs, ys, cx, cy) };
    if (best.n < minN) best = { dx: cx, dy: cy, mse: Infinity, n: 0 };
    stages.forEach(([radius, step], s) => {
      const ox = best.n > 0 ? best.dx : cx, oy = best.n > 0 ? best.dy : cy;
      const m = Math.round(radius / step);
      const cand = [];
      for (let a = -m; a <= m; a++) for (let b = -m; b <= m; b++) cand.push([ox + a * step, oy + b * step]);
      cand.sort((p, q) => (Math.hypot(p[0] - cx, p[1] - cy) - Math.hypot(q[0] - cx, q[1] - cy)) || (p[1] - q[1]) || (p[0] - q[0]));
      for (const [dx, dy] of cand) {
        const c = cost(xs, ys, dx, dy);
        if (s === 0 && record) record(dx, dy, c.n >= minN ? c.mse : Infinity);
        if (c.n >= minN && c.mse < best.mse - 1e-9 * (1 + best.mse)) best = { dx, dy, ...c };
      }
    });
    return best;
  };

  // 1) 전역 이동량. 정수 탐색 격자의 국소 최소 중 평균 제곱 차가 최소의 ALT_GLOBAL_RATIO 배 이내인 것(최대 ALT_GLOBAL_MAX 개)을
  //    다른 가설로 남긴다: 체커 무늬처럼 대각 주기가 있는 영상은 높은 밉에서 전역 최소가 한 주기 어긋날 수 있다.
  const radius = Math.min(GLOBAL_SEARCH_PX, Math.max(2, Math.floor(Math.min(TW, TH) / 8)));
  const gs = strideFor(TW, TH, GLOBAL_SAMPLE_BUDGET), cs = strideFor(TW, TH, GLOBAL_COARSE_BUDGET);
  const gxs = sampleIdx(0, TW, gs), gys = sampleIdx(0, TH, gs);
  const grid = new Map();
  const record = (dx, dy, mse) => grid.set(`${dx},${dy}`, mse);
  let coarse = search(sampleIdx(0, TW, cs), sampleIdx(0, TH, cs), 0, 0, [[radius, 1]], 1, record);
  // 솎은 표본이 완전 피복 픽셀을 하나도 못 잡으면(대부분 가려진 타일) 정밀 표본으로 정수 탐색을 다시 한다.
  if (coarse.n === 0) { grid.clear(); coarse = search(gxs, gys, 0, 0, [[radius, 1]], 1, record); }
  const primary = search(gxs, gys, coarse.dx, coarse.dy, REFINE_STAGES, 1);
  if (primary.n === 0) throw new TowerAssetError('drape: 정합을 잴 완전 피복 픽셀이 없다');
  const minGrid = Math.min(...grid.values());
  const alts = [];
  for (const [key, mse] of grid) {
    if (!(mse <= minGrid * ALT_GLOBAL_RATIO + 1e-9)) continue;
    const [gx, gy] = key.split(',').map(Number);
    let isMin = true;
    for (let a = -1; a <= 1 && isMin; a++) {
      for (let b = -1; b <= 1; b++) {
        const nb = grid.get(`${gx + a},${gy + b}`);
        if ((a || b) && nb !== undefined && nb < mse) { isMin = false; break; }
      }
    }
    if (isMin && Math.hypot(gx - primary.dx, gy - primary.dy) > 1) alts.push({ gx, gy, mse });
  }
  alts.sort((p, q) => p.mse - q.mse || p.gy - q.gy || p.gx - q.gx);
  const globals = [primary];
  for (const a of alts.slice(0, ALT_GLOBAL_MAX)) {
    const g = search(gxs, gys, a.gx, a.gy, REFINE_STAGES, 1);
    if (g.n > 0) globals.push(g);
  }

  // 이동량 (dx, dy) 에서 x·y 축 각각 ±1 px 옮긴 비용이 FLAT_MSE 이하로만 오르면 평평(그 축 이동량을 구별 못함).
  function flatAt(xs, ys, dx, dy, minN, mse) {
    for (const [a, b] of [[1, 0], [0, 1]]) {
      let rise = Infinity;
      for (const s of [-1, 1]) {
        const c = cost(xs, ys, dx + s * a, dy + s * b);
        if (c.n >= minN) rise = Math.min(rise, c.mse - mse);
      }
      if (rise !== Infinity && rise <= FLAT_MSE) return true;
    }
    return false;
  }

  // 모서리 외삽 범위(블록 좌표 di, dj = 픽셀 − 타일 중심): coverage.bounds 를 타일 안으로 자른 사각형, 없거나 잘못되면 타일 전체.
  let ei0 = -TW / 2, ei1 = TW / 2, ej0 = -TH / 2, ej1 = TH / 2;
  const cbx = tile.coverage?.bounds;
  if (cbx && [cbx.minX, cbx.minY, cbx.maxX, cbx.maxY].every(Number.isFinite)) {
    const i0 = Math.max(0, (cbx.minX - tb.minX) / pw), i1 = Math.min(TW, (cbx.maxX - tb.minX) / pw);
    const j0 = Math.max(0, (tb.maxY - cbx.maxY) / ph), j1 = Math.min(TH, (tb.maxY - cbx.minY) / ph);
    if (i1 > i0 && j1 > j0) { ei0 = i0 - TW / 2; ei1 = i1 - TW / 2; ej0 = j0 - TH / 2; ej1 = j1 - TH / 2; }
  }

  const ex = blockEdges(TW), ey = blockEdges(TH);
  const blockPx = { width: ex[1] - ex[0], height: ey[1] - ey[0] };
  const results = globals.map((g) => alignFromGlobal(g));
  let pick = results[0];
  for (const r of results.slice(1)) {
    if (r.status === 'measured' && (pick.status !== 'measured' || r.tileMse < pick.tileMse * (1 - 1e-6))) pick = r;
  }
  const { tileMse, ...out } = pick;
  return out;

  // 2)~4) 한 전역 가설 g 에서 블록 이동량을 재고 아핀을 맞춘다.
  function alignFromGlobal(g) {
    // 블록별 이동량. 전역 이동량에서 완전 피복 표본이 블록 표본의 절반 미만인 블록은 건너뛴다.
    const blocks = [];
    for (let b = 0; b + 1 < ey.length; b++) {
      const j0 = ey[b], j1 = ey[b + 1];
      for (let a = 0; a + 1 < ex.length; a++) {
        const i0 = ex[a], i1 = ex[a + 1];
        const st = strideFor(i1 - i0, j1 - j0, BLOCK_SAMPLE_BUDGET);
        const xs = sampleIdx(i0, i1, st), ys = sampleIdx(j0, j1, st);
        const base = cost(xs, ys, g.dx, g.dy).n;
        if (base * 2 < xs.length * ys.length) continue;
        const minN = Math.ceil(base / 2);
        const r = search(xs, ys, g.dx, g.dy, [[Math.min(BLOCK_SEARCH_PX, radius), 1], ...BLOCK_COARSE_STAGES], minN);
        if (r.n === 0) continue;
        // 이동량 한 축이라도 비용면이 평평하면(균일한 색·한 방향 줄무늬) 그 블록 이동량은 정해지지 않으므로 버린다.
        if (flatAt(xs, ys, r.dx, r.dy, minN, r.mse)) continue;
        blocks.push({
          i0, j0, di: (i0 + i1) / 2 - TW / 2, dj: (j0 + j1) / 2 - TH / 2, xs, ys, minN,
          dx: r.dx, dy: r.dy, mse: r.mse, n: r.n, local: false,
        });
      }
    }
    const finish = (status, extra) => ({
      status, ...extra,
      dxPx: primary.dx, dyPx: primary.dy, rms: Math.sqrt(primary.mse), samples: primary.n,
      globalDxPx: g.dx, globalDyPx: g.dy,
      blockMaxPx: blocks.reduce((m, b) => Math.max(m, Math.hypot(b.dx, b.dy)), 0),
      blockPx,
      blocks: blocks.map(({ i0, j0, dx, dy, n, local }) => ({ i0, j0, dx, dy, n, local })),
    });
    const unmeasurable = (reason) => finish('unmeasurable', {
      reason, maxMisalignPx: NaN, residualMaxPx: NaN, edgeMaxPx: NaN, localMaxPx: NaN,
      scaleX: NaN, scaleY: NaN, rotationRad: NaN, affine: null, tileMse: Infinity,
    });

    // 3) 아핀 적합(이상치 제거) → 모형 예측 근처(±1 px)에서 블록을 다시 찾아 무늬 주기 일치(가짜 최소)를 바로잡는다.
    //    이상치 블록의 예측 근처 최소가 자기 최소보다 뚜렷이 나쁘면(평균 제곱 차 비 > ALIAS_MSE_RATIO) 진짜 국소 어긋남(local)으로 남긴다.
    // 전역 비용면이 평평하면(균일한 색 등) 어떤 이동량도 구별되지 않는다 → 0 px 가 아니라 측정 불가.
    if (flatAt(gxs, gys, g.dx, g.dy, 1, g.mse)) return unmeasurable('비용면이 평평함(영상 무늬가 없어 이동량을 구별할 수 없음)');
    // 아핀(6 매개변수)은 여분이 있어야 잡음이 모서리 외삽으로 부풀지 않는다: 블록 MIN_AFFINE_BLOCKS 개 이상,
    // 또는 블록 격자 전체(2×2 이상)가 피복된 타일. 블록 3~5개 정확 적합은 측정 불가.
    const gridBlocks = (ex.length - 1) * (ey.length - 1);
    const minBlocks = blocks.length === gridBlocks ? Math.min(MIN_AFFINE_BLOCKS, gridBlocks) : MIN_AFFINE_BLOCKS;
    if (blocks.length < Math.max(4, minBlocks)) {
      return unmeasurable(`블록 ${blocks.length}개(아핀 적합에 ${MIN_AFFINE_BLOCKS}개 이상, 또는 2×2 이상 블록 격자 전체 피복 필요)`);
    }
    let fit = robustAffine(blocks, minBlocks);
    if (!fit) return unmeasurable('블록 이동량이 한 아핀 모형으로 모이지 않거나 블록 중심이 한 직선 위');
    for (const b of blocks) {
      const [px, py] = fit.at(b.di, b.dj);
      const near = search(b.xs, b.ys, px, py, REFINE_STAGES, b.minN);
      if (near.n === 0) continue;
      if (fit.inlier.has(b) || near.mse <= b.mse * ALIAS_MSE_RATIO + 1e-9) {
        b.dx = near.dx; b.dy = near.dy; b.mse = near.mse; b.n = near.n;
      } else {
        b.local = true;
      }
    }
    const affineBlocks = blocks.filter((b) => !b.local);
    fit = robustAffine(affineBlocks, minBlocks);
    if (!fit) return unmeasurable('블록 이동량이 한 아핀 모형으로 모이지 않거나 블록 중심이 한 직선 위');
    for (const b of affineBlocks) if (!fit.inlier.has(b)) b.local = true;

    // 4) 피복 범위(coverage.bounds = 타일 ∩ 영상, 없으면 타일) 네 모서리의 모형 변위 최댓값, 그리고 모형으로 설명되지 않는
    //    블록(local)의 실측 이동량 크기. 영상 자료가 없는 곳까지 외삽하지 않는다(완전 피복 타일이면 타일 네 모서리).
    let edgeMaxPx = 0;
    for (const ci of [ei0, ei1]) for (const cj of [ej0, ej1]) edgeMaxPx = Math.max(edgeMaxPx, Math.hypot(...fit.at(ci, cj)));
    let residualMaxPx = 0, localMaxPx = 0;
    for (const b of blocks) {
      const [px, py] = fit.at(b.di, b.dj);
      residualMaxPx = Math.max(residualMaxPx, Math.hypot(b.dx - px, b.dy - py));
      if (b.local) localMaxPx = Math.max(localMaxPx, Math.hypot(b.dx, b.dy));
    }
    const { fx, fy } = fit;
    return finish('measured', {
      maxMisalignPx: Math.max(edgeMaxPx, localMaxPx),
      residualMaxPx, edgeMaxPx, localMaxPx,
      scaleX: fx.ki, scaleY: fy.kj, rotationRad: (fx.kj - fy.ki) / 2,
      affine: { ax: fx.a, kxx: fx.ki, kxy: fx.kj, ay: fy.a, kyx: fy.ki, kyy: fy.kj },
      tileMse: costAffine(gxs, gys, fit.at),
    });
  }
}

// 다른 전역 가설: 정수 격자 국소 최소 중 평균 제곱 차가 최소의 이 배 이내, 최대 개수.
const ALT_GLOBAL_RATIO = 2;
const ALT_GLOBAL_MAX = 2;
// 아핀 잔차가 이보다 큰 블록은 이상치(타일 픽셀).
const OUTLIER_PX = 0.5;
// 이상치 블록의 예측 근처 최소의 평균 제곱 차가 자기 최소의 이 배 이내면 '무늬 주기 일치'로 보고 예측 근처 값을 쓴다.
const ALIAS_MSE_RATIO = 1.5;
// 아핀 적합에 필요한 블록 수(블록 격자 전체가 피복되지 않은 타일). 6 매개변수 정확 적합(3블록)은 잡음을 모서리로 부풀린다.
const MIN_AFFINE_BLOCKS = 6;
// 비용면 평평 판정: ±1 px 이동의 평균 제곱 차 상승(채널값²)이 이 이하면 그 축 이동량을 구별할 수 없다(uint8 반올림 잡음 1/12 보다 작음).
const FLAT_MSE = 0.01;

/**
 * 블록 이동량 (di, dj) → (dx, dy) 에 아핀 최소제곱. 블록 3개 미만이거나 중심이 한 직선 위면 null.
 * @returns {{fx:{a:number,ki:number,kj:number}, fy:{a:number,ki:number,kj:number}, at:(i:number,j:number)=>[number,number]}|null}
 */
function fitAffine(list) {
  const nb = list.length;
  if (nb < 3) return null;
  let mi = 0, mj = 0, mx = 0, my = 0;
  for (const b of list) { mi += b.di; mj += b.dj; mx += b.dx; my += b.dy; }
  mi /= nb; mj /= nb; mx /= nb; my /= nb;
  let sii = 0, sjj = 0, sij = 0, six = 0, sjx = 0, siy = 0, sjy = 0;
  for (const b of list) {
    const ui = b.di - mi, uj = b.dj - mj, vx = b.dx - mx, vy = b.dy - my;
    sii += ui * ui; sjj += uj * uj; sij += ui * uj;
    six += ui * vx; sjx += uj * vx; siy += ui * vy; sjy += uj * vy;
  }
  const det = sii * sjj - sij * sij;
  if (!(det > 1e-9 * (sii + sjj) ** 2)) return null;
  const solve = (m, si, sj) => {
    const ki = (sjj * si - sij * sj) / det, kj = (sii * sj - sij * si) / det;
    return { a: m - ki * mi - kj * mj, ki, kj };
  };
  const fx = solve(mx, six, sjx), fy = solve(my, siy, sjy);
  return { fx, fy, at: (i, j) => [fx.a + fx.ki * i + fx.kj * j, fy.a + fy.ki * i + fy.kj * j] };
}

/**
 * 이상치를 하나씩 빼며 아핀을 맞춘다: 잔차 최댓값이 OUTLIER_PX 이하가 될 때까지 잔차가 가장 큰 블록을 뺀다.
 * 남은 블록(inlier)이 원래의 절반 미만(또는 minBlocks 개 미만)이 되거나 적합이 불가능하면 null(측정 불가).
 */
function robustAffine(list, minBlocks) {
  const active = list.slice();
  const need = Math.max(3, minBlocks, Math.ceil(list.length / 2));
  if (active.length < need) return null;
  for (;;) {
    const fit = fitAffine(active);
    if (!fit) return null;
    let worst = -1, wr = 0;
    for (let q = 0; q < active.length; q++) {
      const [px, py] = fit.at(active[q].di, active[q].dj);
      const r = Math.hypot(active[q].dx - px, active[q].dy - py);
      if (r > wr) { wr = r; worst = q; }
    }
    if (wr <= OUTLIER_PX) return { ...fit, inlier: new Set(active) };
    if (active.length - 1 < need) return null;
    active.splice(worst, 1);
  }
}
