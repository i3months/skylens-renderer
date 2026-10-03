// 압축 codec 계약(T09.0). 명세 단일 출처는 format/ASSET_FORMAT.md 의 codec 값 정의(이 파일의 상수·표와 같은 커밋에서 맞춘다).
// 하위 작업은 자기 소유 경로에 같은 이름·서명으로 구현하고 이 파일은 고치지 않는다(바꿔야 하면 작업자에게 보고).
//
// 전제: 위치·색·법선의 양자화 식은 ASSET_FORMAT §5 가 이미 정했다(u16 위치, u8 색, snorm8 팔면체 법선).
// codec 1 은 그 양자화 값을 바꾸지 않고 (1) 점 순서를 모턴 순으로 재배치하고 (2) 필드별 스트림으로 차분·가변길이 부호화하고
// (3) 스트림마다 엔트로피 부호화한다. 따라서 §8 오차 상한(위치 2^-(quant_exp+1) m ≤ 1.953125 mm < 1 cm, 법선 1.0°)이 그대로 성립한다.
// 색은 선택적으로 손실 모드(mode 1)를 쓴다: 평균 오차 ≤ 2/255.

/** 이 계약이 정의하는 codec 값. 0 은 CODEC_RAW_PLANAR(contracts/asset). */
export const CODEC_SKLC1 = 1;
/** codec 1 이 받는 입력 형식: 27 B 점(format 1)만. format 2 는 codec 1 로 쓰면 거부(CodecError code 'format'). */
export const CODEC1_FORMATS = Object.freeze([1]);

/** 모턴 키 비트 수: 3 축 × 16 비트 = 48 비트(Number 로 정확히 표현). 비트 i 번 = e 의 i 번 비트 → 키 비트 3i, n → 3i+1, u → 3i+2. */
export const MORTON_BITS = 48;

/** 색 스트림 모드. 첫 바이트가 모드다. */
export const COLOR_MODE = Object.freeze({
  /** 무손실. 점 순서대로 채널 평면 r,g,b 각각 이전 점과의 차분(mod 256) → 바이트 평면 */
  DELTA: 0,
  /** 손실. 각 채널 하위 2 비트를 버리고 가운데 값(복원 = (v>>2<<2)+2 로 최대 254, 255는 254로)으로 복원, 이후 DELTA 와 같음. 평균 절대 오차 ≤ 2/255 */
  QUANT2: 1,
  /** 팔레트. 서로 다른 색 ≤ 256 개일 때만. [u8 k-1][k×rgb][점당 u8 인덱스(첫 등장 순서로 번호)]. 무손실 */
  PALETTE: 2,
});
/** QUANT2 의 평균 절대 오차 상한(채널당, u8 단위). SPEC T09.3 '평균 오차 ≤ 2/255'. */
export const COLOR_QUANT2_MEAN_ERR_MAX = 2;

/**
 * 압축 본문(codec 1) 배치. 헤더는 ASSET_FORMAT §3 그대로(codec = 1, body_bytes = 아래 본문 전체 길이, 체크섬은 파일 전체).
 * 본문:
 *   [u8 version = 1][u8 color_mode][u16 0]                      4 B
 *   [u32 posLen][u32 nrmLen][u32 colLen]                          12 B  (각 스트림의 부호화 후 바이트 수, little-endian)
 *   [pos 스트림 posLen B][normal 스트림 nrmLen B][color 스트림 colLen B]
 * 합 = 16 + posLen + nrmLen + colLen 이어야 하고 다르면 거부. 점 수는 헤더 point_count.
 * 각 스트림 = entropyEncode(원스트림 바이트). 원스트림:
 *   pos    : 모턴 키(MORTON_BITS) 오름차순으로 정렬한 점들의 키 차분 d_k = key_k − key_{k−1}(key_{−1} = 0) 을 LEB128 가변길이(7 비트씩, 하위부터, 최상위 비트 = 이어짐)로 이어 붙인 것
 *   normal : 같은 점 순서의 oct_x, oct_y 를 이전 점과의 차분(−254..254)을 지그재그(z = d ≥ 0 ? 2d : −2d−1)로 u16 → 평면 둘(x 평면 전부, y 평면 전부), 각 평면은 지그재그 값의 LEB128
 *   color  : COLOR_MODE 참조(모드별 원스트림)
 * 점 순서: 모턴 키 오름차순, 키가 같으면 원래 인덱스 오름차순(결정적, 명세 §12). 부호화는 이 순서를 본문 순서로 한다(원래 순서 복원 정보는 담지 않는다 — 점은 집합이다).
 */
export const BODY_FIXED_BYTES = 16;
export const BODY_VERSION = 1;

/** entropy 컨테이너: [u8 mode][LEB128 rawLen][payload]. mode 0 = 저장(payload = 원바이트, 길이 rawLen), mode 1 = 적응형 이진 범위 부호화(아래). 부호화가 원본보다 커지면 mode 0 을 쓴다.
 *
 * 복호 엄격 규칙(서버·클라이언트 모두):
 *   rawLen 최소 표현: LEB128은 비최소 표현 금지(예: 0x80 0x00은 거부, 0x00만 사용).
 *   LEB128 상한: 7 바이트(49 비트)를 초과하면 거부.
 *   mode 0 (STORED): payloadLen === rawLen, 아니면 거부.
 *   mode 1 (RANGE):
 *     - rawLen === 0 또는 payloadLen > rawLen 이면 거부.
 *     - payloadLen < 5 이면 거부(최소 헤더).
 *     - payload[0] !== 0 이면 거부(첫 바이트 반드시 0).
 *     - 복호 후 code !== 0 이면 거부(끝 상태 검증).
 *     - 복호 후 읽은 위치 !== payloadLen 이면 거부(payload 정확 소비).
 *     - 조기 거부: rawLen > 64 × payloadLen + 64 이면 'stream' 거부(payload 모자람 보장).
 *
 * 오류 코드 표(CodecError.code):
 *   'stream': rawLen 최소 표현 위반, LEB128 잘림, mode 0·1 payload 검증 실패, mode 1 code ≠ 0, 범위 복호 실패.
 *   'mode': mode가 0·1이 아님.
 *   'limit': rawLen > maxRawBytes(기본 STREAM_RAW_BYTES_MAX) 또는 LEB128 상한 초과.
 *   'range': 입력 형식 오류(Uint8Array 아님, maxRawBytes가 음이 아닌 정수가 아님).
 *
 * 검증 순서(서버·클라이언트 모두):
 *   ① rawLen 범위 확인(limit) — rawLen > maxRawBytes 면 거부
 *   ② mode 1 정규성(stream) — rawLen === 0 또는 payloadLen > rawLen 이면 거부
 *   ③ 조기 거부(stream) — rawLen > 64·payloadLen + 64 이면 거부
 *   ④ 실제 복호
 */
export const ENTROPY_MODE = Object.freeze({ STORED: 0, RANGE: 1 });
/**
 * mode 1 알고리즘(LZMA 방식 공개 알고리즘): 32 비트 low(64 비트 누적)·range, 확률 11 비트(초기 1024), 적응 이동 5,
 * 바이트마다 8 비트 이진 트리(문맥 = 이전 바이트 없이 트리 노드 1..255), 정규화 range < 2^24, 첫 출력 바이트 0(캐시 초기).
 * 복호기는 payload 를 다 쓰지 못하거나 모자라면 거부한다. 구현은 서버(T09.5)와 클라이언트(T09.6)가 따로 한다.
 */
export const RANGE_PROB_BITS = 11;
export const RANGE_MOVE_BITS = 5;

/** 복호 방어 상한: 한 조각 점 수, 스트림 원바이트 상한(손상 입력이 큰 할당을 못 하게). */
export const POINT_COUNT_MAX = 1 << 22;
export const STREAM_RAW_BYTES_MAX = 16 * POINT_COUNT_MAX;

/** codec 오류. code: 'format' | 'length' | 'stream' | 'range' | 'mode' | 'checksum' | 'limit'. */
export class CodecError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(`codec: ${message}`);
    this.name = 'CodecError';
    this.code = code;
  }
}

/** 하위 작업 → 모듈·함수. 서명은 각 항목 JSDoc(아래 stubs 주석) 참조. */
export const CODEC_API = Object.freeze({
  'T09.1': { module: 'server/codec/position/', fns: ['encodePositionStream', 'decodePositionStream', 'positionErrorBoundM'] },
  'T09.2': { module: 'server/codec/normal/', fns: ['encodeNormalStream', 'decodeNormalStream', 'normalAngleErrorDeg'] },
  'T09.3': { module: 'server/codec/color/', fns: ['encodeColorStream', 'decodeColorStream'] },
  'T09.4': { module: 'server/codec/order/', fns: ['mortonKey', 'mortonOrder'] },
  'T09.5': { module: 'server/codec/entropy/', fns: ['entropyEncode', 'entropyDecode'] },
  'T09.6': { module: 'client/codec/', fns: ['decodeChunkClient'] },
  'T09.7': { module: 'bench/codec/', fns: [] },
  'T09.8': { module: 'server/codec/robust/', fns: [] },
  'T09.9': { module: 'bench/codec_client/', fns: [] },
  'T09.10': { module: 'server/codec/quality/', fns: [] },
  'T09.11': { module: 'server/codec/chunk/', fns: ['encodeChunk', 'decodeChunk'] },
});

/*
 * 함수 서명(구현은 각 모듈, 모두 순수 함수, 입력을 바꾸지 않는다, 잘못된 입력은 CodecError):
 *
 * T09.1 server/codec/position/
 *   encodePositionStream(qe: Uint16Array, qn: Uint16Array, qu: Uint16Array) -> Uint8Array
 *       이미 모턴 순서로 정렬된 양자화 위치(길이 같음) → pos 원스트림(키 차분 LEB128). 정렬이 아니면 CodecError('stream').
 *   decodePositionStream(bytes: Uint8Array, n: number) -> {qe, qn, qu: Uint16Array}
 *       정확히 n 점, 바이트를 남기거나 모자라면 CodecError('stream'), 키가 2^48 이상이면 CodecError('range').
 *   positionErrorBoundM(quantExp: number) -> number    = 2^-(quantExp+1) (명세 §8). 양자화 오차는 원 값 대비 ≤ 이 값.
 * T09.2 server/codec/normal/
 *   encodeNormalStream(octX: Int8Array, octY: Int8Array) -> Uint8Array     같은 점 순서. 값은 −127..127.
 *   decodeNormalStream(bytes: Uint8Array, n: number) -> {octX: Int8Array, octY: Int8Array}   −127..127 밖이면 CodecError('range').
 *   normalAngleErrorDeg(nx,ny,nz) -> number   원 법선을 oct 로 부호화·복호화했을 때의 각 오차(도). 상한 1.0°.
 * T09.3 server/codec/color/
 *   encodeColorStream(r: Uint8Array, g: Uint8Array, b: Uint8Array, opts?: {lossy?: boolean}) -> Uint8Array
 *       opts.lossy 가 참이면 QUANT2, 아니면 서로 다른 색 ≤ 256 이면 PALETTE, 아니면 DELTA. 첫 바이트 = 모드.
 *   decodeColorStream(bytes: Uint8Array, n: number) -> {r, g, b: Uint8Array, mode: number}
 * T09.4 server/codec/order/
 *   mortonKey(qe: number, qn: number, qu: number) -> number     0 ≤ 결과 < 2^48
 *   mortonOrder(qe: Uint16Array, qn: Uint16Array, qu: Uint16Array) -> Uint32Array   정렬 순열(키 오름차순, 같으면 인덱스 오름차순)
 * T09.5 server/codec/entropy/
 *   entropyEncode(raw: Uint8Array) -> Uint8Array     ENTROPY 컨테이너. 결정적.
 *   entropyDecode(bytes: Uint8Array, maxRawBytes?: number) -> Uint8Array   rawLen > maxRawBytes(기본 STREAM_RAW_BYTES_MAX) 면 CodecError('limit')
 * T09.6 client/codec/
 *   decodeChunkClient(fileBytes: Uint8Array) -> {header: AssetHeader, planes: {pos_e, pos_n, pos_u: Uint16Array, color_r, color_g, color_b: Uint8Array, normal_oct_x, normal_oct_y: Int8Array}, colorMode?: number}
 *       codec 1 파일 전체(헤더+본문) → client/asset readPlanesClient 와 같은 평면(모턴 순서). codec 0 이면 readPlanesClient 에 위임.
 *       체크섬·길이·모드 검사, 실패는 CodecError 또는 AssetFormatError 만(그 밖 예외·무한 루프 0). 서버 코드를 import 하지 않는다.
 *       codec 1 결과에 colorMode 필드 포함(COLOR_MODE 상수, 손실 모드 표시용). codec 0 은 colorMode 필드 없음(무손실 암시).
 * T09.11 server/codec/chunk/
 *   encodeChunk(rawFileBytes: Uint8Array, opts?: {lossyColor?: boolean}) -> Uint8Array   codec 0 형식 1 파일 → codec 1 파일(헤더 codec = 1, 체크섬 재계산)
 *   decodeChunk(fileBytes: Uint8Array) -> Uint8Array   codec 1 파일 → 같은 점 집합의 codec 0 파일(점 순서는 모턴 순, 무손실 색이면 같은 양자화 값)
 *       decodeChunkInfo(fileBytes: Uint8Array) -> {file: Uint8Array, colorMode: number}   codec 1 파일 전체 검증 후 codec 0 파일과 색 모드(손실 여부) 추출
 */

/** 점 집합 동일성 비교용: 양자화 값 (qe,qn,qu,r,g,b,nx,ny) 튜플의 정렬된 다중집합. 순서 재배치 후 왕복 시험이 쓴다. */
export function pointMultiset(planes) {
  const n = planes.pos_e.length;
  const rows = new Array(n);
  for (let i = 0; i < n; i++) {
    rows[i] = [planes.pos_e[i], planes.pos_n[i], planes.pos_u[i], planes.color_r[i], planes.color_g[i], planes.color_b[i],
      planes.normal_oct_x[i], planes.normal_oct_y[i]].join(',');
  }
  rows.sort();
  return rows;
}

/**
 * 스트림별 원바이트(entropy rawLen) 허용 범위 [최소, 최대]. 서버·클라이언트가 같은 표를 쓴다(F-169).
 * 범위 밖이면 CodecError('limit'). n = 헤더 point_count.
 * @param {number} n
 * @returns {{pos: [number, number], normal: [number, number], color: [number, number]}}
 */
export function streamRawBounds(n) {
  return { pos: [n, 7 * n], normal: [2 * n, 6 * n], color: [Math.min(n + 5, 3 * n + 1), 3 * n + 770] };
}
