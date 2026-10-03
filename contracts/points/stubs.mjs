// T04 하위 작업이 채울 서명. 각 하위 작업은 자기 소유 경로에 같은 이름·서명으로 구현한다(이 파일은 고치지 않는다).
// 오류는 contracts/points/index.mjs 의 PointsError. 헤더는 contracts/ply 의 parsePlyHeader 로 읽는다.
/** @typedef {import('./index.mjs').Point27Cloud} Point27Cloud */
/** @typedef {import('./index.mjs').Gauss56Cloud} Gauss56Cloud */
const ni = (n, o) => { throw new Error(`not implemented: ${n} (${o})`); };

/** T04.1 server/points/ply_read/ — 이진 PLY 전체 읽기. 형식은 detectFormat 으로 판별, 모르는 형식은 PointsError('format'). 본문 크기 = headerBytes + stride·count 가 아니면 'size'.
 * @param {Uint8Array} bytes @returns {Point27Cloud | Gauss56Cloud} */
export function readPly(bytes) { return ni('readPly', 'T04.1'); }

/** T04.2 server/points/ply_write/ — 이진 PLY 쓰기(헤더는 속성 표 그대로, `format binary_little_endian 1.0`, `element vertex N`, `end_header\n`). readPly(writePly(c)) 가 열 배열 동일, 원본 바이트로 쓰면 왕복 바이트 동일.
 * @param {Point27Cloud | Gauss56Cloud} cloud @returns {Uint8Array} */
export function writePly(cloud) { return ni('writePly', 'T04.2'); }

/** T04.3 server/points/ply_stream/ — 청크 단위 스트리밍 읽기(비동기 반복자). 청크마다 열 배열 조각(count ≤ chunkPoints). 전체를 메모리에 올리지 않는다.
 * @param {AsyncIterable<Uint8Array>|Iterable<Uint8Array>} source @param {{chunkPoints?: number}} [opts]
 * @returns {AsyncGenerator<Point27Cloud | Gauss56Cloud>} */
export function readPlyStream(source, opts) { return ni('readPlyStream', 'T04.3'); }

/** T04.4 server/points/ply_robust/ — 손상·불완전 PLY 를 PointsError 로만 거부(다른 예외·무한 루프·큰 할당 0). 정상이면 readPly 결과.
 * @param {Uint8Array} bytes @returns {Point27Cloud | Gauss56Cloud} */
export function readPlySafe(bytes) { return ni('readPlySafe', 'T04.4'); }

/** T04.8 server/points/normals/ — 법선 정규화·검사. 길이 0·비유한은 안전한 대체 없이 표시(invalid 인덱스 목록), 나머지는 단위 길이로(오차 ≤ 1e-6).
 * @param {Float32Array} normals 3n @returns {{normals: Float32Array, invalid: Uint32Array}} */
export function normalizeNormals(normals) { return ni('normalizeNormals', 'T04.8'); }

/** T04.9 tools/points_stat/ — 점 수·경계 상자·밀도(점/m²)·형식.
 * @param {Point27Cloud | Gauss56Cloud} cloud @returns {{count: number, format: number, min: number[], max: number[], densityPerM2: number}} */
export function pointStats(cloud) { return ni('pointStats', 'T04.9'); }

/** T04.10 server/points/segments/ — 파일 이름 `seg<구간>_step<5자리>.ply`(예: seg0_step00250.ply) 묶음 식별. 수준은 step 250·1000·3500·7000 → 0..3. 규칙 밖 이름은 PointsError('name').
 * @param {string[]} fileNames @returns {{segmentId: number, level: 0|1|2|3, fileName: string}[]} 구간 오름차순, 같으면 수준 오름차순 */
export function identifySegments(fileNames) { return ni('identifySegments', 'T04.10'); }
