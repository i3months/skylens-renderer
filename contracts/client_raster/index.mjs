// 클라이언트 경량 래스터라이저 계약(T12). WebGL2 로 .skla 조각을 실시간 3D 뷰로 그린다.
//
// ① 입력과 형식(SPEC §8 결정 0012: 27 B 점 경로와 56 B 가우시안 스플랫 경로를 둘 다 가진다)
//   uploadPiece 의 bytes 는 PIECE 메시지 본문의 조각 바이트(contracts/proto PIECE) 그대로, 곧 contracts/asset 의 .skla 조각
//   한 개(헤더 + 본문, codec 0 또는 1)다. 원본 PLY 레코드(27 B·56 B)가 아니다. 복호는 Web Worker 에서
//   client/codec decodeChunkClient 로 하고, 헤더의 format 필드로 경로를 고른다.
//     FORMAT_POINT27(1) → 점 경로      평면: 위치·색·법선(format/ASSET_FORMAT §4.2)
//     FORMAT_GAUSS56(2) → 가우시안 경로 평면: 위치·색·불투명도·크기·회전
//   RECORD_BYTES(27·56)는 원본 레코드 크기로 형식 이름의 근거일 뿐이고 GPU 배치 크기가 아니다. GPU 배치(정점 속성 보폭·패딩)는
//   구현 몫이며 계약으로 고정하지 않는다(memoryBytes 가 실제 사용량을 센다). 그래서 예전 28 B 패딩 상수는 근거
//   (renderer_basis §7-4·contracts/points·ASSET_FORMAT 어디에도 없음)가 없어 지웠다.
//   법선(형식 1 만): 위치와 같은 ENU 축의 세계 좌표 벡터다. 정합 단계에서 카메라 법선 n 을 Rᵀn 으로 올린 값
//     (renderer_basis §7-1)이고 팔면체 사상 snorm8 로 저장된다(ASSET_FORMAT §5.3). 길이 1 이 보장되지 않으므로 셰이더가
//     정규화한다. 셰이딩(T12.2)은 contracts/raster shade 의 lambert(normalWorld, lightDirWorld, rgb) 와 같은 식이고
//     빛 방향도 세계 좌표다. 형식 2 에는 법선이 없어 셰이딩하지 않는다.
//   색: 점마다 rgb u8 세 개(0..255, 영상 RGB 값).
//     형식 1 은 원본 r g b(codec 1 QUANT2 는 채널당 ±2 손실), 형식 2 는 c = clamp(round((0.5 + C0·f_dc)·255))(ASSET_FORMAT §5.2).
//
// ② 좌표·투영 규약은 contracts/raster 와 같다(그쪽이 정본이고 아래는 그 내용을 옮겨 적은 것이다).
//   X_c = R·X_w + t          세계(GeoAnchor 기준 ENU, 1 unit = 1 m) → 카메라
//   깊이 d = X_c.z            카메라는 +z 를 본다(OpenCV 규약: x 오른쪽, y 아래, z 앞)
//   [u,v,1]ᵀ ∝ K·X_c         u = fx·X_c.x/d + cx, v = fy·X_c.y/d + cy
//   픽셀 (i,j) 는 [i,i+1)×[j,j+1) 칸이고 정수 좌표 (i,j) 는 칸의 왼쪽 위 모서리다(u=i+0.5 가 중심).
//   해상도 변환은 축마다 따로 한다(scaleIntrinsics): fx·cx 에 sx, fy·cy 에 sy. 주점은 cx' = cx·sx
//   (server/raster_ref/intrinsics 의 'basis' 규약, 위 픽셀 규약과 맞는 식).
//   단위: setView 의 width·height 는 CSS 픽셀(캔버스 clientWidth·clientHeight)이고 view.K 도 그 CSS 픽셀 격자
//   (width×height)에 대한 값이다. devicePixelRatio 는 렌더러 안에서 한 곳, scaleIntrinsics 에서만 적용한다:
//   그리기 버퍼 = drawingBufferSize(width, height, dpr) = round(width·dpr) × round(height·dpr) 장치 픽셀,
//   셰이더가 쓰는 K = scaleIntrinsics(view.K, width, height, width, height, dpr)(장치 픽셀).
//   다른 해상도(예: 원본 사진 2048×1152)에서 보정된 K_ref 는 호출자가 scaleIntrinsics(K_ref, refW, refH, width, height, 1)
//   로 CSS 픽셀 K 로 바꿔 넘긴다. 두 번 나눠 해도 한 번에 한 결과와 같다(배율의 곱).
//   버퍼 크기를 반올림하므로 같은 점의 CSS 위치는 dpr 에 따라 최대 0.5 장치 픽셀까지 다를 수 있다(화면 안 점, |u/W| ≤ 1).
//
// ③ 조각 키(key): format/ASSET_FORMAT §11 의 정규 문자열 `${segmentId}.${level}.${tileX}.${tileY}.${lod}.${chunkIndex}`
//   (server/asset/ids encodeChunkKey 의 출력, 예: '7.2.1.-2.0.0'). 클라이언트는 PIECE 의 PieceKey 객체를 이 형식으로 바꿔
//   넘긴다. contracts/proto pieceKeyString 의 `a:b:…`(순서도 다름)은 서버 내부 중복 검사용이라 여기서 쓰지 않는다.
//
// 도착하지 않은 조각은 채우지 않는다(skylens 원칙). 프레임 루프는 조각 도착과 분리되어 있다(async uploadPiece, 다음 draw 에 반영).
// 메모리: maxResidentBytes 이내로 GPU 램을 쓴다(GPU 만, 시스템 메모리 아님).

/**
 * @typedef {Object} Intrinsics  contracts/raster 의 Intrinsics 와 같다(fx, fy > 0, 픽셀 단위)
 * @property {number} fx
 * @property {number} fy
 * @property {number} cx
 * @property {number} cy
 *
 * @typedef {Object} FrameStats  프레임 렌더 통계
 * @property {number} drawnPoints 화면에 그려진 점 수
 * @property {number} drawnPieces 렌더링에 사용된 조각 수
 * @property {number} droppedFrames 건너뛴 프레임 수(메모리/성능 제약)
 * @property {number} drawMs 렌더링 소요 시간(밀리초)
 *
 * @typedef {Object} View  카메라 뷰
 * @property {number[]} R  3×3 회전, 행 우선 9개(세계→카메라)
 * @property {number[]} t  3-벡터(m)
 * @property {Intrinsics} K  width×height CSS 픽셀 격자에 대한 내부 파라미터
 * @property {number} width   CSS 픽셀(양의 정수)
 * @property {number} height  CSS 픽셀(양의 정수)
 * @property {number} devicePixelRatio  장치 픽셀 / CSS 픽셀(양의 유한 수). scaleIntrinsics 에서만 적용한다
 *
 * @typedef {Object} Renderer  클라이언트 경량 래스터라이저 인스턴스
 * @property {(key: string, bytes: Uint8Array) => Promise<void>} uploadPiece  .skla 조각을 비동기로 업로드(복호는 Worker 에서). key 는 ASSET_FORMAT §11 정규 문자열
 * @property {(key: string) => void} releasePiece  조각 메모리 해제
 * @property {(view: View) => void} setView  카메라 뷰 설정
 * @property {() => FrameStats} draw  프레임 렌더링 및 통계 반환
 * @property {() => number} memoryBytes  현재 GPU 메모리 사용량(바이트)
 * @property {() => void} dispose  리소스 정리
 * @property {(callback?: () => void) => void} onContextLost  WebGL 컨텍스트 손실 핸들러
 * @property {(callback?: () => void) => void} onContextRestored  WebGL 컨텍스트 복구 핸들러
 *
 * @typedef {Object} CreateRendererOptions
 * @property {HTMLCanvasElement} canvas  렌더 타겟
 * @property {number} maxPieceBytes  한 조각 최대 크기(바이트, 복호 후)
 * @property {number} maxResidentBytes  GPU 상주 메모리 상한(바이트)
 */

/** 클라이언트 래스터라이저 오류. code: 'context' | 'memory' | 'piece' | 'view' | 'unimplemented'. */
export class ClientRasterError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(`client_raster: ${code}: ${message}`);
    this.name = 'ClientRasterError';
    this.code = code;
  }
}

/** 형식 표시. contracts/asset·contracts/points 의 같은 이름 상수와 같은 값이다(시험으로 대조). */
export const FORMAT_POINT27 = 1;
export const FORMAT_GAUSS56 = 2;
/** 원본 레코드 크기(contracts/asset SOURCE_RECORD_BYTES·contracts/points RECORD_BYTES 와 같다). GPU 배치 크기가 아니다. */
export const RECORD_BYTES = Object.freeze({ [FORMAT_POINT27]: 27, [FORMAT_GAUSS56]: 56 });

/**
 * uploadPiece·releasePiece 의 key 형식(ASSET_FORMAT §11 정규 문자열의 모양). 범위(segmentId < 2^30, tile i32,
 * chunkIndex < 65536)까지의 엄격 검사는 server/asset/ids decodeChunkKey 의 몫이다.
 */
export const PIECE_KEY_PATTERN = /^(0|[1-9][0-9]*)\.[0-3]\.(0|-?[1-9][0-9]*)\.(0|-?[1-9][0-9]*)\.[0-7]\.(0|[1-9][0-9]*)$/;

/**
 * 함수 서명(구현은 client/* 및 Worker 스크립트).
 * 이름과 메서드 순서는 이 표가 기준이다.
 */
export const CLIENT_RASTER_API = Object.freeze({
  createRenderer: { fn: 'createRenderer(options) -> Renderer  options: {canvas, maxPieceBytes, maxResidentBytes}' },
  uploadPiece: { fn: 'renderer.uploadPiece(key, bytes) -> Promise<void>  key: ASSET_FORMAT §11 "seg.level.tileX.tileY.lod.chunk", bytes: .skla piece (format 1|2)' },
  releasePiece: { fn: 'renderer.releasePiece(key) -> void' },
  setView: { fn: 'renderer.setView(view) -> void  view: {R, t, K, width, height, devicePixelRatio}  K·width·height in CSS px' },
  draw: { fn: 'renderer.draw() -> FrameStats  {drawnPoints, drawnPieces, droppedFrames, drawMs}' },
  memoryBytes: { fn: 'renderer.memoryBytes() -> number' },
  dispose: { fn: 'renderer.dispose() -> void' },
  onContextLost: { fn: 'renderer.onContextLost(callback?) -> void' },
  onContextRestored: { fn: 'renderer.onContextRestored(callback?) -> void' },
  drawingBufferSize: { fn: 'drawingBufferSize(width, height, dpr) -> {width, height}  = round(width·dpr), round(height·dpr)' },
  scaleIntrinsics: { fn: 'scaleIntrinsics(K, refW, refH, W, H, dpr) -> Intrinsics  sx = round(W·dpr)/refW, sy = round(H·dpr)/refH' },
});

function posFinite(n, x) {
  if (typeof x !== 'number' || !Number.isFinite(x) || !(x > 0)) throw new ClientRasterError('view', `${n} 는 양의 유한 수여야 함: ${String(x)}`);
}

function posInt(n, x) {
  if (!Number.isInteger(x) || x <= 0) throw new ClientRasterError('view', `${n} 는 양의 정수여야 함: ${String(x)}`);
}

/**
 * CSS 픽셀 크기와 dpr 로 그리기 버퍼(장치 픽셀) 크기를 정한다. 반올림 결과가 0 이면 거부한다.
 * @param {number} width CSS 픽셀(양의 정수)
 * @param {number} height CSS 픽셀(양의 정수)
 * @param {number} dpr devicePixelRatio(양의 유한 수)
 * @returns {{width: number, height: number}}
 */
export function drawingBufferSize(width, height, dpr) {
  posInt('width', width);
  posInt('height', height);
  posFinite('devicePixelRatio', dpr);
  const out = { width: Math.round(width * dpr), height: Math.round(height * dpr) };
  if (out.width <= 0 || out.height <= 0) throw new ClientRasterError('view', `그리기 버퍼 크기가 0: ${out.width}×${out.height}`);
  return out;
}

/**
 * 내부 파라미터를 refW×refH 격자에서 그리기 버퍼(round(W·dpr)×round(H·dpr) 장치 픽셀) 격자로 옮긴다. 순수 함수.
 * fx·cx 에 sx = round(W·dpr)/refW, fy·cy 에 sy = round(H·dpr)/refH 를 따로 곱한다(cx' = cx·sx, 정수 좌표 = 칸 모서리 규약).
 * dpr = 1 이면 결과는 W×H CSS 픽셀 격자의 K 다.
 * @param {Intrinsics} K refW×refH 격자의 K
 * @param {number} refW
 * @param {number} refH
 * @param {number} W CSS 픽셀
 * @param {number} H CSS 픽셀
 * @param {number} dpr
 * @returns {Intrinsics} 장치 픽셀 K
 */
export function scaleIntrinsics(K, refW, refH, W, H, dpr) {
  if (!K || typeof K !== 'object') throw new ClientRasterError('view', 'K 가 객체가 아님');
  posFinite('K.fx', K.fx);
  posFinite('K.fy', K.fy);
  for (const n of ['cx', 'cy']) {
    if (typeof K[n] !== 'number' || !Number.isFinite(K[n])) throw new ClientRasterError('view', `K.${n} 는 유한 수여야 함: ${String(K[n])}`);
  }
  posFinite('refW', refW);
  posFinite('refH', refH);
  const buf = drawingBufferSize(W, H, dpr);
  const sx = buf.width / refW;
  const sy = buf.height / refH;
  const out = { fx: K.fx * sx, fy: K.fy * sy, cx: K.cx * sx, cy: K.cy * sy };
  for (const n of ['fx', 'fy']) if (!(out[n] > 0) || !Number.isFinite(out[n])) throw new ClientRasterError('view', `배율 결과 ${n} 가 양의 유한 수가 아님: ${out[n]}`);
  for (const n of ['cx', 'cy']) if (!Number.isFinite(out[n])) throw new ClientRasterError('view', `배율 결과 ${n} 가 유한하지 않음: ${out[n]}`);
  return out;
}

/**
 * 렌더러를 만든다. 반환 객체는 Renderer 인터페이스를 따른다.
 * @param {CreateRendererOptions} options
 * @returns {Renderer}
 */
export function createRenderer(options) {
  throw new ClientRasterError('unimplemented', 'createRenderer 는 계약서 서명만 제공; 구현은 client/* 에 있음');
}
