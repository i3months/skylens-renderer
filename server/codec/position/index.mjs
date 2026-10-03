// 위치 스트림(codec 1, T09.1). 계약 contracts/codec/index.mjs 의 pos 원스트림:
// 모턴 키 오름차순으로 정렬된 점들의 키 차분을 LEB128(7 비트씩, 하위부터, 최상위 비트 = 이어짐)로 이어 붙인다.
// 모턴 키(48 비트): 축 값의 비트 i → e 는 키 비트 3i, n 은 3i+1, u 는 3i+2.
// 키는 2^48 미만이라 Number 로 정확하지만 JS 비트 연산은 32 비트라서, 각 축의 하위 8 비트(키 하위 24 비트)와
// 상위 8 비트(키 상위 24 비트)를 따로 만들어 hi·2^24 + lo 로 합친다.
import { CodecError, MORTON_BITS } from '../../../contracts/codec/index.mjs';

const TWO24 = 0x1000000;
const KEY_LIMIT = 2 ** MORTON_BITS;
/** 차분 하나의 LEB128 최대 길이: ceil(48 / 7) = 7 바이트 */
const LEB_MAX_BYTES = Math.ceil(MORTON_BITS / 7);

// 8 비트 값 v 의 비트 i 를 3i 자리로 펼친 표(결과 < 2^22)
const SPREAD8 = new Uint32Array(256);
for (let v = 0; v < 256; v++) {
  let s = 0;
  for (let i = 0; i < 8; i++) if (v & (1 << i)) s |= 1 << (3 * i);
  SPREAD8[v] = s;
}

/** 24 비트 반쪽 키에서 축 하나(시작 비트 off)의 8 비트를 모은다 */
function compact8(half, off) {
  let v = 0;
  for (let i = 0; i < 8; i++) v |= ((half >>> (3 * i + off)) & 1) << i;
  return v;
}

/** 양자화 위치의 모턴 키(0 ≤ 결과 < 2^48, 정확한 정수 Number) */
function key3(e, n, u) {
  const lo = SPREAD8[e & 0xff] | (SPREAD8[n & 0xff] << 1) | (SPREAD8[u & 0xff] << 2);
  const hi = SPREAD8[e >>> 8] | (SPREAD8[n >>> 8] << 1) | (SPREAD8[u >>> 8] << 2);
  return hi * TWO24 + lo;
}

/**
 * 모턴 순서로 정렬된 양자화 위치 → pos 원스트림(키 차분 LEB128).
 * @param {Uint16Array} qe @param {Uint16Array} qn @param {Uint16Array} qu
 * @returns {Uint8Array}
 */
export function encodePositionStream(qe, qn, qu) {
  if (!(qe instanceof Uint16Array) || !(qn instanceof Uint16Array) || !(qu instanceof Uint16Array)) {
    throw new CodecError('stream', 'positions must be Uint16Array');
  }
  const n = qe.length;
  if (qn.length !== n || qu.length !== n) throw new CodecError('length', 'position planes differ in length');
  const buf = new Uint8Array(n * LEB_MAX_BYTES);
  let w = 0;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const k = key3(qe[i], qn[i], qu[i]);
    if (k < prev) throw new CodecError('stream', `points not in Morton order at index ${i}`);
    let d = k - prev;
    prev = k;
    // 48 비트 차분이라 >>> 대신 나눗셈·나머지로 7 비트씩 떼어 낸다
    while (d >= 0x80) {
      buf[w++] = (d % 0x80) | 0x80;
      d = Math.floor(d / 0x80);
    }
    buf[w++] = d;
  }
  return buf.slice(0, w);
}

/**
 * pos 원스트림 → 정확히 n 점의 양자화 위치(모턴 순서).
 * 바이트를 남기거나 모자라거나 차분 하나가 7 바이트를 넘거나 LEB128 이 최소 표현이 아니면 CodecError('stream'), 키 ≥ 2^48 이면 CodecError('range').
 * @param {Uint8Array} bytes @param {number} n
 * @returns {{qe: Uint16Array, qn: Uint16Array, qu: Uint16Array}}
 */
export function decodePositionStream(bytes, n) {
  if (!(bytes instanceof Uint8Array)) throw new CodecError('stream', 'input is not bytes');
  if (!Number.isInteger(n) || n < 0) throw new CodecError('length', `bad point count ${n}`);
  // 점 하나에 최소 1 바이트가 필요하므로 n 이 바이트 수보다 크면 할당 전에 거부한다
  if (n > bytes.length) throw new CodecError('stream', 'position stream too short');
  const qe = new Uint16Array(n);
  const qn = new Uint16Array(n);
  const qu = new Uint16Array(n);
  const len = bytes.length;
  let r = 0;
  let key = 0;
  for (let i = 0; i < n; i++) {
    let d = 0;
    let mul = 1;
    let j = 0;
    for (;;) {
      if (r >= len) throw new CodecError('stream', 'position stream truncated');
      if (j >= LEB_MAX_BYTES) throw new CodecError('stream', 'position delta varint too long');
      const b = bytes[r++];
      d += (b & 0x7f) * mul;
      mul *= 0x80;
      if (b < 0x80) {
        if (b === 0 && j > 0) throw new CodecError('stream', 'position delta varint not minimal');
        break;
      }
      j++;
    }
    key += d;
    if (key >= KEY_LIMIT) throw new CodecError('range', `Morton key ${key} >= 2^${MORTON_BITS}`);
    const hi = Math.floor(key / TWO24);
    const lo = key - hi * TWO24;
    qe[i] = (compact8(hi, 0) << 8) | compact8(lo, 0);
    qn[i] = (compact8(hi, 1) << 8) | compact8(lo, 1);
    qu[i] = (compact8(hi, 2) << 8) | compact8(lo, 2);
  }
  if (r !== len) throw new CodecError('stream', `${len - r} trailing bytes in position stream`);
  return { qe, qn, qu };
}

/**
 * 위치 양자화 오차 상한(축마다, m) = 2^-(quantExp+1). 명세 §8.
 * @param {number} quantExp 8, 9, 10
 * @returns {number}
 */
export function positionErrorBoundM(quantExp) {
  if (quantExp !== 8 && quantExp !== 9 && quantExp !== 10) throw new CodecError('range', `quant_exp ${quantExp} not in 8..10`);
  return 2 ** -(quantExp + 1);
}
