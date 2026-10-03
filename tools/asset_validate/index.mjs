// T03.6 포맷 검증기. 명세 format/ASSET_FORMAT.md §3.2·§4·§7·§9 를 검사해 위반 목록을 돌려준다.
// 던지지 않는다. 계약(contracts/asset/index.mjs)의 상수·parseHeader·bodyLayout 만 쓴다.
import { crc32 } from 'node:zlib';
import {
  AssetFormatError, CODEC_RAW_PLANAR, FORMAT_POINT27, FORMAT_GAUSS56, HEADER_SIZE, LOD_MAX,
  OCT_SNORM_MAX, OFFSETS, CHECKSUM_BYTES, POSITION_Q_MAX, QUANT_EXP_MAX, QUANT_EXP_MIN,
  ROT_COMPONENT_MAX, TILE_SIZE_M, VERSION_MINOR, bodyLayout, parseHeader,
} from '../../contracts/asset/index.mjs';

/** @typedef {{code: string, message: string}} Violation */

const ZERO4 = new Uint8Array(CHECKSUM_BYTES);

/**
 * 체크섬 필드(오프셋 112..115)를 0 으로 보고 [0, end) 의 CRC-32 를 구한다.
 * @param {Uint8Array} u8 @param {number} end
 */
function checksumOf(u8, end) {
  const at = OFFSETS.checksum;
  let c = crc32(u8.subarray(0, at));
  c = crc32(ZERO4, c);
  return crc32(u8.subarray(at + CHECKSUM_BYTES, end), c) >>> 0;
}

/**
 * 명세 위반 목록. 빈 배열 = 적합. 독립적인 위반은 모두 적는다.
 * 헤더를 읽을 수 없는 위반(short·magic·version·header_size·format)은 이후 해석이 불가능해 거기서 멈춘다.
 * @param {Uint8Array} fileBytes
 * @returns {Violation[]}
 */
export function validateAsset(fileBytes) {
  /** @type {Violation[]} */
  const out = [];
  try {
    inspect(fileBytes, out);
  } catch (e) {
    // 검사 자체의 예상 밖 실패도 던지지 않고 위반으로 돌려준다.
    out.push({ code: e instanceof AssetFormatError ? e.code : 'field', message: `validator failure: ${e?.message ?? e}` });
  }
  return out;
}

/** @param {unknown} fileBytes @param {Violation[]} out */
function inspect(fileBytes, out) {
  const add = (code, message) => out.push({ code, message });
  const u8 = fileBytes instanceof ArrayBuffer ? new Uint8Array(fileBytes) : fileBytes;
  if (!(u8 instanceof Uint8Array)) return add('short', 'input is not bytes');

  // 헤더 읽기: 계약 parseHeader 의 최소 검사(길이·매직·주 버전·header_size·형식)
  let h;
  try {
    h = parseHeader(u8);
  } catch (e) {
    if (e instanceof AssetFormatError) return add(e.code, e.message);
    throw e;
  }

  // 헤더 필드 규칙(§3.2)
  if (h.codec !== CODEC_RAW_PLANAR) add('codec', `codec ${h.codec} unknown`);
  if (h.pointCount < 1) add('field', `pointCount ${h.pointCount} < 1`);
  if (h.tileSizeM !== TILE_SIZE_M) add('field', `tileSizeM ${h.tileSizeM} != ${TILE_SIZE_M}`);
  if (h.lod > LOD_MAX) add('field', `lod ${h.lod} > ${LOD_MAX}`);
  const quantOk = h.quantExp >= QUANT_EXP_MIN && h.quantExp <= QUANT_EXP_MAX;
  if (!quantOk) add('field', `quantExp ${h.quantExp} not in ${QUANT_EXP_MIN}..${QUANT_EXP_MAX}`);
  if (![h.anchor.lat, h.anchor.lon, h.anchor.alt].every(Number.isFinite)) add('field', 'anchor not finite');

  const finite = [...h.bboxMin, ...h.bboxMax].every(Number.isFinite);
  if (!finite) add('bbox', 'bbox not finite');
  else {
    for (let a = 0; a < 3; a++) {
      if (h.bboxMin[a] > h.bboxMax[a]) add('bbox', `bbox axis ${a} min ${h.bboxMin[a]} > max ${h.bboxMax[a]}`);
      else if (quantOk && (h.bboxMax[a] - h.bboxMin[a]) * 2 ** h.quantExp > POSITION_Q_MAX) {
        add('range', `bbox axis ${a} span exceeds ${POSITION_Q_MAX} steps at quantExp ${h.quantExp}`);
      }
    }
    // e·n 범위가 (tileX, tileY) 타일 안인지(§1.2)
    const tiles = [h.tileX, h.tileY];
    for (let a = 0; a < 2; a++) {
      const lo = TILE_SIZE_M * tiles[a];
      if (!(h.bboxMin[a] >= lo && h.bboxMax[a] < lo + TILE_SIZE_M)) {
        add('tile', `bbox axis ${a} [${h.bboxMin[a]}, ${h.bboxMax[a]}] outside tile [${lo}, ${lo + TILE_SIZE_M})`);
      }
    }
  }
  if (h.versionMinor === VERSION_MINOR && h.reserved.some((b) => b !== 0)) add('reserved', 'reserved bytes not zero');

  // 본문 길이(§3.2-10)
  const layout = bodyLayout(h.format, h.pointCount);
  if (h.bodyBytes < layout.requiredBytes) add('body', `bodyBytes ${h.bodyBytes} < required ${layout.requiredBytes}`);
  const declaredEnd = h.headerSize + h.bodyBytes;
  if (declaredEnd !== u8.length) add('body', `file length ${u8.length} != headerSize + bodyBytes ${declaredEnd}`);

  // 평면 채움 0 과 양자화 값 범위: 실제로 들어 있는 바이트 안에서만 본다
  const bodyEnd = Math.min(declaredEnd, u8.length);
  const body = u8.subarray(h.headerSize, Math.max(h.headerSize, bodyEnd));
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const n = h.pointCount;
  let padBad = 0;
  for (const p of layout.planes) {
    const stop = Math.min(p.offset + p.paddedBytes, body.length);
    for (let i = p.offset + p.bytes; i < stop; i++) if (body[i] !== 0) padBad++;
  }
  if (padBad) add('body', `${padBad} nonzero plane padding byte(s)`);

  for (const p of layout.planes) {
    if (p.offset + p.bytes > body.length) continue;
    if (h.format === FORMAT_POINT27 && p.name.startsWith('normal_oct_')) {
      let bad = 0;
      for (let i = 0; i < n; i++) if (dv.getInt8(p.offset + i) < -OCT_SNORM_MAX) bad++;
      if (bad) add('range', `${p.name}: ${bad} value(s) below -${OCT_SNORM_MAX}`);
    } else if (h.format === FORMAT_GAUSS56 && p.name === 'rotation') {
      let bad = 0;
      for (let i = 0; i < n; i++) {
        const v = dv.getUint32(p.offset + 4 * i, true);
        if (((v >>> 20) & 0x3ff) > ROT_COMPONENT_MAX || ((v >>> 10) & 0x3ff) > ROT_COMPONENT_MAX || (v & 0x3ff) > ROT_COMPONENT_MAX) bad++;
      }
      if (bad) add('range', `rotation: ${bad} value(s) with component > ${ROT_COMPONENT_MAX}`);
    }
  }

  // 체크섬(§7): 선언 범위가 파일 안에 있을 때만 계산할 수 있다
  if (declaredEnd <= u8.length && declaredEnd >= HEADER_SIZE) {
    const want = checksumOf(u8, declaredEnd);
    if (want !== h.checksum) add('checksum', `checksum ${h.checksum} != computed ${want}`);
  }
}
