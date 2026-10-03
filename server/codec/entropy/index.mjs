// T09.5 엔트로피 부호화(서버). contracts/codec 의 ENTROPY_MODE·RANGE_PROB_BITS·RANGE_MOVE_BITS 를 직접 구현한다.
// 참고한 공개 명세: LZMA SDK 문서(Igor Pavlov, 공개 영역)의 range coder 설명. 코드는 차용하지 않고 직접 구현했다.
// 클라이언트(T09.6)는 이 모듈을 import 하지 않고 아래 바이트 형식을 따로 구현한다. 형식의 단일 설명은 이 주석이다.
//
// ── 컨테이너 ─────────────────────────────────────────────────────────────
//   [u8 mode][LEB128 rawLen][payload]
//   rawLen : 원바이트 수. LEB128 = 7 비트씩 하위부터, 최상위 비트 1 = 다음 바이트 이어짐. 최소 길이 표현만 허용
//            (여러 바이트인데 마지막 바이트가 0x00 이면 거부). 7 바이트(49 비트)를 넘게 이어지면 상한 초과로 본다.
//   mode 0 (STORED): payload = 원바이트 그대로, 길이는 정확히 rawLen.
//   mode 1 (RANGE) : payload = 아래 범위 부호기 출력, 복호기가 정확히 다 써야 한다(남거나 모자라면 거부).
//   부호기 선택: 범위 부호 출력 길이 L 이 rawLen 이하이면 mode 1, 크면 mode 0(헤더 길이는 두 모드가 같으므로
//   "부호화 결과가 원본+헤더보다 크면 저장"과 같다). rawLen = 0 이면 L = 5 > 0 이라 항상 mode 0 → 바이트열 [00 00].
//
// ── mode 1: 적응형 이진 범위 부호(LZMA 방식, 공개 알고리즘) ───────────────────────
//   확률 모델: prob[1..255] (u16), 전부 1024(= 2^11 / 2, "비트 0 일 확률" × 2048)로 시작. 스트림 전체가 한 모델 집합을 공유.
//   바이트 b 부호화: m = 1; 비트 i = 7..0 (최상위부터) 에 대해 bit = (b >> i) & 1 을 prob[m] 으로 부호화, m = (m << 1) | bit.
//     (복호는 같은 순서로 8 비트를 읽고 b = m & 0xFF.) 이전 바이트 문맥은 쓰지 않는다.
//   비트 부호화(모든 값은 부호 없는 32 비트, low 는 33 비트까지):
//     bound = (range >>> 11) * p
//     bit 0: range = bound;             p += (2048 − p) >> 5
//     bit 1: low += bound; range −= bound; p −= p >> 5
//     range < 2^24 이면 range <<= 8 (mod 2^32) 후 shiftLow() — 비트당 최대 한 번이면 충분하다.
//   shiftLow(): (cache 초기 0, cacheSize 초기 1, low 초기 0, range 초기 0xFFFFFFFF)
//     if (low < 0xFF000000 || low ≥ 2^32) { carry = low ≥ 2^32 ? 1 : 0;
//        cache+carry 를 한 번, 이어서 (0xFF+carry)&0xFF 를 cacheSize−1 번 출력; cache = (low >>> 24) & 0xFF; cacheSize = 0 }
//     cacheSize += 1; low = (low & 0x00FFFFFF) << 8
//   끝맺음: shiftLow() 5 번. → 첫 출력 바이트는 항상 0x00, 출력 길이 = 정규화 횟수 + 5.
//   복호기: payload 가 5 바이트 미만이거나 첫 바이트 ≠ 0 이면 거부. code = payload[1..4] (big-endian), range = 0xFFFFFFFF.
//     비트 복호: bound = (range >>> 11) * p; code < bound 면 bit 0 (range = bound), 아니면 bit 1 (code −= bound, range −= bound),
//     p 갱신은 부호기와 같다. range < 2^24 이면 range <<= 8, code = (code << 8 | 다음 바이트) mod 2^32 (다음 바이트 없으면 거부).
//     rawLen 바이트를 다 복호한 뒤 읽은 바이트 수 ≠ payload 길이 이거나 code ≠ 0 이면 거부. 정상 스트림은 항상 다 읽고
//     code = 0 이다(끝맺음 4 바이트가 low 자체이므로 code = 창 값 − low = 0).
//   주의: 체크섬이 없는 층이라 손상을 다 잡지는 못한다. 특히 rawLen 을 조금 늘리면, 늘어난 비트를 정규화 없이 복호할 수 있을 때
//     원본 뒤에 0x00 이 붙은 결과가 나오는데 이는 그 결과의 정상 부호화와 바이트 단위로 같아 형식상 구별할 수 없다(파일 체크섬이 잡는다).
//   비정규 거부: mode 1 에서 rawLen = 0 이거나 payload 길이 > rawLen 이면 'stream'(부호기는 그런 출력을 만들지 않는다).
//   조기 거부(선택, 결과는 같다): 비트마다 range 는 최소 2017/2048 배로 줄어 원바이트 하나가 최소 0.176 비트를 쓴다.
//     따라서 rawLen > 64 × payload 길이 + 64 인 mode 1 은 어차피 payload 가 모자라므로 할당 전에 'stream' 으로 거부한다.
//
// ── 오류(CodecError.code) ───────────────────────────────────────────────
//   'stream' : 입력이 비었거나 LEB128 잘림·비최소 표현, payload 모자람/남음, 범위 부호 검사 실패
//   'mode'   : mode 가 0·1 이 아님
//   'limit'  : rawLen > maxRawBytes (기본 STREAM_RAW_BYTES_MAX)
//   'range'  : 인자 자체가 잘못됨(Uint8Array 아님, maxRawBytes 가 음이 아닌 정수가 아님)

import { ENTROPY_MODE, RANGE_PROB_BITS, RANGE_MOVE_BITS, STREAM_RAW_BYTES_MAX, CodecError } from '../../../contracts/codec/index.mjs';

const PROB_ONE = 1 << RANGE_PROB_BITS; // 2048
const PROB_INIT = PROB_ONE >>> 1; // 1024
const TOP = 1 << 24;
const TWO32 = 0x100000000;
const LEB_MAX_BYTES = 7;

/** LEB128 바이트 수 */
function lebSize(v) {
  let n = 1;
  while (v >= 128) { v = Math.floor(v / 128); n++; }
  return n;
}

/** out[pos..] 에 LEB128 을 쓰고 새 위치를 돌려준다 */
function writeLeb(out, pos, v) {
  while (v >= 128) { out[pos++] = (v % 128) | 0x80; v = Math.floor(v / 128); }
  out[pos++] = v;
  return pos;
}

/**
 * 범위 부호화. 출력이 limit 바이트를 넘으면 −1(저장 모드로 간다). 아니면 out[start..] 에 쓴 길이.
 * @param {Uint8Array} raw @param {Uint8Array} out @param {number} start @param {number} limit
 */
function rangeEncodeInto(raw, out, start, limit) {
  const probs = new Uint16Array(256).fill(PROB_INIT);
  const end = start + limit;
  let low = 0; // 0 ≤ low < 2^33
  let range = 0xFFFFFFFF;
  let cache = 0;
  let cacheSize = 1;
  let pos = start;

  // 넘치면 false
  const shiftLow = () => {
    if (low < 0xFF000000 || low >= TWO32) {
      const carry = low >= TWO32 ? 1 : 0;
      if (pos + cacheSize > end) return false;
      out[pos++] = (cache + carry) & 0xFF;
      const fill = (0xFF + carry) & 0xFF;
      for (let k = cacheSize - 1; k > 0; k--) out[pos++] = fill;
      cacheSize = 0;
      cache = Math.floor(low / TOP) & 0xFF;
    }
    cacheSize++;
    low = (low & 0x00FFFFFF) * 256;
    return true;
  };

  const n = raw.length;
  for (let i = 0; i < n; i++) {
    const b = raw[i];
    let m = 1;
    for (let s = 7; s >= 0; s--) {
      const bit = (b >>> s) & 1;
      const p = probs[m];
      const bound = (range >>> 11) * p;
      if (bit === 0) {
        range = bound;
        probs[m] = p + ((PROB_ONE - p) >>> RANGE_MOVE_BITS);
      } else {
        low += bound;
        range -= bound;
        probs[m] = p - (p >>> RANGE_MOVE_BITS);
      }
      m = (m << 1) | bit;
      if (range < TOP) {
        range = (range * 256) >>> 0;
        if (!shiftLow()) return -1;
      }
    }
  }
  for (let k = 0; k < 5; k++) if (!shiftLow()) return -1;
  return pos - start;
}

/**
 * 원바이트 → ENTROPY 컨테이너. 결정적.
 * @param {Uint8Array} raw
 * @returns {Uint8Array}
 */
export function entropyEncode(raw) {
  if (!(raw instanceof Uint8Array)) throw new CodecError('range', 'entropyEncode: raw 는 Uint8Array 여야 한다');
  const n = raw.length;
  const head = 1 + lebSize(n);
  const out = new Uint8Array(head + n);
  writeLeb(out, 1, n);
  const len = n > 0 ? rangeEncodeInto(raw, out, head, n) : -1;
  if (len >= 0) {
    out[0] = ENTROPY_MODE.RANGE;
    return out.slice(0, head + len);
  }
  out[0] = ENTROPY_MODE.STORED;
  out.set(raw, head);
  return out;
}

/**
 * ENTROPY 컨테이너 → 원바이트.
 * @param {Uint8Array} bytes
 * @param {number} [maxRawBytes]
 * @returns {Uint8Array}
 */
export function entropyDecode(bytes, maxRawBytes = STREAM_RAW_BYTES_MAX) {
  if (!(bytes instanceof Uint8Array)) throw new CodecError('range', 'entropyDecode: bytes 는 Uint8Array 여야 한다');
  if (!Number.isSafeInteger(maxRawBytes) || maxRawBytes < 0) throw new CodecError('range', 'entropyDecode: maxRawBytes 는 음이 아닌 정수여야 한다');
  const end = bytes.length;
  if (end < 1) throw new CodecError('stream', 'entropy: 빈 입력');
  const mode = bytes[0];
  if (mode !== ENTROPY_MODE.STORED && mode !== ENTROPY_MODE.RANGE) throw new CodecError('mode', `entropy: 모르는 mode ${mode}`);

  // rawLen (LEB128, 최소 표현)
  let rawLen = 0;
  let mul = 1;
  let pos = 1;
  for (let k = 0; ; k++) {
    if (k >= LEB_MAX_BYTES) throw new CodecError('limit', 'entropy: rawLen 이 상한을 넘는다');
    if (pos >= end) throw new CodecError('stream', 'entropy: rawLen 이 잘렸다');
    const b = bytes[pos++];
    rawLen += (b & 0x7F) * mul;
    mul *= 128;
    if ((b & 0x80) === 0) {
      if (b === 0 && k > 0) throw new CodecError('stream', 'entropy: rawLen 이 최소 표현이 아니다');
      break;
    }
  }
  if (rawLen > maxRawBytes) throw new CodecError('limit', `entropy: rawLen ${rawLen} > ${maxRawBytes}`);
  const payloadLen = end - pos;

  if (mode === ENTROPY_MODE.STORED) {
    if (payloadLen !== rawLen) throw new CodecError('stream', `entropy: 저장 payload ${payloadLen} B ≠ rawLen ${rawLen}`);
    return bytes.slice(pos, end);
  }

  // mode 1: 빈 출력(rawLen 0)은 항상 mode 0 이고, 범위 부호는 rawLen 이하일 때만 쓰이므로 둘 다 비정규
  if (rawLen === 0) throw new CodecError('stream', 'entropy: mode 1 에서 rawLen 이 0 이다');
  if (payloadLen > rawLen) throw new CodecError('stream', 'entropy: mode 1 payload 가 rawLen 보다 크다');
  if (payloadLen < 5) throw new CodecError('stream', 'entropy: 범위 부호 payload 가 5 B 미만');
  if (rawLen > 64 * payloadLen + 64) throw new CodecError('stream', 'entropy: payload 가 rawLen 에 비해 너무 짧다');
  if (bytes[pos] !== 0) throw new CodecError('stream', 'entropy: 범위 부호 첫 바이트가 0 이 아니다');
  let code = ((bytes[pos + 1] << 24) | (bytes[pos + 2] << 16) | (bytes[pos + 3] << 8) | bytes[pos + 4]) >>> 0;
  pos += 5;
  let range = 0xFFFFFFFF;
  const probs = new Uint16Array(256).fill(PROB_INIT);
  const out = new Uint8Array(rawLen);
  for (let i = 0; i < rawLen; i++) {
    let m = 1;
    for (let s = 0; s < 8; s++) {
      const p = probs[m];
      const bound = (range >>> 11) * p;
      if (code < bound) {
        range = bound;
        probs[m] = p + ((PROB_ONE - p) >>> RANGE_MOVE_BITS);
        m <<= 1;
      } else {
        code -= bound;
        range -= bound;
        probs[m] = p - (p >>> RANGE_MOVE_BITS);
        m = (m << 1) | 1;
      }
      if (range < TOP) {
        if (pos >= end) throw new CodecError('stream', 'entropy: 범위 부호 payload 가 모자라다');
        range = (range * 256) >>> 0;
        code = ((code << 8) | bytes[pos++]) >>> 0;
      }
    }
    out[i] = m & 0xFF;
  }
  if (pos !== end) throw new CodecError('stream', `entropy: 범위 부호 payload 가 ${end - pos} B 남는다`);
  if (code !== 0) throw new CodecError('stream', 'entropy: 범위 부호 끝 상태(code ≠ 0)가 맞지 않는다');
  return out;
}
