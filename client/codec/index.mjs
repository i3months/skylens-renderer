// 브라우저용 codec 1 조각 복호기(T09.6). 서버 코드를 import 하지 않는다(순수 JS, 타입 배열만 사용).
// 형식 단일 출처는 contracts/codec/index.mjs 의 상수와 주석, 체크섬은 format/ASSET_FORMAT.md §7.
import {
  BODY_FIXED_BYTES, BODY_VERSION, COLOR_MODE, ENTROPY_MODE, RANGE_PROB_BITS, RANGE_MOVE_BITS,
  POINT_COUNT_MAX, STREAM_RAW_BYTES_MAX, CODEC1_FORMATS, CODEC_SKLC1, MORTON_BITS, CodecError,
} from '../../contracts/codec/index.mjs';
import { AssetFormatError, OFFSETS, CODEC_RAW_PLANAR } from '../../contracts/asset/index.mjs';
import { readHeaderClient, readPlanesClient } from '../asset/index.mjs';

// ---- CRC-32(IEEE, 반사 0xEDB88320) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** 체크섬 필드(112..115)를 0 으로 보고 [0, len) 의 CRC-32 를 구한다. */
function crc32ZeroField(u8, len) {
  const lo = OFFSETS.checksum, hi = lo + 4;
  let c = 0xffffffff;
  for (let i = 0; i < len; i++) {
    const b = i >= lo && i < hi ? 0 : u8[i];
    c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ---- LEB128 ----
/** bytes[pos..] 에서 LEB128 한 값을 읽는다. maxBytes 를 넘는 이어짐은 'range'. 반환 값은 Number(최대 2^49 미만). */
function readLeb(bytes, st, maxBytes, what) {
  let v = 0, mul = 1;
  for (let k = 0; k < maxBytes; k++) {
    if (st.pos >= bytes.length) throw new CodecError('stream', `${what}: 스트림이 모자라다`);
    const b = bytes[st.pos++];
    v += (b & 127) * mul;
    if ((b & 128) === 0) return v;
    mul *= 128;
  }
  throw new CodecError('range', `${what}: LEB128 이 너무 길다`);
}

// ---- 범위 복호기(LZMA 방식 적응형 이진) ----
const PROB_INIT = 1 << (RANGE_PROB_BITS - 1);
const TOP = 2 ** 24;

/** payload(bytes[off..])를 정확히 rawLen 바이트로 복호한다. 모자라거나 남으면 'range'. */
function rangeDecode(bytes, off, rawLen) {
  const end = bytes.length;
  if (end - off < 5) throw new CodecError('range', '범위 부호 payload 가 5 바이트 미만');
  if (bytes[off] !== 0) throw new CodecError('range', '범위 부호 첫 바이트가 0 이 아니다');
  let pos = off + 1;
  let code = ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
  pos += 4;
  let range = 0xffffffff;
  const probs = new Uint16Array(256).fill(PROB_INIT);
  const out = new Uint8Array(rawLen);
  const kTop = 1 << RANGE_PROB_BITS;
  for (let i = 0; i < rawLen; i++) {
    let node = 1;
    for (let b = 0; b < 8; b++) {
      const p = probs[node];
      const bound = (range >>> RANGE_PROB_BITS) * p;
      let bit;
      if (code < bound) {
        range = bound;
        probs[node] = p + ((kTop - p) >>> RANGE_MOVE_BITS);
        bit = 0;
      } else {
        code -= bound;
        range -= bound;
        probs[node] = p - (p >>> RANGE_MOVE_BITS);
        bit = 1;
      }
      node = (node << 1) | bit;
      while (range < TOP) {
        if (pos >= end) throw new CodecError('range', '범위 부호 payload 가 모자라다');
        range = (range * 256) >>> 0;
        code = ((code * 256) + bytes[pos++]) >>> 0;
      }
    }
    out[i] = node & 255;
  }
  if (pos !== end) throw new CodecError('range', '범위 부호 payload 가 남는다');
  return out;
}

/**
 * entropy 컨테이너 복호. [u8 mode][LEB128 rawLen][payload].
 * @param {Uint8Array} bytes 스트림 바이트
 * @param {number} maxRaw 이 스트림이 가질 수 있는 원바이트 상한(부풀린 rawLen 거부)
 */
function entropyDecodeClient(bytes, maxRaw) {
  if (bytes.length < 2) throw new CodecError('stream', 'entropy 컨테이너가 너무 짧다');
  const mode = bytes[0];
  if (mode !== ENTROPY_MODE.STORED && mode !== ENTROPY_MODE.RANGE) throw new CodecError('mode', `알 수 없는 entropy 모드 ${mode}`);
  const st = { pos: 1 };
  const rawLen = readLeb(bytes, st, 5, 'rawLen');
  if (rawLen > maxRaw || rawLen > STREAM_RAW_BYTES_MAX) throw new CodecError('limit', `rawLen ${rawLen} 이 상한 ${maxRaw} 을 넘는다`);
  if (mode === ENTROPY_MODE.STORED) {
    if (bytes.length - st.pos !== rawLen) throw new CodecError('stream', '저장 모드 payload 길이가 rawLen 과 다르다');
    return bytes.subarray(st.pos);
  }
  return rangeDecode(bytes, st.pos, rawLen);
}

// ---- pos 스트림: 키 차분 LEB128 → 모턴 역인터리브 ----
// 12 비트(점 4 개 분량)를 e/n/u 4 비트씩으로 가르는 표. 키 비트 3i → e, 3i+1 → n, 3i+2 → u.
const DE_E = new Uint8Array(4096), DE_N = new Uint8Array(4096), DE_U = new Uint8Array(4096);
for (let v = 0; v < 4096; v++) {
  for (let i = 0; i < 4; i++) {
    DE_E[v] |= ((v >> (3 * i)) & 1) << i;
    DE_N[v] |= ((v >> (3 * i + 1)) & 1) << i;
    DE_U[v] |= ((v >> (3 * i + 2)) & 1) << i;
  }
}
const KEY_LIMIT = 2 ** MORTON_BITS;

function decodePos(raw, n) {
  const qe = new Uint16Array(n), qn = new Uint16Array(n), qu = new Uint16Array(n);
  const st = { pos: 0 };
  let key = 0;
  for (let i = 0; i < n; i++) {
    key += readLeb(raw, st, 7, 'pos');
    if (key >= KEY_LIMIT) throw new CodecError('range', '모턴 키가 2^48 이상');
    const lo = key % TOP;
    const hi = (key - lo) / TOP;
    const c0 = lo & 4095, c1 = lo >>> 12, c2 = hi & 4095, c3 = hi >>> 12;
    qe[i] = DE_E[c0] | (DE_E[c1] << 4) | (DE_E[c2] << 8) | (DE_E[c3] << 12);
    qn[i] = DE_N[c0] | (DE_N[c1] << 4) | (DE_N[c2] << 8) | (DE_N[c3] << 12);
    qu[i] = DE_U[c0] | (DE_U[c1] << 4) | (DE_U[c2] << 8) | (DE_U[c3] << 12);
  }
  if (st.pos !== raw.length) throw new CodecError('stream', 'pos 스트림에 남는 바이트가 있다');
  return { qe, qn, qu };
}

// ---- normal 스트림: 지그재그 차분 평면 둘 ----
function decodeNormal(raw, n) {
  const st = { pos: 0 };
  const out = [new Int8Array(n), new Int8Array(n)];
  for (const plane of out) {
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const z = readLeb(raw, st, 3, 'normal');
      acc += z & 1 ? -((z + 1) / 2) : z / 2;
      if (acc < -127 || acc > 127) throw new CodecError('range', '법선 oct 값이 -127..127 밖');
      plane[i] = acc;
    }
  }
  if (st.pos !== raw.length) throw new CodecError('stream', 'normal 스트림에 남는 바이트가 있다');
  return { octX: out[0], octY: out[1] };
}

// ---- color 스트림 ----
function decodeColor(raw, n, bodyMode) {
  if (raw.length < 1) throw new CodecError('stream', '빈 색 스트림');
  const mode = raw[0];
  if (mode !== COLOR_MODE.DELTA && mode !== COLOR_MODE.QUANT2 && mode !== COLOR_MODE.PALETTE) {
    throw new CodecError('mode', `알 수 없는 색 모드 ${mode}`);
  }
  if (mode !== bodyMode) throw new CodecError('mode', `본문 색 모드 ${bodyMode} 와 스트림 첫 바이트 ${mode} 가 다르다`);
  const r = new Uint8Array(n), g = new Uint8Array(n), b = new Uint8Array(n);
  if (mode === COLOR_MODE.PALETTE) {
    if (raw.length < 2) throw new CodecError('stream', '팔레트 헤더 부족');
    const k = raw[1] + 1;
    if (raw.length !== 2 + 3 * k + n) throw new CodecError('stream', '팔레트 스트림 길이 불일치');
    const base = 2 + 3 * k;
    for (let i = 0; i < n; i++) {
      const id = raw[base + i];
      if (id >= k) throw new CodecError('range', '팔레트 인덱스 범위 밖');
      r[i] = raw[2 + 3 * id]; g[i] = raw[3 + 3 * id]; b[i] = raw[4 + 3 * id];
    }
    return { r, g, b };
  }
  if (raw.length !== 1 + 3 * n) throw new CodecError('stream', '색 스트림 길이 불일치');
  let o = 1;
  for (const ch of [r, g, b]) {
    let prev = 0;
    for (let i = 0; i < n; i++) {
      prev = (prev + raw[o++]) & 255;
      ch[i] = prev;
    }
  }
  return { r, g, b };
}

/** @param {ArrayBuffer|Uint8Array} bytes */
function toBytes(bytes) {
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (bytes instanceof Uint8Array) return bytes;
  throw new AssetFormatError('short', 'input is not bytes');
}

/**
 * codec 0/1 파일 전체 → 헤더와 평면(codec 1 은 모턴 순서). 손상은 CodecError 또는 AssetFormatError.
 * 주의: 계약상 readHeaderClient 는 codec 1 을 거부하므로(client/asset 은 고치지 않는다) codec 바이트를 0 으로 바꾼 사본으로 읽고
 * 돌려주는 헤더의 codec 만 1 로 되돌린다.
 * @param {ArrayBuffer|Uint8Array} fileBytes
 */
export function decodeChunkClient(fileBytes) {
  const u8 = toBytes(fileBytes);
  if (u8.length > OFFSETS.codec && u8[OFFSETS.codec] === CODEC_RAW_PLANAR) {
    const header = readHeaderClient(u8);
    return { header, planes: readPlanesClient(u8, header) };
  }
  if (u8.length <= OFFSETS.codec || u8[OFFSETS.codec] !== CODEC_SKLC1) {
    // 짧은 입력·모르는 codec 은 헤더 읽기가 AssetFormatError 로 거부한다
    readHeaderClient(u8);
    throw new AssetFormatError('codec', `unknown codec ${u8[OFFSETS.codec]}`);
  }
  const copy = u8.slice();
  copy[OFFSETS.codec] = CODEC_RAW_PLANAR;
  const header = readHeaderClient(copy);
  header.codec = CODEC_SKLC1;

  if (!CODEC1_FORMATS.includes(header.format)) throw new CodecError('format', `codec 1 은 format ${header.format} 을 받지 않는다`);
  if (header.pointCount > POINT_COUNT_MAX) throw new CodecError('limit', `점 수 ${header.pointCount} 가 상한 초과`);
  const n = header.pointCount;
  if (header.bodyBytes < BODY_FIXED_BYTES) throw new CodecError('length', '본문이 고정부(16 B)보다 짧다');
  const base = header.headerSize;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8[base] !== BODY_VERSION) throw new CodecError('format', `본문 버전 ${u8[base]}`);
  const colorMode = u8[base + 1];
  if (dv.getUint16(base + 2, true) !== 0) throw new CodecError('format', '본문 예약 u16 이 0 이 아니다');
  const posLen = dv.getUint32(base + 4, true);
  const nrmLen = dv.getUint32(base + 8, true);
  const colLen = dv.getUint32(base + 12, true);
  if (BODY_FIXED_BYTES + posLen + nrmLen + colLen !== header.bodyBytes) {
    throw new CodecError('length', `스트림 길이 합 ${BODY_FIXED_BYTES + posLen + nrmLen + colLen} != body_bytes ${header.bodyBytes}`);
  }
  if (crc32ZeroField(u8, base + header.bodyBytes) !== header.checksum) throw new CodecError('checksum', '체크섬 불일치');

  const p0 = base + BODY_FIXED_BYTES, p1 = p0 + posLen, p2 = p1 + nrmLen;
  const posRaw = entropyDecodeClient(u8.subarray(p0, p1), 7 * n);
  const nrmRaw = entropyDecodeClient(u8.subarray(p1, p2), 6 * n);
  const colRaw = entropyDecodeClient(u8.subarray(p2, p2 + colLen), 3 * n + 770);
  const { qe, qn, qu } = decodePos(posRaw, n);
  const { octX, octY } = decodeNormal(nrmRaw, n);
  const { r, g, b } = decodeColor(colRaw, n, colorMode);
  return {
    header,
    planes: {
      pos_e: qe, pos_n: qn, pos_u: qu, color_r: r, color_g: g, color_b: b, normal_oct_x: octX, normal_oct_y: octY,
    },
  };
}
