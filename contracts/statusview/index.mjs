// 현황판 화면 어댑터 계약(T13). 현황판(skylens statusview)이 하던 일을 경로 B 의 클라이언트 경량 래스터라이저
// (contracts/client_raster)와 선 규약(contracts/proto)·수준 기계(contracts/levels) 위에 다시 얹는 모듈의 서명을 정한다.
// 이 파일은 서명·자료형·대응표만 가진다(구현은 client/status/<모듈>/index.mjs).
//
// 원본 대조 표시: skylens 체크아웃(src/skylens_client/statusview/)은 [cloud] 에서 열 수 없다. 아래 대응표의 '원본' 열은
// SPEC §1.1 이 적은 역할(splatScene.ts 의 DropInViewer, splatReveal.ts 의 도착 기준 노출, cameraSync.ts 의 카메라 동기)에서
// 옮긴 것이고 메서드 이름·인자는 원본과 한 줄씩 대조되지 않았다. 대조는 [local](T13L)이다. 대조 전까지 '원본' 열은 추정이다.
//
// 좌표: GeoAnchor 기준 ENU(x=동, y=북, z=위), 1 unit = 1 m. skylens 씬 규약(x=동, y=위, z=−북)과의 변환은 sceneToEnu·enuToScene 한 곳에 둔다.
// 카메라: contracts/raster 규약(OpenCV: x 오른쪽, y 아래, z 앞, X_c = R·X_w + t). VIEW_UPDATE 의 quat 는 카메라→ENU 회전이다(contracts/proto).
// 원칙: 도착한 것만 그린다. 수준은 교체(누적 아님)이고 추월당한 수준은 건너뛴다. 도착 전 구간은 점 0·'없음' 표시. 메우지 않는다.

import { NONE } from '../levels/index.mjs';

/** 화면 어댑터가 받는 선 메시지 종류(contracts/proto MSG 이름). */
export const STATUS_INPUT_MESSAGES = Object.freeze(['WELCOME', 'PIECE', 'LEVEL_ARRIVED', 'MISSING', 'ERROR']);

/**
 * skylens 현황판 역할 → 어댑터 함수 대응표. 모든 항목은 한 모듈의 한 함수를 가리키고 모듈 경로·완료 기준은 TASKS T13 표와 같다.
 * source 는 skylens 쪽 파일(SPEC §1.1), origin 은 원본 대조 상태('estimated' = 대조 전 추정, T13L 에서 'verified' 로).
 */
export const STATUSVIEW_METHOD_MAP = Object.freeze([
  { role: '구간 도착 → 조각 요청', source: 'splatScene.ts (씬에 구간 추가)', module: 'arrival', fn: 'createArrivalPlanner', origin: 'estimated' },
  { role: '수준 교체(4수준·추월 건너뜀)', source: 'splatScene.ts (딜레이 패턴 수준 교체)', module: 'levels', fn: 'createStatusLevels', origin: 'estimated' },
  { role: '도착 기준 노출', source: 'splatReveal.ts', module: 'reveal', fn: 'computeReveal', origin: 'estimated' },
  { role: '카메라 동기', source: 'cameraSync.ts', module: 'camera', fn: 'syncCamera', origin: 'estimated' },
  { role: '드론·마커 덧그리기', source: 'splatScene.ts 오버레이', module: 'overlay', fn: 'projectMarkers', origin: 'estimated' },
  { role: '"없음" 안내', source: 'statusview 도착 전 구간 표시', module: 'missing_ui', fn: 'missingNotices', origin: 'estimated' },
  { role: '폴백 화면(SPEC §5 제안, 사람 확인 전 임시)', source: '(신규)', module: 'fallback', fn: 'createFallbackController', origin: 'estimated' },
  { role: '조립(어댑터 본체)', source: 'splatScene.ts 공개 메서드 전체', module: 'e2e', fn: 'createStatusView', origin: 'estimated' },
]);

/**
 * 모듈별 함수 서명. 이름·순서·반환 모양이 기준이다.
 *
 * @typedef {{segmentId:number, level:number, lod:number, chunkIndex:number, tileX:number, tileY:number}} PieceKey  contracts/proto 의 PieceKey 객체
 * @typedef {{key:string, count:number}} StatusPiece  key 는 ASSET_FORMAT §11 정규 문자열(contracts/client_raster parsePieceKey 가 받는 형식), count 는 점 수(0 이상 안전 정수)
 * @typedef {import('../levels/index.mjs').SegmentState} SegmentState
 * @typedef {{type:'PIECE_REQUEST', reqId:number, items:PieceKey[]}} PieceRequestMessage
 * @typedef {{pos:number[], quat:number[], fovY:number}} CameraPose  pos ENU m, quat 카메라→ENU(x,y,z,w, 단위), fovY 세로 시야(rad, 0<fovY<π)
 * @typedef {{width:number, height:number, devicePixelRatio:number}} ViewportSize  width·height CSS 픽셀(양의 정수), dpr 양의 유한 수
 * @typedef {{id:string, enu:number[]}} Marker  enu = [동, 북, 위] (m)
 * @typedef {{id:string, u:number, v:number, depth:number, visible:boolean}} ProjectedMarker  u,v CSS 픽셀. visible = depth>0 이고 화면 안
 */
export const STATUSVIEW_API = Object.freeze({
  // T13.1 client/status/arrival
  createArrivalPlanner: {
    fn: 'createArrivalPlanner(options?: {maxItems?: number}) -> {onSegmentArrived(segmentId: number, keys: PieceKey[]): void, drain(): PieceRequestMessage[], pendingCount(): number}',
    rule: '도착 이벤트 순서대로 요청 항목을 쌓고 drain 이 PIECE_REQUEST(reqId 는 0 부터 1 씩, 항목 ≤ min(maxItems, MAX_REQUEST_ITEMS))로 나눠 돌려준다. 같은 PieceKey 는 한 번만 요청한다. 시계·타이머 없음. 입력 검사 위반은 TypeError/RangeError, 던질 때 상태는 바뀌지 않는다.',
  },
  // T13.2 client/status/levels
  createStatusLevels: {
    fn: 'createStatusLevels() -> {arrive(segmentId, level, pieces: StatusPiece[]): ArriveResult, expect(segmentId): void, snapshots(): SegmentState[], drawKeys(): string[], renderPointCount(): number, released(): string[]}',
    rule: 'client/levels createLevelMachine 위에 얹는다. arrive 결과가 skip 이면 아무것도 바뀌지 않는다. replace 이면 낮은 수준 조각 key 는 released() 로 넘어가고(해제 근거) drawKeys 에서 사라진다. drawKeys 는 구간 번호 오름차순·조각 입력 순서. 낮은 수준 점은 교체 직후 0.',
  },
  // T13.3 client/status/reveal
  computeReveal: {
    fn: 'computeReveal(states: SegmentState[]) -> {visible: number[], hidden: number[], renderPointCount: number}',
    rule: '도착한 구간(level ≥ 0)만 visible, 도착 전은 hidden 이고 점 0. 입력을 바꾸지 않고 순서를 지킨다. renderPointCount = visible 구간 조각 count 합.',
  },
  // T13.4 client/status/camera
  syncCamera: {
    fn: 'syncCamera(pose: CameraPose, size: ViewportSize, viewSeq: number) -> {view: View, viewUpdate: {type:\'VIEW_UPDATE\', viewSeq, pos, quat, fovY, width, height}}',
    rule: 'view 는 contracts/client_raster View(R = 카메라→ENU 회전의 전치, t = −R·pos, K: fy = (height/2)/tan(fovY/2), fx = fy, cx = width/2, cy = height/2, CSS 픽셀 격자). viewUpdate 는 contracts/proto VIEW_UPDATE 와 같은 필드이고 quat 는 단위로 정규화해 넣는다. 입력 검사 위반은 TypeError/RangeError.',
  },
  sceneToEnu: { fn: 'sceneToEnu([x, y, z]) -> [x, -z, y]  skylens 씬(x=동, y=위, z=−북) → ENU(동, 북, 위)' },
  enuToScene: { fn: 'enuToScene([e, n, u]) -> [e, u, -n]' },
  // T13.5 client/status/overlay
  projectMarkers: {
    fn: 'projectMarkers(view: View, markers: Marker[]) -> ProjectedMarker[]',
    rule: '입력 순서·개수를 지킨다. contracts/raster 와 같은 투영 u = fx·X_c.x/d + cx. depth ≤ 0 이면 visible=false. unprojectToEnu 로 되돌린 값이 입력 ENU 와 1 cm 이내.',
  },
  unprojectToEnu: { fn: 'unprojectToEnu(view: View, u: number, v: number, depth: number) -> number[]  X_c = d·K⁻¹[u,v,1]ᵀ, X_w = Rᵀ(X_c − t)' },
  // T13.6 client/status/missing_ui
  missingNotices: {
    fn: 'missingNotices(states: SegmentState[]) -> {segmentId: number, text: string}[]',
    rule: '도착 전 구간만 같은 순서로, text 는 client/levels/missing MISSING_LABEL(\'없음\'). 도착한 구간은 항목이 없다.',
  },
  // T13.7 client/status/fallback
  createFallbackController: {
    fn: 'createFallbackController(options?: {helloTimeoutMs?: number}) -> {handle(event: FallbackEvent): FallbackState, state(): FallbackState}',
    rule: 'FallbackEvent = {kind: \'connected\'|\'closed\'|\'error\'|\'timeout\', code?: number}. FallbackState = {mode: \'live\'|\'fallback\', reason: null|\'closed\'|\'unavailable\'|\'timeout\', message: string|null}. 처음은 live/null. ERROR(code 5 UNAVAILABLE)·closed(정상 종료 1000 제외)·timeout 이면 fallback, connected 면 live 로 되돌아온다. 폴백에서도 도착하지 않은 것을 그리거나 채우지 않는다(상태만 돌려준다). 시계 없음(timeout 은 호출자가 알려 준다).',
  },
  // T13.8 client/status/e2e
  createStatusView: {
    fn: 'createStatusView(options: {modules?: object, countOf?: (pieceBytes: Uint8Array) => number}) -> StatusView',
    rule: 'StatusView = {handle(message): void, setCamera(pose, size): {view, viewUpdate}, setMarkers(markers): void, frame(): {view, drawKeys, releasedKeys, markers: ProjectedMarker[], notices, reveal, fallback}, requests(): PieceRequestMessage[]}. message 는 client/proto decodeMessage 의 s2c 출력. modules 로 위 일곱 모듈을 주입할 수 있고 기본은 ../<모듈>/index.mjs.',
  },
});

/** 입력 검사 보조(모듈이 같은 오류 종류를 쓰도록 계약에 둔다). */
export function assertViewport(size) {
  if (size === null || typeof size !== 'object') throw new TypeError('size 는 객체여야 한다');
  const { width, height, devicePixelRatio } = size;
  for (const [n, x] of [['width', width], ['height', height]]) {
    if (!Number.isInteger(x) || x <= 0) throw new RangeError(`${n} 는 양의 정수여야 한다: ${String(x)}`);
  }
  if (typeof devicePixelRatio !== 'number' || !Number.isFinite(devicePixelRatio) || !(devicePixelRatio > 0)) {
    throw new RangeError(`devicePixelRatio 는 양의 유한 수여야 한다: ${String(devicePixelRatio)}`);
  }
}

export const STATUS_NONE = NONE;

/** skylens 씬(x=동, y=위, z=−북) → ENU(동, 북, 위). */
export function sceneToEnu(p) {
  if (!Array.isArray(p) || p.length !== 3 || p.some((x) => typeof x !== 'number' || !Number.isFinite(x))) throw new TypeError('점은 유한 수 3개 배열이어야 한다');
  return [p[0], -p[2] === 0 ? 0 : -p[2], p[1]];
}

/** ENU(동, 북, 위) → skylens 씬. */
export function enuToScene(p) {
  if (!Array.isArray(p) || p.length !== 3 || p.some((x) => typeof x !== 'number' || !Number.isFinite(x))) throw new TypeError('점은 유한 수 3개 배열이어야 한다');
  return [p[0], p[2], -p[1] === 0 ? 0 : -p[1]];
}

/** 초기 표시 규칙 값(T13.9·T13.10 측정 문턱의 근거는 SPEC §4, 여기서는 이름만 둔다). */
export const STATUS_BANDWIDTH_LIMITS = Object.freeze({ initialBytes: 15 * 1024 * 1024, perSegmentBytes: 3 * 1024 * 1024 });
export const STATUS_QUALITY_MIN_SSIM = 0.95;
