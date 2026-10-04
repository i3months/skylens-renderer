// 웹소켓 메시지 부호화·복호(클라이언트, T11.2). 서버 codec 을 import 하거나 복사하지 않은 독립 구현이다
// (서버·클라이언트 교차 시험을 위해). 형식 단일 출처는 contracts/proto/index.mjs 의 주석과 상수.
// 복호는 s2c 종류(WELCOME, PIECE, LEVEL_ARRIVED, MISSING, ERROR)만 받고 c2s 는 ProtoError('direction').
// 부호화는 9종 모두 한다(교차 시험·모의 클라이언트용).
//
// 복호 검사 순서(계약): 바이트배열 아님 'short' → 길이 < 8 'short' → type 모름 'type' → version 'version'
//   → reserved 'reserved' → payloadLength > MAX 'limit' → 프레임 길이 불일치 'length' → 방향 'direction' → 고정 크기 'length' → 본문 값 범위 'field'.
// 가변 종류의 본문: 최소 크기 미만 또는 항목 수·글자 수와 본문 길이 불일치는 'length', 값 범위 위반은 'field'.
//   PIECE_REQUEST 의 count > MAX_REQUEST_ITEMS, ERROR 의 알 수 없는 code·잘못된 utf8 은 'field'.
// 부호화: 메시지 타입 모름 'type', 범위 위반 'field', 본문 상한 초과 'limit'.
import {
  PROTO_VERSION, FRAME_HEADER_BYTES, PIECE_KEY_BYTES, MAX_PAYLOAD_BYTES, MAX_REQUEST_ITEMS, MAX_ERROR_TEXT,
  MSG, MSG_NAMES, DIRECTION, FIXED_PAYLOAD_BYTES, ERR_CODES, ProtoError,
} from '../../contracts/proto/index.mjs';
import { SEGMENT_ID_LIMIT, LOD_MAX } from '../../contracts/asset/index.mjs';

const U32_MAX = 0xffffffff;
const ERR_CODE_SET = new Set(Object.values(ERR_CODES));
const QUAT_NORM_TOL = 1e-3;

const fail = (code, msg) => { throw new ProtoError(code, msg); };
const isInt = (v, lo, hi) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
function int(v, lo, hi, name) {
  if (!isInt(v, lo, hi)) fail('field', `${name} 범위 밖(${lo}..${hi}): ${v}`);
  return v;
}
/** f32 로 저장되는 실수. 저장 후 값(fround)이 유한해야 한다. */
function f32(v, name) {
  if (typeof v !== 'number') fail('field', `${name} 숫자가 아님`);
  const r = Math.fround(v);
  if (!Number.isFinite(r)) fail('field', `${name} 유한하지 않음: ${v}`);
  return r;
}

function checkKey(k, where) {
  if (k === null || typeof k !== 'object') fail('field', `${where} 키가 객체가 아님`);
  int(k.segmentId, 0, SEGMENT_ID_LIMIT - 1, `${where}.segmentId`);
  int(k.level, 0, 3, `${where}.level`);
  int(k.lod, 0, LOD_MAX, `${where}.lod`);
  int(k.chunkIndex, 0, 65535, `${where}.chunkIndex`);
  int(k.tileX, -0x80000000, 0x7fffffff, `${where}.tileX`);
  int(k.tileY, -0x80000000, 0x7fffffff, `${where}.tileY`);
}
function writeKey(dv, o, k) {
  dv.setUint32(o, k.segmentId, true);
  dv.setUint8(o + 4, k.level);
  dv.setUint8(o + 5, k.lod);
  dv.setUint16(o + 6, k.chunkIndex, true);
  dv.setInt32(o + 8, k.tileX, true);
  dv.setInt32(o + 12, k.tileY, true);
}
function readKey(dv, o) {
  return {
    segmentId: dv.getUint32(o, true), level: dv.getUint8(o + 4), lod: dv.getUint8(o + 5),
    chunkIndex: dv.getUint16(o + 6, true), tileX: dv.getInt32(o + 8, true), tileY: dv.getInt32(o + 12, true),
  };
}
/** 단위 사원수 검사(노름 1±1e-3). 인자는 f32 로 저장된 값. */
function checkQuat(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!(Math.abs(n - 1) <= QUAT_NORM_TOL)) fail('field', `quat 노름이 1±${QUAT_NORM_TOL} 밖: ${n}`);
}
function checkFov(f) {
  if (!(f > 0 && f < Math.PI)) fail('field', `fovY 는 0<fovY<π 여야 한다: ${f}`);
}
function vec(v, n, name) {
  if (v === null || typeof v !== 'object' || Array.isArray(v) === false && !ArrayBuffer.isView(v) || v.length !== n) fail('field', `${name} 길이 ${n} 배열이어야 한다`);
  const out = [];
  for (let i = 0; i < n; i++) out.push(f32(v[i], `${name}[${i}]`));
  return out;
}

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * 메시지 -> 프레임 바이트. 범위 밖이면 ProtoError('field'), 본문이 상한을 넘으면 ProtoError('limit').
 * @param {object} message
 * @returns {Uint8Array}
 */
export function encodeMessage(message) {
  if (message === null || typeof message !== 'object') fail('type', '메시지가 객체가 아님');
  const type = MSG[message.type];
  if (type === undefined || typeof message.type !== 'string') fail('type', `알 수 없는 종류: ${message.type}`);
  let payload; // 본문 길이
  let write;   // (dv, base, u8) => void
  switch (type) {
    case MSG.HELLO: {
      const sid = int(message.sessionId, 0, U32_MAX, 'sessionId');
      const seq = int(message.lastPieceSeq, 0, U32_MAX, 'lastPieceSeq');
      payload = 9;
      write = (dv, b) => { dv.setUint32(b, sid, true); dv.setUint32(b + 4, seq, true); dv.setUint8(b + 8, 0); };
      break;
    }
    case MSG.VIEW_UPDATE: {
      const viewSeq = int(message.viewSeq, 0, U32_MAX, 'viewSeq');
      const pos = vec(message.pos, 3, 'pos');
      const quat = vec(message.quat, 4, 'quat');
      checkQuat(quat);
      const fovY = f32(message.fovY, 'fovY');
      checkFov(fovY);
      const w = int(message.width, 1, 65535, 'width');
      const h = int(message.height, 1, 65535, 'height');
      payload = 40;
      write = (dv, b) => {
        dv.setUint32(b, viewSeq, true);
        for (let i = 0; i < 3; i++) dv.setFloat32(b + 4 + 4 * i, pos[i], true);
        for (let i = 0; i < 4; i++) dv.setFloat32(b + 16 + 4 * i, quat[i], true);
        dv.setFloat32(b + 32, fovY, true);
        dv.setUint16(b + 36, w, true);
        dv.setUint16(b + 38, h, true);
      };
      break;
    }
    case MSG.PIECE_REQUEST: {
      const reqId = int(message.reqId, 0, U32_MAX, 'reqId');
      const items = message.items;
      if (!Array.isArray(items)) fail('field', 'items 가 배열이 아님');
      if (items.length > MAX_REQUEST_ITEMS) fail('field', `항목 수 ${items.length} > ${MAX_REQUEST_ITEMS}`);
      items.forEach((k, i) => {
        checkKey(k, `items[${i}]`);
      });
      payload = 6 + PIECE_KEY_BYTES * items.length;
      write = (dv, b) => {
        dv.setUint32(b, reqId, true);
        dv.setUint16(b + 4, items.length, true);
        items.forEach((k, i) => writeKey(dv, b + 6 + PIECE_KEY_BYTES * i, k));
      };
      break;
    }
    case MSG.ACK: {
      const up = int(message.upToPieceSeq, 0, U32_MAX, 'upToPieceSeq');
      payload = 4;
      write = (dv, b) => dv.setUint32(b, up, true);
      break;
    }
    case MSG.WELCOME: {
      const sid = int(message.sessionId, 0, U32_MAX, 'sessionId');
      if (typeof message.resumed !== 'boolean') fail('field', 'resumed 는 boolean 이어야 한다');
      const next = int(message.nextPieceSeq, 1, U32_MAX, 'nextPieceSeq');
      const resumed = message.resumed ? 1 : 0;
      payload = 9;
      write = (dv, b) => { dv.setUint32(b, sid, true); dv.setUint8(b + 4, resumed); dv.setUint32(b + 5, next, true); };
      break;
    }
    case MSG.PIECE: {
      const seq = int(message.pieceSeq, 1, U32_MAX, 'pieceSeq');
      checkKey(message.key, 'key');
      const chunk = message.chunk;
      if (!(chunk instanceof Uint8Array)) fail('field', 'chunk 는 Uint8Array 여야 한다');
      if (chunk.length < 1) fail('field', 'chunk 는 1 B 이상이어야 한다');
      payload = 20 + chunk.length;
      write = (dv, b, u8) => { dv.setUint32(b, seq, true); writeKey(dv, b + 4, message.key); u8.set(chunk, b + 20); };
      break;
    }
    case MSG.LEVEL_ARRIVED: {
      const seg = int(message.segmentId, 0, SEGMENT_ID_LIMIT - 1, 'segmentId');
      const level = int(message.level, 0, 3, 'level');
      const cnt = int(message.pieceCount, 1, U32_MAX, 'pieceCount');
      const first = int(message.firstPieceSeq, 1, U32_MAX - cnt + 1, 'firstPieceSeq'); // 창 끝 ≤ u32 (F-236)
      payload = 13;
      write = (dv, b) => { dv.setUint32(b, seg, true); dv.setUint8(b + 4, level); dv.setUint32(b + 5, cnt, true); dv.setUint32(b + 9, first, true); };
      break;
    }
    case MSG.MISSING: {
      const seg = int(message.segmentId, 0, SEGMENT_ID_LIMIT - 1, 'segmentId');
      payload = 4;
      write = (dv, b) => dv.setUint32(b, seg, true);
      break;
    }
    case MSG.ERROR: {
      const code = int(message.code, 0, 0xffff, 'code');
      if (!ERR_CODE_SET.has(code)) fail('field', `알 수 없는 오류 코드: ${code}`);
      if (typeof message.text !== 'string') fail('field', 'text 는 문자열이어야 한다');
      const bytes = enc.encode(message.text); // 짝 없는 서로게이트는 U+FFFD 로 바뀐다
      if (bytes.length > MAX_ERROR_TEXT) fail('field', `text ${bytes.length} B > ${MAX_ERROR_TEXT}`);
      payload = 4 + bytes.length;
      write = (dv, b, u8) => { dv.setUint16(b, code, true); dv.setUint16(b + 2, bytes.length, true); u8.set(bytes, b + 4); };
      break;
    }
    default: fail('type', `알 수 없는 종류: ${type}`);
  }
  if (payload > MAX_PAYLOAD_BYTES) fail('limit', `본문 ${payload} B > ${MAX_PAYLOAD_BYTES}`);
  const out = new Uint8Array(FRAME_HEADER_BYTES + payload);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, type);
  dv.setUint8(1, PROTO_VERSION);
  dv.setUint16(2, 0, true);
  dv.setUint32(4, payload, true);
  write(dv, FRAME_HEADER_BYTES, out);
  return out;
}

/**
 * 프레임 바이트 -> 메시지(s2c 종류만). 오류는 ProtoError(code).
 * @param {Uint8Array|ArrayBuffer} bytes
 */
export function decodeMessage(bytes) {
  if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
  else if (ArrayBuffer.isView(bytes) && !(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!(bytes instanceof Uint8Array)) fail('short', '바이트 배열이 아님');
  if (bytes.length < FRAME_HEADER_BYTES) fail('short', `프레임 ${bytes.length} B < ${FRAME_HEADER_BYTES}`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = dv.getUint8(0);
  if (MSG_NAMES[type] === undefined) fail('type', `알 수 없는 type: ${type}`);
  const version = dv.getUint8(1);
  if (version !== PROTO_VERSION) fail('version', `version ${version} != ${PROTO_VERSION}`);
  if (dv.getUint16(2, true) !== 0) fail('reserved', 'reserved 가 0 이 아님');
  const payload = dv.getUint32(4, true);
  if (payload > MAX_PAYLOAD_BYTES) fail('limit', `payloadLength ${payload} > ${MAX_PAYLOAD_BYTES}`);
  if (bytes.length !== FRAME_HEADER_BYTES + payload) fail('length', `프레임 ${bytes.length} B != ${FRAME_HEADER_BYTES + payload}`);
  if (DIRECTION[type] !== 's2c') fail('direction', `${MSG_NAMES[type]} 는 클라이언트가 받을 수 없다`);
  const fixed = FIXED_PAYLOAD_BYTES[type];
  if (fixed !== undefined && payload !== fixed) fail('length', `${MSG_NAMES[type]} 본문 ${payload} B != ${fixed}`);
  const b = FRAME_HEADER_BYTES;
  switch (type) {
    case MSG.WELCOME: {
      const resumed = dv.getUint8(b + 4);
      if (resumed > 1) fail('field', `resumed ${resumed}`);
      const nextPieceSeq = dv.getUint32(b + 5, true);
      if (nextPieceSeq < 1) fail('field', 'nextPieceSeq 0');
      return { type: 'WELCOME', sessionId: dv.getUint32(b, true), resumed: resumed === 1, nextPieceSeq };
    }
    case MSG.PIECE: {
      if (payload < 21) fail('length', `PIECE 본문 ${payload} B < 21`);
      const key = readKey(dv, b + 4);
      checkKey(key, 'key');
      const pieceSeq = dv.getUint32(b, true);
      if (pieceSeq < 1) fail('field', 'pieceSeq 0');
      return { type: 'PIECE', pieceSeq, key, chunk: new Uint8Array(bytes.slice(b + 20)) };
    }
    case MSG.LEVEL_ARRIVED: {
      const segmentId = dv.getUint32(b, true);
      const level = dv.getUint8(b + 4);
      int(segmentId, 0, SEGMENT_ID_LIMIT - 1, 'segmentId');
      int(level, 0, 3, 'level');
      const pieceCount = int(dv.getUint32(b + 5, true), 1, U32_MAX, 'pieceCount');
      const firstPieceSeq = int(dv.getUint32(b + 9, true), 1, U32_MAX - pieceCount + 1, 'firstPieceSeq');
      return { type: 'LEVEL_ARRIVED', segmentId, level, pieceCount, firstPieceSeq };
    }
    case MSG.MISSING: {
      const segmentId = dv.getUint32(b, true);
      int(segmentId, 0, SEGMENT_ID_LIMIT - 1, 'segmentId');
      return { type: 'MISSING', segmentId };
    }
    case MSG.ERROR: {
      if (payload < 4) fail('length', `ERROR 본문 ${payload} B < 4`);
      const code = dv.getUint16(b, true);
      const n = dv.getUint16(b + 2, true);
      if (payload !== 4 + n) fail('length', `ERROR 본문 ${payload} B != 4+${n}`);
      if (n > MAX_ERROR_TEXT) fail('field', `msgLen ${n} > ${MAX_ERROR_TEXT}`);
      if (!ERR_CODE_SET.has(code)) fail('field', `알 수 없는 오류 코드: ${code}`);
      let text;
      try { text = dec.decode(bytes.subarray(b + 4, b + 4 + n)); } catch { fail('field', 'utf8 가 아님'); }
      return { type: 'ERROR', code, text };
    }
    default: fail('type', `알 수 없는 type: ${type}`);
  }
}
