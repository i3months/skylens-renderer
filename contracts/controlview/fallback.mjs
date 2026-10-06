// 관제탑 폴백(T15.8) 계약. 구현은 client/tower/fallback/. 서명·자료형·기준 수치만 둔다. 확정(SPEC §5, 사람 결정 2026-10-06).
// 서버 렌더가 불가할 때 3D 층 대신 2D 지도 위에 드론 위치·경로·탐지 마커만 그리기 위한 그리기 목록을 계산한다. 그리기는 클라이언트가 한다.
// 폴백은 화면 단위로 전부 또는 없음이다: 'fallback' 모드에서만 그리기 목록을 내고, 3D 층과 함께 그리지 않는다. 미도착 구역을 보충하지 않는다.
// 원칙: 받은 것만 그린다. 비어 있는 곳을 꾸며 채우지 않는다(보간·외삽·간선 추정·배경 지도 생성 없음). 지도 범위는 받은 점에서만 정한다.
// 좌표: GeoAnchor 기준 ENU(x=동, y=북), 1 unit = 1 m, 배정밀도. 지도: 북쪽이 화면 위. 네트워크·타이머를 쓰지 않는 동기 계산이다.
// 입력 형식·검사는 overlay 계약(TOWER_OVERLAY_*)과 같다(Drone·Detection·Path·Size). ENU 의 높이(u)는 지도에서 쓰지 않는다.

export const TOWER_FALLBACK_BANNER = '실시간 3D 불가';

/** 기본값·한도. minSpanM: 지도가 덮는 최소 변 길이(m). marginPx: 지도 가장자리 여백(px). maxAbsEnuM: 지도에 쓰는 |e|,|n| 상한(m).
 *  minMetersPerPx: minSpanM 과 metersPerPx 의 하한(m/px, 한 곳 정의). minSpanM·setView 의 metersPerPx 가 이보다 작으면 RangeError, 자동 맞춤의 span/avail 이 이보다 작으면 이 값으로 고정한다. maxAbsEnuM 는 setView 의 |centerE|,|centerN| 상한도 된다. */
export const TOWER_FALLBACK_LIMITS = Object.freeze({ minSpanM: 100, marginPx: 16, maxAbsEnuM: 1e6, minMetersPerPx: 1e-6 });

export const TOWER_FALLBACK_FORMULA = Object.freeze({
  fit: '받은 모든 점(드론·탐지·경로 점)의 (e,n) 경계 상자. centerE = (minE+maxE)/2, centerN = (minN+maxN)/2, span = max(maxE−minE, maxN−minN, minSpanM), m = min(max(marginPx, 1), min(width,height)/4)(여백은 최소 1px 이되 한 변의 1/4 을 넘지 않는다: 한 변 < 4px 에서는 m = min(width,height)/4 < 1. min(width,height) < 4·max(marginPx,1) 인 작은 화면에서는 avail = min/2 라 지도가 1px 로 붕괴하지 않는다. 한 변 ≥ 2px 에서 모든 점이 visible), avail = max(min(width,height) − 2·m, 1), metersPerPx = max(span/avail, minMetersPerPx)(하한 미만은 하한으로 고정하며 던지지 않는다). 받은 점이 없으면 view = null',
  toScreen: 'x = width/2 + (e − centerE)/metersPerPx;  y = height/2 − (n − centerN)/metersPerPx;  visible = 0 ≤ x < width 이고 0 ≤ y < height. 한 변 ≥ 2px 에서 자동 맞춤의 모든 점이 [m, size−m] 안에 들어간다(marginPx=0 이어도 한 변 ≥ 4px 에서는 m ≥ 1 이라 경계 x=width 에 놓이지 않음)',
  override: 'setView 로 직접 정한 view 가 있으면 맞춤 대신 그것을 쓴다(null 이면 다시 맞춤). 받은 점이 없어도 view 는 null 이 아니라 그 값이다',
});

/**
 * 형식 요약.
 * View {centerE:number, centerN:number, metersPerPx:number ≥ TOWER_FALLBACK_LIMITS.minMetersPerPx}
 * yaw(드론 마커): overlay 와 같은 방위 — ENU 기준 0 = 북(+y), 시계 방향이 +, rad. 값은 그대로 돌려준다(보정 없음).
 *   지도는 북쪽이 위이므로 yaw 방향의 화면 단위 벡터는 (sin yaw, −cos yaw)(x 오른쪽, y 아래)이다: yaw=0 위, π/2 오른쪽(동), π 아래.
 *   위쪽을 향한 아이콘을 시계 방향 양의 회전(캔버스 rotate 처럼)으로 돌리면 +yaw 를 쓴다. 반시계가 양인 회전 API 로 그릴 때만 −yaw 를 쓴다.
 * frame(size) -> {mode:'live'|'fallback', banner:null|TOWER_FALLBACK_BANNER, empty:boolean, view:null|View,
 *                 drones:[{id,x,y,visible,yaw?}], detections:[{id,x,y,visible,kind,confidence?}], paths:[{id, polyline:[{x,y},...]}]}
 * live 모드: banner=null, view=null, 세 목록 빈 배열(3D 층이 그린다). empty 는 받은 항목이 하나도 없는지.
 * fallback 모드: banner=TOWER_FALLBACK_BANNER 이고 받은 항목이 없어도 배너는 나온다(이때 view=null·세 목록 빈 배열·empty=true).
 * 경로는 받은 점 전부를 순서대로 한 polyline 으로 낸다(솎지 않고 자르지 않고 잇지 않는다). 입력 순서·개수·id 를 지킨다.
 */
export const TOWER_FALLBACK_API = Object.freeze({
  create: 'createTowerFallback(opts?) -> TowerFallback   opts: {minSpanM?, marginPx?}(TOWER_FALLBACK_LIMITS 기본). 형식 위반 TypeError, 알 수 없는 키·범위 위반(minSpanM < minMetersPerPx, marginPx < 0, 비유한) RangeError',
  availability: 'fallback.setAvailable(available:boolean) -> void   true=서버 렌더 가능(live), false=불가(fallback). 처음은 true. boolean 이 아니면 TypeError.  fallback.mode() -> "live"|"fallback"',
  data: 'fallback.setDrones(list)·setDetections(list)·setPath(path)·removePath(id)·clear()·counts() — overlay 와 같은 규칙(교체, 검사 전부 뒤 반영, 던지면 이전 상태 그대로, 경로 maxPaths). |e|,|n| > maxAbsEnuM 이면 RangeError',
  view: 'fallback.setView(view:View|null) -> void   형식 위반 TypeError, metersPerPx < minMetersPerPx(≤ 0·비유한 포함)·|centerE| 또는 |centerN| > maxAbsEnuM(비유한 포함) RangeError',
  frame: 'fallback.frame(size:Size) -> 위 형식. 결과는 새 객체이고 상태를 바꾸지 않는다. live 여도 데이터는 계속 받아 둔다(모드를 바꾸면 곧바로 낸다)',
});

export const TOWER_FALLBACK_MODULES = Object.freeze({
  validate: { file: 'validate.mjs', fn: 'checkFallbackOpts(opts)·checkView(view)·checkAvailable(v)·checkEnuRange(list|path) + overlay validate 의 checkDrones·checkDetections·checkPath·checkSize 다시 내보냄' },
  view: { file: 'view.mjs', fn: 'fitView(points:[[e,n],...], size, {minSpanM, marginPx}) -> View|null;  toScreen(view, size, e, n) -> {x, y, visible}' },
  markers: { file: 'markers.mjs', fn: 'buildMarkers(view, size, items, withKind) -> [{id,x,y,visible,yaw?|kind,confidence?}]   TOWER_FALLBACK_FORMULA.toScreen' },
  paths: { file: 'paths.mjs', fn: 'buildPaths(view, size, paths) -> [{id, polyline:[{x,y}]}]   점 전부, 순서 유지' },
  mode: { file: 'mode.mjs', fn: 'createModeState() -> {set(available), mode()}' },
  index: { file: 'index.mjs', fn: 'createTowerFallback(opts?) 조립(작업자가 이미 작성)' },
});

export const TOWER_FALLBACK_TEST_NAMES = Object.freeze([
  'validate: 형식 위반은 TypeError, 범위 위반은 RangeError',
  'view: 맞춤은 받은 모든 점을 여백 안에 넣는다(숫자 박음)',
  'view: 점이 없으면 null',
  'markers: 알려진 장면의 화면 좌표(숫자 박음)',
  'paths: 점 전부 순서 유지',
  'mode: 처음은 live, 불 아닌 값은 TypeError',
  'index: 서버 불가 모의 시 배너와 지도 목록을 낸다',
  'index: 받지 않은 위치를 지어내지 않는다(보간·외삽 없음)',
  'index: 검사에 실패하면 이전 상태가 그대로다',
  'index: 네트워크·타이머를 쓰지 않는다',
]);
