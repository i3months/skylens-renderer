// 관제탑 드레이프 타일 저장소(T15.2). 도착한 수준의 타일 묶음이 이전 묶음을 통째로 교체한다(누적 아님).
// 결정은 contracts/levels 의 decideArrival 을 쓴다: first/replace 면 교체, skip 이면 상태를 바꾸지 않는다.
// 새 색인을 먼저 만들고 검증이 모두 끝난 뒤에만 교체하므로 던져도 상태는 그대로다(원자적).
// 주의: 보관 타일은 방어적 복사 없이 호출자가 준 객체·배열을 그대로 참조한다.
//   호출자는 넘긴 뒤 타일(rgb·coverage.mask 포함)을 바꾸지 않아야 한다. lookup 도 같은 객체를 돌려준다.
import { DRAPE_MIP_COUNT } from '../../../contracts/tower_assets/index.mjs';
import { NONE, decideArrival, assertLevel, ACTIONS } from '../../../contracts/levels/index.mjs';

/** 드레이프 타일 한 변의 ENU 길이(m). 지형 타일과 같다: tx = floor(x/64). */
const TILE_SIZE_M = 64;

function assertInt(value, name, i) {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new TypeError(`tiles[${i}].${name} 는 정수여야 한다: ${String(value)}`);
}

function assertPositiveInt(value, name, i) {
  assertInt(value, name, i);
  if (value <= 0) throw new RangeError(`tiles[${i}].${name} 는 양의 정수여야 한다: ${value}`);
}

/** 타일 한 장 검증. 어긋나면 TypeError/RangeError. */
function assertTile(tile, i) {
  if (tile === null || typeof tile !== 'object') throw new TypeError(`tiles[${i}] 는 객체여야 한다`);
  assertInt(tile.tx, 'tx', i);
  assertInt(tile.ty, 'ty', i);
  assertInt(tile.mip, 'mip', i);
  if (tile.mip < 0 || tile.mip >= DRAPE_MIP_COUNT) throw new RangeError(`tiles[${i}].mip 는 0..${DRAPE_MIP_COUNT - 1}: ${tile.mip}`);
  assertPositiveInt(tile.width, 'width', i);
  assertPositiveInt(tile.height, 'height', i);
  const n = tile.width * tile.height;
  if (!(tile.rgb instanceof Uint8Array)) throw new TypeError(`tiles[${i}].rgb 는 Uint8Array 여야 한다`);
  if (tile.rgb.length !== n * 3) throw new RangeError(`tiles[${i}].rgb 길이 ${tile.rgb.length} != ${n * 3}`);
  const cov = tile.coverage;
  if (cov === null || typeof cov !== 'object') throw new TypeError(`tiles[${i}].coverage 는 객체여야 한다`);
  if (!(cov.mask instanceof Uint8Array)) throw new TypeError(`tiles[${i}].coverage.mask 는 Uint8Array 여야 한다`);
  if (cov.mask.length !== n) throw new RangeError(`tiles[${i}].coverage.mask 길이 ${cov.mask.length} != ${n}`);
}

/** 묶음 검증과 색인 생성. 성공한 새 Map 을 돌려주고 실패하면 던진다(저장소는 건드리지 않는다). */
function buildIndex(tiles) {
  if (!Array.isArray(tiles)) throw new TypeError('tiles 는 배열이어야 한다');
  const index = new Map();
  tiles.forEach((tile, i) => {
    assertTile(tile, i);
    const key = `${tile.tx},${tile.ty}`;
    if (index.has(key)) throw new RangeError(`묶음 안 (tx,ty) 중복: ${key}`);
    index.set(key, tile);
  });
  return index;
}

export function createDrapeStore() {
  let currentLevel = NONE;
  let index = new Map();

  return {
    /** 도착 처리. 'first' | 'replace' | 'skip'. skip 이면 상태 불변, 던져도 상태 불변. */
    accept(level, tiles) {
      assertLevel(level);
      const next = buildIndex(tiles);
      const action = decideArrival(currentLevel, level);
      if (action === ACTIONS.SKIP) return action;
      index = next;
      currentLevel = level;
      return action;
    },
    /** 상태를 바꾸지 않고 결정만 본다. 수준이 잘못이면 던진다. */
    peek(level) {
      assertLevel(level);
      return decideArrival(currentLevel, level);
    },
    /** 현재 수준: -1(없음) 또는 0..3. */
    level() {
      return currentLevel;
    },
    /** ENU (x, y) 가 속한 타일(floor 규약: 경계는 오른쪽/위 타일). 없으면 null. 비유한 좌표는 RangeError. */
    lookup(x, y) {
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
        throw new RangeError(`좌표는 유한한 수여야 한다: (${String(x)}, ${String(y)})`);
      }
      const tile = index.get(`${Math.floor(x / TILE_SIZE_M)},${Math.floor(y / TILE_SIZE_M)}`);
      return tile === undefined ? null : tile;
    },
    /** 보관 중 타일 수. */
    count() {
      return index.size;
    },
  };
}
