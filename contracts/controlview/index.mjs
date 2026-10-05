// 관제탑 화면 어댑터 계약(T15). 관제탑(skylens towerViewer)이 하던 일을 경로 B 의 서버 자산(contracts/tower_assets)과
// 선 규약(contracts/proto)·수준 기계(contracts/levels) 위에 다시 얹는 모듈의 서명과 대응표를 정한다.
// 이 파일은 서명·자료형·대응표와 순수 판정 한 개(isDrapeAligned)만 가진다. 구현은 client/tower/<모듈>/index.mjs.
//
// 원본 대조 표시: skylens 체크아웃(towerViewer.ts)은 [cloud] 에서 열 수 없다. 아래 대응표의 '원본' 열은 TASKS T15 표가 적은 역할에서
// 옮긴 것이고 메서드 이름·인자는 원본과 한 줄씩 대조되지 않았다. 대조는 [local] 이다. 대조 전까지 origin 은 'estimated'.
//
// 좌표: GeoAnchor 기준 ENU(x=동, y=북, z=위), 1 unit = 1 m. 카메라: contracts/raster 규약(X_c = R·X_w + t).
// 씬 규약(x=동, y=위, z=−북)과 ENU 변환은 contracts/statusview 의 sceneToEnu·enuToScene 을 재사용한다. 카메라 축은 OpenCV(x 오른쪽, y 아래, z 앞),
// quat 는 카메라→ENU 회전이다(statusview/index.mjs 머리와 같음). overlay 의 ENU 일치 1 cm 은 GeoAnchor 기준이다.
// 층 모듈(terrain·drape·buildings·streaming)은 contracts/levels 의 교체·추월 건너뛰기를 따른다.
// 폴백(fallback)은 3D 층의 대체 화면이다: 미도착 구역 보충이 아니고 화면 단위로 전부 또는 없음이며 3D 층과 함께 그리지 않는다.
// 원칙: 도착한 것만 그린다. 수준은 교체(누적 아님)이고 추월당한 수준은 건너뛴다. 메우지 않는다.

/** 모듈 한 개 = client/tower/<module>/index.mjs 의 함수 한 개. */
export const CONTROLVIEW_METHOD_MAP = Object.freeze([
  { role: '지형 그리기(8시점 SSIM ≥ 0.95)', source: 'towerViewer.ts (지형 메시)', module: 'terrain', fn: 'createTerrainLayer', origin: 'estimated' },
  { role: '드레이프 그리기(정합 ≤ 1 px)', source: 'towerViewer.ts (위성 드레이프)', module: 'drape', fn: 'createDrapeLayer', origin: 'estimated' },
  { role: '건물 그리기(3옵션 전환, 재요청 없음)', source: 'towerViewer.ts (건물 옵션)', module: 'buildings', fn: 'createBuildingsLayer', origin: 'estimated' },
  { role: '방향키 조향·Q/E 고도 로컬 처리', source: 'towerViewer.ts (키 입력)', module: 'input', fn: 'createTowerInput', origin: 'estimated' },
  { role: '추적 카메라(기존 감쇠 의미)', source: 'towerViewer.ts (chase)', module: 'chase', fn: 'createChaseCamera', origin: 'estimated' },
  { role: '드론·경로·탐지 마커(ENU 일치 ≤ 1 cm)', source: 'towerViewer.ts (오버레이)', module: 'overlay', fn: 'createTowerOverlay', origin: 'estimated' },
  { role: '시점 이동에 따른 조각 요청', source: 'towerViewer.ts (스트리밍)', module: 'streaming', fn: 'createTowerStreaming', origin: 'estimated' },
  { role: '폴백(2D 지도, 사람 확인 전 임시)', source: '(신규)', module: 'fallback', fn: 'createTowerFallback', origin: 'estimated' },
  { role: '조립(어댑터 본체)', source: 'towerViewer.ts 공개 메서드 전체', module: 'e2e', fn: 'createControlView', origin: 'estimated' },
]);

/** 모듈 경로(client/tower/<module>/index.mjs). */
export const controlviewModulePath = (module) => {
  if (!CONTROLVIEW_METHOD_MAP.some((r) => r.module === module)) throw new RangeError(`unknown controlview module: ${typeof module === 'string' ? module : typeof module}`);
  return `client/tower/${module}/index.mjs`;
};

/** 번들·대역폭 문턱(TASKS T15.10, SPEC). */
// 번들은 gzip, KB = 1000 B (이 계약의 해석, SPEC 미정의), 구간당 3 MB(SPEC S6).
export const CONTROLVIEW_LIMITS = Object.freeze({ bundleBytes: 300_000, initialBytes: 15_000_000, segmentBytes: 3_000_000 });
export const CONTROLVIEW_TERRAIN_MIN_SSIM = 0.95;
export const CONTROLVIEW_OVERLAY_MAX_ENU_ERR_M = 0.01;

/**
 * 드레이프 정합 판정(T15.2, F-391 ⑨). measure 는 server/terrain/drape measureDrapeAlignment 의 출력.
 * 이동량을 모르는 local 블록이 있으면(unmeasuredLocalBlocks > 0) 그 블록의 배제 못 한 이동량이 unexcludedMaxPx 에 들어가지 않으므로 통과로 세지 않는다.
 * NaN 은 어떤 허용 비교도 통과하지 못한다. 필드가 없으면(undefined) 알 수 없으므로 통과가 아니다.
 * tolPx 는 유한 비음수이어야 한다.
 * unmeasuredLocalBlocks = unexcludedPx 가 수가 아닌 local 블록 수: 첫 안착 local, 잔차 재적합 local(out !== false: 예측 근처 최소가 뚜렷이 나쁘거나 예측 위치 표본 부족).
 * 호출부 t === null 은 공개 API 로 도달 불가(연구 decisions/0044 T15.1).
 * @param {{maxMisalignPx:number, unmeasuredLocalBlocks:number}} measure
 * @param {number} tolPx 유한 비음수.
 * @returns {boolean}
 */
export function isDrapeAligned(measure, tolPx) {
  // 입력을 강제 변환하지 않는다: null·문자열·음수·비유한(JSON 이 NaN 을 null 로 바꾼 값 포함)은 모두 통과가 아니다(F-392 ①).
  if (!measure || typeof measure.maxMisalignPx !== 'number' || !Number.isFinite(measure.maxMisalignPx) || measure.maxMisalignPx < 0) return false;
  if (typeof tolPx !== 'number' || !Number.isFinite(tolPx) || tolPx < 0) return false;
  return measure.unmeasuredLocalBlocks === 0 && measure.maxMisalignPx <= tolPx;
}

export * from './terrain.mjs';
export * from './drape.mjs';
export * from './buildings.mjs';
export * from './input.mjs';
export * from './chase.mjs';
export * from './overlay.mjs';
