// 버전 호환 판정(명세 §9). 다른 서버 하위 모듈에 의존하지 않고 DataView 로 헤더를 직접 읽는다.
import {
  MAGIC, VERSION_MAJOR, VERSION_MINOR, HEADER_SIZE, OFFSETS, CODEC_RAW_PLANAR,
  FORMAT_POINT27, FORMAT_GAUSS56,
} from '../../../contracts/asset/index.mjs';

const KNOWN_CODECS = new Set([CODEC_RAW_PLANAR]);

const reject = (reason) => ({ action: 'reject', reason });

/**
 * @param {Uint8Array} bytes 파일 앞부분(최소 header_size 바이트)
 * @param {{readerMinor?: number}} [opts] 시험용 읽는 쪽 부 버전, 기본 VERSION_MINOR
 * @returns {{action: 'accept'|'accept_ignore_extension'|'reject', reason: string}}
 */
export function checkCompat(bytes, opts) {
  const readerMinor = opts?.readerMinor ?? VERSION_MINOR;
  if (!(bytes instanceof Uint8Array)) return reject('input is not bytes');
  if (bytes.length < HEADER_SIZE) return reject(`too short: ${bytes.length} < ${HEADER_SIZE} bytes`);
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== MAGIC[i]) return reject('bad magic');
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const major = dv.getUint16(OFFSETS.versionMajor, true);
  const minor = dv.getUint16(OFFSETS.versionMinor, true);
  if (major !== VERSION_MAJOR) return reject(`major ${major} unsupported (reader ${VERSION_MAJOR})`);
  const headerSize = dv.getUint16(OFFSETS.headerSize, true);
  if (headerSize < HEADER_SIZE || headerSize % 4 !== 0) return reject(`invalid header_size ${headerSize}`);
  if (bytes.length < headerSize) return reject(`header_size ${headerSize} exceeds input ${bytes.length}`);
  const format = bytes[OFFSETS.format];
  if (format !== FORMAT_POINT27 && format !== FORMAT_GAUSS56) return reject(`unknown format ${format}`);
  const codec = bytes[OFFSETS.codec];
  if (!KNOWN_CODECS.has(codec)) return reject(`unknown codec ${codec}`);
  if (minor > readerMinor) {
    return {
      action: 'accept_ignore_extension',
      reason: `minor ${minor} > reader ${readerMinor}: ignore header extension, reserved and body extension planes`,
    };
  }
  return { action: 'accept', reason: `version ${major}.${minor} <= reader ${VERSION_MAJOR}.${readerMinor}` };
}
