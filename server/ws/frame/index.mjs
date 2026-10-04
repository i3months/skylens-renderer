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
// 한 메시지를 이루는 데이터 프레임 수 상한(길이 0 포함). 정상 클라이언트는 메시지당 몇 프레임이면 충분하다.
export const DEFAULT_MAX_FRAGMENTS = 4096;

const textDecoder = new TextDecoder('utf-8', { fatal: true });

/** close 코드가 선로에 실어도 되는 값인가(RFC 7.4.1/7.4.2). */
export function isValidCloseCode(code) {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1011) || (code >= 3000 && code <= 4999);
}

/** close 사유 최대 바이트: 제어 프레임 본문 125 - 코드 2 = 123(RFC 6455 5.5, 5.5.1). */
export const MAX_CLOSE_REASON_BYTES = MAX_CONTROL_PAYLOAD - 2;

/** 송신을 허용하는 opcode 집합(예약 opcode 3-7, 0xb-0xf 는 보내지 않는다). */
const SENDABLE_OPCODES = new Set([0x0, 0x1, 0x2, 0x8, 0x9, 0xa]);

/** close 본문(코드 2바이트 + UTF-8 사유) 만들기. 사유가 123바이트를 넘으면 RangeError. */
export function encodeClosePayload(code, reason = '') {
  const r = Buffer.from(reason, 'utf8');
  if (r.length > MAX_CLOSE_REASON_BYTES) throw new RangeError('close 사유는 123바이트 이하');
  const out = Buffer.allocUnsafe(2 + r.length);
  out.writeUInt16BE(code, 0);
  r.copy(out, 2);
  return out;
}

/**
 * 한 프레임을 직렬화한다.
 * @param {number} opcode 0, 1, 2, 8, 9, 10 중 하나(그 외는 RangeError)
 * @param {Uint8Array} payload
 * @param {{fin?: boolean, maskKey?: Uint8Array}} [opts] maskKey(4바이트)를 주면 마스킹(클라이언트 방향).
 * @returns {Buffer}
 */
export function encodeFrame(opcode, payload = new Uint8Array(0), opts = {}) {
  if (!SENDABLE_OPCODES.has(opcode)) throw new RangeError('보낼 수 없는 opcode');
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
  /** @param {{maxPayload?: number, requireMask?: boolean, maxFragments?: number}} [opts] */
  constructor(opts = {}) {
    this.maxPayload = opts.maxPayload ?? MAX_MESSAGE_BYTES;
    this.requireMask = opts.requireMask !== false;
    this.maxFragments = opts.maxFragments ?? DEFAULT_MAX_FRAGMENTS;
    // 수신 버퍼: 조각 목록 + 누적 길이. 매 push 마다 이어 붙이면 O(n^2) 이므로 프레임이 다 모였을 때 한 번만 합친다.
    this.q = [];
    this.qHead = 0; // q 에서 아직 안 쓴 첫 조각의 위치
    this.qBytes = 0;
    this.frags = []; // 조립 중인 분할 메시지 조각(길이 0 은 쌓지 않는다)
    this.fragBytes = 0;
    this.fragCount = 0; // 길이 0 포함, 이 메시지를 이룬 데이터 프레임 수
    this.fragOpcode = -1;
    this.dead = false;
    this.need = 0; // 현재 프레임이 다 모이기까지 필요한 총 바이트. 모자라면 머리 해석을 다시 하지 않는다(1 B 조각 대비).
  }

  /** @param {Uint8Array} chunk @returns {object[]} 이벤트 목록 */
  push(chunk) {
    const events = [];
    if (this.dead) return events;
    if (chunk.length > 0) {
      this.q.push(Buffer.from(chunk)); // 호출자가 나중에 버퍼를 바꿔도 안전하도록 복사(선형 비용)
      this.qBytes += chunk.length;
    }
    while (!this.dead) {
      const ev = this.#next();
      if (ev === null) break;
      if (ev.type === 'error') this.dead = true;
      if (ev.type !== 'none') events.push(ev);
    }
    return events;
  }

  #fail(code, reason) { return { type: 'error', code, reason }; }

  /** 앞에서 최대 n 바이트를 소비하지 않고 복사해 돌려준다(헤더 확인용, n 은 작다). */
  #peek(n) {
    const want = Math.min(n, this.qBytes);
    const out = Buffer.allocUnsafe(want);
    let got = 0;
    for (let i = this.qHead; got < want; i++) {
      const c = this.q[i];
      const k = Math.min(c.length, want - got);
      c.copy(out, got, 0, k);
      got += k;
    }
    return out;
  }

  /** 앞에서 n 바이트를 소비하고 버린다. */
  #skip(n) {
    this.qBytes -= n;
    while (n > 0) {
      const c = this.q[this.qHead];
      if (c.length <= n) { n -= c.length; this.q[this.qHead++] = undefined; }
      else { this.q[this.qHead] = c.subarray(n); n = 0; }
    }
    if (this.qHead === this.q.length) { this.q = []; this.qHead = 0; }
    else if (this.qHead > 1024 && this.qHead * 2 > this.q.length) { this.q = this.q.slice(this.qHead); this.qHead = 0; }
  }

  /** 앞에서 n 바이트를 소비하며 새 버퍼(전용 ArrayBuffer)로 한 번만 복사한다. */
  #take(n) {
    const out = Buffer.allocUnsafeSlow(n);
    let got = 0;
    while (got < n) {
      const c = this.q[this.qHead];
      const k = Math.min(c.length, n - got);
      c.copy(out, got, 0, k);
      got += k;
      if (k === c.length) this.q[this.qHead++] = undefined;
      else this.q[this.qHead] = c.subarray(k);
    }
    this.qBytes -= n;
    if (this.qHead === this.q.length) { this.q = []; this.qHead = 0; }
    else if (this.qHead > 1024 && this.qHead * 2 > this.q.length) { this.q = this.q.slice(this.qHead); this.qHead = 0; }
    return out;
  }

  #next() {
    if (this.qBytes < 2 || this.qBytes < this.need) return null;
    const b = this.#peek(14); // 헤더 최대 길이 = 2 + 8 + 4
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
      // RFC 6455 5.2: 길이는 가장 짧은 부호화로 써야 한다(125 이하를 확장 필드로 쓰면 위반).
      if (len < 126) return this.#fail(1002, '확장 길이 비최소 부호화');
    } else if (len === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      // RFC 6455 5.2: 64비트 길이의 최상위 비트는 반드시 0 이다. 1 이면 프레임 형식 위반이므로 1002
      // (너무 커서 못 받는 것이 아니라 잘못된 부호화). 최상위 비트가 0 인 큰 값은 상한 초과 1009 로 아래에서 거른다.
      if (big >> 63n !== 0n) return this.#fail(1002, '64비트 길이 최상위 비트');
      // 최소 부호화: 65535 이하를 8바이트 필드로 쓰면 위반.
      if (big <= 0xffffn) return this.#fail(1002, '확장 길이 비최소 부호화');
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return this.#fail(1009, '길이 초과');
      len = Number(big); off = 10;
    }
    // 상한은 본문을 기다리기 전에 검사한다(분할 메시지는 누적 길이).
    if (len > this.maxPayload || (!isControl && this.fragBytes + len > this.maxPayload)) return this.#fail(1009, '페이로드 상한 초과');
    const hdr = off + (masked ? 4 : 0);
    const total = hdr + len;
    if (this.qBytes < total) { this.need = total; return null; }
    this.need = 0;
    const key = masked ? b.subarray(off, off + 4) : null; // b 는 peek 복사본이라 소비 뒤에도 유효
    this.#skip(hdr);
    const payload = this.#take(len);
    if (key) {
      for (let i = 0; i < len; i++) payload[i] ^= key[i & 3];
    }

    if (isControl) return this.#control(opcode, payload);
    if (opcode === OPCODES.TEXT) return this.#fail(1003, '이진 전용');
    if (opcode === OPCODES.CONT) {
      if (this.fragOpcode < 0) return this.#fail(1002, '시작 없는 연속 프레임');
    } else if (this.fragOpcode >= 0) {
      return this.#fail(1002, '분할 중 새 데이터 프레임');
    }
    if (opcode === OPCODES.BINARY) this.fragOpcode = OPCODES.BINARY;
    // 길이 0 프레임도 개수에는 센다: 빈 fin=0 프레임을 무한히 보내 CPU 를 쓰게 하는 것을 막는다.
    if (++this.fragCount > this.maxFragments) return this.#fail(1009, '조각 개수 상한 초과');
    if (len > 0) {
      this.frags.push(payload);
      this.fragBytes += len;
    }
    if (!fin) return { type: 'none' };
    let data;
    if (this.frags.length === 1) {
      const f = this.frags[0];
      data = new Uint8Array(f.buffer, f.byteOffset, f.length); // 전용 버퍼라 복사 없이 뷰로 넘긴다
    } else {
      data = new Uint8Array(this.fragBytes);
      let o = 0;
      for (const f of this.frags) { data.set(f, o); o += f.length; }
    }
    this.frags = []; this.fragBytes = 0; this.fragCount = 0; this.fragOpcode = -1;
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
