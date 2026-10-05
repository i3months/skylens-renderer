// 관제탑 시점 이동에 따른 조각 요청(T15.7) 계약. 구현은 client/tower/streaming/. 서명·자료형·기준 수치만 둔다.
// 이 층은 계산만 한다: 카메라 시점에서 보이는 지형 타일 번호를 구해 "무엇을 요청·취소·내보낼지" 목록을 돌려준다.
// 요청을 실제로 보내는 일(네트워크)과 도착한 타일 자료를 그리는 일(terrain·drape 층)은 이 층의 몫이 아니다. 이 층은 네트워크·타이머를 쓰지 않는다.
// 좌표: GeoAnchor 기준 ENU(x=동, y=북, z=위), 1 unit = 1 m. 타일 번호는 contracts/tower_assets 의 tileOf·tileBounds(한 변 64 m)와 같다.
// 카메라: contracts/statusview CameraPose {pos, quat, fovY} 와 Size {width, height} → overlay/view.mjs poseToView 와 같은 View(X_c = R·X_w + t, OpenCV 축).
// 원칙: 도착한 것만 그린다 — 도착 전 타일은 보충하지 않는다. 이 층은 '보이는데 요청하지 않은 타일'을 0 으로 만드는 것이 목표다.
// 정의: 타일 (tx,ty) 는 ENU 직육면체 [tx·64,(tx+1)·64] × [ty·64,(ty+1)·64] × zRangeM 이 시야 사각뿔(좌우상하 4면)과 근평면(nearM)·원평면(maxDistM) 안에서 만나면 '필요(needed)' 하다. 판정은 보수적이다(과포함 허용, 누락 불허).

export const TOWER_STREAMING_LIMITS = Object.freeze({
  maxDistM: 1500, zMinM: -100, zMaxM: 600, maxInflight: 16, retainMargin: 1, maxHeld: 4096, nearM: 0.1, maxTilesPerUpdate: 4096,
});

/**
 * 형식 요약.
 * TileId {tx:int, ty:int}
 * Plan   {needed:TileId[], request:TileId[], cancel:TileId[], evict:TileId[], deferred:TileId[]}
 *   needed   : 지금 시점에서 필요한 타일(카메라 지면 투영점에서 가까운 순, 같으면 (tx,ty) 사전순).
 *   request  : needed 중 held·inflight 가 아니고 maxInflight 여유가 있어 지금 요청하라는 것(needed 순서). 이 호출이 inflight 로 올린다.
 *   deferred : needed 중 held·inflight 가 아니고 maxInflight 가 차서 이번에 요청하지 못한 것(다음 update 가 다시 요청 후보로 삼는다). 버리지 않는다.
 *   cancel   : inflight 중 retain 집합(needed 를 retainMargin 타일만큼 팽창)에 없는 것. 이 호출이 inflight 에서 뺀다.
 *   evict    : held 중 retain 집합에 없는 것. 이 호출이 held 에서 뺀다. held 가 maxHeld 를 넘으면 retain 안에서도 needed 가 아닌 것을 먼 순서로 더 뺀다(needed 는 빼지 않는다).
 */
export const TOWER_STREAMING_API = Object.freeze({
  create: 'createTowerStreaming(opts?) -> TowerStreaming   opts: {maxDistM?, zRangeM?:[min,max], maxInflight?, retainMargin?, maxHeld?, nearM?}(TOWER_STREAMING_LIMITS 기본). 형식 위반 TypeError, 알 수 없는 키·범위 위반 RangeError',
  update: 'streaming.update(pose:CameraPose, size:Size) -> Plan   시점 한 번에 상태를 갱신하고 계획을 돌려준다. 던지면 상태 불변. 한 호출의 needed 가 maxTilesPerUpdate 를 넘으면 RangeError(상태 불변)',
  arrived: 'streaming.arrived(tx,ty) -> boolean   inflight 였던 타일이면 held 로 옮기고 true. inflight 가 아니면(요청한 적 없거나 이미 취소·도착) 상태를 바꾸지 않고 false(요청하지 않은 타일을 받아들이지 않는다)',
  failed: 'streaming.failed(tx,ty) -> boolean   inflight 였던 타일을 뺀다(재시도는 다음 update 가 needed 이면 다시 요청). 아니면 false',
  missing: 'streaming.missing(pose:CameraPose, size:Size) -> TileId[]   지금 시점에서 필요하지만 held 가 아닌 타일(상태를 바꾸지 않는다). 렌더 쪽 "도착 전" 안내용',
  state: 'streaming.state() -> {held:TileId[], inflight:TileId[]}   (tx,ty) 사전순 새 배열',
  reset: 'streaming.reset() -> void   held·inflight 를 모두 비운다',
});

/** 모듈 파일(client/tower/streaming/). 각 파일의 export 이름이 기준이다. */
export const TOWER_STREAMING_MODULES = Object.freeze({
  validate: { file: 'validate.mjs', fn: 'checkOpts(opts) -> 정규화된 opts  /  checkPose·checkSize(overlay/validate.mjs 규칙과 같게) / checkTile(tx,ty)' },
  visible: { file: 'visible.mjs', fn: 'tilesInView(view, opts) -> TileId[]   view = poseToView 결과. 보수적 AABB-사각뿔 판정(누락 0)' },
  plan: { file: 'plan.mjs', fn: 'planRequests({needed, held, inflight, opts, center}) -> Plan 과 새 held·inflight 집합. 순수 함수' },
  index: { file: 'index.mjs', fn: 'createTowerStreaming(opts?) 조립' },
});

/** 완료 기준 수치(TASKS T15.7): 경로 재생 중 '요청한 적 없는 보이는 타일' 0. 도착이 즉시이면 매 시점 missing 0. */
export const TOWER_STREAMING_MAX_NEVER_REQUESTED = 0;
