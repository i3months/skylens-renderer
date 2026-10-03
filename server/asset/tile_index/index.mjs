// T03.2 타일 색인: ENU 사각 격자(한 변 TILE_SIZE_M), 반열린 구간. 명세 format/ASSET_FORMAT.md §1.2.
import { TILE_SIZE_M } from '../../../contracts/asset/index.mjs';

const I32_MIN = -2147483648;
const I32_MAX = 2147483647;

// 타일 번호 한 축 계산. 64 로 나누기는 정확하므로 floor 가 경계를 그대로 지킨다.
function axisTile(v, name) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new RangeError(`${name} 은 유한한 수여야 한다: ${v}`);
  const t = Math.floor(v / TILE_SIZE_M);
  if (t < I32_MIN || t > I32_MAX) throw new RangeError(`${name} 타일 번호가 i32 범위 밖: ${t}`);
  return t + 0; // -0 을 +0 으로
}

/**
 * ENU 좌표가 속한 타일. 경계 e = 64k 는 타일 k 에 속한다.
 * @param {number} e
 * @param {number} n
 * @returns {{tileX: number, tileY: number}}
 */
export function tileOf(e, n) {
  return { tileX: axisTile(e, 'e'), tileY: axisTile(n, 'n') };
}

function checkTileIndex(v, name) {
  if (!Number.isInteger(v) || v < I32_MIN || v > I32_MAX) throw new RangeError(`${name} 은 i32 정수여야 한다: ${v}`);
}

/**
 * 타일의 ENU 범위 [eMin, eMax) × [nMin, nMax).
 * @param {number} tileX
 * @param {number} tileY
 * @returns {{eMin: number, eMax: number, nMin: number, nMax: number}}
 */
export function tileBounds(tileX, tileY) {
  checkTileIndex(tileX, 'tileX');
  checkTileIndex(tileY, 'tileY');
  const eMin = TILE_SIZE_M * tileX + 0;
  const nMin = TILE_SIZE_M * tileY + 0;
  return { eMin, eMax: eMin + TILE_SIZE_M, nMin, nMax: nMin + TILE_SIZE_M };
}

/**
 * 점들을 타일별로 나눈다. 순서: tileY 오름차순 → tileX 오름차순, 각 목록은 점 번호 오름차순.
 * @param {Float32Array|Float64Array} positions 3n, [e,n,u]
 * @returns {{tileX: number, tileY: number, indices: Uint32Array}[]}
 */
export function groupByTile(positions) {
  if (!(positions instanceof Float32Array || positions instanceof Float64Array)) {
    throw new TypeError('positions 는 Float32Array 또는 Float64Array 여야 한다');
  }
  if (positions.length % 3 !== 0) throw new RangeError(`positions 길이가 3 의 배수가 아니다: ${positions.length}`);
  const count = positions.length / 3;
  const groups = new Map(); // 키 문자열 → {tileX, tileY, list}
  for (let i = 0; i < count; i++) {
    const u = positions[3 * i + 2];
    if (!Number.isFinite(u)) throw new RangeError(`점 ${i} 의 u 가 유한하지 않다: ${u}`);
    const { tileX, tileY } = tileOf(positions[3 * i], positions[3 * i + 1]);
    const key = `${tileX},${tileY}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { tileX, tileY, list: [] }));
    g.list.push(i);
  }
  return [...groups.values()]
    .sort((a, b) => a.tileY - b.tileY || a.tileX - b.tileX)
    .map((g) => ({ tileX: g.tileX, tileY: g.tileY, indices: Uint32Array.from(g.list) }));
}
