// 단계별 검사 비용 측정(F-154, F-163): flat_boxes 계층에서 frustum·distance·predict·occlusion·orderChunks·client 시점당 시간을 잰다.
// 사용: node bench/cull/leaf_check_bench.mjs [--scale small|large] [--runs N] [--json 경로]
// scale: 'small'(기본, ~6.6k points·~6.6k nodes) 또는 'large'(~260k points·~260k nodes·~190k leaves)
// 각 단계는 시점 3개를 한 번씩 돌린 합(ms)을 N 번 되풀이해 그중 최소값을 보고한다(최소값 = 잡음이 가장 적은 표본).
// 첫 호출(캐시 비어 있음), 캐시 미스, 캐시 적중 3가지 경우를 분리하여 측정한다.
// 다른 커밋과 비교하려면 이 파일을 그 커밋의 git worktree 의 bench/cull/ 에 복사해 같은 명령으로 돈다.
import { writeFileSync, readFileSync } from 'node:fs';
import { generate } from '../../fixtures/scenes/flat_boxes/index.mjs';
import { viewpointToCamera } from '../../tools/render_views/index.mjs';
import { buildHierarchy } from '../../server/lod/hierarchy/index.mjs';
import { frustumCull } from '../../server/cull/frustum/index.mjs';
import { distanceCull } from '../../server/cull/distance/index.mjs';
import { predictiveMask } from '../../server/cull/predict/index.mjs';
import { buildDepthPyramid, occlusionCull } from '../../server/cull/occlusion/index.mjs';
import { orderChunks } from '../../server/cull/priority/index.mjs';
import { leafBoxesOf, clientFrustumCull } from '../../client/cull/index.mjs';

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const SCALE = arg('--scale', 'small'); // 'small' 또는 'large'
const RUNS = Number(arg('--runs', 15));
const POINTS = SCALE === 'large' ? 260000 : 6664; // small: ~6.6k, large: ~260k
const POINT_SIZE_M = 0.05;
const VIEWS = ['aerial_overview', 'street_level', 'tower_mid'];

const cloud = generate({ seed: 1, count: POINTS }).cloud;
const hierarchy = buildHierarchy(cloud, { edge0M: 0.5, levelCount: 6, maxLeafPoints: 256 });
const vps = JSON.parse(readFileSync(new URL('../../fixtures/viewpoints/synthetic.json', import.meta.url), 'utf8')).viewpoints;
const cameras = VIEWS.map((name) => {
  const vp = vps.find((v) => v.name === name);
  if (!vp) throw new Error(`bench: 시점 없음: ${name}`);
  return viewpointToCamera({ eye: vp.eye, target: vp.target, up: vp.up, width: 320, height: 180, fov_y_deg: vp.fov_y_deg });
});
const masks = cameras.map((c) => frustumCull(hierarchy, c, { pointSizeM: POINT_SIZE_M }));
const pyramids = cameras.map((c) => buildDepthPyramid(hierarchy, c, { pointSizeM: POINT_SIZE_M }));
const leafBoxes = leafBoxesOf(hierarchy.octree);

const stages = {
  frustum: (c) => frustumCull(hierarchy, c, { pointSizeM: POINT_SIZE_M }),
  distance: (c) => distanceCull(hierarchy, c, { maxDistanceM: 150 }),
  predict: (c) => predictiveMask(hierarchy, { camera: c, velocityMps: [1, 0, 0], angularRadPerS: [0, 0.1, 0] }, { horizonS: 1, steps: 2, pointSizeM: POINT_SIZE_M }),
  occlusion: (c, i) => occlusionCull(hierarchy, c, pyramids[i]),
  orderChunks: (c, i) => orderChunks(hierarchy, c, masks[i]),
  client: (c) => clientFrustumCull(leafBoxesOf(hierarchy.octree), c, { pointSizeM: POINT_SIZE_M }),
};

const result = {};
for (const [name, fn] of Object.entries(stages)) {
  // 첫 호출 시간 측정(캐시 비어 있음)
  const firstCallTime = (() => {
    const t0 = performance.now();
    cameras.forEach((c, i) => fn(c, i));
    return performance.now() - t0;
  })();

  // 캐시 미스 시간 측정: leafIndex를 slice()로 복사하여 새 키 생성
  let minMiss = Infinity;
  for (let r = 0; r < RUNS; r++) {
    // 캐시 미스를 강제하기 위해 매번 새로운 leafBoxes 생성
    const newLeafBoxes = leafBoxesOf(hierarchy.octree);
    const missedFn = name === 'client'
      ? (c) => clientFrustumCull(newLeafBoxes, c, { pointSizeM: POINT_SIZE_M })
      : fn;

    const t0 = performance.now();
    cameras.forEach((c, i) => missedFn(c, i));
    minMiss = Math.min(minMiss, performance.now() - t0);
  }

  // 캐시 적중 시간 측정(워밍업 후)
  for (let w = 0; w < 3; w++) cameras.forEach((c, i) => fn(c, i)); // 워밍업
  let minHit = Infinity;
  for (let r = 0; r < RUNS; r++) {
    const t0 = performance.now();
    cameras.forEach((c, i) => fn(c, i));
    minHit = Math.min(minHit, performance.now() - t0);
  }

  result[name] = {
    firstCall: firstCallTime,
    miss: minMiss,
    hit: minHit
  };
}

const info = {
  scale: SCALE,
  node: process.version,
  points: cloud.count,
  leafCount: hierarchy.octree.leafCount,
  nodeCount: hierarchy.octree.nodeCount,
  runs: RUNS
};

console.log(JSON.stringify(info));
console.log('stage\tfirstCall ms\tmiss ms\thit ms');
for (const [k, v] of Object.entries(result)) {
  console.log(`${k}\t${v.firstCall.toFixed(3)}\t${v.miss.toFixed(3)}\t${v.hit.toFixed(3)}`);
}

const jsonPath = arg('--json');
if (jsonPath) {
  writeFileSync(jsonPath, JSON.stringify({ ...info, measurements: result }, null, 2));
}
