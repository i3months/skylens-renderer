// 브라우저용 .skla 헤더·평면 읽기. DataView·타입 배열만 쓴다(서버 전용 의존 없음).
import {
  MAGIC, VERSION_MAJOR, HEADER_SIZE, OFFSETS, RESERVED_BYTES, FORMAT_POINT27, FORMAT_GAUSS56,
  TYPE_BYTES, AssetFormatError, bodyLayout, CODEC_RAW_PLANAR, TILE_SIZE_M,
} from '../../contracts/asset/index.mjs';

/** @param {ArrayBuffer|Uint8Array} bytes */
function toBytes(bytes) {
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (bytes instanceof Uint8Array) return bytes;
  throw new AssetFormatError('short', 'input is not bytes');
}

/** header_size + body_bytes 가 입력 길이와 같아야 한다(짧아도 길어도 거부). */
function checkLength(len, headerSize, bodyBytes) {
  if (headerSize + bodyBytes !== len) {
    throw new AssetFormatError('body', `header_size ${headerSize} + body_bytes ${bodyBytes} != input ${len}`);
  }
}

/**
 * 헤더 읽기(parseHeader 와 같은 검사·같은 결과).
 * @param {ArrayBuffer|Uint8Array} bytes
 * @returns {import('../../contracts/asset/index.mjs').AssetHeader}
 */
export function readHeaderClient(bytes) {
  const u8 = toBytes(bytes);
  if (u8.length < HEADER_SIZE) throw new AssetFormatError('short', `need ${HEADER_SIZE} bytes, got ${u8.length}`);
  for (let i = 0; i < 4; i++) {
    if (u8[i] !== MAGIC[i]) throw new AssetFormatError('magic', 'bad magic');
  }
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const versionMajor = dv.getUint16(OFFSETS.versionMajor, true);
  if (versionMajor !== VERSION_MAJOR) {
    throw new AssetFormatError('version', `major ${versionMajor} unsupported (reader ${VERSION_MAJOR})`);
  }
  const headerSize = dv.getUint16(OFFSETS.headerSize, true);
  if (headerSize < HEADER_SIZE || headerSize % 4 !== 0) throw new AssetFormatError('header_size', `${headerSize}`);
  if (u8.length < headerSize) throw new AssetFormatError('short', `header_size ${headerSize} > input ${u8.length}`);
  const format = u8[OFFSETS.format];
  if (format !== FORMAT_POINT27 && format !== FORMAT_GAUSS56) throw new AssetFormatError('format', `unknown format ${format}`);
  // 명세 §3.2 3·5·6·10, §9: 모르는 codec 은 거부, 최소 의미 검사.
  const codec = u8[OFFSETS.codec];
  if (codec !== CODEC_RAW_PLANAR) throw new AssetFormatError('codec', `unknown codec ${codec}`);
  const pointCount = dv.getUint32(OFFSETS.pointCount, true);
  if (pointCount < 1) throw new AssetFormatError('field', 'pointCount 0');
  const tileSizeM = dv.getUint16(OFFSETS.tileSizeM, true);
  if (tileSizeM !== TILE_SIZE_M) throw new AssetFormatError('field', `tileSizeM ${tileSizeM}`);
  const quantExp = u8[OFFSETS.quantExp];
  if (quantExp < 8 || quantExp > 10) throw new AssetFormatError('field', `quantExp ${quantExp}`);
  const bodyBytes = dv.getUint32(OFFSETS.bodyBytes, true);
  checkLength(u8.length, headerSize, bodyBytes);
  const segLevel = dv.getUint32(OFFSETS.segLevel, true);
  const f64 = (o) => dv.getFloat64(o, true);
  // 서버 unpack 과 같게 bbox 6값이 유한해야 한다
  for (const o of [OFFSETS.bboxMin, OFFSETS.bboxMax]) {
    for (let k = 0; k < 3; k++) {
      if (!Number.isFinite(f64(o + 8 * k))) throw new AssetFormatError('bbox', 'bbox not finite');
    }
  }
  const chunkIndex = dv.getUint32(OFFSETS.chunkIndex, true);
  if (chunkIndex > 65535) throw new AssetFormatError('field', `chunkIndex ${chunkIndex} not in 0..65535`);
  return {
    versionMajor,
    versionMinor: dv.getUint16(OFFSETS.versionMinor, true),
    headerSize,
    format,
    codec,
    segmentId: segLevel >>> 2,
    level: /** @type {0|1|2|3} */ (segLevel & 3),
    pointCount,
    tileX: dv.getInt32(OFFSETS.tileX, true),
    tileY: dv.getInt32(OFFSETS.tileY, true),
    tileSizeM,
    lod: u8[OFFSETS.lod],
    quantExp,
    chunkIndex,
    bodyBytes,
    bboxMin: [f64(OFFSETS.bboxMin), f64(OFFSETS.bboxMin + 8), f64(OFFSETS.bboxMin + 16)],
    bboxMax: [f64(OFFSETS.bboxMax), f64(OFFSETS.bboxMax + 8), f64(OFFSETS.bboxMax + 16)],
    anchor: { lat: f64(OFFSETS.anchorLat), lon: f64(OFFSETS.anchorLon), alt: f64(OFFSETS.anchorAlt) },
    checksum: dv.getUint32(OFFSETS.checksum, true),
    // 입력과 메모리를 공유하지 않도록 복사한다.
    reserved: new Uint8Array(u8.subarray(OFFSETS.reserved, OFFSETS.reserved + RESERVED_BYTES)),
    extension: new Uint8Array(u8.subarray(HEADER_SIZE, headerSize)),
  };
}

const ARRAYS = { u8: Uint8Array, i8: Int8Array, u16: Uint16Array, u32: Uint32Array };

/**
 * 필수 평면을 타입 배열 뷰로 준다(원본 버퍼 공유). 확장 평면은 무시한다.
 * 주의: 타입 배열 뷰는 호스트 바이트 순서를 쓴다. 파일은 리틀엔디언이고 LE 호스트만 가정한다(BE 호스트 미지원).
 * 입력 뷰의 시작 주소가 정렬되지 않았으면 그 평면만 복사한다.
 * @param {ArrayBuffer|Uint8Array} fileBytes
 * @param {import('../../contracts/asset/index.mjs').AssetHeader} header
 * @returns {Record<string, Uint16Array|Uint8Array|Int8Array|Uint32Array>}
 */
export function readPlanesClient(fileBytes, header) {
  const u8 = toBytes(fileBytes);
  if (header.codec !== CODEC_RAW_PLANAR) throw new AssetFormatError('codec', `unknown codec ${header.codec}`);
  checkLength(u8.length, header.headerSize, header.bodyBytes);
  const { planes, requiredBytes } = bodyLayout(header.format, header.pointCount);
  if (header.bodyBytes < requiredBytes) {
    throw new AssetFormatError('body', `body_bytes ${header.bodyBytes} < required ${requiredBytes}`);
  }
  const out = {};
  for (const p of planes) {
    const rel = header.headerSize + p.offset;
    const start = u8.byteOffset + rel;
    const Ctor = ARRAYS[p.type];
    out[p.name] = start % TYPE_BYTES[p.type] === 0
      ? new Ctor(u8.buffer, start, header.pointCount)
      : new Ctor(u8.slice(rel, rel + p.bytes).buffer);
  }
  return out;
}
