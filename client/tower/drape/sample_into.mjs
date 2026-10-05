// 드레이프 타일 표본의 화소 루프용 판(T15.2, F-403). 출력 버퍼에 직접 쓰고 새 배열을 만들지 않는다.
// 규칙(F-402): 표본점이 속한 타일 화소 칸 (ci, cj) 의 coverage.mask 가 0 이면 자료 없음(false).
//   ci = clamp(floor((x − minX)/(64/width)), 0, width−1), cj = clamp(floor((maxY − y)/(64/height)), 0, height−1).
//   칸 mask > 0 이면 sample.mjs 와 같은 화소 중심 기준 이중선형(u, v 에서 0.5 를 빼고 가장자리는 고정),
//   mask > 0 이웃만 가중해 재정규화, 반올림 뒤 0..255 로 제한. 타일 경계 밖이면 false.
// 검사 없음: tile 은 저장소가 검증한 것, x·y 는 유한 수라고 호출자가 보장한다.
import { TERRAIN_TILE_SIZE_M } from '../../../contracts/tower_assets/index.mjs';

/**
 * 한 타일의 표본 계수를 미리 구한다(화소 루프에서 타일이 바뀔 때 한 번). 결과 객체는 sampleDrapePrepared 에 넘긴다.
 * 화소 칸 크기 64/width 가 2 의 거듭제곱(width 가 2 의 거듭제곱)이면 나눗셈 대신 역수 곱을 쓴다.
 * 2 의 거듭제곱으로 나누기와 그 역수 곱하기는 같은 값이므로 결과는 나눗셈과 같다.
 * @param {import('../../../contracts/tower_assets/index.mjs').DrapeTile} tile
 */
export function prepareDrapeSampler(tile) {
  const width = tile.width;
  const height = tile.height;
  return {
    width,
    height,
    rgb: tile.rgb,
    mask: tile.coverage.mask,
    minX: tile.tx * TERRAIN_TILE_SIZE_M,
    minY: tile.ty * TERRAIN_TILE_SIZE_M,
    maxX: (tile.tx + 1) * TERRAIN_TILE_SIZE_M,
    maxY: (tile.ty + 1) * TERRAIN_TILE_SIZE_M,
    cw: TERRAIN_TILE_SIZE_M / width,
    ch: TERRAIN_TILE_SIZE_M / height,
    mulX: (width & (width - 1)) === 0,
    mulY: (height & (height - 1)) === 0,
    invCw: width / TERRAIN_TILE_SIZE_M,
    invCh: height / TERRAIN_TILE_SIZE_M,
  };
}

/**
 * prepareDrapeSampler 결과로 표본한다. 규칙·결과는 sampleDrapeInto 와 같다.
 * @param {ReturnType<typeof prepareDrapeSampler>} sp
 * @param {number} x
 * @param {number} y
 * @param {Uint8Array|number[]} out
 * @param {number} off
 * @returns {boolean}
 */
export function sampleDrapePrepared(sp, x, y, out, off) {
  if (x < sp.minX || x > sp.maxX || y < sp.minY || y > sp.maxY) return false;
  const s = sp.mulX ? (x - sp.minX) * sp.invCw : (x - sp.minX) / sp.cw;
  const t = sp.mulY ? (sp.maxY - y) * sp.invCh : (sp.maxY - y) / sp.ch;
  return bilinear(sp.width, sp.height, sp.rgb, sp.mask, s, t, out, off);
}

/**
 * Math.min(255, Math.max(0, Math.round(x))) 와 같은 값(x 는 유한 수).
 * Math.round 는 값에 따라 갈라지는 분기로 번역되어 무작위 영상에서 분기 예측이 자주 틀리므로 비교 결과를 더하는 식으로 쓴다.
 * x ≥ 0 이면 f = floor(x), x − f 가 정확하므로 f + (x − f ≥ 0.5) 는 Math.round(x) 와 같다(0.5 는 올림).
 */
function round255(x) {
  if (!(x > 0)) return 0;
  const f = Math.floor(x);
  const q = f + ((x - f >= 0.5) | 0);
  return q > 255 ? 255 : q;
}

/** 칸 단위 연속 좌표 (s, t) 에서 칸 mask 확인 뒤 화소 중심 기준 이중선형. */
function bilinear(width, height, rgb, mask, s, t, out, off) {
  let ci = Math.floor(s);
  let cj = Math.floor(t);
  if (ci < 0) ci = 0; else if (ci > width - 1) ci = width - 1;
  if (cj < 0) cj = 0; else if (cj > height - 1) cj = height - 1;
  if (!(mask[cj * width + ci] > 0)) return false;

  const u = s - 0.5;
  const v = t - 0.5;
  const i0 = Math.floor(u);
  const j0 = Math.floor(v);
  const fx = u - i0;
  const fy = v - j0;
  const ia = i0 < 0 ? 0 : i0 > width - 1 ? width - 1 : i0;
  const ib = i0 + 1 < 0 ? 0 : i0 + 1 > width - 1 ? width - 1 : i0 + 1;
  const ja = j0 < 0 ? 0 : j0 > height - 1 ? height - 1 : j0;
  const jb = j0 + 1 < 0 ? 0 : j0 + 1 > height - 1 ? height - 1 : j0 + 1;
  const wx0 = 1 - fx, wx1 = fx;
  const wy0 = 1 - fy, wy1 = fy;

  // sample.mjs 와 같은 누적 순서(행 ja → jb, 각 행에서 ia → ib)로 더해 결과를 맞춘다.
  let r = 0, g = 0, b = 0, w = 0;
  let o = ja * width + ia;
  if (mask[o] > 0) { const k = wy0 * wx0; r += rgb[o * 3] * k; g += rgb[o * 3 + 1] * k; b += rgb[o * 3 + 2] * k; w += k; }
  o = ja * width + ib;
  if (mask[o] > 0) { const k = wy0 * wx1; r += rgb[o * 3] * k; g += rgb[o * 3 + 1] * k; b += rgb[o * 3 + 2] * k; w += k; }
  o = jb * width + ia;
  if (mask[o] > 0) { const k = wy1 * wx0; r += rgb[o * 3] * k; g += rgb[o * 3 + 1] * k; b += rgb[o * 3 + 2] * k; w += k; }
  o = jb * width + ib;
  if (mask[o] > 0) { const k = wy1 * wx1; r += rgb[o * 3] * k; g += rgb[o * 3 + 1] * k; b += rgb[o * 3 + 2] * k; w += k; }
  if (!(w > 0)) return false;
  out[off] = round255(r / w);
  out[off + 1] = round255(g / w);
  out[off + 2] = round255(b / w);
  return true;
}

/**
 * 준비 없이 한 번 표본한다(시험·단발 호출용). 화소 루프는 prepareDrapeSampler + sampleDrapePrepared 를 쓴다.
 * @param {import('../../../contracts/tower_assets/index.mjs').DrapeTile} tile
 * @param {number} x ENU 동쪽(m)
 * @param {number} y ENU 북쪽(m)
 * @param {Uint8Array|number[]} out 결과를 쓸 버퍼
 * @param {number} off out 안의 첫 채널 위치
 * @returns {boolean} 썼으면 true, 타일 밖이거나 자료 없음이면 false(out 은 그대로)
 */
export function sampleDrapeInto(tile, x, y, out, off) {
  const width = tile.width;
  const height = tile.height;
  const minX = tile.tx * TERRAIN_TILE_SIZE_M;
  const minY = tile.ty * TERRAIN_TILE_SIZE_M;
  const maxX = (tile.tx + 1) * TERRAIN_TILE_SIZE_M;
  const maxY = (tile.ty + 1) * TERRAIN_TILE_SIZE_M;
  if (x < minX || x > maxX || y < minY || y > maxY) return false;
  const s = (x - minX) / (TERRAIN_TILE_SIZE_M / width);
  const t = (maxY - y) / (TERRAIN_TILE_SIZE_M / height);
  return bilinear(width, height, tile.rgb, tile.coverage.mask, s, t, out, off);
}
