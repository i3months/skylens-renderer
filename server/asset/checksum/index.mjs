// T03.5 체크섬: 테이블 기반 CRC-32 (명세 §7).
import { AssetFormatError, OFFSETS, CHECKSUM_BYTES, HEADER_SIZE } from '../../../contracts/asset/index.mjs';

// 반사 다항식 0xEDB88320 의 256항 테이블
const TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  TABLE[n] = c >>> 0;
}

// 끝 XOR 이 끝난 값 prev 를 내부 상태로 되돌린 뒤 [start, end) 를 이어 계산한다
function update(bytes, prev, start, end) {
  let c = (prev ^ 0xffffffff) >>> 0;
  for (let i = start; i < end; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * @param {Uint8Array} bytes
 * @param {number} [prev] 이어서 계산할 때 앞 결과
 * @returns {number} u32
 */
export function crc32(bytes, prev = 0) {
  return update(bytes, prev >>> 0, 0, bytes.length);
}

/**
 * 파일[0, headerSize + bodyBytes) 에서 checksum 필드(오프셋 112, 4바이트)를 0 으로 본 CRC-32.
 * 헤더를 읽을 수 없거나 범위가 파일을 넘으면 AssetFormatError 를 던진다.
 * @param {Uint8Array} fileBytes
 * @returns {number}
 */
export function computeChecksum(fileBytes) {
  if (fileBytes.length < HEADER_SIZE) throw new AssetFormatError('short', `header needs ${HEADER_SIZE} bytes, got ${fileBytes.length}`);
  const dv = new DataView(fileBytes.buffer, fileBytes.byteOffset, fileBytes.byteLength);
  const headerSize = dv.getUint16(OFFSETS.headerSize, true);
  const bodyBytes = dv.getUint32(OFFSETS.bodyBytes, true);
  if (headerSize < HEADER_SIZE) throw new AssetFormatError('header_size', `header_size ${headerSize} < ${HEADER_SIZE}`);
  const end = headerSize + bodyBytes;
  if (end > fileBytes.length) throw new AssetFormatError('body', `range ${end} exceeds file length ${fileBytes.length}`);
  const cs = OFFSETS.checksum;
  let c = update(fileBytes, 0, 0, cs);
  c = update(new Uint8Array(CHECKSUM_BYTES), c, 0, CHECKSUM_BYTES);
  return update(fileBytes, c, cs + CHECKSUM_BYTES, end);
}

/**
 * @param {Uint8Array} fileBytes
 * @returns {boolean} 헤더의 checksum 과 computeChecksum 이 같으면 참(읽을 수 없으면 거짓)
 */
export function verifyChecksum(fileBytes) {
  try {
    const dv = new DataView(fileBytes.buffer, fileBytes.byteOffset, fileBytes.byteLength);
    return dv.getUint32(OFFSETS.checksum, true) === computeChecksum(fileBytes);
  } catch (e) {
    if (e instanceof AssetFormatError || e instanceof RangeError || e instanceof TypeError) return false;
    throw e;
  }
}
