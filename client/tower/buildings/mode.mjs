// 관제탑 건물 표시 옵션 상태(T15.3.1). 계약: contracts/controlview/buildings.mjs BUILDINGS_MODULES.mode.
// 옵션 전환은 로컬 상태 바꾸기만 한다(네트워크·accept 없음). 잘못된 값은 RangeError 이고 상태는 그대로다.
import { DISPLAY_MODES, DEFAULT_DISPLAY_MODE } from '../../../contracts/tower_assets/index.mjs';

function assertMode(mode) {
  if (!DISPLAY_MODES.includes(mode)) {
    throw new RangeError(`buildings: 표시 옵션은 ${DISPLAY_MODES.join('|')} 중 하나여야 한다: ${String(mode)}`);
  }
}

/** 표시 옵션 상태. initial 이 undefined 면 DEFAULT_DISPLAY_MODE, 아니면 DISPLAY_MODES 중 하나여야 한다. */
export function createModeState(initial) {
  let current = DEFAULT_DISPLAY_MODE;
  if (initial !== undefined) {
    assertMode(initial);
    current = initial;
  }
  return {
    get() {
      return current;
    },
    set(mode) {
      assertMode(mode);
      current = mode;
    },
  };
}
