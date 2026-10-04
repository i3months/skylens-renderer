// 퍼저 자기 검증용 최소 기준 코덱(T11.10). 제품 코덱이 아니다: 계약(contracts/proto)의 배치·검사 순서를 그대로
// 옮긴 작은 구현으로, (1) 시드 프레임을 만들고 (2) 제품 코덱이 없을 때 퍼저 자체를 시험하는 대역이 된다.
// direction: 'c2s' 면 서버 복호, 's2c' 면 클라이언트 복호와 같은 방향 검사를 한다.
import {
  PROTO_VERSION, FRAME_HEADER_BYTES, PIECE_KEY_BYTES, MAX_PAYLOAD_BYTES, MAX_REQUEST_ITEMS, MAX_ERROR_TEXT,
  MSG, MSG_NAMES, DIRECTION, FIXED_PAYLOAD_BYTES, ERR_CODES, ProtoError,
} from '../../../contracts/proto/index.mjs';
import { SEGMENT_ID_LIMIT, LOD_MAX } from '../../../contracts/asset/index.mjs';

const ERR_CODE_SET = new Set(Object.values(ERR_CODES));
const fail = (c, m) => { throw new ProtoError(c, m); };
const inr = (v, lo, hi, n) => { if (!Number.isInteger(v) || v < lo || v > hi) fail('field', n); return v; };

function readKey(dv, o) {
  const k = {
    segmentId: dv.getUint32(o, true), level: dv.getUint8(o + 4), lod: dv.getUint8(o + 5),
    chunkIndex: dv.getUint16(o + 6, true), tileX: dv.getInt32(o + 8, true), tileY: dv.getInt32(o + 12, true),
  };
  inr(k.segmentId, 0, SEGMENT_ID_LIMIT - 1, 'segmentId'); inr(k.level, 0, 3, 'level'); inr(k.lod, 0, LOD_MAX, 'lod');
  return k;
}
function writeKey(dv, o, k) {
  inr(k.segmentId, 0, SEGMENT_ID_LIMIT - 1, 'segmentId'); inr(k.level, 0, 3, 'level'); inr(k.lod, 0, LOD_MAX, 'lod');
  inr(k.chunkIndex, 0, 65535, 'chunkIndex'); inr(k.tileX, -2147483648, 2147483647, 'tileX'); inr(k.tileY, -2147483648, 2147483647, 'tileY');
  dv.setUint32(o, k.segmentId, true); dv.setUint8(o + 4, k.level); dv.setUint8(o + 5, k.lod);
  dv.setUint16(o + 6, k.chunkIndex, true); dv.setInt32(o + 8, k.tileX, true); dv.setInt32(o + 12, k.tileY, true);
}

export function encodeMessage(m) {
  const t = MSG[m.type];
  if (t === undefined) fail('type', String(m.type));
  const u32 = (v, n) => inr(v, 0, 0xffffffff, n);
  let n;
  if (m.type === 'PIECE_REQUEST') n = 6 + PIECE_KEY_BYTES * inr(m.items.length, 0, MAX_REQUEST_ITEMS, 'count');
  else if (m.type === 'PIECE') n = 4 + PIECE_KEY_BYTES + inr(m.chunk.length, 1, MAX_PAYLOAD_BYTES - 20, 'chunk');
  else if (m.type === 'ERROR') { m = { ...m, _b: new TextEncoder().encode(m.text) }; n = 4 + inr(m._b.length, 0, MAX_ERROR_TEXT, 'msgLen'); }
  else n = FIXED_PAYLOAD_BYTES[t];
  const out = new Uint8Array(FRAME_HEADER_BYTES + n), dv = new DataView(out.buffer);
  dv.setUint8(0, t); dv.setUint8(1, PROTO_VERSION); dv.setUint32(4, n, true);
  const o = FRAME_HEADER_BYTES;
  switch (m.type) {
    case 'HELLO': dv.setUint32(o, u32(m.sessionId, 'sessionId'), true); dv.setUint32(o + 4, u32(m.lastPieceSeq, 'seq'), true); break;
    case 'VIEW_UPDATE': {
      dv.setUint32(o, u32(m.viewSeq, 'viewSeq'), true);
      m.pos.forEach((v, i) => { if (!Number.isFinite(v)) fail('field', 'pos'); dv.setFloat32(o + 4 + 4 * i, v, true); });
      m.quat.forEach((v, i) => { if (!Number.isFinite(v)) fail('field', 'quat'); dv.setFloat32(o + 16 + 4 * i, v, true); });
      dv.setFloat32(o + 32, m.fovY, true);
      dv.setUint16(o + 36, inr(m.width, 1, 65535, 'width'), true); dv.setUint16(o + 38, inr(m.height, 1, 65535, 'height'), true);
      break;
    }
    case 'PIECE_REQUEST': dv.setUint32(o, u32(m.reqId, 'reqId'), true); dv.setUint16(o + 4, m.items.length, true); m.items.forEach((k, i) => writeKey(dv, o + 6 + 16 * i, k)); break;
    case 'ACK': dv.setUint32(o, u32(m.upToPieceSeq, 'seq'), true); break;
    case 'WELCOME': dv.setUint32(o, u32(m.sessionId, 'sessionId'), true); dv.setUint8(o + 4, m.resumed ? 1 : 0); dv.setUint32(o + 5, u32(m.nextPieceSeq, 'seq'), true); break;
    case 'PIECE': dv.setUint32(o, u32(m.pieceSeq, 'seq'), true); writeKey(dv, o + 4, m.key); out.set(m.chunk, o + 20); break;
    case 'LEVEL_ARRIVED': dv.setUint32(o, inr(m.segmentId, 0, SEGMENT_ID_LIMIT - 1, 'segmentId'), true); dv.setUint8(o + 4, inr(m.level, 0, 3, 'level')); dv.setUint32(o + 5, u32(m.pieceCount, 'pieceCount'), true); break;
    case 'MISSING': dv.setUint32(o, inr(m.segmentId, 0, SEGMENT_ID_LIMIT - 1, 'segmentId'), true); break;
    case 'ERROR': if (!ERR_CODE_SET.has(m.code)) fail('field', 'code'); dv.setUint16(o, m.code, true); dv.setUint16(o + 2, m._b.length, true); out.set(m._b, o + 4); break;
  }
  return out;
}

/** @param {'c2s'|'s2c'} direction */
export function makeDecoder(direction) {
  return function decodeMessage(bytes) {
    if (!(bytes instanceof Uint8Array)) fail('short', 'not bytes');
    if (bytes.length < FRAME_HEADER_BYTES) fail('short', `len ${bytes.length}`);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const t = dv.getUint8(0);
    if (MSG_NAMES[t] === undefined) fail('type', String(t));
    if (dv.getUint8(1) !== PROTO_VERSION) fail('version', String(dv.getUint8(1)));
    if (dv.getUint16(2, true) !== 0) fail('reserved', 'nonzero');
    const n = dv.getUint32(4, true);
    if (n > MAX_PAYLOAD_BYTES) fail('limit', String(n));
    if (bytes.length !== FRAME_HEADER_BYTES + n) fail('length', `${bytes.length} != ${FRAME_HEADER_BYTES + n}`);
    if (DIRECTION[t] !== direction) fail('direction', MSG_NAMES[t]);
    if (FIXED_PAYLOAD_BYTES[t] !== undefined && n !== FIXED_PAYLOAD_BYTES[t]) fail('length', 'fixed');
    const o = FRAME_HEADER_BYTES;
    switch (MSG_NAMES[t]) {
      case 'HELLO': if (dv.getUint8(o + 8) !== 0) fail('field', 'flags'); return { type: 'HELLO', sessionId: dv.getUint32(o, true), lastPieceSeq: dv.getUint32(o + 4, true) };
      case 'VIEW_UPDATE': {
        const f = (i) => dv.getFloat32(o + 4 + 4 * i, true);
        const pos = [f(0), f(1), f(2)], quat = [f(3), f(4), f(5), f(6)], fovY = f(7);
        if (![...pos, ...quat].every(Number.isFinite)) fail('field', 'finite');
        if (Math.abs(Math.hypot(...quat) - 1) > 1e-3) fail('field', 'quat');
        if (!(fovY > 0 && fovY < Math.PI)) fail('field', 'fovY');
        const width = dv.getUint16(o + 36, true), height = dv.getUint16(o + 38, true);
        if (width < 1 || height < 1) fail('field', 'size');
        return { type: 'VIEW_UPDATE', viewSeq: dv.getUint32(o, true), pos, quat, fovY, width, height };
      }
      case 'PIECE_REQUEST': {
        if (n < 6) fail('length', 'req head');
        const count = dv.getUint16(o + 4, true);
        // 계약 순서: length(본문 길이 일치) 먼저, 그다음 field(count 상한).
        if (n !== 6 + 16 * count) fail('length', 'req body');
        if (count > MAX_REQUEST_ITEMS) fail('field', 'count');
        const items = []; for (let i = 0; i < count; i++) items.push(readKey(dv, o + 6 + 16 * i));
        return { type: 'PIECE_REQUEST', reqId: dv.getUint32(o, true), items };
      }
      case 'ACK': return { type: 'ACK', upToPieceSeq: dv.getUint32(o, true) };
      case 'WELCOME': {
        const r = dv.getUint8(o + 4); if (r > 1) fail('field', 'resumed');
        return { type: 'WELCOME', sessionId: dv.getUint32(o, true), resumed: r === 1, nextPieceSeq: dv.getUint32(o + 5, true) };
      }
      case 'PIECE': {
        if (n < 21) fail('length', 'piece');
        return { type: 'PIECE', pieceSeq: dv.getUint32(o, true), key: readKey(dv, o + 4), chunk: bytes.slice(o + 20) };
      }
      case 'LEVEL_ARRIVED': {
        const segmentId = dv.getUint32(o, true), level = dv.getUint8(o + 4);
        if (segmentId >= SEGMENT_ID_LIMIT || level > 3) fail('field', 'level');
        return { type: 'LEVEL_ARRIVED', segmentId, level, pieceCount: dv.getUint32(o + 5, true) };
      }
      case 'MISSING': { const s = dv.getUint32(o, true); if (s >= SEGMENT_ID_LIMIT) fail('field', 'segmentId'); return { type: 'MISSING', segmentId: s }; }
      case 'ERROR': {
        if (n < 4) fail('length', 'error');
        const len = dv.getUint16(o + 2, true);
        if (n !== 4 + len) fail('length', 'error body');
        if (len > MAX_ERROR_TEXT) fail('field', 'msgLen');
        let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(o + 4)); } catch { fail('field', 'utf8'); }
        const code = dv.getUint16(o, true);
        if (!ERR_CODE_SET.has(code)) fail('field', 'code');
        return { type: 'ERROR', code, text };
      }
    }
    return fail('type', 'unreachable');
  };
}
