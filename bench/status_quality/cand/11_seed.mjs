// 사용: node bench/status_quality/cand/11_seed.mjs <장면시드=1> <위상=기준> [점수=2500000]
// tune.mjs 의 evaluateThinner 로직을 복사해 장면 시드를 인자로 바꾼 측정. 위상을 주면 위상 변형 솎기, 생략하면 기준(createSpatialThinner).
import { generate } from '../../../fixtures/scenes/flat_boxes/index.mjs';
import { viewpointToCamera } from '../../../tools/render_views/index.mjs';
import { renderPoints } from '../../../server/raster_ref/zbuffer/index.mjs';
import { ssim } from '../../../server/metrics/ssim/index.mjs';
import { buildHierarchy, materialize } from '../../../server/lod/select/index.mjs';
import { cullAndSelectDefault } from '../../../server/cull/combine/index.mjs';
import { createSpatialThinner } from '../../../server/scheduler/segment_budget/index.mjs';
import { createPhaseThinnerFactory } from '../../../server/scheduler/segment_budget/cand_11_phase.mjs';
import { measureStatusBandwidth, S6_SEND_CONFIG } from '../../status_bw/index.mjs';
import { W, H, TAU, POINT_SIZE_M, LEVEL_COUNT, MAX_LEAF, EDGE0_M, VIEWPOINTS, chunkedRoundTrip } from '../index.mjs';

function subset(c, idx) {
  const n = idx.length;
  const o = { format: c.format, count: n, positions: new Float32Array(3 * n), normals: new Float32Array(3 * n), colors: new Uint8Array(3 * n) };
  for (let k = 0; k < n; k++) {
    const s = idx[k];
    for (let a = 0; a < 3; a++) { o.positions[3 * k + a] = c.positions[3 * s + a]; o.normals[3 * k + a] = c.normals[3 * s + a]; o.colors[3 * k + a] = c.colors[3 * s + a]; }
  }
  return o;
}

const seed = +process.argv[2] || 1;
const phaseArg = process.argv[3];
const count = +process.argv[4] || 2500000;
const createThinner = phaseArg === undefined || phaseArg === 'base' ? createSpatialThinner : createPhaseThinnerFactory(+phaseArg);
const t0 = Date.now();
const bw = measureStatusBandwidth({ segments: 1, pointsPerSegment: count, seed, ...S6_SEND_CONFIG, createThinner });
const row = bw.rows[0];
const top = row.levels[3];
const ratio = top.points / top.sourcePoints;
const { cloud } = generate({ seed, count });
const thinned = subset(cloud, createThinner(cloud.positions, cloud).select(Math.round(cloud.count * ratio)));
const h = buildHierarchy(thinned, { edge0M: EDGE0_M, levelCount: LEVEL_COUNT, maxLeafPoints: MAX_LEAF });
const ssims = [];
for (const vp of VIEWPOINTS) {
  const cam = viewpointToCamera({ eye: vp.eye, target: vp.target, up: vp.up, width: W, height: H, fov_y_deg: vp.fov_y_deg });
  const ref = renderPoints(cam, cloud, { pointSizeM: POINT_SIZE_M }).color;
  const r = await cullAndSelectDefault(h, cam, { thresholdPx: TAU, pointSizeM: POINT_SIZE_M });
  const rt = chunkedRoundTrip(materialize(h, r.selection));
  ssims.push(ssim(ref, renderPoints(cam, rt.cloud, { pointSizeM: POINT_SIZE_M }).color, W, H, 3));
}
const f = (x) => +x.toFixed(4);
console.log(JSON.stringify({ seed, phase: phaseArg ?? 'base', bytes: row.frameBytes, ratio: +ratio.toFixed(5), levelPoints: row.levels.map((l) => l.points), ssimMin: f(Math.min(...ssims)), ssimMean: f(ssims.reduce((a, b) => a + b, 0) / ssims.length), ssims: ssims.map(f), seconds: (Date.now() - t0) / 1000 }));
