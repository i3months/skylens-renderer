// 실제 컬링 단계(frustum·backface·occlusion·priority)와 cullAndSelectDefault 를 재는 공용 측정 로직.
// run.mjs 와 measure_scaling.mjs 가 쓴다. 장면은 대규모 평지(fixtures/scenes/large)를 쓴다.
import { generate as generateLarge } from '../../fixtures/scenes/large/index.mjs';
import { buildHierarchy } from '../../server/lod/hierarchy/index.mjs';
import { frustumCull } from '../../server/cull/frustum/index.mjs';
import { leafNormalCones, backfaceCull } from '../../server/cull/backface/index.mjs';
import { buildDepthPyramid, occlusionCull } from '../../server/cull/occlusion/index.mjs';
import { orderChunks } from '../../server/cull/priority/index.mjs';
import { cullAndSelectDefault } from '../../server/cull/combine/index.mjs';
import { measureCullCost, measureCullCostAsync } from './index.mjs';

export const POINT_SIZE_M = 0.3;
export const THRESHOLD_PX = 1;
export const STAGE_NAMES = ['frustum', 'backface', 'occlusion', 'priority'];

/** 바라보는 점(target)을 향하는 카메라. 축 규약은 contracts/raster: X_c = R·X_w + t, +z 가 앞, y 가 아래. */
export function lookAtCamera(eye, target, { width = 800, height = 600, f = 500 } = {}) {
  const fw = norm(sub(target, eye));
  const up = [0, 1, 0];
  const d = norm(neg(sub(up, mul(fw, dot(up, fw))))); // 화면 아래
  const r = cross(d, fw); // 화면 오른쪽(det=+1)
  const R = [...r, ...d, ...fw];
  const t = [-dot(r, eye), -dot(d, eye), -dot(fw, eye)];
  return { width, height, K: { fx: f, fy: f, cx: width / 2, cy: height / 2 }, R, t };
}

/** 서로 다른 세 시점: 높은 사선, 낮고 먼 시점, 장면 한가운데 위. */
export function makeCameras() {
  return [
    lookAtCamera([0, 80, -280], [0, 0, 0]),
    lookAtCamera([180, 15, -200], [0, 0, 60]),
    lookAtCamera([20, 40, 0], [60, 0, 120]),
  ];
}

/** 점 수 points, 리프당 최대 점 수 maxLeafPoints 로 계층을 만든다(리프 수는 maxLeafPoints 가 정한다). */
export function buildBenchHierarchy(points, maxLeafPoints, { seed = 42 } = {}) {
  const scene = generateLarge({ seed, count: points });
  const hierarchy = buildHierarchy(scene.cloud, { edge0M: 0.5, levelCount: 2, maxLeafPoints, maxDepth: 16 });
  return { hierarchy, pointCount: scene.cloud.count, leafCount: hierarchy.octree.leafCount };
}

/** 실제 단계 함수들. 준비물(법선 원뿔, priority 입력 마스크)은 재기 전에 한 번 만든다. */
export function makeRealStages(hierarchy, cameras, { pointSizeM = POINT_SIZE_M } = {}) {
  const cones = leafNormalCones(hierarchy);
  const masks = new Map(cameras.map((c) => [c, frustumCull(hierarchy, c, { pointSizeM })]));
  return {
    frustum: (h, cam) => frustumCull(h, cam, { pointSizeM }),
    backface: (h, cam) => backfaceCull(h, cam, cones, { pointSizeM }),
    occlusion: (h, cam) => occlusionCull(h, cam, buildDepthPyramid(h, cam, { pointSizeM })),
    priority: (h, cam) => orderChunks(h, cam, masks.get(cam)),
  };
}

/**
 * 한 계층을 재서 한 줄 결과를 돌려준다.
 * stageMedianMs: 단계별 median, stagesSumMs: 네 단계 합의 시점당 median·p95·max, combinedMs: cullAndSelectDefault(prioritize) 시점당.
 */
export async function measureScene(hierarchy, cameras, { repeats = 3, now } = {}) {
  const stages = makeRealStages(hierarchy, cameras);
  const staged = measureCullCost(hierarchy, cameras, { stages, repeats, now });
  const combinedStages = {
    cullAndSelectDefault: (h, cam) => cullAndSelectDefault(h, cam, { thresholdPx: THRESHOLD_PX, pointSizeM: POINT_SIZE_M, prioritize: true }),
  };
  const combined = await measureCullCostAsync(hierarchy, cameras, { stages: combinedStages, repeats, now });
  return { staged, combined };
}

export const TABLE_HEADER = ['점', '리프', 'frustum', 'backface', 'occlusion', 'priority', '단계합 median', '단계합 p95', 'cullAndSelectDefault median', 'cullAndSelectDefault p95'];

/** measureScene 결과 한 줄(표 행). 숫자는 ms, 소수 둘째 자리. */
export function tableRow(pointCount, leafCount, { staged, combined }) {
  const f = (x) => x.toFixed(2);
  const c = combined.perStageMs.cullAndSelectDefault;
  return [
    String(pointCount), String(leafCount),
    ...STAGE_NAMES.map((n) => f(staged.perStageMs[n].median)),
    f(staged.perViewMs.median), f(staged.perViewMs.p95), f(c.median), f(c.p95),
  ];
}

export function formatTable(rows) {
  return [TABLE_HEADER, ...rows].map((r) => r.join('\t')).join('\n');
}

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function neg(a) { return [-a[0], -a[1], -a[2]]; }
function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a) { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; }
