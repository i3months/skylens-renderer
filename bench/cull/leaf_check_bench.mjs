// 단계별 검사 비용 측정(F-154, F-163): flat_boxes 계층에서 frustum·distance·predict·occlusion·orderChunks·client 시점당 시간을 잰다.
// 사용: node bench/cull/leaf_check_bench.mjs [--scale small|large] [--runs N] [--json 경로]
// scale: 'small'(기본, 점 ~6.6k) 또는 'large'(점 26만). 단계별 시간은 flat_boxes 계층으로 잰다.
// 검사 캐시 자체는 별도로 합성 계층(노드 26만·리프 약 19만, F-154 실패 상황 규모)에서 첫 호출·미스·적중을 잰다(leaf_check 절).
// 각 단계는 시점 3개를 한 번씩 돌린 합(ms)을 N 번 되풀이해 그중 최소값을 보고한다(최소값 = 잡음이 가장 적은 표본).
// 첫 호출(새 계층·캐시 비어 있음, 앞 단계로 인한 JIT 워밍 포함), 캐시 미스, 캐시 적중 3가지 경우를 분리하여 측정한다.
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
import { checkLeafIndexOneToOne } from '../../server/cull/degenerate/leaf_check.mjs';
import { leafBoxesOf, clientFrustumCull } from '../../client/cull/index.mjs';

const USAGE = 'usage: node bench/cull/leaf_check_bench.mjs [--scale small|large] [--runs N] [--points N] [--json path]\n  --runs, --points: positive integers; --scale: small (default) or large';
const die = (msg) => { console.error(`error: ${msg}\n${USAGE}`); process.exit(1); };
const knownFlags = new Set(['--scale', '--runs', '--points', '--json', '--help', '-h']);
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) die(`${name} needs a value`);
  return v;
};
const posInt = (name, dflt) => {
  const v = arg(name, undefined);
  if (v === undefined) return dflt;
  if (!/^[1-9][0-9]*$/.test(v) || !Number.isSafeInteger(Number(v))) die(`${name} must be a positive integer, got '${v}'`);
  return Number(v);
};

// --help/-h 처리
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

// 알 수 없는 플래그·중복 플래그 검사
const flagCounts = {};
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg.startsWith('--')) {
    if (!knownFlags.has(arg)) die(`unknown flag: ${arg}`);
    flagCounts[arg] = (flagCounts[arg] || 0) + 1;
    if (flagCounts[arg] > 1) die(`duplicate flag: ${arg}`);
    // 플래그에 값이 필요한 경우 여기서 검사
    if (['--scale', '--runs', '--points', '--json'].includes(arg)) {
      if (i + 1 >= process.argv.length || process.argv[i + 1].startsWith('--')) {
        die(`${arg} needs a value`);
      }
    }
  }
}
const SCALE = arg('--scale', 'small');
if (SCALE !== 'small' && SCALE !== 'large') die(`--scale must be small or large, got '${SCALE}'`);
const RUNS = posInt('--runs', 15);
const POINTS = posInt('--points', SCALE === 'large' ? 260000 : 6664); // default small: ~6.6k, large: ~260k
// large uses a smaller maxLeafPoints and deeper levels so it yields a distinctly larger leaf count (~22.7k vs ~1.9k at 260k points).
const HIER_OPTS = SCALE === 'large'
  ? { edge0M: 0.5, levelCount: 8, maxLeafPoints: 32 }
  : { edge0M: 0.5, levelCount: 6, maxLeafPoints: 256 };
const POINT_SIZE_M = 0.05;
const VIEWS = ['aerial_overview', 'street_level', 'tower_mid'];

const cloud = generate({ seed: 1, count: POINTS }).cloud;
const hierarchy = buildHierarchy(cloud, HIER_OPTS);
const vps = JSON.parse(readFileSync(new URL('../../fixtures/viewpoints/synthetic.json', import.meta.url), 'utf8')).viewpoints;
const cameras = VIEWS.map((name) => {
  const vp = vps.find((v) => v.name === name);
  if (!vp) throw new Error(`bench: 시점 없음: ${name}`);
  return viewpointToCamera({ eye: vp.eye, target: vp.target, up: vp.up, width: 320, height: 180, fov_y_deg: vp.fov_y_deg });
});
const masksBase = cameras.map((c) => frustumCull(hierarchy, c, { pointSizeM: POINT_SIZE_M }));
const pyramidsBase = cameras.map((c) => buildDepthPyramid(hierarchy, c, { pointSizeM: POINT_SIZE_M }));
const leafBoxes = leafBoxesOf(hierarchy.octree);

const stages = (hierarchy, masks = masksBase, pyramids = pyramidsBase) => ({
  frustum: (c) => frustumCull(hierarchy, c, { pointSizeM: POINT_SIZE_M }),
  distance: (c) => distanceCull(hierarchy, c, { maxDistanceM: 150 }),
  predict: (c) => predictiveMask(hierarchy, { camera: c, velocityMps: [1, 0, 0], angularRadPerS: [0, 0.1, 0] }, { horizonS: 1, steps: 2, pointSizeM: POINT_SIZE_M }),
  occlusion: (c, i) => occlusionCull(hierarchy, c, pyramids[i]),
  orderChunks: (c, i) => orderChunks(hierarchy, c, masks[i]),
  client: (c) => clientFrustumCull(leafBoxesOf(hierarchy.octree), c, { pointSizeM: POINT_SIZE_M }),
});
// 캐시 미스용 계층: leafIndex 를 slice() 로 복사해 새 캐시 키를 만든다(나머지 배열은 공유).
const missHierarchy = () => ({ ...hierarchy, octree: { ...hierarchy.octree, leafIndex: hierarchy.octree.leafIndex.slice() } });
const hitStages = stages(hierarchy);

const result = {};
for (const name of Object.keys(hitStages)) {
  const fn = hitStages[name];
  // 첫 호출: 단계마다 새로 빌드한 계층(캐시 비어 있음)에서 잰다. 계층 빌드는 시간에 넣지 않는다.
  // 단, 앞 단계가 이미 코드를 달궜으므로 JIT 비용은 단계 순서에 따라 일부 빠진다(cold-process 값이 아님).
  const fresh = buildHierarchy(cloud, HIER_OPTS);
  // 마스크·피라미드는 기본 계층에서 미리 만든 것을 쓴다(같은 입력이라 내용 동일, fresh 의 캐시를 건드리지 않음).
  const freshFn = stages(fresh)[name];
  const firstCallTime = (() => {
    const t0 = performance.now();
    cameras.forEach((c, i) => freshFn(c, i));
    return performance.now() - t0;
  })();

  // 캐시 미스 시간 측정: leafIndex 를 slice() 로 복사해 새 키를 만들고 전체 검사를 다시 돌게 한다
  let minMiss = Infinity;
  for (let r = 0; r < RUNS; r++) {
    const missFn = stages(missHierarchy())[name];
    const t0 = performance.now();
    cameras.forEach((c, i) => missFn(c, i));
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
    'warm-JIT 첫 호출': firstCallTime,
    miss: minMiss,
    hit: minHit
  };
}

// leaf_check 절: 합성 계층(노드 26만·리프 19만)에서 검사 함수만 직접 잰다.
const LC_NODES = 260000;
const LC_LEAVES = 190000;
const lcIndex = new Int32Array(LC_NODES).fill(-1);
for (let k = 0; k < LC_LEAVES; k++) lcIndex[LC_NODES - 1 - k] = k;
const lcBoxMin = new Float32Array(3 * LC_NODES);
const lcBoxMax = new Float32Array(3 * LC_NODES).fill(1);
const lcOc = { leafIndex: lcIndex, boxMin: lcBoxMin, boxMax: lcBoxMax, leafCount: LC_LEAVES, nodeCount: LC_NODES };
const timeIt = (fn) => { const t0 = performance.now(); fn(); return performance.now() - t0; };
const lcFirst = timeIt(() => checkLeafIndexOneToOne(lcOc));
let lcMiss = Infinity;
for (let r = 0; r < RUNS; r++) {
  const oc = { ...lcOc, leafIndex: lcIndex.slice() };
  lcMiss = Math.min(lcMiss, timeIt(() => checkLeafIndexOneToOne(oc)));
}
let lcHit = Infinity;
for (let r = 0; r < RUNS; r++) lcHit = Math.min(lcHit, timeIt(() => checkLeafIndexOneToOne(lcOc)));
result.leaf_check = { 'warm-JIT 첫 호출': lcFirst, miss: lcMiss, hit: lcHit };

const info = {
  scale: SCALE,
  node: process.version,
  points: cloud.count,
  leafCount: hierarchy.octree.leafCount,
  nodeCount: hierarchy.octree.nodeCount,
  runs: RUNS,
  leafCheckNodes: LC_NODES,
  leafCheckLeaves: LC_LEAVES
};

console.log(JSON.stringify(info));
console.log('stage\twarm-JIT 첫 호출 ms\tmiss ms\thit ms');
for (const [k, v] of Object.entries(result)) {
  console.log(`${k}\t${v['warm-JIT 첫 호출'].toFixed(3)}\t${v.miss.toFixed(3)}\t${v.hit.toFixed(3)}`);
}

const jsonPath = arg('--json');
if (jsonPath) {
  try {
    writeFileSync(jsonPath, JSON.stringify({ ...info, measurements: result }, null, 2));
  } catch (err) {
    die(`failed to write JSON file: ${err.message}`);
  }
}
