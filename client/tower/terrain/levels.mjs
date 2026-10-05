// 관제탑 지형 수준 상태(T15.1-A4). 도착한 수준의 타일 묶음이 이전 묶음을 통째로 교체한다(누적 아님).
// 결정은 contracts/levels 의 decideArrival 을 쓴다: first/replace 면 교체, skip 이면 상태를 바꾸지 않는다.
// 검증은 상태를 바꾸기 전에 끝낸다(원자적). 시계·타이머 없음: 상태는 도착 이벤트로만 바뀐다.
import { assertTileShape } from './mesh.mjs';
import { NONE, decideArrival, assertLevel, ACTIONS } from '../../../contracts/levels/index.mjs';

function assertCoord(value, name) {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new TypeError(`타일 ${name} 는 정수여야 한다: ${String(value)}`);
}

/** 묶음 검증: 배열, 타일마다 정수 tx,ty·cells≥2·heights 길이 cells²(mesh 와 동일), (tx,ty) 유일, cells 동일. 어긋나면 TypeError/RangeError. */
function validateTiles(tiles) {
  if (!Array.isArray(tiles)) throw new TypeError('tiles 는 배열이어야 한다');
  const seen = new Set();
  let cells;
  tiles.forEach((tile, i) => {
    if (tile === null || typeof tile !== 'object') throw new TypeError(`tiles[${i}] 는 객체여야 한다`);
    assertCoord(tile.tx, 'tx');
    assertCoord(tile.ty, 'ty');
    const key = `${tile.tx},${tile.ty}`;
    if (seen.has(key)) throw new RangeError(`묶음 안 (tx,ty) 중복: ${key}`);
    seen.add(key);
    // mesh 와 같은 검사(cells ≥ 2, heights 길이 cells², 위치 범위)를 skip 여부와 무관하게 먼저 적용한다.
    assertTileShape(tile, i);
    if (cells === undefined) cells = tile.cells;
    else if (tile.cells !== cells) throw new RangeError(`묶음 안 cells 불일치: ${cells} 와 ${tile.cells}`);
  });
}

// 계약: tiles 는 그 수준의 화면 전체 완전 묶음이다(누적·병합 없음, 지역별 수준 상태 없음). 자세한 이유는 index.mjs 머리말.
export function createTerrainState() {
  let currentLevel = NONE;
  let stored = Object.freeze([]);

  return {
    /** 도착 처리. 'first' | 'replace' | 'skip' 을 돌려준다. 던지면 상태는 그대로다. */
    accept(level, tiles) {
      assertLevel(level);
      validateTiles(tiles);
      const action = decideArrival(currentLevel, level);
      if (action === ACTIONS.SKIP) return action;
      stored = Object.freeze(tiles.map((tile) => Object.freeze({ ...tile })));
      currentLevel = level;
      return action;
    },
    /** 상태를 바꾸지 않고 결정만 본다: 'first' | 'replace' | 'skip'. 수준이 잘못이면 던진다. */
    peek(level) {
      assertLevel(level);
      return decideArrival(currentLevel, level);
    },
    /** 현재 수준: -1(없음) 또는 0..3. */
    level() {
      return currentLevel;
    },
    /** 보관 중 타일(복사본 배열, 타일 객체는 동결). */
    tiles() {
      return [...stored];
    },
  };
}
