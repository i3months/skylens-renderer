// 관제탑 건물 수준 상태(T15.3.1). 계약: contracts/controlview/buildings.mjs BUILDINGS_MODULES.levels.
// 지형 상태(client/tower/terrain/levels.mjs)와 같은 의미다: 한 수준 = 전체 묶음 단위, 도착한 묶음이 이전 묶음을 통째로 교체한다(누적 아님).
// 결정은 contracts/levels 의 decideArrival: first/replace 면 교체, skip(추월당했거나 같은 수준)이면 상태를 바꾸지 않는다.
// 검증(수준·묶음)은 skip 판정과 상태 변경보다 먼저 끝낸다: 잘못된 묶음은 skip 경로에서도 던지고, 던지면 상태는 그대로다(원자적).
// 시계·타이머 없음: 상태는 도착 이벤트로만 바뀐다.
import { NONE, ACTIONS, decideArrival, assertLevel } from '../../../contracts/levels/index.mjs';
import { validateBundle } from './validate.mjs';

// 보관용 복사: 형식화 배열은 동결할 수 없으므로 새 배열로 복사해 입력의 사후 변경을 끊는다.
// 돌려주는 형식화 배열은 읽기 전용 계약이다(읽을 때마다 복사하지 않는다).
function copyGroup(group) {
  return Object.freeze({
    ids: Object.freeze([...group.ids]),
    mesh: Object.freeze({ positions: new Float32Array(group.mesh.positions), indices: new Uint32Array(group.mesh.indices) }),
    edgeLines: new Float32Array(group.edgeLines),
    uv: new Float32Array(group.uv),
    wallMask: new Uint8Array(group.wallMask),
    points: new Float32Array(group.points),
  });
}

function copyImage(image) {
  if (image === null) return null;
  return Object.freeze({ width: image.width, height: image.height, rgb: new Uint8Array(image.rgb) });
}

/** 건물 수준 상태. accept/peek/level/bundle. 도착 전 bundle() 은 null. */
export function createBuildingsState() {
  let currentLevel = NONE;
  let stored = null;

  return {
    /** 도착 처리. 'first' | 'replace' | 'skip'. 던지면 상태는 그대로다. */
    accept(level, bundle) {
      // 수준 검사를 묶음 검사보다 먼저 한다: 둘 다 틀리면 수준 오류가 난다.
      assertLevel(level);
      validateBundle(bundle);
      const action = decideArrival(currentLevel, level);
      if (action === ACTIONS.SKIP) return action;
      stored = Object.freeze({ groups: Object.freeze(bundle.groups.map(copyGroup)), image: copyImage(bundle.image) });
      currentLevel = level;
      return action;
    },
    /** 상태를 바꾸지 않고 결정만 본다. 수준이 잘못이면 던진다(decideArrival 이 검사). */
    peek(level) {
      return decideArrival(currentLevel, level);
    },
    /** 현재 수준: -1(없음) 또는 0..3. */
    level() {
      return currentLevel;
    },
    /** 보관 중 묶음(동결된 사본, 형식화 배열은 읽기 전용) 또는 아직 도착 전이면 null. */
    bundle() {
      return stored;
    },
  };
}
