// 관제탑 입력 층 조립(T15.4). 서명은 contracts/controlview/input.mjs 를 따른다.
// 동기 호출만 쓴다: 눌린 키 -> 자세 적분 -> 카메라 계산이 한 프레임 안에서 끝난다.
import { TOWER_INPUT_DEFAULTS } from '../../../contracts/controlview/input.mjs';
import { createPoseState } from './state.mjs';
import { createKeyTracker } from './keys.mjs';
import { poseToCameraPose } from './camera.mjs';

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

// opts 검사: 형식 위반은 TypeError, 알 수 없는 키·범위 위반은 RangeError.
function checkOpts(opts) {
  if (opts === undefined) return {};
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
    throw new TypeError('opts 는 객체여야 한다');
  }
  for (const k of Object.keys(opts)) {
    if (k !== 'pos' && k !== 'yaw' && !Object.prototype.hasOwnProperty.call(TOWER_INPUT_DEFAULTS, k)) {
      throw new RangeError(`알 수 없는 opts 키: ${k}`);
    }
  }
  if (opts.pos !== undefined) {
    if (!Array.isArray(opts.pos) || opts.pos.length !== 3) throw new TypeError('pos 는 길이 3 배열이어야 한다');
    if (!opts.pos.every(isFiniteNum)) throw new RangeError('pos 는 유한한 수여야 한다');
  }
  if (opts.yaw !== undefined && !isFiniteNum(opts.yaw)) {
    throw new RangeError('yaw 는 유한한 수여야 한다');
  }
  for (const k of Object.keys(TOWER_INPUT_DEFAULTS)) {
    if (opts[k] !== undefined && !isFiniteNum(opts[k])) {
      throw new RangeError(`${k} 는 유한한 수여야 한다`);
    }
  }
  // 부호·범위 검사(maxDtSec>0, 속도류>=0, minAltM<=maxAltM 등)는 state.mjs 의 checkOpts 에만 둔다(단일 출처).
  // createPoseState 가 던지는 RangeError 가 그대로 전파된다. 여기에 같은 검사를 다시 두지 않는다.
  return opts;
}

export function createTowerInput(opts) {
  const o = checkOpts(opts);
  const cfg = { ...TOWER_INPUT_DEFAULTS };
  for (const k of Object.keys(TOWER_INPUT_DEFAULTS)) if (o[k] !== undefined) cfg[k] = o[k];
  const state = createPoseState({
    ...cfg,
    pos: o.pos !== undefined ? [...o.pos] : [0, 0, cfg.minAltM],
    yaw: o.yaw !== undefined ? o.yaw : 0,
  });
  const keys = createKeyTracker();

  return {
    keyDown: (code) => keys.down(code),
    keyUp: (code) => keys.up(code),
    releaseAll: () => keys.releaseAll(),
    step(dtSec) {
      if (!isFiniteNum(dtSec) || dtSec < 0) throw new RangeError('dt 는 유한 ≥ 0 이어야 한다');
      // 긴 정지 뒤 순간이동을 막기 위해 상한을 둔다. state.mjs 에도 같은 상한이 있다(의도적 중복).
      return state.step(Math.min(dtSec, cfg.maxDtSec), keys.held());
    },
    pose: () => state.pose(),
    camera: () => poseToCameraPose(state.pose(), cfg.fovYRad),
  };
}
