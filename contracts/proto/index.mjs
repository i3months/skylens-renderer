// 웹소켓 메시지 계약(T11). 전송은 웹소켓(TCP) 단일 이진 프레임이다. 모든 다바이트 값은 little-endian.
// 프레임 = 머리 8 B + 본문(payloadLength B).
//   [0]   u8  type        MSG 값
//   [1]   u8  version     PROTO_VERSION(1)
//   [2:4] u16 reserved    0 이어야 한다(아니면 'reserved')
//   [4:8] u32 payloadLength  본문 길이. MAX_PAYLOAD_BYTES 이하. 프레임 전체 길이 = 8 + payloadLength 와 정확히 같아야 한다('length').
// 본문 배치(종류별, 고정 크기는 정확히 일치해야 한다. 어긋나면 'length'):
//   HELLO(1, c→s)         9 B   sessionId u32 (0 = 새 접속), lastPieceSeq u32 (이미 받은 마지막 조각 순번, 새 접속이면 0), flags u8 (0)
//   VIEW_UPDATE(2, c→s)   40 B  viewSeq u32, pos f32×3 (ENU m), quat f32×4 (x,y,z,w, 단위), fovY f32 (rad, 0<fovY<π), width u16, height u16
//   PIECE_REQUEST(3, c→s) 6 + 16·n B  reqId u32, count u16 (≤ MAX_REQUEST_ITEMS), 항목 n 개: PieceKey 16 B
//   ACK(4, c→s)           4 B   upToPieceSeq u32 (여기까지 받았음)
//   WELCOME(5, s→c)       9 B   sessionId u32, resumed u8 (0|1), nextPieceSeq u32
//   PIECE(6, s→c)         4 + 16 + chunkLen B  pieceSeq u32, PieceKey 16 B, 조각 바이트(contracts/asset 의 .skla 조각 그대로, 1 B 이상)
//   LEVEL_ARRIVED(7, s→c) 9 B   segmentId u32, level u8 (0..3), pieceCount u32
//   MISSING(8, s→c)       4 B   segmentId u32  (도착하지 않은 구간. 메우거나 꾸미지 않는다)
//   ERROR(9, s→c)         4 + n B  code u16 (ERR_CODES), msgLen u16, utf8 메시지(msgLen ≤ MAX_ERROR_TEXT)
// PieceKey 16 B: segmentId u32, level u8, lod u8, chunkIndex u16, tileX i32, tileY i32 (contracts/asset ChunkKey 와 같은 값).
// 검사 순서(서버·클라이언트 같다): 길이 < 8 'short' → type 모름 'type' → version 다름 'version' → reserved≠0 'reserved'
//   → payloadLength > MAX_PAYLOAD_BYTES 'limit' → 프레임 길이 불일치 'length' → 본문 값 범위 'field'.
// 방향 검사: 서버 복호는 c→s 종류만, 클라이언트 복호는 s→c 종류만 받는다. 반대 방향 type 은 'direction'.

export const PROTO_VERSION = 1;
export const FRAME_HEADER_BYTES = 8;
export const PIECE_KEY_BYTES = 16;
/** 프레임 본문 상한(바이트). 조각 하나가 이보다 크면 보낼 수 없다. */
export const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
/** 조각 요청 한 번에 담을 수 있는 항목 수(F-175 ⑥). */
export const MAX_REQUEST_ITEMS = 256;
export const MAX_ERROR_TEXT = 256;

export const MSG = Object.freeze({
  HELLO: 1,
  VIEW_UPDATE: 2,
  PIECE_REQUEST: 3,
  ACK: 4,
  WELCOME: 5,
  PIECE: 6,
  LEVEL_ARRIVED: 7,
  MISSING: 8,
  ERROR: 9,
});
export const MSG_NAMES = Object.freeze(Object.fromEntries(Object.entries(MSG).map(([k, v]) => [v, k])));
/** 방향: 'c2s' 는 클라이언트가 보내고 서버가 읽는다. */
export const DIRECTION = Object.freeze({
  [MSG.HELLO]: 'c2s', [MSG.VIEW_UPDATE]: 'c2s', [MSG.PIECE_REQUEST]: 'c2s', [MSG.ACK]: 'c2s',
  [MSG.WELCOME]: 's2c', [MSG.PIECE]: 's2c', [MSG.LEVEL_ARRIVED]: 's2c', [MSG.MISSING]: 's2c', [MSG.ERROR]: 's2c',
});
/** 고정 크기 본문(바이트). 가변 종류(PIECE_REQUEST·PIECE·ERROR)는 없다. */
export const FIXED_PAYLOAD_BYTES = Object.freeze({
  [MSG.HELLO]: 9, [MSG.VIEW_UPDATE]: 40, [MSG.ACK]: 4, [MSG.WELCOME]: 9, [MSG.LEVEL_ARRIVED]: 9, [MSG.MISSING]: 4,
});
export const ERR_CODES = Object.freeze({ BAD_MESSAGE: 1, UNKNOWN_SESSION: 2, TOO_SLOW: 3, OVER_LIMIT: 4, UNAVAILABLE: 5 });

/** 부호화·복호 오류. code: 'short'|'type'|'version'|'reserved'|'limit'|'length'|'field'|'direction'. */
export class ProtoError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(`proto: ${code}: ${message}`);
    this.name = 'ProtoError';
    this.code = code;
  }
}

/**
 * 메시지 객체 모양(복호 결과·부호화 입력이 같다). 숫자는 모두 위 배치의 정수·실수 값이다.
 * @typedef {{type:'HELLO', sessionId:number, lastPieceSeq:number}
 *  | {type:'VIEW_UPDATE', viewSeq:number, pos:number[], quat:number[], fovY:number, width:number, height:number}
 *  | {type:'PIECE_REQUEST', reqId:number, items:PieceKey[]}
 *  | {type:'ACK', upToPieceSeq:number}
 *  | {type:'WELCOME', sessionId:number, resumed:boolean, nextPieceSeq:number}
 *  | {type:'PIECE', pieceSeq:number, key:PieceKey, chunk:Uint8Array}
 *  | {type:'LEVEL_ARRIVED', segmentId:number, level:number, pieceCount:number}
 *  | {type:'MISSING', segmentId:number}
 *  | {type:'ERROR', code:number, text:string}} Message
 * @typedef {{segmentId:number, level:number, lod:number, chunkIndex:number, tileX:number, tileY:number}} PieceKey
 *
 * 부호화·복호 서명(서버 server/proto/codec, 클라이언트 client/proto 가 같은 서명을 내보낸다):
 *   encodeMessage(message) -> Uint8Array          범위 밖이면 ProtoError('field')
 *   decodeMessage(bytes) -> Message               서버는 c2s 만, 클라이언트는 s2c 만 받는다
 * 값 범위: segmentId 0..SEGMENT_ID_LIMIT-1, level 0..3, lod 0..LOD_MAX, chunkIndex 0..65535, tile 은 i32,
 *   fovY 는 유한하고 0<fovY<π, pos·quat 는 유한 실수(quat 노름 1±1e-3), width·height 1..65535, 순번 u32.
 */

/** 조각 키의 문자열 형태(중복 검사용). */
export function pieceKeyString(k) {
  return `${k.segmentId}:${k.level}:${k.lod}:${k.chunkIndex}:${k.tileX}:${k.tileY}`;
}
