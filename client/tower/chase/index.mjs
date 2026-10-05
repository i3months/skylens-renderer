// 관제탑 추적 카메라 조립(T15.5). 서명은 contracts/controlview/chase.mjs 를 따른다.
// 동기 호출만 쓴다: 목표 -> 감쇠 -> rig -> 카메라 계산이 한 프레임 안에서 끝난다.
import { TOWER_CHASE_DEFAULTS } from '../../../contracts/controlview/chase.mjs';
import { createChaseState } from './state.mjs';
import { rigPose } from './rig.mjs';
import { poseToCameraPose } from '../input/camera.mjs';

const isNum = (v) => typeof v === 'number';
const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);
const F32_MAX = 3.4028234663852886e38; // float32 최대 유한값. input/camera.mjs 가 카메라 위치에 이 범위를 요구한다.
const isF32 = (v) => Number.isFinite(Math.fround(v));

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
  for (const [k, v] of Object.entries({ distM, heightM, lookAheadM })) {
    if (v !== undefined && !isF32(v)) throw new RangeError(`${k} 는 float32 유한이어야 한다`);
  }
  // 카메라 위치 = pos − distM·(sin,cos) + heightM 이 어떤 목표에서도 float32 안에 들도록 합을 막는다.
  if (Math.abs(distM ?? TOWER_CHASE_DEFAULTS.distM) + Math.abs(heightM ?? TOWER_CHASE_DEFAULTS.heightM) > F32_MAX) {
    throw new RangeError('|distM| + |heightM| 가 float32 범위를 넘는다');
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
      // 카메라 위치(pos 성분 ± distM, + heightM)가 float32 유한이어야 camera() 가 던지지 않는다.
      const reach = Math.abs(cfg.distM) + Math.abs(cfg.heightM);
      if (!pos.every((v) => isF32(v) && Math.abs(v) + reach <= F32_MAX)) {
        throw new RangeError('pos 는 float32 유한이고 카메라 위치(pos ± distM, + heightM)도 float32 범위 안이어야 한다');
      }
      chase.setTarget([...pos], yaw);
      hasTarget = true;
    },
    // 목표 상실: 마지막 자세를 그리지 않도록 목표를 해제한다. 재등장 뒤 컷은 호출자가 snap() 한다.
    clearTarget() {
      hasTarget = false;
    },
    step(dtSec) {
      if (!isNum(dtSec)) throw new TypeError('dt 는 number 여야 한다');
      if (!isFiniteNum(dtSec) || dtSec < 0) throw new RangeError('dt 는 유한 ≥ 0 이어야 한다');
      // 긴 정지 뒤 급가속을 막기 위해 상한을 둔다. state.mjs 에 같은 상한이 있어도 의도적 중복이다.
      if (!hasTarget) return null;
      return chase.step(Math.min(dtSec, cfg.maxDtSec));
    },
    snap() {
      if (hasTarget) chase.snap();
    },
    camera() {
      if (!hasTarget) return null;
      return poseToCameraPose(rigPose(chase.state(), cfg), cfg.fovYRad);
    },
  };
}
