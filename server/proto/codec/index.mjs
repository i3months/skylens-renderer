// 서버 쪽 웹소켓 메시지 부호화·복호(T11.1). 계약: contracts/proto/index.mjs.
// encodeMessage 는 9종 모두, decodeMessage 는 c→s 종류(HELLO, VIEW_UPDATE, PIECE_REQUEST, ACK)만 받는다.
// 복호 검사 순서(계약): 바이트배열 아님 'short' → type 모름 'type' → version 'version'
//   → reserved 'reserved' → payloadLength > MAX 'limit' → 프레임 길이 불일치 'length' → 방향 'direction' → 고정 크기 'length' → 본문 값 범위 'field'.
// 부호화: 메시지 타입 모름 'type', 범위 위반 'field', 본문 상한 초과 'limit'.
// 모든 다바이트 값은 little-endian. 외부 코드 없음.
import {
  PROTO_VERSION, FRAME_HEADER_BYTES, PIECE_KEY_BYTES, MAX_PAYLOAD_BYTES, MAX_REQUEST_ITEMS, MAX_ERROR_TEXT,
  MSG, MSG_NAMES, DIRECTION, FIXED_PAYLOAD_BYTES, ERR_CODES, ProtoError,
} from '../../../contracts/proto/index.mjs';
import { SEGMENT_ID_LIMIT, LOD_MAX } from '../../../contracts/asset/index.mjs';

const U32_MAX = 0xffffffff;
const QUAT_TOL = 1e-3;
const ERR_CODE_SET = new Set(Object.values(ERR_CODES));
const utf8Enc = new TextEncoder();
const utf8Dec = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function fail(code, msg) { throw new ProtoError(code, msg); }
function uint(v, max, name) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) fail('field', `${name} 범위 밖: ${v}`);
  return v;
}
/** pieceSeq·nextPieceSeq 는 1 부터(계약). 0 은 'field'. */
function seq1(v, name) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > U32_MAX) fail('field', `${name} 범위 밖(1..${U32_MAX}): ${v}`);
  return v;
}
function int32(v, name) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < -0x80000000 || v > 0x7fffffff) fail('field', `${name} 범위 밖: ${v}`);
  return v;
}
function finite32(v, name) {
  if (typeof v !== 'number') fail('field', `${name} 숫자 아님`);
  const f = Math.fround(v);
  if (!Number.isFinite(f)) fail('field', `${name} 유한하지 않음: ${v}`);
  return f;
}

function checkKey(k) {
  if (k === null || typeof k !== 'object') fail('field', 'PieceKey 아님');
  uint(k.segmentId, SEGMENT_ID_LIMIT - 1, 'segmentId');
  uint(k.level, 3, 'level');
  uint(k.lod, LOD_MAX, 'lod');
  uint(k.chunkIndex, 0xffff, 'chunkIndex');
  int32(k.tileX, 'tileX');
  int32(k.tileY, 'tileY');
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

/** 시점 값 검사(f32 로 반올림한 값 기준). 반올림된 pos·quat·fovY 를 돌려준다. */
function checkView(pos, quat, fovY, width, height) {
  if (!Array.isArray(pos) && !ArrayBuffer.isView(pos)) fail('field', 'pos 배열 아님');
  if (!Array.isArray(quat) && !ArrayBuffer.isView(quat)) fail('field', 'quat 배열 아님');
  if (pos.length !== 3) fail('field', 'pos 길이는 3');
  if (quat.length !== 4) fail('field', 'quat 길이는 4');
  const p = [0, 1, 2].map((i) => finite32(pos[i], `pos[${i}]`));
  const q = [0, 1, 2, 3].map((i) => finite32(quat[i], `quat[${i}]`));
  const norm = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!(Math.abs(norm - 1) <= QUAT_TOL)) fail('field', `quat 노름 ${norm} 이 1±${QUAT_TOL} 밖`);
  const f = finite32(fovY, 'fovY');
  if (!(f > 0 && f < Math.PI)) fail('field', `fovY 0<fovY<π 밖: ${fovY}`);
  uint(width, 0xffff, 'width'); if (width < 1) fail('field', 'width 0');
  uint(height, 0xffff, 'height'); if (height < 1) fail('field', 'height 0');
  return { p, q, f };
}

function frame(type, payloadLength) {
  if (payloadLength > MAX_PAYLOAD_BYTES) fail('limit', `본문 ${payloadLength} B 가 상한 초과`);
  const out = new Uint8Array(FRAME_HEADER_BYTES + payloadLength);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, type);
  dv.setUint8(1, PROTO_VERSION);
  dv.setUint16(2, 0, true);
  dv.setUint32(4, payloadLength, true);
  return { out, dv, o: FRAME_HEADER_BYTES };
}

/** @param {object} m 계약의 Message @returns {Uint8Array} */
export function encodeMessage(m) {
  if (m === null || typeof m !== 'object') fail('type', '메시지 객체 아님');
  const type = MSG[m.type];
  if (type === undefined) fail('type', `모르는 type: ${m.type}`);
  switch (m.type) {
    case 'HELLO': {
      uint(m.sessionId, U32_MAX, 'sessionId'); uint(m.lastPieceSeq, U32_MAX, 'lastPieceSeq');
      const { out, dv, o } = frame(type, 9);
      dv.setUint32(o, m.sessionId, true); dv.setUint32(o + 4, m.lastPieceSeq, true); dv.setUint8(o + 8, 0);
      return out;
    }
    case 'VIEW_UPDATE': {
      uint(m.viewSeq, U32_MAX, 'viewSeq');
      const { p, q, f } = checkView(m.pos, m.quat, m.fovY, m.width, m.height);
      const { out, dv, o } = frame(type, 40);
      dv.setUint32(o, m.viewSeq, true);
      for (let i = 0; i < 3; i++) dv.setFloat32(o + 4 + 4 * i, p[i], true);
      for (let i = 0; i < 4; i++) dv.setFloat32(o + 16 + 4 * i, q[i], true);
      dv.setFloat32(o + 32, f, true); dv.setUint16(o + 36, m.width, true); dv.setUint16(o + 38, m.height, true);
      return out;
    }
    case 'PIECE_REQUEST': {
      uint(m.reqId, U32_MAX, 'reqId');
      if (!Array.isArray(m.items)) fail('field', 'items 배열 아님');
      if (m.items.length > MAX_REQUEST_ITEMS) fail('field', `항목 ${m.items.length} 개가 ${MAX_REQUEST_ITEMS} 초과`);
      m.items.forEach(checkKey);
      const { out, dv, o } = frame(type, 6 + PIECE_KEY_BYTES * m.items.length);
      dv.setUint32(o, m.reqId, true); dv.setUint16(o + 4, m.items.length, true);
      m.items.forEach((k, i) => writeKey(dv, o + 6 + PIECE_KEY_BYTES * i, k));
      return out;
    }
    case 'ACK': {
      uint(m.upToPieceSeq, U32_MAX, 'upToPieceSeq');
      const { out, dv, o } = frame(type, 4);
      dv.setUint32(o, m.upToPieceSeq, true);
      return out;
    }
    case 'WELCOME': {
      uint(m.sessionId, U32_MAX, 'sessionId'); seq1(m.nextPieceSeq, 'nextPieceSeq');
      if (typeof m.resumed !== 'boolean') fail('field', 'resumed 는 boolean');
      const { out, dv, o } = frame(type, 9);
      dv.setUint32(o, m.sessionId, true); dv.setUint8(o + 4, m.resumed ? 1 : 0); dv.setUint32(o + 5, m.nextPieceSeq, true);
      return out;
    }
    case 'PIECE': {
      seq1(m.pieceSeq, 'pieceSeq'); checkKey(m.key);
      if (!(m.chunk instanceof Uint8Array)) fail('field', 'chunk 는 Uint8Array');
      if (m.chunk.length < 1) fail('field', 'chunk 는 1 B 이상');
      const { out, dv, o } = frame(type, 4 + PIECE_KEY_BYTES + m.chunk.length);
      dv.setUint32(o, m.pieceSeq, true); writeKey(dv, o + 4, m.key); out.set(m.chunk, o + 4 + PIECE_KEY_BYTES);
      return out;
    }
    case 'LEVEL_ARRIVED': {
      uint(m.segmentId, SEGMENT_ID_LIMIT - 1, 'segmentId'); uint(m.level, 3, 'level'); if (typeof m.pieceCount !== 'number' || !Number.isInteger(m.pieceCount) || m.pieceCount < 1 || m.pieceCount > U32_MAX) fail('field', `pieceCount 범위 밖(1..${U32_MAX}): ${m.pieceCount}`);
      const { out, dv, o } = frame(type, 9);
      dv.setUint32(o, m.segmentId, true); dv.setUint8(o + 4, m.level); dv.setUint32(o + 5, m.pieceCount, true);
      return out;
    }
    case 'MISSING': {
      uint(m.segmentId, SEGMENT_ID_LIMIT - 1, 'segmentId');
      const { out, dv, o } = frame(type, 4);
      dv.setUint32(o, m.segmentId, true);
      return out;
    }
    case 'ERROR': {
      uint(m.code, 0xffff, 'code');
      if (!ERR_CODE_SET.has(m.code)) fail('field', `모르는 오류 코드: ${m.code}`);
      if (typeof m.text !== 'string') fail('field', 'text 는 문자열');
      const t = utf8Enc.encode(m.text);
      if (t.length > MAX_ERROR_TEXT) fail('field', `메시지 ${t.length} B 가 ${MAX_ERROR_TEXT} 초과`);
      const { out, dv, o } = frame(type, 4 + t.length);
      dv.setUint16(o, m.code, true); dv.setUint16(o + 2, t.length, true); out.set(t, o + 4);
      return out;
    }
    default:
      return fail('type', `모르는 type: ${m.type}`);
  }
}

/** 서버 복호: c→s 종류만. @param {Uint8Array} bytes */
export function decodeMessage(bytes) {
  if (!(bytes instanceof Uint8Array)) fail('short', 'bytes 는 Uint8Array');
  if (bytes.length < FRAME_HEADER_BYTES) fail('short', `길이 ${bytes.length} < ${FRAME_HEADER_BYTES}`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = dv.getUint8(0);
  if (MSG_NAMES[type] === undefined) fail('type', `모르는 type: ${type}`);
  if (dv.getUint8(1) !== PROTO_VERSION) fail('version', `version ${dv.getUint8(1)}`);
  if (dv.getUint16(2, true) !== 0) fail('reserved', 'reserved 가 0 아님');
  const plen = dv.getUint32(4, true);
  if (plen > MAX_PAYLOAD_BYTES) fail('limit', `본문 ${plen} B 가 상한 초과`);
  if (bytes.length !== FRAME_HEADER_BYTES + plen) fail('length', `프레임 ${bytes.length} B != ${FRAME_HEADER_BYTES + plen}`);
  if (DIRECTION[type] !== 'c2s') fail('direction', `${MSG_NAMES[type]} 는 서버가 받는 종류가 아님`);
  const fixed = FIXED_PAYLOAD_BYTES[type];
  if (fixed !== undefined && plen !== fixed) fail('length', `${MSG_NAMES[type]} 본문 ${plen} B != ${fixed}`);
  const o = FRAME_HEADER_BYTES;
  switch (type) {
    case MSG.HELLO: {
      if (dv.getUint8(o + 8) !== 0) fail('field', 'flags 가 0 아님');
      return { type: 'HELLO', sessionId: dv.getUint32(o, true), lastPieceSeq: dv.getUint32(o + 4, true) };
    }
    case MSG.VIEW_UPDATE: {
      const pos = [0, 1, 2].map((i) => dv.getFloat32(o + 4 + 4 * i, true));
      const quat = [0, 1, 2, 3].map((i) => dv.getFloat32(o + 16 + 4 * i, true));
      const fovY = dv.getFloat32(o + 32, true);
      const width = dv.getUint16(o + 36, true);
      const height = dv.getUint16(o + 38, true);
      checkView(pos, quat, fovY, width, height);
      return { type: 'VIEW_UPDATE', viewSeq: dv.getUint32(o, true), pos, quat, fovY, width, height };
    }
    case MSG.PIECE_REQUEST: {
      if (plen < 6) fail('length', `PIECE_REQUEST 본문 ${plen} B < 6`);
      const count = dv.getUint16(o + 4, true);
      if (plen !== 6 + PIECE_KEY_BYTES * count) fail('length', `PIECE_REQUEST 본문 ${plen} B != 6+16·${count}`);
      if (count > MAX_REQUEST_ITEMS) fail('field', `항목 ${count} 개가 ${MAX_REQUEST_ITEMS} 초과`);
      const items = [];
      for (let i = 0; i < count; i++) {
        const k = readKey(dv, o + 6 + PIECE_KEY_BYTES * i);
        checkKey(k);
        items.push(k);
      }
      return { type: 'PIECE_REQUEST', reqId: dv.getUint32(o, true), items };
    }
    case MSG.ACK:
      return { type: 'ACK', upToPieceSeq: dv.getUint32(o, true) };
    default:
      return fail('type', `처리 불가 type: ${type}`);
  }
}
