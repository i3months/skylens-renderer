// 키 추적기. 눌린 키 집합만 관리하고 반대 키 상쇄는 하지 않는다(상쇄는 state 가 맡는다).
import { TOWER_INPUT_KEYS } from '../../../contracts/controlview/input.mjs';

// 동작 이름 목록(held() 객체의 키 순서).
const ACTIONS = ['yawLeft', 'yawRight', 'forward', 'back', 'altUp', 'altDown'];

// Object.prototype 키(constructor, __proto__ 등)를 모르는 키로 다루려고 own 속성만 확인한다.
function actionOf(code) {
  if (typeof code !== 'string') return undefined;
  return Object.prototype.hasOwnProperty.call(TOWER_INPUT_KEYS, code) ? TOWER_INPUT_KEYS[code] : undefined;
}

export function createKeyTracker() {
  // 눌린 동작 집합(같은 동작에 묶인 키가 늘어도 안전하도록 키 코드 기준으로 저장).
  const pressed = new Set();
  return {
    // 아는 키면 true. 이미 눌린 키의 반복은 무시하지만 여전히 true.
    down(code) {
      if (actionOf(code) === undefined) return false;
      pressed.add(code);
      return true;
    },
    up(code) {
      if (actionOf(code) === undefined) return false;
      pressed.delete(code);
      return true;
    },
    // 창이 포커스를 잃을 때 모든 키를 뗀다.
    releaseAll() {
      pressed.clear();
    },
    // 호출마다 새 객체를 돌려주므로 바꿔도 내부 상태는 불변.
    held() {
      const out = {};
      for (const a of ACTIONS) out[a] = false;
      for (const code of pressed) out[TOWER_INPUT_KEYS[code]] = true;
      return out;
    },
  };
}
