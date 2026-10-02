// T03.1 헤더 쓰기·읽기. 명세: format/ASSET_FORMAT.md §3. 계약: contracts/asset/stubs.mjs.
import {
  AssetFormatError, parseHeader, serializeHeader, bodyLayout,
  VERSION_MAJOR, VERSION_MINOR, HEADER_SIZE, CODEC_RAW_PLANAR,
  TILE_SIZE_M, LOD_MAX, QUANT_EXP_MIN, QUANT_EXP_MAX, POSITION_Q_MAX,
} from '../../../contracts/asset/index.mjs';

/** 의미 규칙(명세 §3.2 의 3·5~10 앞부분) 검사. 실패하면 던진다. */
function checkSemantics(h) {
  if (h.codec !== CODEC_RAW_PLANAR) throw new AssetFormatError('codec', `unknown codec ${h.codec}`);
  if (h.pointCount < 1) throw new AssetFormatError('field', 'pointCount must be >= 1');
  if (h.tileSizeM !== TILE_SIZE_M) throw new AssetFormatError('field', `tileSizeM ${h.tileSizeM} != ${TILE_SIZE_M}`);
  if (h.lod > LOD_MAX) throw new AssetFormatError('field', `lod ${h.lod} > ${LOD_MAX}`);
  if (h.quantExp < QUANT_EXP_MIN || h.quantExp > QUANT_EXP_MAX) {
    throw new AssetFormatError('field', `quantExp ${h.quantExp} not in ${QUANT_EXP_MIN}..${QUANT_EXP_MAX}`);
  }
  for (const k of ['lat', 'lon', 'alt']) {
    if (!Number.isFinite(h.anchor[k])) throw new AssetFormatError('field', `anchor.${k} not finite`);
  }
  for (let a = 0; a < 3; a++) {
    const lo = h.bboxMin[a];
    const hi = h.bboxMax[a];
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new AssetFormatError('bbox', `axis ${a} not finite`);
    if (lo > hi) throw new AssetFormatError('bbox', `axis ${a} min ${lo} > max ${hi}`);
    if ((hi - lo) * 2 ** h.quantExp > POSITION_Q_MAX) {
      throw new AssetFormatError('range', `axis ${a} span ${hi - lo} m exceeds u16 at quantExp ${h.quantExp}`);
    }
  }
  const tiles = [h.tileX, h.tileY];
  for (let a = 0; a < 2; a++) {
    const t0 = TILE_SIZE_M * tiles[a];
    if (h.bboxMin[a] < t0 || h.bboxMax[a] >= t0 + TILE_SIZE_M) {
      throw new AssetFormatError('tile', `bbox axis ${a} [${h.bboxMin[a]}, ${h.bboxMax[a]}] outside tile ${tiles[a]}`);
    }
  }
  const need = bodyLayout(h.format, h.pointCount).requiredBytes;
  if (h.bodyBytes < need) throw new AssetFormatError('body', `bodyBytes ${h.bodyBytes} < required ${need}`);
}

/**
 * 엄격 헤더 읽기(명세 §3.2 의 체크섬 제외 전부).
 * @param {Uint8Array} bytes
 * @param {{fileBytes?: number}} [opts]
 */
export function readHeaderStrict(bytes, opts) {
  const h = parseHeader(bytes);
  checkSemantics(h);
  if (h.versionMinor === 0 && h.reserved.some((b) => b !== 0)) {
    throw new AssetFormatError('reserved', 'reserved bytes must be 0 for version 1.0');
  }
  const fileBytes = opts?.fileBytes;
  if (fileBytes !== undefined && h.headerSize + h.bodyBytes !== fileBytes) {
    throw new AssetFormatError('body', `headerSize ${h.headerSize} + bodyBytes ${h.bodyBytes} != file length ${fileBytes}`);
  }
  return h;
}

/** 1.0·128 B·reserved 0·checksum 0 헤더를 쓴다. 의미 규칙을 어기면 던진다. */
export function writeHeader(fields) {
  const h = {
    ...fields,
    versionMajor: VERSION_MAJOR,
    versionMinor: VERSION_MINOR,
    headerSize: HEADER_SIZE,
    checksum: 0,
    reserved: new Uint8Array(12),
    extension: new Uint8Array(0),
  };
  const out = serializeHeader(h); // 자료형 범위 검사
  checkSemantics(h);
  return out;
}
