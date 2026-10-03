// 컬링 계약(T08). LOD 계층(contracts/lod)의 '리프'를 조각 단위로 삼아, 시점마다 그릴 필요가 없는 리프를 걸러 낸다.
// 새 점을 만들지 않고 도착하지 않은 것을 메우지 않는다(skylens 원칙). 좌표는 GeoAnchor 기준 ENU, 1 unit = 1 m.
// 카메라는 contracts/raster 의 Camera(X_c = R·X_w + t, +z 를 봄)를 그대로 쓴다.
//
// 모든 컬링 단계는 '보수적'이다: 보여야 할 리프를 버리지 않는다(거짓 제거 0). 확실히 필요 없을 때만 버린다.
// 단계 결과는 길이 leafCount 인 Uint8Array 마스크(1 = 남김, 0 = 제거)다. 단계끼리는 AND 로 합친다(combine).
// 입력 오류(계층·카메라)는 'cull:' 로 시작하는 명시 오류를 던진다. 단, 퇴화 시점(아래)은 던지지 않고 빈 결과를 돌려준다.
//
// 퇴화 시점(T08.10): 카메라가 NaN·Infinity 를 가지거나, 해상도·초점거리가 0 이하이거나, R 이 회전이 아니면
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
 * @property {number} kept          남은 리프 수
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

/** 거짓 제거 판정 기준: 보이는 리프(참조 래스터 index 로 확인)가 제거되면 거짓 제거다. 허용 0. */
export const MAX_FALSE_REMOVALS = 0;
/** T08.2 법선 컬링이 렌더 결과에 주는 SSIM 변화 상한 (SPEC 성공 기준). */
export const BACKFACE_MAX_SSIM_DROP = 0.002;
/** T08.8 컬링+LOD 결합의 8시점 SSIM 하한. */
export const COMBINE_MIN_SSIM = 0.95;

/** 함수 서명. 이름과 모듈 위치는 이 표가 기준이다. 모든 마스크 함수의 첫 인자는 hierarchy. */
export const CULL_API = Object.freeze({
  degenerate: { module: 'server/cull/degenerate/index.mjs', fn: 'isDegenerateView(camera) -> boolean ; emptyMask(hierarchy) -> LeafMask(전부 0) ; assertHierarchyForCull(hierarchy) -> void ("cull:" 오류)' },
  frustum: { module: 'server/cull/frustum/index.mjs', fn: 'frustumCull(hierarchy, camera, {pointSizeM?}) -> LeafMask   리프 상자의 점이 지름 pointSizeM(m) 원판으로 그려져도 화면에 확실히 안 걸칠 때만 0(좌·우·위·아래 평면을 원판 반경 fx·pointSizeM/(2z) px 만큼 바깥으로 민다). pointSizeM 이 없으면 좌·우·위·아래로는 제거 없음(앞 z > 0 만). 퇴화 시점이면 전부 0' },
  backface: { module: 'server/cull/backface/index.mjs', fn: 'leafNormalCones(hierarchy) -> NormalCones ; backfaceCull(hierarchy, camera, cones) -> LeafMask   리프의 모든 점이 카메라를 등지는 것이 확실할 때만 0' },
  occlusion: { module: 'server/cull/occlusion/index.mjs', fn: 'buildDepthPyramid(hierarchy, camera, {size=64}) -> {size, levels:Float32Array[]}   CPU 거친 깊이 피라미드(칸마다 가장 가까운 깊이의 보수적 하한이 아닌 "가림막" 깊이 = 칸 안 모든 픽셀이 이보다 가깝게 채워진 깊이의 최댓값) ; occlusionCull(hierarchy, camera, pyramid?) -> LeafMask   리프 상자 전체가 가림막 뒤일 때만 0' },
  distance: { module: 'server/cull/distance/index.mjs', fn: 'distanceCull(hierarchy, camera, {maxDistanceM}) -> LeafMask   카메라 중심~상자 최소 거리 > maxDistanceM 이면 0 (경계 = 남김)' },
  predict: { module: 'server/cull/predict/index.mjs', fn: 'predictCamera(camera, {velocityMps, angularRadPerS}, dtS) -> Camera ; predictiveMask(hierarchy, state, {horizonS, steps}) -> LeafMask   현재와 예측 시점들의 frustumCull 합집합(OR)' },
  priority: { module: 'server/cull/priority/index.mjs', fn: 'leafPriority(hierarchy, camera) -> Float64Array(leafCount)   화면 기여 점수(클수록 먼저) ; orderChunks(hierarchy, camera, mask) -> Uint32Array   남은 리프를 점수 내림차순(동률은 번호 작은 쪽)' },
  client: { module: 'client/cull/index.mjs', fn: 'clientFrustumCull(leafBoxes, camera, {pointSizeM?}) -> Uint8Array   leafBoxes = {boxMin:Float32Array(3·n), boxMax:Float32Array(3·n)}(리프 번호 순); 같은 pointSizeM 의 서버 frustumCull 과 같은 마스크(없으면 좌·우·위·아래 제거 없음)' },
  combine: { module: 'server/cull/combine/index.mjs', fn: 'cullAndSelect(hierarchy, camera, {thresholdPx, stages?, maxDistanceM?, prioritize?}) -> CombinedResult   stages 기본 ["frustum","backface","occlusion","distance"]; 남은 리프만 selectLevels 의 단계로, 제거 리프는 NOT_DRAWN' },
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
