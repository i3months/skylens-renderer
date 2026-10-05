// 관제탑 건물 그리기(T15.3) 계약. 구현은 client/tower/buildings/. 서명·자료형·기준 수치만 둔다.
// 좌표: GeoAnchor 기준 ENU(x=동, y=북, z=위), 1 unit = 1 m. 카메라: contracts/raster 규약(X_c = R·X_w + t, OpenCV 축).
// 표시 옵션 3종(contracts/tower_assets DISPLAY_MODES): points(건물 표면 표본점) / black(검정 면 + 모서리 선, 기본) / aerial(지붕에 항공영상, 벽·바닥은 검정).
// 핵심 규칙(완료 기준): 옵션 전환은 로컬 상태 바꾸기만 한다. accept 한 번에 세 옵션의 자료가 모두 들어오므로 전환 때 네트워크 요청이 0 이다.
// 원칙: 도착한 건물 묶음만 그린다(없는 곳은 빈 화소, 메우지 않는다). 수준은 교체(누적 아님)이고 추월당한 수준은 건너뛴다(contracts/levels decideArrival).
// 클라이언트 코드는 contracts/ 만 가져온다(server/ 를 가져오지 않는다). 시험은 server/ 를 참조 구현으로 써도 된다.

/**
 * 건물 묶음 한 개(server buildBuildingLod 출력 + black·aerial_uv·points 가공 결과).
 * @typedef {{ ids:number[], mesh:{positions:Float32Array, indices:Uint32Array}, edgeLines:Float32Array, uv:Float32Array, wallMask:Uint8Array, points:Float32Array }} BuildingGroup
 *   mesh = 삼각형(반시계, 위에서 볼 때), edgeLines = xyz 쌍 연속(선분당 6 float), uv·wallMask = 정점당 2·1(wallMask 1 이면 검정), points = xyz 연속 표본.
 * @typedef {{ width:number, height:number, rgb:Uint8Array }} AerialImage  항공영상(행 0 = 북). uv (0,0) = 영상 왼쪽 위(북서), (1,1) = 오른쪽 아래(남동), v = 0 이 북쪽이고 남쪽으로 증가(server aerial_uv 와 같은 규약, 표본 row = v·height − 0.5).
 * @typedef {{ groups:BuildingGroup[], image:AerialImage|null }} BuildingBundle  image 가 null 이면 aerial 은 전부 검정 면(영상이 없는 것을 메우지 않음).
 */

/** 건물 층 서명(구현 위치와 함수 이름이 기준). */
export const BUILDINGS_LAYER_API = Object.freeze({
  create: 'createBuildingsLayer(opts?) -> BuildingsLayer   opts: { mode?: "points"|"black"|"aerial"(기본 black), lightDirEnu?:[x,y,z], lineRgb?:[r,g,b], pointRgb?:[r,g,b] }',
  accept: 'layer.accept(level:0..3, bundle:BuildingBundle) -> "first"|"replace"|"skip"   skip 이면 상태를 바꾸지 않는다. 잘못된 묶음이면 던지고 상태는 그대로. 한 수준 = 전체 묶음 단위',
  setMode: 'layer.setMode(mode) -> void   DISPLAY_MODES 가 아니면 RangeError(상태 그대로). 네트워크·accept 없이 로컬로 바꾼다',
  mode: 'layer.mode() -> "points"|"black"|"aerial"',
  render: 'layer.render(camera) -> RenderResult(contracts/raster)   현재 옵션 한 가지만 그린다. depth = 카메라 z(m) 또는 0, index = 그 화소를 차지한 묶음 번호(accept 한 묶음 목록 순서) 또는 −1. points 는 점 하나 = 한 화소(깊이 시험)',
  state: 'layer.state() -> { level:-1|0..3, groupCount:number, buildingCount:number, mode:string }   level −1 = 아직 아무것도 도착하지 않음(render 는 전부 빈 화소)',
});

/** 모듈 파일(client/tower/buildings/). 각 파일의 export 이름이 기준이다. */
export const BUILDINGS_MODULES = Object.freeze({
  validate: { file: 'validate.mjs', fn: 'validateBundle(bundle) -> void  묶음 검증(길이·유한·인덱스 범위·uv 0..1·wallMask 0|1·edgeLines 6 의 배수·points 3 의 배수). 위반이면 던진다(강제 변환 없음)' },
  levels: { file: 'levels.mjs', fn: 'createBuildingsState() -> { accept(level, bundle) -> action, peek(level) -> action, level(), bundle() }  decideArrival 로 교체·건너뛰기' },
  raster_flat: { file: 'raster_flat.mjs', fn: 'rasterizeFlat(camera, groups, shadeFn, out) -> void  z-버퍼 삼각형 래스터(근평면 z>0.01 m 클리핑, 화소 중심 표본, 원근 보정 깊이). shadeFn(groupIndex, triIndex) -> [r,g,b]. out.index = 묶음 번호' },
  raster_tex: { file: 'raster_tex.mjs', fn: 'rasterizeTextured(camera, groups, image, out) -> void  uv 를 원근 보정 보간해 image 이중선형 표본. wallMask=1 이거나 image 가 null 이면 검정(0,0,0 이 아니라 black 옵션의 면 색 BUILDINGS_DEFAULTS.faceRgb)' },
  lines: { file: 'lines.mjs', fn: 'rasterizeLines(camera, groups, rgb, out, opts?) -> void  edgeLines 선분을 근평면에서 잘라 화소로 그린다. 깊이 시험은 opts.depthBias(m, 기본 BUILDINGS_DEFAULTS.lineDepthBiasM)만큼 앞으로 당긴다. out 의 깊이를 갱신한다' },
  points: { file: 'points.mjs', fn: 'rasterizePoints(camera, groups, rgb, out) -> void  표본점 한 개 = 한 화소(round 가 아니라 floor 칸), 깊이 시험' },
  compose: { file: 'compose.mjs', fn: 'composeLayers(base:RenderResult, over:RenderResult) -> RenderResult  화소마다 깊이가 더 가까운 쪽(0 은 없음)의 color·depth·index 를 취한 새 결과. 같은 깊이는 base 유지. 크기가 다르면 던진다. 입력은 바꾸지 않는다' },
  mode: { file: 'mode.mjs', fn: 'createModeState(initial?) -> { get(), set(mode) }  DISPLAY_MODES 검증, 기본 DEFAULT_DISPLAY_MODE' },
  index: { file: 'index.mjs', fn: 'createBuildingsLayer(opts?) 조립 (작업자가 한다)' },
});

/** 기본 그리기 값. */
export const BUILDINGS_DEFAULTS = Object.freeze({
  faceRgb: Object.freeze([0, 0, 0]), // black 옵션의 면 색(검정)
  lineRgb: Object.freeze([200, 200, 200]), // 모서리 선
  pointRgb: Object.freeze([255, 255, 255]),
  lineDepthBiasM: 0.05,
  nearM: 0.01,
});
