// 관제탑 오버레이 입력 검사(validate): 드론·탐지·경로·크기·옵션을 검사하고 정규화된 깊은 복사를 돌려준다.
// 계약: contracts/controlview/overlay.mjs 의 TOWER_OVERLAY_API·TOWER_OVERLAY_LIMITS·TOWER_OVERLAY_KINDS.
// 규칙: 형식 위반(배열·객체·문자열·number 가 아님)은 TypeError, 범위 위반은 RangeError.
// 던지는 순서는 결정적이다: 입력 전체의 형식 검사를 먼저 끝낸 뒤 범위 검사를 한다. 부분 결과는 돌려주지 않는다.
// 입력은 바꾸지 않고, 돌려주는 값은 입력과 메모리를 공유하지 않는다(-0 은 0 으로 정규화).
import { TOWER_OVERLAY_LIMITS, TOWER_OVERLAY_KINDS } from '../../../contracts/controlview/overlay.mjs';

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const norm = (x) => (x === 0 ? 0 : x); // -0 → 0

// ---- 1단계: 형식 검사하며 원시 값만 복사한다(접근자는 한 번만 읽는다) ----

function rawNum(v, name) {
  if (typeof v !== 'number') throw new TypeError(`${name} 는 숫자여야 한다`);
  return v;
}

function rawArray(v, name) {
  if (!Array.isArray(v)) throw new TypeError(`${name} 는 배열이어야 한다`);
  const n = v.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = v[i]; // 희소 칸은 undefined 가 되어 아래 형식 검사에서 걸린다
  return out;
}

function rawObj(v, name) {
  if (!isObj(v)) throw new TypeError(`${name} 는 객체여야 한다`);
  return v;
}

function rawVec(v, name) {
  const a = rawArray(v, name);
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = rawNum(a[i], `${name}[${i}]`);
  return out;
}

// 객체에서 키 목록과 지정 필드를 한 번씩만 읽는다. 선택 필드는 undefined 면 없는 것으로 본다.
function snap(o, fields) {
  const keys = Object.keys(o);
  const vals = {};
  for (const f of fields) if (hasOwn(o, f)) vals[f] = o[f];
  return { keys, vals };
}

function rawItem(item, name, kind) {
  rawObj(item, name);
  const { keys, vals } = snap(item, kind === 'drone' ? ['id', 'enu', 'yaw'] : ['id', 'enu', 'kind', 'confidence']);
  if (typeof vals.id !== 'string') throw new TypeError(`${name}.id 는 문자열이어야 한다`);
  const r = { keys, id: vals.id, enu: rawVec(vals.enu, `${name}.enu`) };
  if (kind === 'drone') {
    if (vals.yaw !== undefined) r.yaw = rawNum(vals.yaw, `${name}.yaw`);
  } else {
    if (vals.kind !== undefined) {
      if (typeof vals.kind !== 'string') throw new TypeError(`${name}.kind 는 문자열이어야 한다`);
      r.kind = vals.kind;
    }
    if (vals.confidence !== undefined) r.confidence = rawNum(vals.confidence, `${name}.confidence`);
  }
  return r;
}

// ---- 2단계: 범위 검사 ----

function checkKeys(keys, allowed, name) {
  for (const k of keys) if (!allowed.includes(k)) throw new RangeError(`${name} 에 알 수 없는 키 '${k}'`);
}

function checkId(id, name) {
  const n = Array.from(id).length; // 코드포인트 단위
  if (n === 0 || n > TOWER_OVERLAY_LIMITS.maxIdChars) {
    throw new RangeError(`${name}.id 길이는 1..${TOWER_OVERLAY_LIMITS.maxIdChars} 자여야 한다`);
  }
}

// float32 로도 유한해야 한다(렌더가 float32 로 내릴 때 Infinity 가 되는 결함을 막는다).
function checkF32(x, name) {
  if (!Number.isFinite(x) || !Number.isFinite(Math.fround(x))) {
    throw new RangeError(`${name} 는 float32 로도 유한해야 한다`);
  }
  return norm(x);
}

function checkVec(a, name) {
  if (a.length !== 3) throw new RangeError(`${name} 는 성분 3개여야 한다`);
  return [checkF32(a[0], `${name}[0]`), checkF32(a[1], `${name}[1]`), checkF32(a[2], `${name}[2]`)];
}

function checkList(list, kind, max, name) {
  const raw = rawArray(list, name);
  const items = raw.map((it, i) => rawItem(it, `${name}[${i}]`, kind));
  if (items.length > max) throw new RangeError(`${name} 는 ${max} 개 이하여야 한다`);
  const allowed = kind === 'drone' ? ['id', 'enu', 'yaw'] : ['id', 'enu', 'kind', 'confidence'];
  const seen = new Set();
  const out = [];
  items.forEach((r, i) => {
    const nm = `${name}[${i}]`;
    checkKeys(r.keys, allowed, nm);
    checkId(r.id, nm);
    if (seen.has(r.id)) throw new RangeError(`${nm}.id '${r.id}' 가 중복이다`);
    seen.add(r.id);
    const o = { id: r.id, enu: checkVec(r.enu, `${nm}.enu`) };
    if (kind === 'drone') {
      if (r.yaw !== undefined) {
        if (!Number.isFinite(r.yaw)) throw new RangeError(`${nm}.yaw 는 유한해야 한다`);
        o.yaw = norm(r.yaw);
      }
    } else {
      const k = r.kind === undefined ? 'detection' : r.kind;
      if (!TOWER_OVERLAY_KINDS.includes(k)) throw new RangeError(`${nm}.kind '${k}' 는 알 수 없다`);
      o.kind = k;
      if (r.confidence !== undefined) {
        if (!(r.confidence >= 0 && r.confidence <= 1)) throw new RangeError(`${nm}.confidence 는 [0,1] 이어야 한다`);
        o.confidence = norm(r.confidence);
      }
    }
    out.push(o);
  });
  return out;
}

export function checkDrones(list) {
  return checkList(list, 'drone', TOWER_OVERLAY_LIMITS.maxDrones, 'drones');
}

export function checkDetections(list) {
  return checkList(list, 'detection', TOWER_OVERLAY_LIMITS.maxDetections, 'detections');
}

export function checkPath(path) {
  rawObj(path, 'path');
  const { keys, vals } = snap(path, ['id', 'points']);
  if (typeof vals.id !== 'string') throw new TypeError('path.id 는 문자열이어야 한다');
  const pts = rawArray(vals.points, 'path.points').map((p, i) => rawVec(p, `path.points[${i}]`));
  checkKeys(keys, ['id', 'points'], 'path');
  checkId(vals.id, 'path');
  if (pts.length < 2) throw new RangeError('path.points 는 2개 이상이어야 한다');
  if (pts.length > TOWER_OVERLAY_LIMITS.maxPathPoints) {
    throw new RangeError(`path.points 는 ${TOWER_OVERLAY_LIMITS.maxPathPoints} 개 이하여야 한다`);
  }
  return { id: vals.id, points: pts.map((p, i) => checkVec(p, `path.points[${i}]`)) };
}

export function checkSize(size) {
  rawObj(size, 'size');
  const { keys, vals } = snap(size, ['width', 'height']);
  rawNum(vals.width, 'size.width');
  rawNum(vals.height, 'size.height');
  checkKeys(keys, ['width', 'height'], 'size');
  for (const k of ['width', 'height']) {
    if (!Number.isInteger(vals[k]) || vals[k] <= 0) throw new RangeError(`size.${k} 는 양의 정수여야 한다`);
  }
  return { width: vals.width, height: vals.height };
}

export function checkOpts(opts) {
  if (opts === undefined) return { nearM: TOWER_OVERLAY_LIMITS.nearM };
  rawObj(opts, 'opts');
  const { keys, vals } = snap(opts, ['nearM']);
  if (vals.nearM !== undefined) rawNum(vals.nearM, 'opts.nearM');
  checkKeys(keys, ['nearM'], 'opts');
  if (vals.nearM === undefined) return { nearM: TOWER_OVERLAY_LIMITS.nearM };
  const f = Math.fround(vals.nearM);
  if (!Number.isFinite(vals.nearM) || !Number.isFinite(f) || !(f > 0)) {
    throw new RangeError('opts.nearM 는 float32 로도 유한한 양수여야 한다');
  }
  return { nearM: vals.nearM };
}
