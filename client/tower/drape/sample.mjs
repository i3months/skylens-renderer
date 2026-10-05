// 드레이프 타일 표본(T15.2). ENU (x, y) 에서 화소 중심 기준 이중선형 보간으로 색을 읽는다.
// 규약: 화소 (i, j) 는 [i, i+1) × [j, j+1) 칸, 중심 (i+0.5, j+0.5). i = (x − minX)/(64/width), j = (maxY − y)/(64/height).
// 규칙 하나: (1) 표본점이 속한 화소 칸(i = clamp(floor((x−minX)/(64/width))), j = clamp(floor((maxY−y)/(64/height))), 가장자리 x=maxX·y=minY 는 끝 화소)의 mask 가 0 이면 null.
// (2) 그 칸의 mask 가 0 보다 크면 4이웃 이중선형 보간하되 mask>0 인 이웃만 가중하고 남은 가중으로 재정규화한다(mask 0 이웃은 뺀다).
// (3) mask 1..254 는 255 와 같은 가중(색 동등 가중, mask/255 를 곱하지 않는다).
// 가장자리는 가장 가까운 화소로 고정한다(바깥 이웃을 만들지 않는다). 영상 밖을 꾸며 채우지 않는다.
import { tileBounds, TERRAIN_TILE_SIZE_M } from '../../../contracts/tower_assets/index.mjs';

function checkTile(tile) {
  if (tile === null || typeof tile !== 'object') throw new RangeError('sampleDrape: tile 이 객체가 아니다');
  const { width, height, rgb, coverage } = tile;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError('sampleDrape: width, height 는 1 이상의 정수');
  }
  if (!Number.isInteger(tile.tx) || !Number.isInteger(tile.ty)) throw new RangeError('sampleDrape: tx, ty 는 정수');
  if (!rgb || rgb.length !== width * height * 3) throw new RangeError('sampleDrape: rgb 길이가 width·height·3 이 아니다');
  if (!coverage || !coverage.mask || coverage.mask.length !== width * height) {
    throw new RangeError('sampleDrape: coverage.mask 길이가 width·height 가 아니다');
  }
}

/**
 * @param {import('../../../contracts/tower_assets/index.mjs').DrapeTile} tile
 * @param {number} x ENU 동쪽(m)
 * @param {number} y ENU 북쪽(m)
 * @returns {[number, number, number] | null} 0..255 정수 3개, 타일 밖이거나 자료 없음이면 null
 */
export function sampleDrape(tile, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new RangeError(`sampleDrape: 좌표가 유한수가 아니다 (${x}, ${y})`);
  checkTile(tile);
  const { width, height, rgb } = tile;
  const mask = tile.coverage.mask;
  const tb = tileBounds(tile.tx, tile.ty);
  if (x < tb.minX || x > tb.maxX || y < tb.minY || y > tb.maxY) return null;

  // 화소 중심 기준 연속 좌표(중심이 정수가 되도록 0.5 를 뺀다).
  const cu = (x - tb.minX) / (TERRAIN_TILE_SIZE_M / width);
  const cv = (tb.maxY - y) / (TERRAIN_TILE_SIZE_M / height);
  const u = cu - 0.5;
  const v = cv - 0.5;
  const i0 = Math.floor(u);
  const j0 = Math.floor(v);
  const fx = u - i0;
  const fy = v - j0;
  const clampI = (i) => (i < 0 ? 0 : i > width - 1 ? width - 1 : i);
  const clampJ = (j) => (j < 0 ? 0 : j > height - 1 ? height - 1 : j);
  // 표본점이 속한 화소 칸이 mask 0 이면 이웃이 살아 있어도 메우지 않고 null.
  if (!(mask[clampJ(Math.floor(cv)) * width + clampI(Math.floor(cu))] > 0)) return null;
  const ii = [clampI(i0), clampI(i0 + 1)];
  const jj = [clampJ(j0), clampJ(j0 + 1)];
  const wx = [1 - fx, fx];
  const wy = [1 - fy, fy];

  let r = 0, g = 0, b = 0, w = 0;
  for (let a = 0; a < 2; a++) {
    for (let c = 0; c < 2; c++) {
      const o = jj[a] * width + ii[c];
      if (!(mask[o] > 0)) continue;
      const k = wy[a] * wx[c];
      r += rgb[o * 3] * k; g += rgb[o * 3 + 1] * k; b += rgb[o * 3 + 2] * k; w += k;
    }
  }
  if (!(w > 0)) return null;
  const q = (s) => Math.min(255, Math.max(0, Math.round(s / w)));
  return [q(r), q(g), q(b)];
}
