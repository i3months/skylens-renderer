// 관제탑 입력 층의 자세 상태(createPoseState): 눌린 키 집합으로 위치·방위·고도를 적분한다.
// 좌표: ENU(x=동, y=북, z=위) m. 방위 yaw: 0 = 북(+y), 시계 방향이 +, rad. 네트워크·타이머를 쓰지 않는다.
import { TOWER_INPUT_DEFAULTS } from '../../../contracts/controlview/input.mjs';

const NUM_KEYS = ['yawRateRad', 'speedMps', 'altRateMps', 'minAltM', 'maxAltM', 'pitchRad', 'fovYRad', 'maxDtSec'];

// 속도·회전율·dt 상한의 허용 최댓값.
const MAX_RATE = 1e6;

function finiteNum(v, name) {
  if (typeof v !== 'number') throw new TypeError(`${name} 는 숫자여야 한다`);
  if (!Number.isFinite(v)) throw new RangeError(`${name} 는 유한해야 한다`);
  return v;
}

function checkOpts(opts) {
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) throw new TypeError('opts 는 객체여야 한다');
  const c = { ...TOWER_INPUT_DEFAULTS };
  for (const k of NUM_KEYS) if (opts[k] !== undefined) c[k] = finiteNum(opts[k], k);
  if (c.speedMps < 0) throw new RangeError('speedMps 는 0 이상이어야 한다');
  if (c.yawRateRad < 0) throw new RangeError('yawRateRad 는 0 이상이어야 한다');
  if (c.altRateMps < 0) throw new RangeError('altRateMps 는 0 이상이어야 한다');
  if (c.maxDtSec <= 0) throw new RangeError('maxDtSec 는 0 보다 커야 한다');
  // 극단 값(1e308)이 적분 중 무한대로 번지지 않게 상한을 둔다.
  for (const k of ['speedMps', 'yawRateRad', 'altRateMps', 'maxDtSec']) {
    if (c[k] > MAX_RATE) throw new RangeError(`${k} 는 ${MAX_RATE} 이하여야 한다`);
  }
  // 시야각은 camera.mjs 와 같은 규칙으로 검사한다(float32 반올림 뒤에도 0<fovY<π).
  const f32Fov = Math.fround(c.fovYRad);
  if (!(c.fovYRad > 0 && c.fovYRad < Math.PI) || !(f32Fov > 0 && f32Fov < Math.PI)) {
    throw new RangeError(`fovYRad 는 0<fovY<π 여야 한다(float32 반올림 후에도): ${c.fovYRad}`);
  }
  // 피치는 camera.mjs 와 달리 범위를 제한한다(camera.mjs 는 유한성만 검사).
  if (c.pitchRad < -Math.PI / 2 || c.pitchRad > Math.PI / 2) throw new RangeError('pitchRad 는 [-π/2, π/2] 안이어야 한다');
  if (c.minAltM > c.maxAltM) throw new RangeError('minAltM 은 maxAltM 이하여야 한다');
  // 기본 pos[2] 도 float32 로 유한해야 한다.
  if (!Number.isFinite(Math.fround(c.minAltM))) throw new RangeError('minAltM 은 float32 로도 유한해야 한다');
  if (!Number.isFinite(Math.fround(c.maxAltM))) throw new RangeError('maxAltM 은 float32 로도 유한해야 한다');
  let pos = [0, 0, c.minAltM];
  if (opts.pos !== undefined) {
    if (!Array.isArray(opts.pos) || opts.pos.length !== 3) throw new TypeError('pos 는 길이 3 배열이어야 한다');
    pos = opts.pos.map((v, i) => finiteNum(v, `pos[${i}]`));
    pos.forEach((v, i) => {
      if (!Number.isFinite(Math.fround(v))) throw new RangeError(`pos[${i}] 는 float32 로도 유한해야 한다`);
    });
    if (pos[2] < c.minAltM || pos[2] > c.maxAltM) throw new RangeError('pos[2] 는 [minAltM, maxAltM] 안이어야 한다');
  }
  const yaw = opts.yaw === undefined ? 0 : finiteNum(opts.yaw, 'yaw');
  return { c, pos, yaw };
}

/** createPoseState(opts) -> { step(dt, held), pose() }. held = {yawLeft,yawRight,forward,back,altUp,altDown}. */
export function createPoseState(opts = {}) {
  const { c, pos: p0, yaw: y0 } = checkOpts(opts);
  const pos = p0.slice();
  let yaw = y0;

  return {
    step(dt, held) {
      if (typeof dt !== 'number') throw new TypeError('dt 는 숫자여야 한다');
      if (!Number.isFinite(dt) || dt < 0) throw new RangeError('dt 는 유한 0 이상이어야 한다');
      if (held === null || typeof held !== 'object') throw new TypeError('held 는 객체여야 한다');
      // dt 상한은 index.mjs 에도 있다. 두 층이 각자 독립으로 지키려는 의도적 중복이다.
      const d = Math.min(dt, c.maxDtSec);
      // 반대 키 쌍이 둘 다 눌리면 0 으로 상쇄한다.
      const turn = (held.yawRight ? 1 : 0) - (held.yawLeft ? 1 : 0);
      const move = (held.forward ? 1 : 0) - (held.back ? 1 : 0);
      const climb = (held.altUp ? 1 : 0) - (held.altDown ? 1 : 0);
      // 스텝 중간 방위(yaw + turn·yawRate·d/2)로 이동한 뒤 yaw 를 turn·yawRate·d 만큼 갱신한다(중점 적분).
      const yawMid = yaw + turn * c.yawRateRad * d / 2;
      pos[0] += Math.sin(yawMid) * move * c.speedMps * d;
      pos[1] += Math.cos(yawMid) * move * c.speedMps * d;
      pos[2] = Math.min(c.maxAltM, Math.max(c.minAltM, pos[2] + climb * c.altRateMps * d));
      yaw += turn * c.yawRateRad * d;
      return { pos: pos.slice(), yaw, pitch: c.pitchRad };
    },
    pose() {
      return { pos: pos.slice(), yaw, pitch: c.pitchRad };
    },
  };
}
