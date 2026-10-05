// 관제탑 추적 카메라의 감쇠 수학(damp): 지수 감쇠 계수, 각도 접기, 스칼라·각도 감쇠.
// 계약: contracts/controlview/chase.mjs 의 TOWER_CHASE_FORMULA(factor·position·yaw). 순수 JS, 네트워크·타이머를 쓰지 않는다.
// 방위 yaw: 0 = 북(+y), 시계 방향이 +, rad.

const TWO_PI = 2 * Math.PI;

function num(v, name) {
  if (typeof v !== 'number') throw new TypeError(`${name} 는 숫자여야 한다`);
  if (!Number.isFinite(v)) throw new RangeError(`${name} 는 유한해야 한다`);
  return v;
}

// 감쇠 계수 a = 1 − exp(−dt/tau). tau = 0 이면 1(단, dt = 0 이면 변화 없음이라 0).
export function dampFactor(dt, tau) {
  num(dt, 'dt');
  num(tau, 'tau');
  if (dt < 0) throw new RangeError('dt 는 0 이상이어야 한다');
  if (tau < 0) throw new RangeError('tau 는 0 이상이어야 한다');
  if (dt === 0) return 0;
  if (tau === 0) return 1;
  // expm1 로 작은 dt/tau 에서도 정밀도를 지킨다.
  return -Math.expm1(-dt / tau);
}

// 각도를 (−π, π] 로 접는다(최단 호의 부호 있는 크기).
export function wrapPi(rad) {
  num(rad, 'rad');
  if (rad > -Math.PI && rad <= Math.PI) return rad;
  // |rad| 가 매우 크면 2π 곱 뺄셈이 정밀도를 잃어 범위를 벗어나므로, 삼각함수의 인수 축약에 맡긴다.
  const r = Math.abs(rad) > 1e9 ? Math.atan2(Math.sin(rad), Math.cos(rad)) : rad - TWO_PI * Math.floor((rad + Math.PI) / TWO_PI);
  return r <= -Math.PI ? Math.PI : r;
}

// 스칼라 감쇠: cur + (target − cur)·a.
export function dampScalar(cur, target, a) {
  num(cur, 'cur');
  num(target, 'target');
  num(a, 'a');
  const d = target - cur;
  // 차이가 배정밀도를 넘치면 두 값의 가중합으로 계산한다(결과는 cur·target 사이라 유한하다).
  return Number.isFinite(d) ? cur + d * a : cur * (1 - a) + target * a;
}

// 각도 감쇠: cur + wrapPi(target − cur)·a (최단 호). 결과는 접지 않는다.
export function dampAngle(cur, target, a) {
  num(cur, 'cur');
  num(target, 'target');
  num(a, 'a');
  return cur + wrapPi(target - cur) * a;
}
