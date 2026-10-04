// 경량 자산 포맷(.skla) 계약. 명세 전문은 format/ASSET_FORMAT.md 이고, 수치가 다르면 명세가 이긴다.
// 이 파일은 상수·타입·헤더 읽기(parseHeader)·헤더 쓰기(serializeHeader)·본문 배치(bodyLayout)만 구현한다.
// 하위 작업(T03.1~T03.11)이 채울 함수의 서명은 ./stubs.mjs 에 있다.
// 모든 다바이트 값은 little-endian 이다.

/** 매직 4바이트 'SKLA' (0x53 0x4B 0x4C 0x41). */
export const MAGIC = Object.freeze([0x53, 0x4b, 0x4c, 0x41]);
export const MAGIC_STRING = 'SKLA';
/** 이 계약이 읽고 쓰는 주 버전. 다른 주 버전은 거부한다. */
export const VERSION_MAJOR = 1;
/** 이 계약이 아는 부 버전. 더 큰 부 버전은 받아들이되 모르는 영역(헤더 확장·예약·본문 확장 평면)은 무시한다. */
export const VERSION_MINOR = 0;
export const VERSION = Object.freeze({ major: VERSION_MAJOR, minor: VERSION_MINOR });
/** v1 기본 헤더 크기(바이트). header_size 는 이 값 이상이고 4의 배수다. */
export const HEADER_SIZE = 128;
/** header_size 상한(u16 안에서 가장 큰 4의 배수). */
export const HEADER_SIZE_MAX = 65532;

/** 형식 표시: 원본 27 B 점(xyz f32·법선 f32·rgb u8). */
export const FORMAT_POINT27 = 1;
/** 형식 표시: 원본 56 B 가우시안(xyz·f_dc_0..2·opacity·scale_0..2·rot_0..3, 모두 f32). */
export const FORMAT_GAUSS56 = 2;
/** 형식별 원본 레코드 크기(바이트). 역변환(unpack)이 내는 레코드 크기와 같다. */
export const SOURCE_RECORD_BYTES = Object.freeze({ [FORMAT_POINT27]: 27, [FORMAT_GAUSS56]: 56 });

/** 본문 부호화: 0 = 무압축 필드별 평면 배열. 다른 값은 T09 가 부 버전을 올려 정한다. */
export const CODEC_RAW_PLANAR = 0;

/** 타일 한 변(m). ENU 사각 격자, 원점 = GeoAnchor. tile = floor(좌표 / 64). */
export const TILE_SIZE_M = 64;
/** 딜레이 패턴 수준 → 학습 스텝. 수준 번호 0..3. */
export const LEVEL_STEPS = Object.freeze([250, 1000, 3500, 7000]);
export const LEVEL_COUNT = 4;
/** 구간 id 상한(배타). seg_level = segment_id·4 + level 이 u32 에 들어가야 한다. */
export const SEGMENT_ID_LIMIT = 2 ** 30;
/** chunkIndex 상한(배타). 헤더 칸은 u32 지만 값은 0..65535 만 허용한다. contracts/proto PieceKey 가 u16 이라 같은 값을 PIECE 로 보내야 하기 때문(F-193). */
export const CHUNK_INDEX_LIMIT = 65536;
/** LOD 단계 범위 0..7. 0 = 가장 세밀(도착한 점 그대로). 단계 의미(거리표)는 T07 계약이 정한다. */
export const LOD_MAX = 7;
/** 위치 양자화 단계 = 2^-quant_exp m. 허용 quant_exp 8..10. */
export const QUANT_EXP_MIN = 8;
export const QUANT_EXP_MAX = 10;
/** 위치 양자화 정수 최댓값(u16). */
export const POSITION_Q_MAX = 65535;
/** 구면 조화 0차 계수. 가우시안 색 f_dc ↔ rgb 변환에 쓴다. */
export const SH_C0 = 0.28209479177387814;
/** 가우시안 크기(ln s) 양자화: q = clamp(round((ln s - SCALE_LOG_MIN) * 16), 0, 255). */
export const SCALE_LOG_MIN = -10;
export const SCALE_LOG_STEPS_PER_UNIT = 16;
/** 법선 팔면체 사상 snorm8 의 정수 범위 ±127. */
export const OCT_SNORM_MAX = 127;
/** 회전 smallest-three 10비트 성분: a = round(v·√2·511) + 511, a ∈ 0..1022. */
export const ROT_COMPONENT_CENTER = 511;
export const ROT_COMPONENT_MAX = 1022;

/**
 * 역변환 오차 상한(명세 §8).
 * positionAxisM(qexp): 축마다 |복원(f64) − 원본| ≤ 2^-(qexp+1) m.
 * positionF32ExtraM: |좌표| < 4096 m 에서 f32 로 내릴 때 더해지는 반올림 상한 2^-13 m.
 * gaussFdc: 0.5 + SH_C0·f_dc 가 [0, 1] 안인 원본에만 적용(밖은 잘림, 명세 §8).
 */
export const ERROR_BOUNDS = Object.freeze({
  positionAxisM: (qexp) => 2 ** -(qexp + 1),
  positionF32ExtraM: 2 ** -13,
  colorPoint27: 0,
  gaussFdc: 0.5 / (255 * SH_C0),
  normalDeg: 1.0,
  opacityAlpha: 1 / 510,
  scaleLog: 1 / 32,
  rotationDeg: 0.3,
});

/** 헤더 필드 오프셋(바이트). */
export const OFFSETS = Object.freeze({
  magic: 0, versionMajor: 4, versionMinor: 6, headerSize: 8, format: 10, codec: 11,
  segLevel: 12, pointCount: 16, tileX: 20, tileY: 24, tileSizeM: 28, lod: 30, quantExp: 31,
  chunkIndex: 32, bodyBytes: 36, bboxMin: 40, bboxMax: 64, anchorLat: 88, anchorLon: 96, anchorAlt: 104,
  checksum: 112, reserved: 116,
});
export const CHECKSUM_BYTES = 4;
export const RESERVED_BYTES = 12;

/** 형식별 필수 평면(본문 순서대로). type: u16 | u8 | i8 | u32. */
export const PLANES = Object.freeze({
  [FORMAT_POINT27]: Object.freeze([
    { name: 'pos_e', type: 'u16' }, { name: 'pos_n', type: 'u16' }, { name: 'pos_u', type: 'u16' },
    { name: 'color_r', type: 'u8' }, { name: 'color_g', type: 'u8' }, { name: 'color_b', type: 'u8' },
    { name: 'normal_oct_x', type: 'i8' }, { name: 'normal_oct_y', type: 'i8' },
  ]),
  [FORMAT_GAUSS56]: Object.freeze([
    { name: 'pos_e', type: 'u16' }, { name: 'pos_n', type: 'u16' }, { name: 'pos_u', type: 'u16' },
    { name: 'color_r', type: 'u8' }, { name: 'color_g', type: 'u8' }, { name: 'color_b', type: 'u8' },
    { name: 'opacity', type: 'u8' },
    { name: 'scale_0', type: 'u8' }, { name: 'scale_1', type: 'u8' }, { name: 'scale_2', type: 'u8' },
    { name: 'rotation', type: 'u32' },
  ]),
});
export const TYPE_BYTES = Object.freeze({ u8: 1, i8: 1, u16: 2, u32: 4 });

/**
 * 포맷 오류. code 로 원인을 가른다.
 * 이 파일이 쓰는 것: 'short' | 'magic' | 'version' | 'header_size' | 'format' | 'field'.
 * 하위 작업은 같은 클래스에 'codec' | 'body' | 'checksum' | 'reserved' | 'range' | 'tile' | 'bbox' 를 더해 쓴다.
 */
export class AssetFormatError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(`asset: ${code}: ${message}`);
    this.name = 'AssetFormatError';
    this.code = code;
  }
}

/**
 * @typedef {Object} GeoAnchor
 * @property {number} lat  위도(도)
 * @property {number} lon  경도(도)
 * @property {number} alt  고도(m)
 */

/**
 * 헤더 한 개. 좌표는 모두 GeoAnchor 기준 ENU(m), 배열 순서 [e, n, u].
 * @typedef {Object} AssetHeader
 * @property {number} versionMajor
 * @property {number} versionMinor
 * @property {number} headerSize    기본 128, 확장 영역 포함 전체 헤더 바이트
 * @property {1|2} format           FORMAT_POINT27 | FORMAT_GAUSS56
 * @property {number} codec         CODEC_RAW_PLANAR(0) 등
 * @property {number} segmentId     구간 id (0 ≤ id < 2^30)
 * @property {0|1|2|3} level        딜레이 패턴 수준 번호(LEVEL_STEPS 색인)
 * @property {number} pointCount    점 수(u32)
 * @property {number} tileX         floor(e / tileSizeM) (i32)
 * @property {number} tileY         floor(n / tileSizeM) (i32)
 * @property {number} tileSizeM     v1 은 64 고정
 * @property {number} lod           LOD 단계 0..7
 * @property {number} quantExp      위치 양자화 단계 = 2^-quantExp m
 * @property {number} chunkIndex    같은 (구간, 수준, 타일, LOD) 안의 조각 번호(0..CHUNK_INDEX_LIMIT-1 = 0..65535. 칸은 u32 지만 contracts/proto PieceKey u16 과 같은 상한을 쓴다)
 * @property {number} bodyBytes     본문 바이트(필수 평면 + 확장 평면)
 * @property {[number, number, number]} bboxMin  양자화 원점 = 조각 점들의 최솟값(f64)
 * @property {[number, number, number]} bboxMax  조각 점들의 최댓값(f64)
 * @property {GeoAnchor} anchor
 * @property {number} checksum      CRC-32(명세 §7)
 * @property {Uint8Array} reserved  12 B. v1.0 쓰기는 0. 읽기는 값을 보존만 한다
 * @property {Uint8Array} extension headerSize − 128 바이트. 상위 부 버전 영역, 보존만 한다
 */

/**
 * 조각 식별 키. 딜레이 패턴 교체는 (segmentId, level) 로, 타일·LOD 선택은 나머지로 한다.
 * @typedef {Object} ChunkKey
 * @property {number} segmentId
 * @property {0|1|2|3} level
 * @property {number} tileX
 * @property {number} tileY
 * @property {number} lod
 * @property {number} chunkIndex
 */

/**
 * 원본 27 B 점의 필드별 표현(길이 n). packChunk 입력이자 unpackChunk 출력.
 * @typedef {Object} Point27Fields
 * @property {Float32Array} positions  3n, ENU [e,n,u]
 * @property {Float32Array} normals    3n, 단위 벡터
 * @property {Uint8Array} colors       3n, rgb
 */

/**
 * 원본 56 B 가우시안의 필드별 표현(길이 n). packChunk 입력이자 unpackChunk 출력.
 * @typedef {Object} Gauss56Fields
 * @property {Float32Array} positions  3n, ENU [e,n,u]
 * @property {Float32Array} fdc        3n, f_dc_0..2
 * @property {Float32Array} opacity    n, 로짓(시그모이드 이전)
 * @property {Float32Array} scales     3n, ln s
 * @property {Float32Array} rotations  4n, (w, x, y, z)
 */

/** @param {number} n */
const pad4 = (n) => n + ((4 - (n % 4)) % 4);

/**
 * 본문 필수 평면의 배치. 각 평면은 4바이트 경계에서 시작하고, 평면 끝의 채움 바이트는 0 이다.
 * @param {1|2} format
 * @param {number} pointCount
 * @returns {{planes: {name: string, type: string, offset: number, bytes: number, paddedBytes: number}[], requiredBytes: number}}
 * @throws {AssetFormatError}
 */
export function bodyLayout(format, pointCount) {
  const list = PLANES[format];
  if (!list) throw new AssetFormatError('format', `unknown format ${format}`);
  if (!Number.isInteger(pointCount) || pointCount < 0 || pointCount > 0xffffffff) {
    throw new AssetFormatError('field', `pointCount ${pointCount}`);
  }
  let offset = 0;
  const planes = list.map((p) => {
    const bytes = pointCount * TYPE_BYTES[p.type];
    const plane = { name: p.name, type: p.type, offset, bytes, paddedBytes: pad4(bytes) };
    offset += plane.paddedBytes;
    return plane;
  });
  return { planes, requiredBytes: offset };
}

/** @param {Uint8Array|ArrayBuffer} bytes */
function view(bytes) {
  const u8 = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  if (!(u8 instanceof Uint8Array)) throw new AssetFormatError('short', 'input is not bytes');
  return { u8, dv: new DataView(u8.buffer, u8.byteOffset, u8.byteLength) };
}

/**
 * 헤더를 읽는다(최소 검사). 검사하는 것: 길이, 매직, 주 버전, header_size(≥128, 4의 배수, 입력 길이 이하), 형식 표시.
 * 그 밖의 범위 검사(수준 외 값·LOD·quant_exp·타일 크기·예약 0·코덱·본문 길이·체크섬)는
 * 엄격 읽기(T03.1 readHeaderStrict)·호환 검사(T03.10)·검증기(T03.6)가 한다.
 * 부 버전이 더 커도 받아들이고, 예약·확장 영역은 reserved·extension 으로 보존만 한다.
 * @param {Uint8Array|ArrayBuffer} bytes 파일 앞부분(최소 header_size 바이트). Buffer 도 된다
 * @returns {AssetHeader}
 * @throws {AssetFormatError}
 */
export function parseHeader(bytes) {
  const { u8, dv } = view(bytes);
  if (u8.length < HEADER_SIZE) throw new AssetFormatError('short', `need ${HEADER_SIZE} bytes, got ${u8.length}`);
  for (let i = 0; i < 4; i++) {
    if (u8[i] !== MAGIC[i]) throw new AssetFormatError('magic', 'bad magic');
  }
  const versionMajor = dv.getUint16(OFFSETS.versionMajor, true);
  const versionMinor = dv.getUint16(OFFSETS.versionMinor, true);
  if (versionMajor !== VERSION_MAJOR) {
    throw new AssetFormatError('version', `major ${versionMajor} unsupported (reader ${VERSION_MAJOR})`);
  }
  const headerSize = dv.getUint16(OFFSETS.headerSize, true);
  if (headerSize < HEADER_SIZE || headerSize % 4 !== 0) throw new AssetFormatError('header_size', `${headerSize}`);
  if (u8.length < headerSize) throw new AssetFormatError('short', `header_size ${headerSize} > input ${u8.length}`);
  const format = u8[OFFSETS.format];
  if (format !== FORMAT_POINT27 && format !== FORMAT_GAUSS56) throw new AssetFormatError('format', `unknown format ${format}`);
  const segLevel = dv.getUint32(OFFSETS.segLevel, true);
  const f64 = (o) => dv.getFloat64(o, true);
  return {
    versionMajor,
    versionMinor,
    headerSize,
    format,
    codec: u8[OFFSETS.codec],
    segmentId: segLevel >>> 2,
    level: /** @type {0|1|2|3} */ (segLevel & 3),
    pointCount: dv.getUint32(OFFSETS.pointCount, true),
    tileX: dv.getInt32(OFFSETS.tileX, true),
    tileY: dv.getInt32(OFFSETS.tileY, true),
    tileSizeM: dv.getUint16(OFFSETS.tileSizeM, true),
    lod: u8[OFFSETS.lod],
    quantExp: u8[OFFSETS.quantExp],
    chunkIndex: readChunkIndex(dv),
    bodyBytes: dv.getUint32(OFFSETS.bodyBytes, true),
    bboxMin: [f64(OFFSETS.bboxMin), f64(OFFSETS.bboxMin + 8), f64(OFFSETS.bboxMin + 16)],
    bboxMax: [f64(OFFSETS.bboxMax), f64(OFFSETS.bboxMax + 8), f64(OFFSETS.bboxMax + 16)],
    anchor: { lat: f64(OFFSETS.anchorLat), lon: f64(OFFSETS.anchorLon), alt: f64(OFFSETS.anchorAlt) },
    checksum: dv.getUint32(OFFSETS.checksum, true),
    // Buffer.slice 는 복사가 아닌 뷰라서 새 Uint8Array 로 복사한다(입력이 Buffer 여도 결과 형이 같다).
    reserved: new Uint8Array(u8.subarray(OFFSETS.reserved, OFFSETS.reserved + RESERVED_BYTES)),
    extension: new Uint8Array(u8.subarray(HEADER_SIZE, headerSize)),
  };
}

/** @param {DataView} dv */
function readChunkIndex(dv) {
  const v = dv.getUint32(OFFSETS.chunkIndex, true);
  if (v >= CHUNK_INDEX_LIMIT) throw new AssetFormatError('field', `chunkIndex ${v} not in 0..${CHUNK_INDEX_LIMIT - 1}`);
  return v;
}

/** @param {unknown} v @param {number} lo @param {number} hi @param {string} name */
function int(v, lo, hi, name) {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new AssetFormatError('field', `${name} ${v} not in ${lo}..${hi}`);
  return /** @type {number} */ (v);
}
/** @param {unknown} v @param {string} name */
function num(v, name) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new AssetFormatError('field', `${name} ${v} not finite`);
  return v;
}

/**
 * 헤더를 header_size 바이트로 쓴다. parseHeader 결과를 넣으면 원래 헤더 바이트와 같다(왕복 바이트 동일).
 * 자료형 범위만 검사한다(u8·u16·u32·i32 정수, f64 유한, segmentId < 2^30, level 0..3, 알려진 형식, header_size 규칙).
 * versionMajor 는 검사하지 않는다(거부 시험용 파일을 만들 수 있게). 의미 검사는 T03.1 writeHeader 가 한다.
 * checksum 은 주어진 값을 그대로 쓴다(없으면 0). 계산은 T03.5 computeChecksum.
 * reserved·extension 이 없으면 0 으로 채운다.
 * @param {AssetHeader} h
 * @returns {Uint8Array}
 * @throws {AssetFormatError}
 */
export function serializeHeader(h) {
  const headerSize = int(h.headerSize ?? HEADER_SIZE, HEADER_SIZE, HEADER_SIZE_MAX, 'headerSize');
  if (headerSize % 4 !== 0) throw new AssetFormatError('header_size', `${headerSize}`);
  const out = new Uint8Array(headerSize);
  const dv = new DataView(out.buffer);
  out.set(MAGIC, 0);
  dv.setUint16(OFFSETS.versionMajor, int(h.versionMajor, 0, 0xffff, 'versionMajor'), true);
  dv.setUint16(OFFSETS.versionMinor, int(h.versionMinor, 0, 0xffff, 'versionMinor'), true);
  dv.setUint16(OFFSETS.headerSize, headerSize, true);
  if (h.format !== FORMAT_POINT27 && h.format !== FORMAT_GAUSS56) throw new AssetFormatError('format', `unknown format ${h.format}`);
  out[OFFSETS.format] = h.format;
  out[OFFSETS.codec] = int(h.codec, 0, 0xff, 'codec');
  const seg = int(h.segmentId, 0, SEGMENT_ID_LIMIT - 1, 'segmentId');
  const level = int(h.level, 0, LEVEL_COUNT - 1, 'level');
  dv.setUint32(OFFSETS.segLevel, seg * 4 + level, true);
  dv.setUint32(OFFSETS.pointCount, int(h.pointCount, 0, 0xffffffff, 'pointCount'), true);
  dv.setInt32(OFFSETS.tileX, int(h.tileX, -(2 ** 31), 2 ** 31 - 1, 'tileX'), true);
  dv.setInt32(OFFSETS.tileY, int(h.tileY, -(2 ** 31), 2 ** 31 - 1, 'tileY'), true);
  dv.setUint16(OFFSETS.tileSizeM, int(h.tileSizeM, 0, 0xffff, 'tileSizeM'), true);
  out[OFFSETS.lod] = int(h.lod, 0, 0xff, 'lod');
  out[OFFSETS.quantExp] = int(h.quantExp, 0, 0xff, 'quantExp');
  dv.setUint32(OFFSETS.chunkIndex, int(h.chunkIndex, 0, CHUNK_INDEX_LIMIT - 1, 'chunkIndex'), true);
  dv.setUint32(OFFSETS.bodyBytes, int(h.bodyBytes, 0, 0xffffffff, 'bodyBytes'), true);
  for (let a = 0; a < 3; a++) {
    dv.setFloat64(OFFSETS.bboxMin + 8 * a, num(h.bboxMin?.[a], `bboxMin[${a}]`), true);
    dv.setFloat64(OFFSETS.bboxMax + 8 * a, num(h.bboxMax?.[a], `bboxMax[${a}]`), true);
  }
  dv.setFloat64(OFFSETS.anchorLat, num(h.anchor?.lat, 'anchor.lat'), true);
  dv.setFloat64(OFFSETS.anchorLon, num(h.anchor?.lon, 'anchor.lon'), true);
  dv.setFloat64(OFFSETS.anchorAlt, num(h.anchor?.alt, 'anchor.alt'), true);
  dv.setUint32(OFFSETS.checksum, int(h.checksum ?? 0, 0, 0xffffffff, 'checksum'), true);
  if (h.reserved !== undefined) {
    if (!(h.reserved instanceof Uint8Array) || h.reserved.length !== RESERVED_BYTES) {
      throw new AssetFormatError('field', `reserved must be ${RESERVED_BYTES} bytes`);
    }
    out.set(h.reserved, OFFSETS.reserved);
  }
  if (h.extension !== undefined) {
    if (!(h.extension instanceof Uint8Array) || h.extension.length !== headerSize - HEADER_SIZE) {
      throw new AssetFormatError('field', `extension must be headerSize - ${HEADER_SIZE} bytes`);
    }
    out.set(h.extension, HEADER_SIZE);
  }
  return out;
}

/**
 * 헤더에서 조각 키를 꺼낸다.
 * @param {AssetHeader} h
 * @returns {ChunkKey}
 */
export function chunkKeyOf(h) {
  return { segmentId: h.segmentId, level: h.level, tileX: h.tileX, tileY: h.tileY, lod: h.lod, chunkIndex: h.chunkIndex };
}

export * from './stubs.mjs';
