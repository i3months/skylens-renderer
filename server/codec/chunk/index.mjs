// codec 1(SKLC1) 조각 부호화·복호화(T09.11). 형식·와이어 규칙은 contracts/codec/index.mjs 와 format/ASSET_FORMAT.md §4.3.
import { crc32 } from 'node:zlib';
import {
  FORMAT_POINT27, CODEC_RAW_PLANAR, OFFSETS, AssetFormatError, bodyLayout, parseHeader, serializeHeader,
  TILE_SIZE_M, LOD_MAX, QUANT_EXP_MIN, QUANT_EXP_MAX, POSITION_Q_MAX,
} from '../../../contracts/asset/index.mjs';
import {
  CODEC_SKLC1, COLOR_MODE, BODY_FIXED_BYTES, BODY_VERSION, POINT_COUNT_MAX, CodecError, streamRawBounds,
} from '../../../contracts/codec/index.mjs';
import { mortonOrder } from '../order/index.mjs';
import { encodePositionStream, decodePositionStream } from '../position/index.mjs';
import { encodeNormalStream, decodeNormalStream } from '../normal/index.mjs';
import { encodeColorStream, decodeColorStream } from '../color/index.mjs';
import { entropyEncode, entropyDecode } from '../entropy/index.mjs';

/** 체크섬 필드를 0 으로 보고 파일 전체의 CRC-32 를 계산해 채운다(§7). */
function fillChecksum(file) {
  new DataView(file.buffer, file.byteOffset, file.byteLength).setUint32(OFFSETS.checksum, 0, true);
  const c = crc32(file) >>> 0;
  new DataView(file.buffer, file.byteOffset, file.byteLength).setUint32(OFFSETS.checksum, c, true);
}

/** 호출 전에 checkRawInput 을 통과한 파일만 받는다(평면 범위는 그쪽이 보장). @param {Uint8Array} file */
function readPlanesRaw(file, h) {
  const { planes } = bodyLayout(h.format, h.pointCount);
  const out = {};
  for (const p of planes) {
    const rel = h.headerSize + p.offset;
    // 평면 범위 검사는 두지 않는다: checkRawInput 이 file.length == header_size + body_bytes 와 body_bytes >= requiredBytes 를
    // 이미 보장하므로 마지막 평면 끝(header_size + requiredBytes)이 파일 끝을 넘을 수 없다(도달 불가 중복 검사였다, F-174 ③).
    const raw = new Uint8Array(file.subarray(rel, rel + p.bytes)); // 복사본(Buffer 입력이어도 byteOffset 0)
    out[p.name] = p.type === 'u16' ? new Uint16Array(raw.buffer) : p.type === 'i8' ? new Int8Array(raw.buffer) : raw;
  }
  return out;
}

const ZERO4 = new Uint8Array(4);

/** 체크섬 필드(4 B)를 0 으로 본 파일 전체의 CRC-32. 파일을 복사하지 않고 필드 앞·뒤를 이어 계산한다(§7). */
function checksumOf(file) {
  let c = crc32(file.subarray(0, OFFSETS.checksum));
  c = crc32(ZERO4, c);
  return crc32(file.subarray(OFFSETS.checksum + 4), c) >>> 0;
}

/** codec 0 입력 엄격 검사: 헤더 의미·길이·본문 크기·체크섬. 손상 입력을 정상 파일로 세탁하지 않는다. */
function checkRawInput(file, h) {
  checkHeaderSemantics(h);
  if (file.length !== h.headerSize + h.bodyBytes) throw new CodecError('length', 'file length != header_size + body_bytes');
  // point_count 와 실제 점 수의 일치는 형식이 따로 검증하지 않는다. n=5 파일의 point_count 를 6 으로 바꿔도 필수 본문 바이트가
  // 같으면(pad4 때문, §3.1) §3.2-10(body_bytes >= 필수 합)을 만족하는 유효한 파일이라 받아들이고, 패딩 자리가 0 점이 된다(F-175 ①).
  const { requiredBytes } = bodyLayout(h.format, h.pointCount);
  if (h.bodyBytes < requiredBytes) throw new CodecError('length', `body_bytes ${h.bodyBytes} < ${requiredBytes}`);
  if (checksumOf(file) !== h.checksum) throw new CodecError('checksum', 'checksum mismatch');
}

/**
 * ENTROPY 컨테이너의 앞부분(mode, LEB128 rawLen)만 읽어 rawLen 이 [min, max] 안인지 확인한 뒤 복호한다.
 * entropyDecode 가 min 을 받지 않으므로 여기서 먼저 확인해 큰 할당·긴 복호 전에 'limit' 으로 거부한다.
 * 컨테이너 형식 오류(모르는 mode·잘림·비최소 LEB)는 entropyDecode 가 오류 코드를 정하도록 넘긴다.
 */
function decodeBounded(bytes, [min, max]) {
  if (bytes.length >= 2 && (bytes[0] === 0 || bytes[0] === 1)) {
    let rawLen = 0, mul = 1, k = 1, ok = false;
    for (; k < 8 && k < bytes.length; k++) {
      const b = bytes[k];
      rawLen += (b & 0x7F) * mul;
      mul *= 128;
      if ((b & 0x80) === 0) { ok = !(b === 0 && k > 1); break; }
    }
    // rawLen > max 항은 entropyDecode(max) 의 같은 검사와 겹치지만(같은 'limit' 코드), min 과 함께 한 메시지로 범위를 알리려고
    // 한 조건으로 둔다. 겹쳐도 오류 코드는 같다(F-175 ⑦).
    if (ok && (rawLen < min || rawLen > max)) throw new CodecError('limit', `entropy rawLen ${rawLen} not in [${min}, ${max}]`);
  }
  return entropyDecode(bytes, max);
}

/**
 * codec 0 형식 1 파일 → codec 1 파일. 점은 모턴 순으로 재배치된다.
 * @param {Uint8Array} rawFileBytes
 * @param {{lossyColor?: boolean}} [opts]
 * @returns {Uint8Array}
 */
export function encodeChunk(rawFileBytes, opts = {}) {
  const h = parseHeader(rawFileBytes);
  if (h.format !== FORMAT_POINT27) throw new CodecError('format', 'codec 1 accepts format 1 only');
  if (h.codec !== CODEC_RAW_PLANAR) throw new CodecError('format', 'input must be codec 0');
  const n = h.pointCount;
  if (n < 1 || n > POINT_COUNT_MAX) throw new CodecError('limit', `point count ${n}`);
  checkRawInput(rawFileBytes, h);
  const pl = readPlanesRaw(rawFileBytes, h);
  const ord = mortonOrder(pl.pos_e, pl.pos_n, pl.pos_u);
  const g16 = (a) => { const o = new Uint16Array(n); for (let k = 0; k < n; k++) o[k] = a[ord[k]]; return o; };
  const g8 = (a, T) => { const o = new T(n); for (let k = 0; k < n; k++) o[k] = a[ord[k]]; return o; };
  const qe = g16(pl.pos_e), qn = g16(pl.pos_n), qu = g16(pl.pos_u);
  const pos = entropyEncode(encodePositionStream(qe, qn, qu));
  const nrm = entropyEncode(encodeNormalStream(g8(pl.normal_oct_x, Int8Array), g8(pl.normal_oct_y, Int8Array)));
  const colRaw = encodeColorStream(g8(pl.color_r, Uint8Array), g8(pl.color_g, Uint8Array), g8(pl.color_b, Uint8Array), { lossy: !!opts.lossyColor });
  const col = entropyEncode(colRaw);
  const bodyBytes = BODY_FIXED_BYTES + pos.length + nrm.length + col.length;
  const head = serializeHeader({ ...h, codec: CODEC_SKLC1, bodyBytes, checksum: 0 });
  const out = new Uint8Array(head.length + bodyBytes);
  out.set(head, 0);
  const dv = new DataView(out.buffer);
  let o = head.length;
  out[o] = BODY_VERSION; out[o + 1] = colRaw[0]; // 색 스트림 첫 바이트 = 모드
  dv.setUint32(o + 4, pos.length, true); dv.setUint32(o + 8, nrm.length, true); dv.setUint32(o + 12, col.length, true);
  o += BODY_FIXED_BYTES;
  out.set(pos, o); o += pos.length;
  out.set(nrm, o); o += nrm.length;
  out.set(col, o);
  fillChecksum(out);
  return out;
}

/**
 * codec 1 헤더 의미 검사(ASSET_FORMAT §3.2 의 4~9, 11). server/asset/header 의 readHeaderStrict 는 codec 1 의 body_bytes 규칙을
 * 거부하므로(소유 밖) 같은 검사를 여기서 직접 한다. client/codec 의 checkHeaderSemantics 와 같은 집합이어야 한다.
 */
function checkHeaderSemantics(h) {
  if (h.tileSizeM !== TILE_SIZE_M) throw new AssetFormatError('field', `tileSizeM ${h.tileSizeM} != ${TILE_SIZE_M}`);
  if (h.lod > LOD_MAX) throw new AssetFormatError('field', `lod ${h.lod} > ${LOD_MAX}`);
  if (h.quantExp < QUANT_EXP_MIN || h.quantExp > QUANT_EXP_MAX) throw new AssetFormatError('field', `quantExp ${h.quantExp}`);
  for (const k of ['lat', 'lon', 'alt']) {
    if (!Number.isFinite(h.anchor[k])) throw new AssetFormatError('field', `anchor.${k} not finite`);
  }
  for (let a = 0; a < 3; a++) {
    const lo = h.bboxMin[a], hi = h.bboxMax[a];
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new AssetFormatError('bbox', `axis ${a} not finite`);
    if (lo > hi) throw new AssetFormatError('bbox', `axis ${a} min > max`);
    if ((hi - lo) * 2 ** h.quantExp > POSITION_Q_MAX) throw new AssetFormatError('range', `axis ${a} span exceeds u16`);
  }
  const tiles = [h.tileX, h.tileY];
  for (let a = 0; a < 2; a++) {
    const t0 = TILE_SIZE_M * tiles[a];
    if (h.bboxMin[a] < t0 || h.bboxMax[a] >= t0 + TILE_SIZE_M) throw new AssetFormatError('tile', `bbox axis ${a} outside tile`);
  }
  if (h.versionMinor === 0 && h.reserved.some((x) => x !== 0)) throw new AssetFormatError('reserved', 'reserved bytes must be 0 for version 1.0');
}

/**
 * codec 1 파일 → 같은 점 집합의 codec 0 파일(점 순서는 모턴 순). 체크섬을 검사한다.
 * @param {Uint8Array} fileBytes
 * @returns {Uint8Array}
 */
export function decodeChunk(fileBytes) {
  return decodeChunkInfo(fileBytes).file;
}

/**
 * decodeChunk 와 같으나 색 모드(COLOR_MODE: 손실 QUANT2 인지)도 돌려준다. codec 0 파일은 바이트 형식이라 모드를 담을 수 없다.
 * @param {Uint8Array} fileBytes
 * @returns {{file: Uint8Array, colorMode: number}}
 */
export function decodeChunkInfo(fileBytes) {
  const h = parseHeader(fileBytes);
  if (h.codec !== CODEC_SKLC1) throw new CodecError('mode', `codec ${h.codec} is not 1`);
  if (h.format !== FORMAT_POINT27) throw new CodecError('format', 'codec 1 accepts format 1 only');
  const n = h.pointCount;
  if (n < 1 || n > POINT_COUNT_MAX) throw new CodecError('limit', `point count ${n}`);
  checkHeaderSemantics(h);
  if (fileBytes.length !== h.headerSize + h.bodyBytes) throw new CodecError('length', 'file length != header_size + body_bytes');
  if (checksumOf(fileBytes) !== h.checksum) throw new CodecError('checksum', 'checksum mismatch');
  if (h.bodyBytes < BODY_FIXED_BYTES) throw new CodecError('length', 'body too short');
  const b = h.headerSize;
  const dv = new DataView(fileBytes.buffer, fileBytes.byteOffset);
  if (fileBytes[b] !== BODY_VERSION || dv.getUint16(b + 2, true) !== 0) throw new CodecError('format', 'bad body version/reserved');
  const [pl, nl, cl] = [dv.getUint32(b + 4, true), dv.getUint32(b + 8, true), dv.getUint32(b + 12, true)];
  if (BODY_FIXED_BYTES + pl + nl + cl !== h.bodyBytes) throw new CodecError('length', 'stream lengths do not sum to body_bytes');
  const s0 = b + BODY_FIXED_BYTES;
  const bounds = streamRawBounds(n);
  const pos = decodePositionStream(decodeBounded(fileBytes.subarray(s0, s0 + pl), bounds.pos), n);
  const nrm = decodeNormalStream(decodeBounded(fileBytes.subarray(s0 + pl, s0 + pl + nl), bounds.normal), n);
  const col = decodeColorStream(decodeBounded(fileBytes.subarray(s0 + pl + nl, s0 + pl + nl + cl), bounds.color), n);
  if (col.mode !== fileBytes[b + 1] || !Object.values(COLOR_MODE).includes(col.mode)) throw new CodecError('mode', 'color mode mismatch');
  const { planes, requiredBytes } = bodyLayout(h.format, n);
  const head = serializeHeader({ ...h, codec: CODEC_RAW_PLANAR, bodyBytes: requiredBytes, checksum: 0 });
  const out = new Uint8Array(head.length + requiredBytes);
  out.set(head, 0);
  const src = { pos_e: pos.qe, pos_n: pos.qn, pos_u: pos.qu, color_r: col.r, color_g: col.g, color_b: col.b, normal_oct_x: nrm.octX, normal_oct_y: nrm.octY };
  for (const p of planes) {
    const a = src[p.name];
    out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), head.length + p.offset);
  }
  fillChecksum(out);
  return { file: out, colorMode: col.mode };
}
