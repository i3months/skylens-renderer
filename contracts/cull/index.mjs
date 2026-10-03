// 컬링 계약(T08). LOD 계층(contracts/lod)의 '리프'를 조각 단위로 삼아, 시점마다 그릴 필요가 없는 리프를 걸러 낸다.
// 새 점을 만들지 않고 도착하지 않은 것을 메우지 않는다(skylens 원칙). 좌표는 GeoAnchor 기준 ENU, 1 unit = 1 m.
// 카메라는 contracts/raster 의 Camera(X_c = R·X_w + t, +z 를 봄)를 그대로 쓴다.
//
// 모든 컬링 단계는 '보수적'이다: 보여야 할 리프를 버리지 않는다(거짓 제거 0). 확실히 필요 없을 때만 버린다.
// 단계 결과는 길이 leafCount 인 Uint8Array 마스크(1 = 남김, 0 = 제거)다. 단계끼리는 AND 로 합친다(combine).
// 입력 오류(계층·카메라 구조: 객체 아님·width/height/K/R/t 누락·수가 아닌 값·R·t 가 일반 배열이 아님·길이 틀림·희소 배열 구멍; 타입 배열 필수; leafIndex 는 Int32Array(같은 realm)이고 모든 값이 정수이며, -1 또는 [0, leafCount) 이고 리프 ↔ 노드 일대일이며 범위 내(server/cull/degenerate/leaf_check.mjs); 리프 노드의 상자 좌표가 ±Infinity 면 = 구조 오류(cull: 오류))는 단계별로 다르게 처리한다(F-155):
//   checkLeafIndexOneToOne 을 쓰는 단계(frustumCull·distanceCull·occlusionCull·leafPriority·predictiveMask·orderChunks): 검증을 통과한 계층(octree 배열 포함)은 불변으로 가정한다(server/cull/degenerate/leaf_check.mjs 의 캐시 방식). 리프 노드의 ±Infinity 만 거부하고 제자리 수정은 감지 보장이 없다(검증 표본에 걸릴 때만 잡힘). 내용을 바꾸려면 새 typed array 를 만든다. 내부 노드·NaN 은 모두 통과. 할당 실패(RangeError)는 'cull:' 오류 범위 밖.
//   assertHierarchyInput 을 쓰는 단계(backfaceCull·leafNormalCones·cullAndSelect): 모든 노드의 NaN·±Infinity 거부.
//   distanceCull: NaN 쪽 경계 비교는 무시하고 남은 유한 경계로 한쪽 간격(하한)을 만든다(예: min.x=NaN, max.x=-1e6, C=0 → 간격 1e6, 축 1). Math.hypot 이 간격들로 계산: 결과가 double 최댓값(약 1.797e308)을 넘으면 Infinity 가 되고 이는 기준 초과로 먼 것으로 봐 리프를 제거한다(하한이므로 거짓 제거 아님). 한 축 간격이 NaN 이면 hypot 은 NaN 을 돌려 거리가 NaN 이고 비교 NaN > maxDistanceM 은 거짓이므로 리프는 남는다. 유한 간격만으로 확실히 먼 경우도 제거한다. leafPriority: NaN 리프는 유한한 점수를 받는다(점수 합이 비유한이면 0 으로 바꾸는 가드는 방어용이고, 현재 입력 검증 아래 도달 경로 없음 — priority_nan_score.test.mjs).
//   클라이언트: leafBoxesOf 는 NaN·±Infinity 모두 통과, clientFrustumCull 은 ±Infinity 상자를 cull: 오류로 던지고 NaN 은 통과.
// NaN 리프 정책표(F-156 ⑦, 시험: server/cull/degenerate/nan_box_policy_table.test.mjs): 상자 좌표에 NaN 이 있는 리프는 보일지 알 수 없으므로 '거짓 제거 0' 원칙에 따라 단독 호출에서 절대 제거하지 않는다(distanceCull 제외). ±Infinity 리프는 모든 서버 단계가 cull: 오류, 아래 표는 NaN 만 다룬다.
//   단계                                    NaN 리프 결과
//   frustumCull · predictiveMask            1(남김), pointSizeM 유무와 무관
//   distanceCull                            0 또는 1(유한 축 간격만으로 먼 경우만 0, 하한이므로 거짓 제거 아님)
//   occlusionCull                           1(남김)
//   clientFrustumCull                       1(남김), pointSizeM 유무와 무관
//   leafPriority                            유한한 점수(정렬 키가 깨지지 않게). 점수는 우선순위일 뿐 제거가 아니다
//   orderChunks                             마스크가 1 이면 조각 목록에 남김
//   backfaceCull · leafNormalCones · cullAndSelect(combine)   조용히 지우지 않고 cull: 오류로 거부(NaN 을 받지 않는 단계)
//   distanceCull 을 제외한 모든 마스크 단계에서는 NaN 리프가 0 이 되지 않으므로 단계를 AND 로 합쳐도 NaN 리프가 거짓 제거되는 경로는 없다. combine 만 오류인 것은 의도다(오류는 제거가 아니다).
// 리프 0 개 계층(leafCount < 1, F-145): 모든 서버 단계와 클라이언트가 똑같이 구조 오류(cull: 오류)를 던진다. 빈 마스크를 돌려주지 않는다. 계층 검사 중 필드를 읽다가 예외(접근자·Proxy)가 나면 그것도 구조 오류로 'cull:' 오류로 바꿔 던진다(frustum 은 assertHierarchyLocal 래퍼, backface 는 checkHierarchy 씀; distance·priority·occlusion·predict·combine 은 공용 래퍼 server/cull/degenerate/hierarchy_guard.mjs 의 guardHierarchyRead 씀; leafBoxesOf·cachedNormalCones 는 호출층이 구조 검사를 거쳐 쓴다). 클라이언트 clientFrustumCull 은 상자가 0 개(n < 1)이면 빈 마스크가 아니라 cull: 오류를 던진다(F-148). 상태 접근자(필드를 읽다가 예외를 던지기 시작하는 getter)는 구조 검사 시 필드를 읽으므로 그 시점의 예외를 'cull:' 오류로 바꾼다 → 이후 호출에서는 예외를 다시 던진다.
//
// 퇴화 시점(T08.10): 카메라가 NaN·Infinity 를 가지거나, 해상도·초점거리가 0 이하이거나, 해상도가 정수가 아니거나,
//   해상도 한 변이 1e6 px 를 넘거나, 총 픽셀 수(width×height)가 2**26 을 넘거나, 시야각이 1e-6 rad 미만이거나, R 이 회전이 아니면
//   예외 없이 isDegenerateView(camera) === true 이고 모든 컬링 함수가 '아무것도 남기지 않는' 빈 마스크(전부 0)를 돌려준다.
//   지면 아래 카메라(카메라 중심이 모든 상자보다 아래)는 퇴화가 아니다: 정상 입력으로 처리한다.
// 법선 원뿔(T08.2): 리프 k 의 대표 법선 방향 axis[k](단위) 와 반각의 코사인 cosHalf[k]. 리프 안 모든 점 법선 n 이 n·axis ≥ cosHalf 를 만족한다.
//   법선이 없는 점(길이 0)이 하나라도 있으면 그 리프는 cosHalf = −1(원뿔 = 전체 구, 절대 뒷면 제거 안 함).
// 점 원판(F-116): 래스터는 점을 반경 r = fx·pointSizeM/(2z) px 원판으로 그리므로(위·아래도 fx), 절두체 판정(frustum·client)은
//   좌·우·위·아래 평면을 그 반경만큼 바깥으로 민다. pointSizeM 을 모르면(인자 없음) 좌·우·위·아래로는 아무것도 버리지 않는다.
// 점 형식(27 B)·법선 의미는 renderer_basis 그대로: 법선은 세계 좌표 단위 벡터이며 카메라 쪽을 향하면 앞면이다.

/**
 * @typedef {import('../raster/index.mjs').Camera} Camera
 * @typedef {import('../lod/index.mjs').Hierarchy} Hierarchy
 * @typedef {import('../lod/index.mjs').Selection} Selection
 *
 * @typedef {Uint8Array} LeafMask   길이 leafCount, 1 = 남김, 0 = 제거
 *
 * @typedef {Object} NormalCones    server/cull/backface 의 leafNormalCones 결과
 * @property {Float32Array} axis      3·leafCount, 단위 길이
 * @property {Float32Array} cosHalf   leafCount, [−1, 1]
 *
 * @typedef {Object} ViewState   시점 상태: 카메라와 (있으면) 이동 속도
 * @property {Camera} camera
 * @property {number[]} [velocityMps]    카메라 중심의 세계 좌표 속도(m/s), 길이 3
 * @property {number[]} [angularRadPerS] 카메라 각속도(세계 좌표, rad/s), 길이 3
 *
 * @typedef {Object} CullStats
 * @property {number} leafCount
 * @property {number} kept          그려질 리프 수(chunks 길이: 마스크 1 이면서 LOD 가 NOT_DRAWN 으로 두지 않은 리프)
 * @property {number} removedFrustum
 * @property {number} removedBackface
 * @property {number} removedOcclusion
 * @property {number} removedDistance
 *
 * @typedef {Object} CullResult   조각 목록: 남긴 리프 번호를 화면 기여 큰 순서로
 * @property {Uint8Array} mask          길이 leafCount
 * @property {Uint32Array} chunks       남은 리프 번호(우선순위 정렬이 켜져 있으면 기여 큰 순, 아니면 번호 오름차순)
 * @property {CullStats} stats
 *
 * @typedef {Object} CombinedResult  server/cull/combine 의 cullAndSelect 결과
 * @property {CullResult} cull
 * @property {Selection} selection      선택된 단계. 제거된 리프는 NOT_DRAWN
 */

/** 컬링 단계 이름(통계·사유 표기용). */
export const CULL_STAGES = Object.freeze(['frustum', 'backface', 'occlusion', 'distance']);

/** 뒷면 제거의 정의: 법선이 카메라를 등진 점도 렌더는 그린다. 뒷면 단계는 화면 결과가 달라지지 않을 때만 리프를 0 으로 한다(앞면으로 그려진 점이 있거나, 뒷면 점이 가림막에 덮이지 않으면 남김). */

/** 거짓 제거 판정 기준: 보이는 리프(참조 래스터 index 로 확인)가 제거되면 거짓 제거다. 허용 0. */
export const MAX_FALSE_REMOVALS = 0;
/** T08.2 법선 컬링이 렌더 결과에 주는 SSIM 변화 상한 (SPEC 성공 기준). */
export const BACKFACE_MAX_SSIM_DROP = 0.002;
/** T08.8 컬링+LOD 결합의 8시점 SSIM 하한. */
export const COMBINE_MIN_SSIM = 0.95;

/** 함수 서명. 이름과 모듈 위치는 이 표가 기준이다. 모든 마스크 함수의 첫 인자는 hierarchy. */
export const CULL_API = Object.freeze({
  degenerate: { module: 'server/cull/degenerate/index.mjs', fn: 'isDegenerateView(camera) -> boolean ; assertCameraShape(camera) -> void ("cull:" 오류) ; degenerateCamera(camera) -> boolean ; emptyMask(hierarchy) -> LeafMask(전부 0) ; assertHierarchyForCull(hierarchy) -> void ("cull:" 오류)' },
  frustum: { module: 'server/cull/frustum/index.mjs', fn: 'frustumCull(hierarchy, camera, {pointSizeM?}) -> LeafMask   리프 상자의 점이 지름 pointSizeM(m) 원판으로 그려져도 화면에 확실히 안 걸칠 때만 0(좌·우·위·아래 평면을 원판 반경 fx·pointSizeM/(2z) px 만큼 바깥으로 민다). pointSizeM 이 없으면 좌·우·위·아래로는 제거 없음(앞 z > 0 만). 퇴화 시점이면 전부 0' },
  backface: { module: 'server/cull/backface/index.mjs', fn: 'leafNormalCones(hierarchy) -> NormalCones ; backfaceCull(hierarchy, camera, cones, {pointSizeM?, requireCover?, marginDeg?}) -> LeafMask   리프의 모든 점이 카메라를 등지는 것이 확실할 때만 0. pointSizeM 이 없으면 덮임 판정 지름을 모르므로 2단계 후보를 전부 남김(제거 0)' },
  occlusion: { module: 'server/cull/occlusion/index.mjs', fn: 'buildDepthPyramid(hierarchy, camera, {size=64, pointSizeM?=0.05, maxOccluderPoints?=262144, occluderLevel?, occluderMask?}) -> {size, levels:Float32Array[], pointSizeM, occluderPoints}   CPU 거친 깊이 피라미드(칸마다 가장 가까운 깊이의 보수적 하한이 아닌 "가림막" 깊이 = 칸 안 모든 픽셀이 이보다 가깝게 채워진 깊이의 최댓값) ; occlusionCull(hierarchy, camera, pyramid?) -> LeafMask   리프 상자 전체가 가림막 뒤일 때만 0' },
  distance: { module: 'server/cull/distance/index.mjs', fn: 'distanceCull(hierarchy, camera, {maxDistanceM}) -> LeafMask   카메라 중심~상자 최소 거리 > maxDistanceM 이면 0 (경계 = 남김) [maxDistanceM 기준 미정(의사결정 대기)]' },
  predict: { module: 'server/cull/predict/index.mjs', fn: 'predictCamera(camera, {velocityMps, angularRadPerS}, dtS) -> Camera ; predictiveMask(hierarchy, state, {horizonS, steps, pointSizeM?}) -> LeafMask   현재와 예측 시점들의 frustumCull 합집합(OR). 한계: 예측 표본(tau>0)이 모두 퇴화면 표본 사이는 덮지 않음(horizon 에 대해 비단조 가능)' },
  priority: { module: 'server/cull/priority/index.mjs', fn: 'leafPriority(hierarchy, camera) -> Float64Array(leafCount)   화면 기여 점수(클수록 먼저) ; orderChunks(hierarchy, camera, mask) -> Uint32Array   남은 리프를 점수 내림차순(동률은 번호 작은 쪽)' },
  client: { module: 'client/cull/index.mjs', fn: 'clientFrustumCull(leafBoxes, camera, {pointSizeM?}) -> Uint8Array   leafBoxes = {boxMin:Float32Array(3·n), boxMax:Float32Array(3·n)}(리프 번호 순); 같은 pointSizeM 의 서버 frustumCull 과 같은 마스크(없으면 좌·우·위·아래 제거 없음)' },
  combine: { module: 'server/cull/combine/index.mjs', fn: 'cullAndSelect(hierarchy, camera, {thresholdPx, stages?, maxDistanceM?, pointSizeM?, prioritize?}) -> CombinedResult   pointSizeM(원판 지름 m)은 모든 단계에 전달, 없으면 절두체는 좌우상하 제거 없음·가림은 제거 없음; stages 기본 ["frustum","backface","occlusion","distance"]; 남은 리프만 selectLevels 의 단계로, 제거 리프는 NOT_DRAWN. edge-leaf preservation (F-126): 점 원판이 화면 가장자리를 걸친 리프(중심은 화면 밖)가 보존되려면 pointSizeM 을 전달해야 한다. pointSizeM 없으면 edge leaves 는 제거되어 NOT_DRAWN 이다' },
  bench: { module: 'bench/cull/index.mjs', fn: 'measureCullCost(hierarchy, cameras, opts) -> {perViewMs:{median,p95,max}, perStageMs:{...}}' },
});

const ERR = 'cull:';

/** 마스크가 길이 leafCount 의 0/1 Uint8Array 인지 검사한다(단계 결과 공용 검사). */
export function assertLeafMask(mask, leafCount) {
  if (!(mask instanceof Uint8Array) || mask.length !== leafCount) throw new Error(`${ERR} 마스크는 길이 ${leafCount} 의 Uint8Array 여야 함`);
  for (let i = 0; i < leafCount; i++) if (mask[i] !== 0 && mask[i] !== 1) throw new Error(`${ERR} 마스크[${i}] = ${mask[i]} 는 0/1 이 아님`);
}

/** 마스크들의 AND. */
export function andMasks(masks, leafCount) {
  const out = new Uint8Array(leafCount).fill(1);
  for (const m of masks) { assertLeafMask(m, leafCount); for (let i = 0; i < leafCount; i++) out[i] &= m[i]; }
  return out;
}

/** 마스크에서 조각 목록(번호 오름차순). */
export function chunksOfMask(mask) {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  const out = new Uint32Array(n);
  for (let i = 0, o = 0; i < mask.length; i++) if (mask[i]) out[o++] = i;
  return out;
}
