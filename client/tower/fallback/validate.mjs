// T15.8 폴백 입력 검사(validate): 옵션·뷰·가용성·ENU 범위를 검사하고 정규화된 깊은 복사를 돌려준다.
// 계약: contracts/controlview/fallback.mjs 의 TOWER_FALLBACK_API·TOWER_FALLBACK_LIMITS.
// 규칙: 형식 위반(객체·배열·number 가 아님)은 TypeError, 범위 위반은 RangeError.
// 던지는 순서는 결정적이다: 입력 전체의 형식 검사를 먼저 끝낸 뒤 범위 검사를 한다. 부분 결과는 돌려주지 않는다.
// 입력은 바꾸지 않고, 돌려주는 값은 입력과 메모리를 공유하지 않는다(-0 은 0 으로 정규화).
import { TOWER_FALLBACK_LIMITS } from '../../../contracts/controlview/fallback.mjs';

export { checkDrones, checkDetections, checkPath, checkSize } from '../overlay/validate.mjs';

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isArr = (v) => Array.isArray(v);
const norm = (x) => (x === 0 ? 0 : x); // -0 → 0

// ---- 1단계: 형식 검사하며 원시 값만 복사한다(접근자는 한 번만 읽는다) ----

function rawNum(v, name) {
  if (typeof v !== 'number') throw new TypeError(`${name} 는 숫자여야 한다`);
  return v;
}

function snap(o, fields) {
  const keys = Object.keys(o);
  const vals = {};
  for (const f of fields) if (hasOwn(o, f)) vals[f] = o[f];
  return { keys, vals };
}

// ---- 2단계: 범위 검사 ----

function checkKeys(keys, allowed, name) {
  for (const k of keys) if (!allowed.includes(k)) throw new RangeError(`${name} 에 알 수 없는 키 '${k}'`);
}

function checkFinite(x, name) {
  if (!Number.isFinite(x)) throw new RangeError(`${name} 는 유한해야 한다`);
  return norm(x);
}

// ---- checkFallbackOpts ----

export function checkFallbackOpts(opts) {
  if (opts === undefined) return { minSpanM: TOWER_FALLBACK_LIMITS.minSpanM, marginPx: TOWER_FALLBACK_LIMITS.marginPx };

  if (!isObj(opts)) throw new TypeError('opts 는 객체여야 한다');

  const { keys, vals } = snap(opts, ['minSpanM', 'marginPx']);

  // 형식 검사
  if (vals.minSpanM !== undefined) rawNum(vals.minSpanM, 'opts.minSpanM');
  if (vals.marginPx !== undefined) rawNum(vals.marginPx, 'opts.marginPx');
  checkKeys(keys, ['minSpanM', 'marginPx'], 'opts');

  // 범위 검사
  const minSpanM = vals.minSpanM !== undefined ? vals.minSpanM : TOWER_FALLBACK_LIMITS.minSpanM;
  const marginPx = vals.marginPx !== undefined ? vals.marginPx : TOWER_FALLBACK_LIMITS.marginPx;

  if (!Number.isFinite(minSpanM) || minSpanM <= 0) {
    throw new RangeError('opts.minSpanM 은 유한한 양수여야 한다');
  }
  if (!Number.isFinite(marginPx) || marginPx < 0) {
    throw new RangeError('opts.marginPx 는 유한한 음이 아닌 수여야 한다');
  }

  return { minSpanM: norm(minSpanM), marginPx: norm(marginPx) };
}

// ---- checkView ----

export function checkView(view) {
  if (view === null) return null;

  if (!isObj(view)) throw new TypeError('view 는 객체여야 한다');

  const { keys, vals } = snap(view, ['centerE', 'centerN', 'metersPerPx']);

  // 형식 검사
  if (vals.centerE === undefined) throw new TypeError('view.centerE 는 필수다');
  if (vals.centerN === undefined) throw new TypeError('view.centerN 는 필수다');
  if (vals.metersPerPx === undefined) throw new TypeError('view.metersPerPx 는 필수다');

  rawNum(vals.centerE, 'view.centerE');
  rawNum(vals.centerN, 'view.centerN');
  rawNum(vals.metersPerPx, 'view.metersPerPx');
  checkKeys(keys, ['centerE', 'centerN', 'metersPerPx'], 'view');

  // 범위 검사
  const centerE = checkFinite(vals.centerE, 'view.centerE');
  const centerN = checkFinite(vals.centerN, 'view.centerN');
  const metersPerPx = checkFinite(vals.metersPerPx, 'view.metersPerPx');

  if (metersPerPx <= 0) throw new RangeError('view.metersPerPx 는 양수여야 한다');

  return { centerE, centerN, metersPerPx };
}

// ---- checkAvailable ----

export function checkAvailable(v) {
  if (typeof v !== 'boolean') throw new TypeError('available 은 boolean 이어야 한다');
  return v;
}

// ---- checkEnuRange ----

export function checkEnuRange(x) {
  if (isArr(x)) {
    // 배열 형식: 드론·탐지 목록
    for (let i = 0; i < x.length; i++) {
      const item = x[i];
      if (!isObj(item)) throw new TypeError(`배열[${i}] 는 객체여야 한다`);
      const enu = item.enu;
      if (!isArr(enu)) throw new TypeError(`배열[${i}].enu 는 배열이어야 한다`);
      if (enu.length !== 3) throw new TypeError(`배열[${i}].enu 는 성분 3개여야 한다`);

      // enu[0] = e, enu[1] = n 검사
      const e = enu[0];
      const n = enu[1];
      if (typeof e !== 'number') throw new TypeError(`배열[${i}].enu[0] 는 숫자여야 한다`);
      if (typeof n !== 'number') throw new TypeError(`배열[${i}].enu[1] 는 숫자여야 한다`);

      if (!Number.isFinite(e) || !Number.isFinite(n)) throw new RangeError(`배열[${i}].enu 의 e,n 은 유한해야 한다`);
      if (Math.abs(e) > TOWER_FALLBACK_LIMITS.maxAbsEnuM || Math.abs(n) > TOWER_FALLBACK_LIMITS.maxAbsEnuM) {
        throw new RangeError(`배열[${i}].enu 의 |e|,|n| 은 ${TOWER_FALLBACK_LIMITS.maxAbsEnuM} 이하여야 한다`);
      }
    }
    return x;
  } else if (isObj(x)) {
    // 경로 형식: {id, points}
    const id = x.id;
    const points = x.points;

    if (!isArr(points)) throw new TypeError('path.points 는 배열이어야 한다');

    // 각 점의 형식 검사
    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      if (!isArr(pt)) throw new TypeError(`path.points[${i}] 는 배열이어야 한다`);
      if (pt.length !== 3) throw new TypeError(`path.points[${i}] 는 성분 3개여야 한다`);
      const e = pt[0];
      const n = pt[1];
      if (typeof e !== 'number') throw new TypeError(`path.points[${i}][0] 는 숫자여야 한다`);
      if (typeof n !== 'number') throw new TypeError(`path.points[${i}][1] 는 숫자여야 한다`);
    }

    // 범위 검사
    for (let i = 0; i < points.length; i++) {
      const e = points[i][0];
      const n = points[i][1];
      if (!Number.isFinite(e) || !Number.isFinite(n)) {
        throw new RangeError(`path.points[${i}] 의 e,n 은 유한해야 한다`);
      }
      if (Math.abs(e) > TOWER_FALLBACK_LIMITS.maxAbsEnuM || Math.abs(n) > TOWER_FALLBACK_LIMITS.maxAbsEnuM) {
        throw new RangeError(`path.points[${i}] 의 |e|,|n| 은 ${TOWER_FALLBACK_LIMITS.maxAbsEnuM} 이하여야 한다`);
      }
    }
    return x;
  } else {
    throw new TypeError('입력은 배열 또는 객체여야 한다');
  }
}
