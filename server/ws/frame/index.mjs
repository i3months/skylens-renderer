// RFC 6455 이진 프레임 읽기·쓰기(T11.3). 의존성 없음, 직접 구현.
//   FrameParser : 바이트 조각을 밀어 넣으면 완성된 이벤트를 돌려준다(클라이언트 → 서버 방향, 마스크 필수).
//     이벤트: { type: 'message', data: Uint8Array } | { type: 'ping'|'pong', data } | { type: 'close', code, reason } | { type: 'error', code, reason }
//     error 이벤트가 나오면 파서는 멈춘다(이후 입력 무시). code 는 보낼 close 코드(1002 규약 위반, 1003 텍스트, 1007, 1009 상한 초과).
//   encodeFrame : 서버 → 클라이언트 프레임(마스크 없음). 시험용 클라이언트가 쓰도록 maskKey 를 주면 마스킹한다.
// 페이로드 상한 = contracts/proto MAX_PAYLOAD_BYTES + 여유(프로토콜 머리 8바이트와 어림 오차). 헤더의 길이만 보고 버퍼링 전에 거부한다.
// 이 프로토콜은 이진 전용이라 텍스트 메시지(opcode 1)는 1003 으로 거부한다.
import { MAX_PAYLOAD_BYTES } from '../../../contracts/proto/index.mjs';

export const OPCODES = Object.freeze({ CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa });
export const FRAME_SLACK_BYTES = 1024;
export const MAX_MESSAGE_BYTES = MAX_PAYLOAD_BYTES + FRAME_SLACK_BYTES;
export const MAX_CONTROL_PAYLOAD = 125;

const textDecoder = new TextDecoder('utf-8', { fatal: true });

/** close 코드가 선로에 실어도 되는 값인가(RFC 7.4.1/7.4.2). */
export function isValidCloseCode(code) {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1011) || (code >= 3000 && code <= 4999);
}

/** close 본문(코드 2바이트 + UTF-8 사유) 만들기. */
export function encodeClosePayload(code, reason = '') {
  const r = Buffer.from(reason, 'utf8');
  const out = Buffer.allocUnsafe(2 + r.length);
  out.writeUInt16BE(code, 0);
  r.copy(out, 2);
  return out;
}

/**
 * 한 프레임을 직렬화한다.
 * @param {number} opcode
 * @param {Uint8Array} payload
 * @param {{fin?: boolean, maskKey?: Uint8Array}} [opts] maskKey(4바이트)를 주면 마스킹(클라이언트 방향).
 * @returns {Buffer}
 */
export function encodeFrame(opcode, payload = new Uint8Array(0), opts = {}) {
  const fin = opts.fin !== false;
  const maskKey = opts.maskKey;
  if (maskKey !== undefined && maskKey.length !== 4) throw new RangeError('maskKey 는 4바이트');
  const len = payload.length;
  if (opcode >= 0x8 && (len > MAX_CONTROL_PAYLOAD || !fin)) throw new RangeError('제어 프레임은 125바이트 이하·분할 불가');
  const lenBytes = len < 126 ? 0 : len <= 0xffff ? 2 : 8;
  const head = Buffer.allocUnsafe(2 + lenBytes + (maskKey ? 4 : 0));
  head[0] = (fin ? 0x80 : 0) | opcode;
  const maskBit = maskKey ? 0x80 : 0;
  let o = 2;
  if (lenBytes === 0) head[1] = maskBit | len;
  else if (lenBytes === 2) { head[1] = maskBit | 126; head.writeUInt16BE(len, 2); o = 4; }
  else { head[1] = maskBit | 127; head.writeBigUInt64BE(BigInt(len), 2); o = 10; }
  if (!maskKey) return Buffer.concat([head, payload]);
  head.set(maskKey, o);
  const body = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ maskKey[i & 3];
  return Buffer.concat([head, body]);
}

export class FrameParser {
  /** @param {{maxPayload?: number, requireMask?: boolean}} [opts] */
  constructor(opts = {}) {
    this.maxPayload = opts.maxPayload ?? MAX_MESSAGE_BYTES;
    this.requireMask = opts.requireMask !== false;
    this.buf = Buffer.alloc(0);
    this.frags = []; // 조립 중인 분할 메시지 조각
    this.fragBytes = 0;
    this.fragOpcode = -1;
    this.dead = false;
  }

  /** @param {Uint8Array} chunk @returns {object[]} 이벤트 목록 */
  push(chunk) {
    const events = [];
    if (this.dead) return events;
    this.buf = this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk]);
    while (!this.dead) {
      const ev = this.#next();
      if (ev === null) break;
      if (ev.type === 'error') this.dead = true;
      if (ev.type !== 'none') events.push(ev);
    }
    return events;
  }

  #fail(code, reason) { return { type: 'error', code, reason }; }

  #next() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    if ((b[0] & 0x70) !== 0) return this.#fail(1002, 'RSV 비트');
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    const isControl = opcode >= 0x8;
    if (![0, 1, 2, 8, 9, 10].includes(opcode)) return this.#fail(1002, '알 수 없는 opcode');
    if (this.requireMask && !masked) return this.#fail(1002, '클라이언트 프레임에 마스크 없음');
    if (isControl && (!fin || len > MAX_CONTROL_PAYLOAD)) return this.#fail(1002, '잘못된 제어 프레임');
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2); off = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return this.#fail(1009, '길이 초과');
      len = Number(big); off = 10;
    }
    // 상한은 본문을 기다리기 전에 검사한다(분할 메시지는 누적 길이).
    if (len > this.maxPayload || (!isControl && this.fragBytes + len > this.maxPayload)) return this.#fail(1009, '페이로드 상한 초과');
    const total = off + (masked ? 4 : 0) + len;
    if (b.length < total) return null;
    const payload = Buffer.from(b.subarray(off + (masked ? 4 : 0), total));
    if (masked) {
      const k = b.subarray(off, off + 4);
      for (let i = 0; i < len; i++) payload[i] ^= k[i & 3];
    }
    this.buf = b.subarray(total);

    if (isControl) return this.#control(opcode, payload);
    if (opcode === OPCODES.TEXT) return this.#fail(1003, '이진 전용');
    if (opcode === OPCODES.CONT) {
      if (this.fragOpcode < 0) return this.#fail(1002, '시작 없는 연속 프레임');
    } else if (this.fragOpcode >= 0) {
      return this.#fail(1002, '분할 중 새 데이터 프레임');
    }
    if (opcode === OPCODES.BINARY) this.fragOpcode = OPCODES.BINARY;
    this.frags.push(payload);
    this.fragBytes += len;
    if (!fin) return { type: 'none' };
    const data = new Uint8Array(Buffer.concat(this.frags, this.fragBytes));
    this.frags = []; this.fragBytes = 0; this.fragOpcode = -1;
    return { type: 'message', data };
  }

  #control(opcode, payload) {
    const data = new Uint8Array(payload);
    if (opcode === OPCODES.PING) return { type: 'ping', data };
    if (opcode === OPCODES.PONG) return { type: 'pong', data };
    if (data.length === 0) return { type: 'close', code: 1005, reason: '' };
    if (data.length === 1) return this.#fail(1002, 'close 본문 1바이트');
    const code = (data[0] << 8) | data[1];
    if (!isValidCloseCode(code)) return this.#fail(1002, '잘못된 close 코드');
    let reason;
    try { reason = textDecoder.decode(data.subarray(2)); } catch { return this.#fail(1007, 'close 사유 UTF-8 아님'); }
    return { type: 'close', code, reason };
  }
}
