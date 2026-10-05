// 관제탑 드론·경로·탐지 마커(T15.6) 계약. 구현은 client/tower/overlay/. 서명·자료형·기준 수치만 둔다.
// 이 층은 계산만 한다: ENU 위치를 화면(CSS 픽셀) 좌표로 투영해 그리기 목록을 돌려준다. 그리기는 클라이언트 2D 오버레이가 한다.
// 좌표: GeoAnchor 기준 ENU(x=동, y=북, z=위), 1 unit = 1 m, 배정밀도로 보관한다(float32 로 줄이지 않는다).
// 카메라: contracts/statusview CameraPose {pos, quat, fovY} → View(statusview syncCamera 규칙: R = 카메라→ENU 회전의 전치, t = −R·pos, fy = (height/2)/tan(fovY/2), fx = fy, cx = width/2, cy = height/2).
// 투영: X_c = R·X_w + t, d = X_c.z, u = fx·X_c.x/d + cx, v = fy·X_c.y/d + cy.
// 원칙: 도착한 것만 그린다 — 받은 드론·경로·탐지만 그리고, 받지 못한 위치를 예측·보간·외삽으로 지어내지 않는다.
// 이 층은 네트워크·타이머를 쓰지 않는다. 한 번 호출이 한 프레임 안에서 끝나는 동기 계산이다.

/** 한도·기본값. nearM: 경로 선분을 이 깊이(m) 앞에서 자른다. */
export const TOWER_OVERLAY_LIMITS = Object.freeze({
  maxDrones: 256, maxDetections: 4096, maxPaths: 64, maxPathPoints: 100_000, nearM: 0.1, maxIdChars: 64,
});

/** 탐지 종류. 기본 'detection'. */
export const TOWER_OVERLAY_KINDS = Object.freeze(['detection', 'alert']);

/** 투영·역투영 수식(시험이 이 문자열을 읽지는 않는다. 구현 근거를 사람이 읽는 용도). */
export const TOWER_OVERLAY_FORMULA = Object.freeze({
  project: 'X_c = R·X_w + t;  d = X_c.z;  d ≤ 0 이거나 u·v·d 가 유한하지 않으면 visible=false, u=v=0;  그 밖에는 u = fx·X_c.x/d + cx, v = fy·X_c.y/d + cy, visible = 0 ≤ u < width 이고 0 ≤ v < height',
  unproject: 'X_c = d·K⁻¹[u,v,1]ᵀ;  X_w = R⁻¹(X_c − t)',
  pathClip: '선분 (A,B) 의 깊이 dA, dB 가 nearM 을 가로지르면 교점 P = A + (B−A)·(nearM−dA)/(dB−dA) 에서 자른다. nearM 앞(깊이 < nearM)인 조각은 버리고 이어진 조각마다 polyline 하나. 화면 밖 자르기는 하지 않는다(그리기가 한다)',
  enuMatch: 'unproject(project(p)) 의 각 성분이 p 와 1 cm(CONTROLVIEW_OVERLAY_MAX_ENU_ERR_M) 이내. 조건: |p| ≤ 1e4 m, 깊이 ≥ nearM',
});

/**
 * 형식 요약.
 * Drone     {id:string, enu:[e,n,u], yaw?:number}      id 는 1..maxIdChars 자, 같은 목록에서 중복 불가. yaw 는 방위(0=북, 시계 방향 +, rad)이고 그대로 돌려준다
 * Detection {id:string, enu:[e,n,u], kind?:'detection'|'alert', confidence?:number}   confidence 는 [0,1]
 * Path      {id:string, points:[[e,n,u],...]}           points 는 2개 이상
 * Size      {width:int>0, height:int>0}                 CSS 픽셀
 * 투영 결과 한 점 {id, u, v, depth, visible}, 경로 {id, polylines:[[ {u,v,depth}, ... ], ...]}
 */
export const TOWER_OVERLAY_API = Object.freeze({
  create: 'createTowerOverlay(opts?) -> TowerOverlay   opts: {nearM?}(TOWER_OVERLAY_LIMITS.nearM 기본). 형식 위반 TypeError, 알 수 없는 키·범위 위반 RangeError',
  drones: 'overlay.setDrones(list:Drone[]) -> void   목록 전체를 교체한다(누적하지 않는다). 빈 배열은 모두 지운다. 검사는 전부 끝난 뒤에만 반영한다(던지면 이전 상태 그대로)',
  detections: 'overlay.setDetections(list:Detection[]) -> void   setDrones 와 같은 규칙',
  paths: 'overlay.setPath(path:Path) -> void   같은 id 가 있으면 그 경로를 교체한다.  overlay.removePath(id) -> boolean   있었으면 true',
  clear: 'overlay.clear() -> void   드론·탐지·경로 전부 지운다',
  counts: 'overlay.counts() -> {drones, detections, paths}',
  project: 'overlay.project(pose:CameraPose, size:Size) -> {drones:[{id,u,v,depth,visible,yaw?}], detections:[{id,u,v,depth,visible,kind,confidence?}], paths:[{id,polylines}]}   입력 순서·개수를 지킨다. 결과는 새 객체다. 상태를 바꾸지 않는다',
  unproject: 'overlay.unproject(pose:CameraPose, size:Size, u:number, v:number, depth:number) -> [e,n,u]   depth 는 양의 유한 수. 결과가 넘치면 RangeError',
});

/** 모듈 파일(client/tower/overlay/). */
export const TOWER_OVERLAY_MODULES = Object.freeze({
  view: { file: 'view.mjs', fn: 'poseToView(pose:CameraPose, size) -> View   statusview syncCamera 의 view 와 같다' },
  validate: { file: 'validate.mjs', fn: 'checkDrones(list)·checkDetections(list)·checkPath(path)·checkSize(size)·checkOpts(opts) -> 정규화된 복사본   TOWER_OVERLAY_API 의 검사 규칙' },
  project: { file: 'project.mjs', fn: 'projectPoints(view, items) -> {id,u,v,depth,visible}[];  unprojectPoint(view, u, v, depth) -> [e,n,u]' },
  clip: { file: 'clip.mjs', fn: 'clipPolyline(view, points, nearM) -> polylines   TOWER_OVERLAY_FORMULA.pathClip' },
  store: { file: 'store.mjs', fn: 'createOverlayStore() -> {setDrones, setDetections, setPath, removePath, clear, counts, drones(), detections(), paths()}   상태만. 투영 없음. 이미 validate 를 거친 값을 받는다(검사 안 함). drones()·detections()·paths() 는 깊은 복사를 돌려준다(밖에서 고쳐도 상태 불변)' },
  index: { file: 'index.mjs', fn: 'createTowerOverlay(opts?) 조립' },
});

/** 시험 이름(구현 모듈별 .test.mjs 가 이 이름을 쓴다). */
export const TOWER_OVERLAY_TEST_NAMES = Object.freeze([
  'view: poseToView 는 syncCamera 의 view 와 같다',
  'validate: 형식 위반은 TypeError, 범위 위반은 RangeError, 중복 id 는 RangeError',
  'store: setDrones 는 교체이고 누적하지 않는다',
  'project: 알려진 카메라·점의 화면 좌표(숫자 박음)',
  'project: 카메라 뒤 점은 visible=false, u=v=0',
  'project: ENU 왕복 오차 ≤ 1 cm',
  'clip: 선분이 근평면을 가로지르면 교점에서 자른다',
  'clip: 전부 뒤에 있으면 polyline 이 없다',
  'index: 검사에 실패하면 이전 상태가 그대로다',
  'index: 입력 순서·개수·id 를 지킨다',
  'index: 받지 않은 위치를 지어내지 않는다(보간·외삽 없음)',
  'index: 네트워크·타이머를 쓰지 않는다',
]);
