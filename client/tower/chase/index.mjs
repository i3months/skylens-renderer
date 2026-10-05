// 관제탑 추적 카메라 조립(T15.5). 서명은 contracts/controlview/chase.mjs 를 따른다.
// 동기 호출만 쓴다: 목표 -> 감쇠 -> rig -> 카메라 계산이 한 프레임 안에서 끝난다.
import { TOWER_CHASE_DEFAULTS } from '../../../contracts/controlview/chase.mjs';
import { createChaseState } from './state.mjs';
import { rigPose } from './rig.mjs';
import { poseToCameraPose } from '../input/camera.mjs';

const isNum = (v) => typeof v === 'number';
const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

// opts 검사: 형식 위반은 TypeError, 알 수 없는 키·범위 위반은 RangeError.
function checkOpts(opts) {
  if (opts === undefined) return {};
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
    throw new TypeError('opts 는 객체여야 한다');
  }
  for (const k of Object.keys(opts)) {
    if (!Object.prototype.hasOwnProperty.call(TOWER_CHASE_DEFAULTS, k)) {
      throw new RangeError(`알 수 없는 opts 키: ${k}`);
    }
  }
  for (const k of Object.keys(TOWER_CHASE_DEFAULTS)) {
    if (opts[k] !== undefined && !isNum(opts[k])) throw new TypeError(`${k} 는 number 여야 한다`);
  }
  const { tauSec, distM, heightM, lookAheadM, fovYRad, maxDtSec } = opts;
  for (const [k, v] of Object.entries({ tauSec, distM, heightM, lookAheadM, fovYRad, maxDtSec })) {
    if (v !== undefined && !Number.isFinite(v)) throw new RangeError(`${k} 는 유한해야 한다`);
  }
  if (tauSec !== undefined && tauSec < 0) throw new RangeError('tauSec 는 0 이상이어야 한다');
  if (distM !== undefined && distM < 0) throw new RangeError('distM 는 0 이상이어야 한다');
  if (maxDtSec !== undefined && !(maxDtSec > 0)) throw new RangeError('maxDtSec 는 0 보다 커야 한다');
  if (fovYRad !== undefined) {
    const f32 = Math.fround(fovYRad);
    if (!(fovYRad > 0 && fovYRad < Math.PI) || !(f32 > 0 && f32 < Math.PI)) {
      throw new RangeError('fovYRad 는 0<fovY<π 여야 한다(float32 반올림 후에도)');
    }
  }
  return opts;
}

export function createChaseCamera(opts) {
  const o = checkOpts(opts);
  const cfg = { ...TOWER_CHASE_DEFAULTS };
  for (const k of Object.keys(TOWER_CHASE_DEFAULTS)) if (o[k] !== undefined) cfg[k] = o[k];
  const chase = createChaseState(cfg);
  let hasTarget = false;

  return {
    setTarget(pos, yaw) {
      if (!Array.isArray(pos) || pos.length !== 3) throw new TypeError('pos 는 길이 3 배열이어야 한다');
      if (!pos.every(isNum)) throw new TypeError('pos 는 number 배열이어야 한다');
      if (!isNum(yaw)) throw new TypeError('yaw 는 number 여야 한다');
      if (!pos.every(isFiniteNum) || !isFiniteNum(yaw)) throw new RangeError('pos·yaw 는 유한해야 한다');
      chase.setTarget([...pos], yaw);
      hasTarget = true;
    },
    step(dtSec) {
      if (!isFiniteNum(dtSec) || dtSec < 0) throw new RangeError('dt 는 유한 ≥ 0 이어야 한다');
      // 긴 정지 뒤 급가속을 막기 위해 상한을 둔다. state.mjs 에 같은 상한이 있어도 의도적 중복이다.
      return chase.step(Math.min(dtSec, cfg.maxDtSec));
    },
    snap: () => chase.snap(),
    camera() {
      if (!hasTarget) return null;
      return poseToCameraPose(rigPose(chase.state(), cfg), cfg.fovYRad);
    },
  };
}
