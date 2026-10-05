// 관제탑 조각 요청 입력 검사(T15.7). 계약: contracts/controlview/streaming.mjs.
// 규칙: 형식 위반(타입이 다름)은 TypeError, 알 수 없는 키·범위 위반은 RangeError. 입력은 고치지 않고 정규화된 새 객체를 돌려준다.
import { TOWER_STREAMING_LIMITS } from '../../../contracts/controlview/streaming.mjs';
import { poseToView } from '../overlay/view.mjs';

const OPT_KEYS = ['maxDistM', 'zRangeM', 'maxInflight', 'retainMargin', 'maxHeld', 'nearM'];
export const TILE_INDEX_MAX = 1_000_000; // 타일 번호 절댓값 상한(64 m 타일 기준 64000 km)
const INT_RANGES = { maxInflight: [1, 4096], retainMargin: [0, 16], maxHeld: [1, 1_000_000] };

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v, name) => {
  if (typeof v !== 'number') throw new TypeError(`${name} 는 숫자여야 한다`);
  return v;
};
const norm = (x) => (x === 0 ? 0 : x); // -0 → 0

function int(v, name, lo, hi) {
  num(v, name);
  if (!Number.isInteger(v) || v < lo || v > hi) throw new RangeError(`${name} 는 ${lo}..${hi} 정수여야 한다: ${v}`);
  return v;
}

function posFinite(v, name) {
  num(v, name);
  const f = Math.fround(v);
  if (!Number.isFinite(v) || !Number.isFinite(f) || !(f > 0)) throw new RangeError(`${name} 는 float32 로도 유한한 양수여야 한다: ${v}`);
  return v;
}

/** 옵션 검사 → 정규화된 새 opts(여섯 키 모두 채움). 형식 검사를 먼저 모두 마친 뒤 범위 검사를 한다. */
export function checkOpts(opts) {
  if (opts === undefined) opts = {};
  if (!isObj(opts)) throw new TypeError('opts 는 객체여야 한다');
  const raw = {};
  for (const k of OPT_KEYS) raw[k] = opts[k]; // 접근자는 한 번만 읽는다
  const keys = Object.keys(opts);
  // 1단계: 형식
  for (const k of OPT_KEYS) {
    const v = raw[k];
    if (v === undefined) continue;
    if (k === 'zRangeM') {
      if (!Array.isArray(v)) throw new TypeError('opts.zRangeM 는 배열이어야 한다');
      raw.zRangeM = [num(v[0], 'opts.zRangeM[0]'), num(v[1], 'opts.zRangeM[1]')];
    } else num(v, `opts.${k}`);
  }
  // 2단계: 알 수 없는 키·범위
  for (const k of keys) if (!OPT_KEYS.includes(k)) throw new RangeError(`알 수 없는 opts 키: ${k}`);
  const L = TOWER_STREAMING_LIMITS;
  const out = {};
  out.maxDistM = raw.maxDistM === undefined ? L.maxDistM : posFinite(raw.maxDistM, 'opts.maxDistM');
  out.nearM = raw.nearM === undefined ? L.nearM : posFinite(raw.nearM, 'opts.nearM');
  if (!(out.nearM < out.maxDistM)) throw new RangeError('opts.nearM 는 maxDistM 보다 작아야 한다');
  if (raw.zRangeM === undefined) out.zRangeM = [L.zMinM, L.zMaxM];
  else {
    const [a, b] = raw.zRangeM;
    if (!Number.isFinite(a) || !Number.isFinite(b) || !(a <= b)) throw new RangeError('opts.zRangeM 는 유한한 [min,max] (min ≤ max) 여야 한다');
    out.zRangeM = [norm(a), norm(b)];
  }
  for (const k of ['maxInflight', 'retainMargin', 'maxHeld']) {
    out[k] = raw[k] === undefined ? L[k] : int(raw[k], `opts.${k}`, INT_RANGES[k][0], INT_RANGES[k][1]);
  }
  return out;
}

/** 타일 번호 검사: 숫자가 아니면 TypeError, 정수가 아니거나 ±TILE_INDEX_MAX 밖이면 RangeError. 입력과 같은 값을 돌려준다. */
export function checkTile(tx, ty) {
  int(tx, 'tx', -TILE_INDEX_MAX, TILE_INDEX_MAX);
  int(ty, 'ty', -TILE_INDEX_MAX, TILE_INDEX_MAX);
  return { tx: norm(tx), ty: norm(ty) };
}

/** pose·size 검사는 poseToView 가 던지는 규칙을 그대로 따른다(위임). 검사를 통과하면 view 를 돌려준다. */
export function checkView(pose, size) {
  return poseToView(pose, size);
}
