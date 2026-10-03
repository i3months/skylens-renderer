// T08.8 컬링 + LOD 결합 선택. 계약: contracts/cull/index.mjs 의 CULL_API.combine, CombinedResult, CullStats.
//
// cullAndSelect(hierarchy, camera, opts) 는 동기 함수다. 단계 구현(frustum·backface·occlusion·distance)과 우선순위 정렬은
// 주입받는다(opts.stageImpls, opts.orderChunks). 기본 구현은 async 보조 함수 loadDefaultImpls()/loadDefaultStages() 가
// CULL_API 의 모듈 위치에서 동적 import(await import) 로 가져온다. 주입이 없으면 Promise 를 돌려주지 않고
// 'cull: 단계 구현이 필요' 명시 오류를 던진다. 한 번에 쓰려면 async 인 cullAndSelectDefault 를 쓴다.
//
// 순서:
//   0) 입력 검사(계층·카메라 구조·옵션) — 틀리면 'cull:' 오류.
//   1) 퇴화 시점(NaN·Infinity, 해상도·초점거리 ≤ 0, R 이 회전이 아님)이면 던지지 않고 빈 결과:
//      mask 전부 0, chunks 비움, leafLevel 전부 NOT_DRAWN, pointCount 0, stats.degenerate = true.
//      opts.pointSizeM(래스터 원판 지름 m)은 stageOpts 로 모든 단계에 전달된다. 없으면 거리 단계처럼 가림 단계는 아무것도 버리지 않는다.
//      (LOD 선택 selectLevels 도 pointSizeM 이 있으면 같은 원판 규칙을 쓴다.)
//   2) opts.stages 순서대로 단계 마스크를 구해 AND(andMasks). 통계의 removed<단계> 는 '그 단계가 새로 제거한 수'
//      (앞 단계까지 남아 있던 리프 중 이 단계가 0 으로 만든 수). 실행하지 않은 단계는 0.
//   3) selectLevels(원래 LOD 선택; 호출만 하고 고치지 않는다) 결과를 복사해 마스크 0 리프를 NOT_DRAWN 으로 바꾸고
//      pointCount 를 남은 리프의 단계 구간 길이 합으로 다시 센다. 마스크 1 리프의 단계는 LOD 만일 때와 같다.
//      컬링은 리프를 빼기만 하므로 pointCount ≤ LOD 만일 때. 새 점을 만들지 않는다.
//   4) cull.chunks = 마스크 1 리프 번호(prioritize 면 orderChunks 순, 아니면 번호 오름차순).
//      chunks 는 계약대로 '마스크로 남은 리프' 이며, selectLevels 가 따로 NOT_DRAWN 으로 둔 리프(빈 리프 등)는 제외한다
//      (그릴 점이 없는 조각을 전송·정렬 대상으로 만들지 않는다). stats.kept 는 chunks 길이.
import { CULL_API, CULL_STAGES, andMasks, chunksOfMask, assertLeafMask } from '../../../contracts/cull/index.mjs';
import { NOT_DRAWN } from '../../../contracts/lod/index.mjs';
import { assertCamera } from '../../../contracts/raster/index.mjs';
import { isDegenerateView } from '../degenerate/index.mjs';
import { selectLevels, assertHierarchyInput } from '../../lod/select/index.mjs';

const ERR = 'cull:';
const STAT_KEY = Object.freeze({ frustum: 'removedFrustum', backface: 'removedBackface', occlusion: 'removedOcclusion', distance: 'removedDistance' });

/** 기본 단계 순서(계약의 CULL_STAGES). */
export const DEFAULT_STAGES = CULL_STAGES;

const repoUrl = (rel) => new URL(`../../../${rel}`, import.meta.url).href;

/**
 * 기본 구현을 CULL_API 모듈에서 동적으로 읽는다.
 * @returns {Promise<{stageImpls:Object<string,Function>, orderChunks:Function, isDegenerateView:Function}>}
 *   stageImpls[name] = (hierarchy, camera, {maxDistanceM, thresholdPx}) => LeafMask
 */
export async function loadDefaultImpls() {
  const [deg, fr, bf, oc, di, pr] = await Promise.all(
    ['degenerate', 'frustum', 'backface', 'occlusion', 'distance', 'priority'].map((k) => import(repoUrl(CULL_API[k].module))),
  );
  const cones = new WeakMap(); // 계층마다 법선 원뿔은 한 번만 만든다
  const stageImpls = {
    // pointSizeM 은 래스터 원판 지름(m). 없으면 절두체는 좌·우·위·아래로 버리지 않고, 가림은 아무것도 버리지 않는다(보수적).
    frustum: (h, cam, o) => fr.frustumCull(h, cam, { pointSizeM: o.pointSizeM }),
    // 뒷면 단계의 덮임 판정은 래스터 원판 지름이 필요하다. 없으면(0 포함) 가림 단계처럼 아무것도 버리지 않는다(F-123).
    backface: (h, cam, o) => {
      if (o.pointSizeM === undefined || o.pointSizeM === 0) return new Uint8Array(h.octree.leafCount).fill(1);
      if (!cones.has(h)) cones.set(h, bf.leafNormalCones(h));
      return bf.backfaceCull(h, cam, cones.get(h), { pointSizeM: o.pointSizeM });
    },
    occlusion: (h, cam, o) => (o.pointSizeM === undefined || o.pointSizeM === 0
      ? new Uint8Array(h.octree.leafCount).fill(1)
      : oc.occlusionCull(h, cam, oc.buildDepthPyramid(h, cam, { pointSizeM: o.pointSizeM }))),
    // maxDistanceM 이 없으면 거리 단계는 아무것도 버리지 않는다(보수적).
    distance: (h, cam, o) => (o.maxDistanceM === undefined ? new Uint8Array(h.octree.leafCount).fill(1) : di.distanceCull(h, cam, { maxDistanceM: o.maxDistanceM })),
  };
  return { stageImpls, orderChunks: pr.orderChunks, isDegenerateView: deg.isDegenerateView };
}

/** 단계 구현만 필요할 때. */
export async function loadDefaultStages() {
  return (await loadDefaultImpls()).stageImpls;
}

/** 기본 구현을 읽어 cullAndSelect 를 부른다(async). opts 에 넣은 주입은 기본보다 우선한다. */
export async function cullAndSelectDefault(hierarchy, camera, opts = {}) {
  const d = await loadDefaultImpls();
  return cullAndSelect(hierarchy, camera, {
    ...opts,
    stageImpls: opts.stageImpls ?? d.stageImpls,
    orderChunks: opts.orderChunks ?? d.orderChunks,
    isDegenerateView: opts.isDegenerateView ?? d.isDegenerateView,
  });
}

/** 카메라 구조 검사(구조 위반만 오류; 값이 NaN·0 이하·비회전인 것은 퇴화 시점으로 넘긴다). */
function assertCameraShape(camera) {
  if (!camera || typeof camera !== 'object') throw new Error(`${ERR} 카메라가 객체가 아님`);
  const { K, R, t } = camera;
  if (typeof camera.width !== 'number' || typeof camera.height !== 'number') throw new Error(`${ERR} 카메라 width·height 는 수여야 함`);
  if (!K || typeof K !== 'object' || !['fx', 'fy', 'cx', 'cy'].every((n) => typeof K[n] === 'number')) throw new Error(`${ERR} 카메라 K 는 fx·fy·cx·cy 수를 가진 객체여야 함`);
  if (!Array.isArray(R) || R.length !== 9 || !R.every((x) => typeof x === 'number')) throw new Error(`${ERR} 카메라 R 은 수 9개 배열이어야 함`);
  if (!Array.isArray(t) || t.length !== 3 || !t.every((x) => typeof x === 'number')) throw new Error(`${ERR} 카메라 t 는 수 3개 배열이어야 함`);
}

/** 주입이 없을 때의 퇴화 판정: 계약상 퇴화 조건은 raster 카메라 검사 실패와 같다(구조 검사는 앞에서 끝남). */
function localIsDegenerate(camera) {
  return isDegenerateView(camera);
}

function assertOpts(opts) {
  if (!opts || typeof opts !== 'object') throw new Error(`${ERR} opts 가 객체가 아님`);
  const { thresholdPx, maxDistanceM, prioritize, pointSizeM } = opts;
  if (!(typeof thresholdPx === 'number' && Number.isFinite(thresholdPx) && thresholdPx > 0)) throw new Error(`${ERR} thresholdPx 는 양의 유한수: ${String(thresholdPx)}`);
  if (maxDistanceM !== undefined && !(typeof maxDistanceM === 'number' && maxDistanceM > 0)) throw new Error(`${ERR} maxDistanceM 은 양수(Infinity 허용): ${String(maxDistanceM)}`);
  if (pointSizeM !== undefined && !(typeof pointSizeM === 'number' && Number.isFinite(pointSizeM) && pointSizeM >= 0)) throw new Error(`${ERR} pointSizeM 은 0 이상의 유한 수: ${String(pointSizeM)}`);
  if (prioritize !== undefined && typeof prioritize !== 'boolean') throw new Error(`${ERR} prioritize 는 boolean: ${String(prioritize)}`);
  const stages = opts.stages ?? DEFAULT_STAGES;
  if (!Array.isArray(stages)) throw new Error(`${ERR} stages 는 배열이어야 함`);
  const seen = new Set();
  for (const s of stages) {
    if (!CULL_STAGES.includes(s)) throw new Error(`${ERR} 알 수 없는 단계: ${String(s)}`);
    if (seen.has(s)) throw new Error(`${ERR} 단계가 중복됨: ${s}`);
    seen.add(s);
  }
  const impls = opts.stageImpls;
  if (impls === undefined || impls === null) {
    throw new Error(`${ERR} 단계 구현이 필요 (opts.stageImpls; 기본 구현은 await loadDefaultStages() 또는 cullAndSelectDefault 로 얻는다)`);
  }
  if (typeof impls !== 'object') throw new Error(`${ERR} stageImpls 는 객체여야 함`);
  for (const s of stages) if (typeof impls[s] !== 'function') throw new Error(`${ERR} 단계 구현이 필요: stageImpls.${s}`);
  if (prioritize && typeof opts.orderChunks !== 'function') throw new Error(`${ERR} prioritize 에는 orderChunks 구현이 필요 (opts.orderChunks)`);
  if (opts.isDegenerateView !== undefined && typeof opts.isDegenerateView !== 'function') throw new Error(`${ERR} isDegenerateView 는 함수여야 함`);
  return stages;
}

function emptyStats(leafCount) {
  return { leafCount, kept: 0, removedFrustum: 0, removedBackface: 0, removedOcclusion: 0, removedDistance: 0 };
}

/**
 * @param {import('../../../contracts/lod/index.mjs').Hierarchy} hierarchy
 * @param {import('../../../contracts/raster/index.mjs').Camera} camera
 * @param {{thresholdPx:number, stages?:string[], maxDistanceM?:number, pointSizeM?:number, prioritize?:boolean,
 *          stageImpls:Object<string,Function>, orderChunks?:Function, isDegenerateView?:Function}} opts
 * @returns {import('../../../contracts/cull/index.mjs').CombinedResult}
 */
export function cullAndSelect(hierarchy, camera, opts) {
  try {
    assertHierarchyInput(hierarchy);
  } catch (e) {
    throw new Error(`${ERR} 계층이 올바르지 않음 (${e.message})`);
  }
  assertCameraShape(camera);
  const stages = assertOpts(opts);
  const leafCount = hierarchy.octree.leafCount;

  const degenerate = (opts.isDegenerateView ?? localIsDegenerate)(camera);
  if (degenerate) {
    return {
      cull: { mask: new Uint8Array(leafCount), chunks: new Uint32Array(0), stats: { ...emptyStats(leafCount), degenerate: true } },
      selection: { leafLevel: new Uint8Array(leafCount).fill(NOT_DRAWN), pointCount: 0 },
    };
  }

  // 단계 마스크 AND, 단계별로 새로 제거한 수
  const stats = emptyStats(leafCount);
  const stageOpts = { maxDistanceM: opts.maxDistanceM, thresholdPx: opts.thresholdPx, pointSizeM: opts.pointSizeM };
  let mask = new Uint8Array(leafCount).fill(1);
  for (const s of stages) {
    const m = opts.stageImpls[s](hierarchy, camera, stageOpts);
    assertLeafMask(m, leafCount);
    let removed = 0;
    for (let k = 0; k < leafCount; k++) if (mask[k] === 1 && m[k] === 0) removed++;
    stats[STAT_KEY[s]] = removed;
    mask = andMasks([mask, m], leafCount);
  }

  // 원래 LOD 선택 → 마스크 0 리프만 NOT_DRAWN, 점 수 다시 세기
  const lod = selectLevels(hierarchy, camera, { thresholdPx: opts.thresholdPx, pointSizeM: opts.pointSizeM });
  const leafLevel = new Uint8Array(lod.leafLevel);
  const { levels } = hierarchy;
  let pointCount = 0;
  for (let k = 0; k < leafCount; k++) {
    if (mask[k] === 0) { leafLevel[k] = NOT_DRAWN; continue; }
    const l = leafLevel[k];
    if (l !== NOT_DRAWN) pointCount += levels[l].leafStart[k + 1] - levels[l].leafStart[k];
  }

  // NOT_DRAWN 리프 제외: 정렬 입력 마스크도 같은 리프만 1 로 둔다(원래 mask 는 건드리지 않는다).
  const chunkMask = new Uint8Array(mask);
  for (let k = 0; k < leafCount; k++) if (leafLevel[k] === NOT_DRAWN) chunkMask[k] = 0;
  let chunks = chunksOfMask(chunkMask);
  if (opts.prioritize) {
    const ordered = opts.orderChunks(hierarchy, camera, chunkMask);
    if (!(ordered instanceof Uint32Array) || ordered.length !== chunks.length) throw new Error(`${ERR} orderChunks 결과는 남은 리프 수(${chunks.length}) 길이의 Uint32Array 여야 함`);
    const seen = new Uint8Array(leafCount);
    for (const k of ordered) {
      if (!(k < leafCount) || chunkMask[k] !== 1 || seen[k]) throw new Error(`${ERR} orderChunks 결과가 남은 리프의 순열이 아님 (리프 ${k})`);
      seen[k] = 1;
    }
    chunks = ordered;
  }
  stats.kept = chunks.length;
  return { cull: { mask, chunks, stats }, selection: { leafLevel, pointCount } };
}
