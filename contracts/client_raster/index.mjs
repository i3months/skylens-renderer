// 클라이언트 경량 래스터라이저 계약(T12). WebGL 을 써서 27 B 점군을 실시간 3D 뷰로 그린다.
// 좌표·투영 규약은 contracts/raster 와 같다(그쪽이 정본).
//   X_c = R·X_w + t          세계(GeoAnchor 기준 ENU, 1 unit = 1 m) → 카메라
//   깊이 d = X_c.z            카메라는 +z 를 본다(OpenCV 규약: x 오른쪽, y 아래, z 앞)
//   [u,v,1]ᵀ ∝ K·X_c         u = fx·X_c.x/d + cx, v = fy·X_c.y/d + cy
//   해상도 스케일: K = K_ref · (resolution / resolution_ref)
// 점 조각(piece): 코덱이 Web Worker 에서 복호. 도착하지 않은 조각은 채우지 않는다(skylens 원칙).
// 프레임 루프는 조각 도착과 분리되어 있다(async uploadPiece 호출, 다음 draw 에 반영).
// 메모리: maxResidentBytes 이내로 GPU 램을 쓴다(GPU 만, 시스템 메모리 아님).

/**
 * @typedef {Object} FrameStats  프레임 렌더 통계
 * @property {number} drawnPoints 화면에 그려진 점 수
 * @property {number} drawnPieces 렌더링에 사용된 조각 수
 * @property {number} droppedFrames 건너뛴 프레임 수(메모리/성능 제약)
 * @property {number} drawMs 렌더링 소요 시간(밀리초)
 *
 * @typedef {Object} Renderer  클라이언트 경량 래스터라이저 인스턴스
 * @property {(key: string, bytes: Uint8Array) => Promise<void>} uploadPiece  조각을 비동기로 업로드(복호는 Worker 에서)
 * @property {(key: string) => void} releasePiece  조각 메모리 해제
 * @property {(view: {R: number[], t: number[], K: Object, width: number, height: number, devicePixelRatio: number}) => void} setView  카메라 뷰 설정(R: 3×3 회전 9개, t: 3-벡터, K: {fx, fy, cx, cy})
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

const ERR = 'client_raster:';

/** 27 B 점 레코드 크기(contracts/points 의 FORMAT_POINT27). */
export const POINT27_BYTES = 27;
/** 28 byte 포인트 배치(padding 포함) */
export const POINT27_PADDED_BYTES = 28;

/**
 * 함수 서명(구현은 client/* 및 Worker 스크립트).
 * 이름과 메서드 순서는 이 표가 기준이다.
 */
export const CLIENT_RASTER_API = Object.freeze({
  createRenderer: { fn: 'createRenderer(options) -> Renderer  options: {canvas, maxPieceBytes, maxResidentBytes}' },
  uploadPiece: { fn: 'renderer.uploadPiece(key, bytes) -> Promise<void>' },
  releasePiece: { fn: 'renderer.releasePiece(key) -> void' },
  setView: { fn: 'renderer.setView(view) -> void  view: {R, t, K, width, height, devicePixelRatio}' },
  draw: { fn: 'renderer.draw() -> FrameStats  {drawnPoints, drawnPieces, droppedFrames, drawMs}' },
  memoryBytes: { fn: 'renderer.memoryBytes() -> number' },
  dispose: { fn: 'renderer.dispose() -> void' },
  onContextLost: { fn: 'renderer.onContextLost(callback?) -> void' },
  onContextRestored: { fn: 'renderer.onContextRestored(callback?) -> void' },
});

/**
 * 렌더러를 만든다. 반환 객체는 Renderer 인터페이스를 따른다.
 * @param {CreateRendererOptions} options
 * @returns {Renderer}
 */
export function createRenderer(options) {
  throw new Error(`${ERR} createRenderer 는 계약서 서명만 제공; 구현은 client/* 에 있음`);
}

/** 클라이언트 래스터라이저 오류. code: 'context' | 'memory' | 'piece' | 'view'. */
export class ClientRasterError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(`client_raster: ${code}: ${message}`);
    this.name = 'ClientRasterError';
    this.code = code;
  }
}
