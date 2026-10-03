// T09.2 법선 팔면체 스트림. 형식은 contracts/codec/index.mjs 주석의 normal 원스트림:
// 같은 점 순서의 oct_x, oct_y 를 이전 점과의 차분(첫 점의 이전 값 = 0, 범위 −254..254) →
// 지그재그(z = d ≥ 0 ? 2d : −2d−1, 0..508) → LEB128(7 비트씩 하위부터, 최상위 비트 = 이어짐).
// 배치는 x 평면 전부 뒤에 y 평면 전부. 팔면체 사상 식(ASSET_FORMAT §5.3·§6)은 server/asset/pack·unpack 을 재사용한다.
import { CodecError, POINT_COUNT_MAX } from '../../../contracts/codec/index.mjs';
import { OCT_SNORM_MAX } from '../../../contracts/asset/index.mjs';
import { encodeOctNormal } from '../../asset/pack/index.mjs';
import { decodeOctNormal } from '../../asset/unpack/index.mjs';

/** u16 지그재그 값은 LEB128 로 최대 3 바이트(7+7+2 비트). */
const LEB_MAX_BYTES = 3;
const U16_MAX = 0xffff;

/**
 * 한 평면(차분 → 지그재그 → LEB128)을 out 의 pos 부터 쓴다. 쓴 뒤 위치를 돌려준다.
 * @param {Int8Array} plane @param {Uint8Array} out @param {number} pos
 */
function writePlane(plane, out, pos) {
  let prev = 0;
  for (let i = 0; i < plane.length; i++) {
    const v = plane[i];
    const d = v - prev;
    prev = v;
    let z = d >= 0 ? 2 * d : -2 * d - 1;
    while (z >= 0x80) {
      out[pos++] = (z & 0x7f) | 0x80;
      z >>>= 7;
    }
    out[pos++] = z;
  }
  return pos;
}

/**
 * 법선 원스트림 부호화.
 * @param {Int8Array} octX 값 −127..127
 * @param {Int8Array} octY 값 −127..127, 길이는 octX 와 같음
 * @returns {Uint8Array}
 */
export function encodeNormalStream(octX, octY) {
  if (!(octX instanceof Int8Array) || !(octY instanceof Int8Array)) {
    throw new CodecError('format', 'normal planes must be Int8Array');
  }
  if (octX.length !== octY.length) {
    throw new CodecError('length', `normal plane lengths differ (${octX.length} vs ${octY.length})`);
  }
  const n = octX.length;
  if (n > POINT_COUNT_MAX) throw new CodecError('limit', `point count ${n} exceeds ${POINT_COUNT_MAX}`);
  for (const plane of [octX, octY]) {
    for (let i = 0; i < n; i++) {
      if (plane[i] < -OCT_SNORM_MAX) throw new CodecError('range', `oct value ${plane[i]} at ${i} not in ±${OCT_SNORM_MAX}`);
    }
  }
  // 차분 −254..254 → 지그재그 ≤ 508 < 2^14, 값마다 최대 2 바이트
  const out = new Uint8Array(4 * n);
  let pos = writePlane(octX, out, 0);
  pos = writePlane(octY, out, pos);
  return out.slice(0, pos);
}

/**
 * 한 평면을 읽어 dst 에 채운다. 읽은 뒤 위치를 돌려준다.
 * @param {Uint8Array} bytes @param {number} pos @param {Int8Array} dst @param {string} name
 */
function readPlane(bytes, pos, dst, name) {
  let prev = 0;
  for (let i = 0; i < dst.length; i++) {
    let z = 0;
    let shift = 0;
    let k = 0;
    for (;;) {
      if (pos >= bytes.length) throw new CodecError('stream', `normal ${name} plane truncated at point ${i}`);
      if (k >= LEB_MAX_BYTES) throw new CodecError('stream', `normal ${name} LEB128 too long at point ${i}`);
      const b = bytes[pos++];
      z += (b & 0x7f) * 2 ** shift;
      k++;
      if ((b & 0x80) === 0) {
        // 정규형만 받는다: 두 바이트 이상인데 마지막 바이트가 0 이면 중복 표현
        if (k > 1 && b === 0) throw new CodecError('stream', `normal ${name} non-canonical LEB128 at point ${i}`);
        break;
      }
      shift += 7;
    }
    if (z > U16_MAX) throw new CodecError('stream', `normal ${name} zigzag ${z} exceeds u16 at point ${i}`);
    const d = (z & 1) === 0 ? z / 2 : -(z + 1) / 2;
    const v = prev + d;
    if (v < -OCT_SNORM_MAX || v > OCT_SNORM_MAX) {
      throw new CodecError('range', `normal ${name} value ${v} at point ${i} not in ±${OCT_SNORM_MAX}`);
    }
    dst[i] = v;
    prev = v;
  }
  return pos;
}

/**
 * 법선 원스트림 복호. 정확히 n 점(x 평면 n 개, y 평면 n 개)을 읽고 바이트가 남거나 모자라면 CodecError('stream').
 * @param {Uint8Array} bytes
 * @param {number} n
 * @returns {{octX: Int8Array, octY: Int8Array}}
 */
export function decodeNormalStream(bytes, n) {
  if (!(bytes instanceof Uint8Array)) throw new CodecError('stream', 'normal stream must be Uint8Array');
  if (!Number.isSafeInteger(n) || n < 0) throw new CodecError('stream', `bad point count ${n}`);
  if (n > POINT_COUNT_MAX) throw new CodecError('limit', `point count ${n} exceeds ${POINT_COUNT_MAX}`);
  // 값마다 최소 1 바이트: 할당 전에 길이 하한을 본다
  if (bytes.length < 2 * n) throw new CodecError('stream', `normal stream ${bytes.length} B too short for ${n} points`);
  const octX = new Int8Array(n);
  const octY = new Int8Array(n);
  let pos = readPlane(bytes, 0, octX, 'x');
  pos = readPlane(bytes, pos, octY, 'y');
  if (pos !== bytes.length) throw new CodecError('stream', `normal stream has ${bytes.length - pos} trailing bytes`);
  return { octX, octY };
}

/**
 * 원 법선을 팔면체 snorm8 로 부호화·복호화했을 때의 각 오차(도). 명세 §8 상한 1.0°.
 * 각은 atan2(|a×b|, a·b) 로 구한다(작은 각에서 acos 보다 정확).
 * @param {number} nx @param {number} ny @param {number} nz 유한, 길이 0 아님(단위 길이 불필요)
 * @returns {number}
 */
export function normalAngleErrorDeg(nx, ny, nz) {
  for (const c of [nx, ny, nz]) {
    if (typeof c !== 'number' || !Number.isFinite(c)) throw new CodecError('range', 'normal component not finite');
  }
  const len = Math.hypot(nx, ny, nz);
  if (!(len > 0) || !Number.isFinite(len)) throw new CodecError('range', 'normal has zero or overflowing length');
  const ax = nx / len;
  const ay = ny / len;
  const az = nz / len;
  const [qx, qy] = encodeOctNormal(ax, ay, az);
  const [bx, by, bz] = decodeOctNormal(qx, qy);
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  const dot = ax * bx + ay * by + az * bz;
  return (Math.atan2(Math.hypot(cx, cy, cz), dot) * 180) / Math.PI;
}
