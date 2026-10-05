// 추적 카메라 감쇠 상태(T15.5). TOWER_CHASE_FORMULA.position·yaw. 순수 JS, 타이머·네트워크 없음.
import { dampFactor, wrapPi, dampScalar, dampAngle } from './damp.mjs';

const DEFAULT_TAU = 0.35;
const DEFAULT_MAX_DT = 0.25;

function checkPos(pos) {
  if (!Array.isArray(pos)) throw new TypeError('pos 는 길이 3 배열이어야 한다');
  if (pos.length !== 3) throw new RangeError('pos 길이는 3 이어야 한다');
  for (const v of pos) {
    if (typeof v !== 'number') throw new TypeError('pos 성분은 숫자여야 한다');
    if (!Number.isFinite(v)) throw new RangeError('pos 성분은 유한해야 한다');
  }
}
function checkNum(v, name) {
  if (typeof v !== 'number') throw new TypeError(`${name} 은 숫자여야 한다`);
  if (!Number.isFinite(v)) throw new RangeError(`${name} 은 유한해야 한다`);
}

export function createChaseState(cfg = {}) {
  if (cfg === null || typeof cfg !== 'object') throw new TypeError('cfg 는 객체여야 한다');
  const tauSec = cfg.tauSec === undefined ? DEFAULT_TAU : cfg.tauSec;
  const maxDtSec = cfg.maxDtSec === undefined ? DEFAULT_MAX_DT : cfg.maxDtSec;
  checkNum(tauSec, 'tauSec');
  checkNum(maxDtSec, 'maxDtSec');
  if (tauSec < 0) throw new RangeError('tauSec 는 0 이상이어야 한다');
  if (maxDtSec <= 0) throw new RangeError('maxDtSec 는 0 보다 커야 한다');

  let target = null; // { pos, yaw }
  let cur = null;

  const copy = () => ({ pos: [cur.pos[0], cur.pos[1], cur.pos[2]], yaw: cur.yaw });

  return {
    setTarget(pos, yaw) {
      checkPos(pos);
      checkNum(yaw, 'yaw');
      target = { pos: [pos[0], pos[1], pos[2]], yaw: wrapPi(yaw) };
      // 첫 호출은 감쇠 없이 그 자리에 놓는다
      if (cur === null) cur = { pos: [...target.pos], yaw: target.yaw };
    },
    step(dt) {
      checkNum(dt, 'dt');
      if (dt < 0) throw new RangeError('dt 는 0 이상이어야 한다');
      if (cur === null) return null;
      const a = dampFactor(Math.min(dt, maxDtSec), tauSec);
      cur.pos = cur.pos.map((c, i) => dampScalar(c, target.pos[i], a));
      cur.yaw = wrapPi(dampAngle(cur.yaw, target.yaw, a));
      return copy();
    },
    snap() {
      if (target === null) return;
      cur = { pos: [...target.pos], yaw: target.yaw };
    },
    state() {
      return cur === null ? null : copy();
    },
  };
}
