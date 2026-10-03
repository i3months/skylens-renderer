// 하위 작업이 채울 인터페이스. 여기 있는 함수는 서명·문서만 고정하고 모두 'not implemented' 를 던진다.
// 각 하위 작업은 자기 소유 경로(server/asset/<모듈>/ 등)에 같은 이름·같은 서명으로 구현하고,
// 이 파일은 고치지 않는다(서명을 바꿔야 하면 작업자에게 돌려보낸다).
// 명세: format/ASSET_FORMAT.md. 오류는 contracts/asset/index.mjs 의 AssetFormatError 로 던진다.
//
// 타입은 ./index.mjs 의 typedef 를 쓴다.
/** @typedef {import('./index.mjs').AssetHeader} AssetHeader */
/** @typedef {import('./index.mjs').ChunkKey} ChunkKey */
/** @typedef {import('./index.mjs').GeoAnchor} GeoAnchor */
/** @typedef {import('./index.mjs').Point27Fields} Point27Fields */
/** @typedef {import('./index.mjs').Gauss56Fields} Gauss56Fields */

/** @param {string} name @param {string} owner */
function notImplemented(name, owner) {
  throw new Error(`not implemented: ${name} (${owner})`);
}

// ---------------------------------------------------------------------------
// T03.1 헤더 쓰기·읽기 — server/asset/header/
// ---------------------------------------------------------------------------

/**
 * 엄격 헤더 읽기. parseHeader 의 검사에 더해 명세 §3.2 의 필드 규칙을 모두 검사한다:
 * tileSizeM = 64, lod ≤ 7, quantExp 8..10, pointCount ≥ 1, codec 이 읽는 쪽이 아는 값,
 * bodyBytes ≥ 필수 평면 합, bbox 유한·min ≤ max, 축마다 (max − min)·2^quantExp ≤ 65535,
 * bbox 의 e·n 범위가 (tileX, tileY) 타일 안, anchor 유한, versionMinor = 0 이면 reserved 전부 0.
 * 파일 전체 길이가 주어지면 headerSize + bodyBytes = 길이 도 본다.
 * @param {Uint8Array} bytes 헤더 또는 파일 전체
 * @param {{fileBytes?: number}} [opts] 파일 전체 길이(알면)
 * @returns {AssetHeader}
 * @throws {import('./index.mjs').AssetFormatError}
 */
export function readHeaderStrict(bytes, opts) {
  return notImplemented('readHeaderStrict', 'T03.1 server/asset/header/');
}

/**
 * 현재 버전(1.0)·header_size 128·reserved 0·checksum 0 으로 헤더를 만든다. 의미 규칙(readHeaderStrict 와 같은 것)을 어기면 던진다.
 * 체크섬은 본문을 붙인 뒤 T03.5 computeChecksum 으로 채운다.
 * @param {Omit<AssetHeader, 'versionMajor'|'versionMinor'|'headerSize'|'checksum'|'reserved'|'extension'>} fields
 * @returns {Uint8Array} 128 바이트
 */
export function writeHeader(fields) {
  return notImplemented('writeHeader', 'T03.1 server/asset/header/');
}

// ---------------------------------------------------------------------------
// T03.2 타일 색인 — server/asset/tile_index/
// ---------------------------------------------------------------------------

/**
 * ENU 좌표가 속한 타일. tileX = floor(e / 64), tileY = floor(n / 64). 경계 e = 64k 는 타일 k 에 속한다(반열린 구간).
 * u 는 타일과 무관하다. 유한하지 않은 값은 던진다. 결과는 i32 범위여야 한다.
 * @param {number} e 동(m)
 * @param {number} n 북(m)
 * @returns {{tileX: number, tileY: number}}
 */
export function tileOf(e, n) {
  return notImplemented('tileOf', 'T03.2 server/asset/tile_index/');
}

/**
 * 타일의 ENU 범위 [eMin, eMax) × [nMin, nMax). eMin = 64·tileX, eMax = eMin + 64.
 * @param {number} tileX
 * @param {number} tileY
 * @returns {{eMin: number, eMax: number, nMin: number, nMax: number}}
 */
export function tileBounds(tileX, tileY) {
  return notImplemented('tileBounds', 'T03.2 server/asset/tile_index/');
}

/**
 * 점들을 타일별로 나눈다. 반환 순서: tileY 오름차순, 같으면 tileX 오름차순(결정적). 각 목록의 점 번호는 오름차순.
 * @param {Float32Array|Float64Array} positions 3n, [e,n,u]
 * @returns {{tileX: number, tileY: number, indices: Uint32Array}[]}
 */
export function groupByTile(positions) {
  return notImplemented('groupByTile', 'T03.2 server/asset/tile_index/');
}

// ---------------------------------------------------------------------------
// T03.3 조각 경계 상자 — server/asset/bounds/
// ---------------------------------------------------------------------------

/**
 * 점들의 축별 최솟값·최댓값(f64). 점이 0개이거나 유한하지 않은 값이 있으면 던진다.
 * @param {Float32Array|Float64Array} positions 3n
 * @returns {{min: [number, number, number], max: [number, number, number]}}
 */
export function computeBounds(positions) {
  return notImplemented('computeBounds', 'T03.3 server/asset/bounds/');
}

/**
 * 위치 양자화 지수. 10, 9, 8 순서로 모든 축에서 (max − min)·2^k ≤ 65535 인 가장 큰 k. 없으면 AssetFormatError('range') — 조각을 u 방향으로 나눠야 한다.
 * @param {[number, number, number]} min
 * @param {[number, number, number]} max
 * @returns {8|9|10}
 */
export function chooseQuantExp(min, max) {
  return notImplemented('chooseQuantExp', 'T03.3 server/asset/bounds/');
}

/**
 * 양자화 격자가 덮는 상자: [min, min + 65535·2^-qexp] 축별. 모든 점이 이 안에 있어야 한다.
 * @param {[number, number, number]} min
 * @param {number} quantExp
 * @returns {{min: [number, number, number], max: [number, number, number]}}
 */
export function quantizedBox(min, quantExp) {
  return notImplemented('quantizedBox', 'T03.3 server/asset/bounds/');
}

// ---------------------------------------------------------------------------
// T03.4 구간·수준 식별자 — server/asset/ids/
// ---------------------------------------------------------------------------

/**
 * seg_level = segmentId·4 + level (u32). segmentId 0..2^30−1, level 0..3 밖이면 던진다.
 * @param {number} segmentId
 * @param {number} level
 * @returns {number}
 */
export function packSegLevel(segmentId, level) {
  return notImplemented('packSegLevel', 'T03.4 server/asset/ids/');
}

/**
 * @param {number} segLevel u32
 * @returns {{segmentId: number, level: 0|1|2|3}}
 */
export function unpackSegLevel(segLevel) {
  return notImplemented('unpackSegLevel', 'T03.4 server/asset/ids/');
}

/**
 * 학습 스텝(250·1000·3500·7000) → 수준 번호 0..3. 그 밖이면 던진다.
 * @param {number} step
 * @returns {0|1|2|3}
 */
export function levelOfStep(step) {
  return notImplemented('levelOfStep', 'T03.4 server/asset/ids/');
}

/**
 * 조각 키의 정규 문자열: `${segmentId}.${level}.${tileX}.${tileY}.${lod}.${chunkIndex}` (10진, 음수 타일은 '-' 부호, 앞자리 0 없음).
 * @param {ChunkKey} key
 * @returns {string}
 */
export function encodeChunkKey(key) {
  return notImplemented('encodeChunkKey', 'T03.4 server/asset/ids/');
}

/**
 * encodeChunkKey 의 역. 정규형이 아닌 문자열(앞자리 0, '+', 공백, 범위 밖)은 던진다.
 * @param {string} s
 * @returns {ChunkKey}
 */
export function decodeChunkKey(s) {
  return notImplemented('decodeChunkKey', 'T03.4 server/asset/ids/');
}

// ---------------------------------------------------------------------------
// T03.5 체크섬 — server/asset/checksum/
// ---------------------------------------------------------------------------

/**
 * CRC-32 (IEEE 802.3, 반사 다항식 0xEDB88320, 초기값 0xFFFFFFFF, 끝 XOR 0xFFFFFFFF; zlib crc32 과 같은 값).
 * 'abc' → 0x352441C2, '123456789' → 0xCBF43926.
 * @param {Uint8Array} bytes
 * @param {number} [prev] 이어서 계산할 때 앞 결과
 * @returns {number} u32
 */
export function crc32(bytes, prev) {
  return notImplemented('crc32', 'T03.5 server/asset/checksum/');
}

/**
 * 파일 체크섬(명세 §7): 파일[0, headerSize + bodyBytes) 에서 checksum 필드 4바이트(오프셋 112)를 0 으로 본 CRC-32.
 * @param {Uint8Array} fileBytes
 * @returns {number}
 */
export function computeChecksum(fileBytes) {
  return notImplemented('computeChecksum', 'T03.5 server/asset/checksum/');
}

/**
 * @param {Uint8Array} fileBytes
 * @returns {boolean} 헤더의 checksum 과 computeChecksum 이 같으면 참
 */
export function verifyChecksum(fileBytes) {
  return notImplemented('verifyChecksum', 'T03.5 server/asset/checksum/');
}

// ---------------------------------------------------------------------------
// T03.6 포맷 검증기 — tools/asset_validate/
// ---------------------------------------------------------------------------

/**
 * 명세 위반 목록. 빈 배열 = 적합. 첫 위반에서 멈추지 않고 독립적으로 볼 수 있는 위반을 모두 적는다.
 * 각 항목 `{code, message}` — code 는 AssetFormatError 의 code 와 같은 어휘.
 * 검사: 헤더 엄격 규칙, 파일 길이 = headerSize + bodyBytes, 평면 채움 0, 양자화 값 범위(pos ≤ 65535 은 자료형상 자명, snorm ±127, rot 성분 ≤ 1022·최댓값 색인),
 * 체크섬, 버전 정책(§9). 이상한 입력에도 던지지 않는다(손상 = 위반 목록).
 * @param {Uint8Array} fileBytes
 * @returns {{code: string, message: string}[]}
 */
export function validateAsset(fileBytes) {
  return notImplemented('validateAsset', 'T03.6 tools/asset_validate/');
}

// ---------------------------------------------------------------------------
// T03.7 역변환 — server/asset/unpack/
// ---------------------------------------------------------------------------

/**
 * 조각을 원본 형식의 필드로 되돌린다(명세 §6 복원식). codec 0 만 안다. 체크섬은 검사하지 않는다(verifyChecksum 별도).
 * 오차는 명세 §8 상한 이내여야 한다.
 * @param {Uint8Array} fileBytes
 * @returns {{header: AssetHeader, fields: Point27Fields | Gauss56Fields}}
 */
export function unpackChunk(fileBytes) {
  return notImplemented('unpackChunk', 'T03.7 server/asset/unpack/');
}

/**
 * 조각을 원본 PLY 정점 레코드 바이트열로 되돌린다. 27 B: x y z nx ny nz (f32) r g b (u8).
 * 56 B: x y z f_dc_0..2 opacity scale_0..2 rot_0..3 (f32). little-endian, 점 순서 = 본문 순서.
 * @param {Uint8Array} fileBytes
 * @returns {Uint8Array} pointCount × 27 또는 × 56
 */
export function toSourceRecords(fileBytes) {
  return notImplemented('toSourceRecords', 'T03.7 server/asset/unpack/');
}

/**
 * 팔면체 snorm8 법선 복원(명세 §5.3).
 * @param {number} qx −127..127
 * @param {number} qy −127..127
 * @returns {[number, number, number]} 단위 벡터
 */
export function decodeOctNormal(qx, qy) {
  return notImplemented('decodeOctNormal', 'T03.7 server/asset/unpack/');
}

/**
 * smallest-three 회전 복원(명세 §5.4).
 * @param {number} packed u32
 * @returns {[number, number, number, number]} (w, x, y, z), 단위 길이, 가장 큰 성분 ≥ 0
 */
export function decodeRotation(packed) {
  return notImplemented('decodeRotation', 'T03.7 server/asset/unpack/');
}

// ---------------------------------------------------------------------------
// 조각 쓰기(packer) — 소유 하위 작업 미정. 제안 경로 server/asset/pack/ (TASKS T03 표에 쓰기 하위 작업이 없다)
// fixtures/asset_golden/generate.mjs 에 골든 파일용 참조 부호화가 있다(명세 §5 식 그대로).
// ---------------------------------------------------------------------------

/**
 * 원본 필드로 조각 파일 한 개를 만든다. 결정적이어야 한다(같은 입력 → 같은 바이트, 명세 §10).
 * 점 순서는 입력 순서를 그대로 쓴다(재배치는 T09.4). bbox·quantExp·tile 은 점에서 계산하고,
 * 모든 점이 한 타일 안이 아니면 AssetFormatError('tile') 를 던진다.
 * @param {{format: 1|2, segmentId: number, level: number, lod: number, chunkIndex: number, anchor: GeoAnchor,
 *          fields: Point27Fields | Gauss56Fields}} input
 * @returns {Uint8Array} 헤더 + 본문, 체크섬 채움
 */
export function packChunk(input) {
  return notImplemented('packChunk', 'server/asset/pack/ (owner undecided)');
}

/**
 * 팔면체 snorm8 법선 부호화(명세 §5.3). 길이 0·유한하지 않은 법선은 던진다.
 * @param {number} x @param {number} y @param {number} z
 * @returns {[number, number]}
 */
export function encodeOctNormal(x, y, z) {
  return notImplemented('encodeOctNormal', 'server/asset/pack/ (owner undecided)');
}

/**
 * smallest-three 회전 부호화(명세 §5.4). 입력은 (w, x, y, z), 정규화 전이어도 된다. 길이 0 은 던진다.
 * @param {number} w @param {number} x @param {number} y @param {number} z
 * @returns {number} u32
 */
export function encodeRotation(w, x, y, z) {
  return notImplemented('encodeRotation', 'server/asset/pack/ (owner undecided)');
}

// ---------------------------------------------------------------------------
// T03.8 클라이언트 읽기 — client/asset/
// ---------------------------------------------------------------------------

/**
 * 브라우저용 헤더 읽기. node: 모듈·Buffer 를 쓰지 않고 DataView 만 쓴다. 결과는 parseHeader 와 필드가 같아야 한다(client_header_parity).
 * @param {ArrayBuffer|Uint8Array} bytes
 * @returns {AssetHeader}
 */
export function readHeaderClient(bytes) {
  return notImplemented('readHeaderClient', 'T03.8 client/asset/');
}

/**
 * 본문 필수 평면을 형식별 타입 배열 뷰로 준다(4바이트 정렬이라 복사 없이 만들 수 있다). 확장 평면은 무시한다.
 * 이름은 contracts/asset/index.mjs PLANES 의 name.
 * @param {ArrayBuffer|Uint8Array} fileBytes
 * @param {AssetHeader} header
 * @returns {Record<string, Uint16Array|Uint8Array|Int8Array|Uint32Array>}
 */
export function readPlanesClient(fileBytes, header) {
  return notImplemented('readPlanesClient', 'T03.8 client/asset/');
}

// ---------------------------------------------------------------------------
// T03.9 결정성 — server/asset/determinism/
// ---------------------------------------------------------------------------

/**
 * 같은 입력으로 packChunk 를 times 번 돌려 바이트가 모두 같은지 본다.
 * @param {Parameters<typeof packChunk>[0]} input
 * @param {number} [times] 기본 2
 * @returns {{identical: boolean, firstDiffOffset: number | null}}
 */
export function checkDeterminism(input, times) {
  return notImplemented('checkDeterminism', 'T03.9 server/asset/determinism/');
}

// ---------------------------------------------------------------------------
// T03.10 버전 호환 — server/asset/compat/
// ---------------------------------------------------------------------------

/**
 * 버전 호환 판정(명세 §9).
 * - versionMajor ≠ 1 → 'reject' (구버전 0 과 미래 주 버전 모두)
 * - versionMajor = 1, versionMinor ≤ 0 → 'accept'
 * - versionMajor = 1, versionMinor > 0 → 'accept_ignore_extension' (헤더 확장·예약·본문 확장 평면 무시)
 * - codec 을 모르면 'reject' (부 버전과 무관)
 * 매직이 틀리거나 128 B 보다 짧으면 'reject'.
 * @param {Uint8Array} bytes
 * @param {{readerMinor?: number}} [opts] 시험용 읽는 쪽 부 버전, 기본 VERSION_MINOR
 * @returns {{action: 'accept'|'accept_ignore_extension'|'reject', reason: string}}
 */
export function checkCompat(bytes, opts) {
  return notImplemented('checkCompat', 'T03.10 server/asset/compat/');
}
