// T13.T 솎기 튜닝 측정 도구. 새로 작성한 코드이며 외부 코드를 차용하지 않았다.
// 한 후보(솎기 도구 공장 + 수준별 점 배분)를 두 가지로 잰다: (1) S6 송출 구성에서 구간 바이트가 3,000,000 B 이하로 맞춰진 점 수,
// (2) 그 비율을 최고 수준 대용 장면(flat_boxes)에 적용한 8시점 SSIM(기준 = 솎기 전 원본 렌더). 방법은 연구 t13b-quality 결과 D 와 같다.
// 후보 계약: createThinner(positions: Float32Array, attrs?: {normals:Float32Array, colors:Uint8Array, count:number})
//   → { count, select(k): Uint32Array }  — 고른 원본 색인(모턴 순이면 codec 1 차분이 작아진다). 점을 만들거나 옮기지 않는다.
import { generate } from '../../fixtures/scenes/flat_boxes/index.mjs';
import { viewpointToCamera } from '../../tools/render_views/index.mjs';
import { renderPoints } from '../../server/raster_ref/zbuffer/index.mjs';
import { ssim } from '../../server/metrics/ssim/index.mjs';
import { buildHierarchy, materialize } from '../../server/lod/select/index.mjs';
import { cullAndSelectDefault } from '../../server/cull/combine/index.mjs';
import { createSpatialThinner } from '../../server/scheduler/segment_budget/index.mjs';
import { measureStatusBandwidth, S6_SEND_CONFIG } from '../status_bw/index.mjs';
import { W, H, TAU, POINT_SIZE_M, LEVEL_COUNT, MAX_LEAF, EDGE0_M, VIEWPOINTS, chunkedRoundTrip } from './index.mjs';

function subset(c, idx) {
  const n = idx.length;
  const o = { format: c.format, count: n, positions: new Float32Array(3 * n), normals: new Float32Array(3 * n), colors: new Uint8Array(3 * n) };
  for (let k = 0; k < n; k++) {
    const s = idx[k];
    for (let a = 0; a < 3; a++) { o.positions[3 * k + a] = c.positions[3 * s + a]; o.normals[3 * k + a] = c.normals[3 * s + a]; o.colors[3 * k + a] = c.colors[3 * s + a]; }
  }
  return o;
}

/**
 * @param {{createThinner?:Function, allocate?:Function(생략하면 S6_SEND_CONFIG.allocate), count?:number, seed?:number, pointSizeScale?:number, bwOnly?:boolean}} [opts]
 *   count: 구간당 최고 수준 점 수(기본 2,500,000 = SPEC 규모). pointSizeScale: 비교 렌더 점 크기 배율(기본 1).
 * @returns {Promise<{bytes:number, thinned:boolean, levelPoints:number[], levelSource:number[], ratio:number, ssimMin:number, ssimMean:number, ssims:number[], sentMean:number}>}
 */
export async function evaluateThinner(opts = {}) {
  const count = opts.count ?? 2500000;
  const bw = measureStatusBandwidth({ segments: 1, pointsPerSegment: count, seed: opts.seed ?? 1, ...S6_SEND_CONFIG, createThinner: opts.createThinner, ...(opts.allocate !== undefined ? { allocate: opts.allocate } : {}) });
  const row = bw.rows[0];
  const top = row.levels[3];
  const ratio = top.points / top.sourcePoints;
  const base = { bytes: row.frameBytes, thinned: row.thinned, levelPoints: row.levels.map((l) => l.points), levelSource: row.levels.map((l) => l.sourcePoints), ratio };
  if (opts.bwOnly) return base;
  const { cloud } = generate({ seed: 1, count });
  const makeThinner = opts.createThinner ?? createSpatialThinner;
  const thinned = subset(cloud, makeThinner(cloud.positions, cloud).select(Math.round(cloud.count * ratio)));
  const h = buildHierarchy(thinned, { edge0M: EDGE0_M, levelCount: LEVEL_COUNT, maxLeafPoints: MAX_LEAF });
  const ssims = [];
  let sent = 0;
  for (const vp of VIEWPOINTS) {
    const cam = viewpointToCamera({ eye: vp.eye, target: vp.target, up: vp.up, width: W, height: H, fov_y_deg: vp.fov_y_deg });
    const ref = renderPoints(cam, cloud, { pointSizeM: POINT_SIZE_M }).color;
    const r = await cullAndSelectDefault(h, cam, { thresholdPx: TAU, pointSizeM: POINT_SIZE_M });
    const sel = materialize(h, r.selection);
    sent += sel.count;
    const rt = chunkedRoundTrip(sel);
    ssims.push(ssim(ref, renderPoints(cam, rt.cloud, { pointSizeM: POINT_SIZE_M * (opts.pointSizeScale ?? 1) }).color, W, H, 3));
  }
  return { ...base, ssimMin: Math.min(...ssims), ssimMean: ssims.reduce((a, b) => a + b, 0) / ssims.length, ssims, sentMean: sent / VIEWPOINTS.length };
}
