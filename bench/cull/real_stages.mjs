// 실제 컬링 단계(frustum·backface·occlusion·priority)와 cullAndSelectDefault 를 재는 공용 측정 로직.
// run.mjs 와 measure_scaling.mjs 가 쓴다. 장면은 대규모 평지(fixtures/scenes/large)를 쓴다.
import { readFileSync } from 'node:fs';
import { generate as generateLarge } from '../../fixtures/scenes/large/index.mjs';
import { generate as generateFlatBoxes } from '../../fixtures/scenes/flat_boxes/index.mjs';
import { viewpointToCamera } from '../../tools/render_views/index.mjs';
import { buildHierarchy } from '../../server/lod/hierarchy/index.mjs';
import { frustumCull } from '../../server/cull/frustum/index.mjs';
import { leafNormalCones, backfaceCull } from '../../server/cull/backface/index.mjs';
import { buildDepthPyramid, occlusionCull } from '../../server/cull/occlusion/index.mjs';
import { orderChunks } from '../../server/cull/priority/index.mjs';
import { cullAndSelectDefault, loadDefaultImpls, cachedNormalCones } from '../../server/cull/combine/index.mjs';
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

/** 실제 단계가 쓰는 모듈 함수들. 시험이 감시용 모듈로 바꿔 끼워 실제 모듈이 {pointSizeM} 을 받았는지 본다. */
export const REAL_MODULES = Object.freeze({ frustumCull, leafNormalCones, backfaceCull, buildDepthPyramid, occlusionCull, orderChunks });

/** 실제 단계 함수들. 준비물(법선 원뿔, priority 입력 마스크)은 재기 전에 한 번 만든다. */
export function makeRealStages(hierarchy, cameras, { pointSizeM = POINT_SIZE_M, modules = REAL_MODULES } = {}) {
  const m = modules;
  const cones = m.leafNormalCones(hierarchy);
  const masks = new Map(cameras.map((c) => [c, m.frustumCull(hierarchy, c, { pointSizeM })]));
  return {
    frustum: (h, cam) => m.frustumCull(h, cam, { pointSizeM }),
    backface: (h, cam) => m.backfaceCull(h, cam, cones, { pointSizeM }),
    occlusion: (h, cam) => m.occlusionCull(h, cam, m.buildDepthPyramid(h, cam, { pointSizeM })),
    priority: (h, cam) => m.orderChunks(h, cam, masks.get(cam)),
  };
}

/**
 * 뒷면·가림 제거가 실제로 일어나는 장면(축소한 flat_boxes). 점 지름은 렌더 기본(0.05 m)과 다른 값 0.06 m 로 둔다(전달이 끊기면 기본값으로 대체돼 티가 안 나는 것을 막는다). 장면·시점을
 * 같은 배율로 줄여 원판이 화면에서 가림막을 덮을 만큼 커지게 한다(배율 1/k = 원래 장면의 점 지름 0.05·k m).
 * 시점은 뒷면·가림 제거가 모두 생기는 것만 고른다(제거 수는 시험이 단언한다).
 */
export const REMOVAL_SCENE = Object.freeze({
  scale: 1 / 30, count: 200000, seed: 1, width: 320, height: 180, thresholdPx: 0.5, pointSizeM: 0.06,
  levelCount: 6, maxLeafPoints: 256, viewNames: ['street_level', 'low_close_box', 'tower_mid', 'edge_far'],
});

export function buildRemovalScene() {
  const sc = REMOVAL_SCENE;
  const src = generateFlatBoxes({ seed: sc.seed, count: sc.count }).cloud;
  const positions = new Float32Array(src.positions.length);
  for (let i = 0; i < positions.length; i++) positions[i] = src.positions[i] * sc.scale;
  const cloud = { format: 1, count: src.count, positions, normals: src.normals, colors: src.colors };
  const hierarchy = buildHierarchy(cloud, { edge0M: 0.5 * sc.scale, levelCount: sc.levelCount, maxLeafPoints: sc.maxLeafPoints });
  const vps = JSON.parse(readFileSync(new URL('../../fixtures/viewpoints/synthetic.json', import.meta.url), 'utf8')).viewpoints;
  const cameras = sc.viewNames.map((name) => {
    const vp = vps.find((v) => v.name === name);
    if (!vp) throw new Error(`bench: 시점 없음: ${name}`);
    return viewpointToCamera({ eye: vp.eye.map((x) => x * sc.scale), target: vp.target.map((x) => x * sc.scale), up: vp.up, width: sc.width, height: sc.height, fov_y_deg: vp.fov_y_deg });
  });
  return { hierarchy, cameras, pointSizeM: sc.pointSizeM, thresholdPx: sc.thresholdPx, pointCount: cloud.count, leafCount: hierarchy.octree.leafCount };
}

/** 단계 구현을 감싸 호출마다 (단계 이름, 받은 opts.pointSizeM) 을 log 에 쌓는다. 결과·동작은 그대로. */
export function traceStageImpls(impls, log) {
  return Object.fromEntries(Object.entries(impls).map(([name, fn]) => [
    name, (h, cam, o) => { log.push({ stage: name, pointSizeM: o.pointSizeM }); return fn(h, cam, o); },
  ]));
}

/**
 * 한 계층을 재서 한 줄 결과를 돌려준다. 첫 반복(cold: JIT·첫 호출 비용 포함)과 나머지(warm)를 따로 잰다.
 * 측정 순서: 법선 원뿔·priority 마스크는 makeRealStages 에서 먼저 만들고, 단계별 cold → warm 을 잰 뒤, loadDefaultImpls(지연 import)를
 * 기다리고 나서 cachedNormalCones 을 데운 후 결합 경로 cold → warm 을 잰다. 따라서 cold 에 원뿔 생성과 지연 import 는 들어가지 않는다.
 * staged/combined 는 warm. cold.staged/cold.combined 는 첫 반복(시점 수만큼 표본).
 * stageMedianMs: 단계별 median, stagesSumMs: 네 단계 합의 시점당 median·p95·max, combinedMs: cullAndSelectDefault(prioritize) 시점당.
 * removal: cullAndSelect 가 낸 단계별 새 제거 리프 수의 합(모든 호출), calls: 결합 경로 단계 구현이 받은 pointSizeM 기록.
 */
export async function measureScene(hierarchy, cameras, { repeats = 3, now, pointSizeM = POINT_SIZE_M, thresholdPx = THRESHOLD_PX, modules = REAL_MODULES } = {}) {
  const stages = makeRealStages(hierarchy, cameras, { pointSizeM, modules });
  const cold = { staged: measureCullCost(hierarchy, cameras, { stages, repeats: 1, now }) };
  const staged = measureCullCost(hierarchy, cameras, { stages, repeats, now });

  const defaults = await loadDefaultImpls();
  // Warm up cachedNormalCones before measuring combined cold to exclude cone creation from timing
  cachedNormalCones(hierarchy, leafNormalCones);
  const calls = [];
  const removal = { backface: 0, occlusion: 0, frustum: 0, distance: 0 };
  const combinedStages = {
    cullAndSelectDefault: async (h, cam) => {
      const r = await cullAndSelectDefault(h, cam, {
        thresholdPx, pointSizeM, prioritize: true,
        stageImpls: traceStageImpls(defaults.stageImpls, calls), orderChunks: defaults.orderChunks, isDegenerateView: defaults.isDegenerateView,
      });
      const s = r.cull.stats;
      removal.backface += s.removedBackface; removal.occlusion += s.removedOcclusion;
      removal.frustum += s.removedFrustum; removal.distance += s.removedDistance;
    },
  };
  cold.combined = await measureCullCostAsync(hierarchy, cameras, { stages: combinedStages, repeats: 1, now });
  const combined = await measureCullCostAsync(hierarchy, cameras, { stages: combinedStages, repeats, now });
  return { staged, combined, cold, removal, calls };
}

export const TABLE_HEADER = ['점', '리프', 'frustum', 'backface', 'occlusion', 'priority', '단계합 median', '단계합 p95', 'cullAndSelectDefault median', 'cullAndSelectDefault p95', '단계합 cold median', 'cullAndSelectDefault cold median'];

/** measureScene 결과 한 줄(표 행). 숫자는 ms, 소수 둘째 자리. 앞 열은 warm, 마지막 둘은 cold(첫 반복). */
export function tableRow(pointCount, leafCount, { staged, combined, cold }) {
  const f = (x) => x.toFixed(2);
  const c = combined.perStageMs.cullAndSelectDefault;
  return [
    String(pointCount), String(leafCount),
    ...STAGE_NAMES.map((n) => f(staged.perStageMs[n].median)),
    f(staged.perViewMs.median), f(staged.perViewMs.p95), f(c.median), f(c.p95),
    f(cold.staged.perViewMs.median), f(cold.combined.perStageMs.cullAndSelectDefault.median),
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
