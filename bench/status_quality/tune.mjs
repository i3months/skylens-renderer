// T13.T 솎기 튜닝 측정 도구. 새로 작성한 코드이며 외부 코드를 차용하지 않았다.
// 한 후보(솎기 도구 공장 + 수준별 점 배분)를 두 가지로 잰다: (1) S6 송출 구성에서 구간 바이트가 3,000,000 B 이하로 맞춰진 점 수,
// (2) 그 비율을 최고 수준 대용 장면(flat_boxes)에 적용한 8시점 SSIM(기준 = 솎기 전 원본 렌더). 방법은 연구 t13b-quality 결과 D 와 같다(evaluateThinner).
// (1)과 (2)는 다른 장면이라, SSIM 을 잰 점군 자체의 S6 경로 바이트도 함께 잰다(ssimTargetBytes). 바이트와 SSIM 을 같은 점군에서 재는
// 방식은 evaluateFlatBoxesBudget 이다(flat_boxes 4수준을 예산에 맞추고 수준별로 그 수준만 그린 SSIM).
// 후보 계약: createThinner(positions: Float32Array, attrs?: {normals:Float32Array, colors:Uint8Array, count:number})
//   → { count, select(k): Uint32Array }  — 고른 원본 색인(모턴 순이면 codec 1 차분이 작아진다). 점을 만들거나 옮기지 않는다.
import { generate } from '../../fixtures/scenes/flat_boxes/index.mjs';
import { viewpointToCamera } from '../../tools/render_views/index.mjs';
import { renderPoints } from '../../server/raster_ref/zbuffer/index.mjs';
import { ssim } from '../../server/metrics/ssim/index.mjs';
import { buildHierarchy, materialize } from '../../server/lod/select/index.mjs';
import { cullAndSelectDefault } from '../../server/cull/combine/index.mjs';
import { measureStatusBandwidth, S6_SEND_CONFIG } from '../status_bw/index.mjs';
import { packCloudPieces } from '../proto/measure.mjs';
import { encodeChunk } from '../../server/codec/chunk/index.mjs';
import { encodeMessage } from '../../server/proto/codec/index.mjs';
import { encodeFrame, OPCODES } from '../../server/ws/frame/index.mjs';
import { fitSegmentBudget } from '../../server/scheduler/segment_budget/index.mjs';
import { SEGMENT_BUDGET_BYTES } from '../proto/index.mjs';
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

const frameLen = (msg) => encodeFrame(OPCODES.BINARY, encodeMessage(msg)).length;

/**
 * 점군 하나를 S6 송출 경로(bench/status_bw 와 같은 경로: packCloudPieces → codec 1 encodeChunk → PIECE 프레임 + LEVEL_ARRIVED 1 개)로
 * 보냈을 때의 웹소켓 프레임 바이트 합. PIECE 머리의 pieceSeq 는 고정 폭이라 바이트는 순번과 무관하다.
 */
export function s6PathBytes(cloud, { segmentId = 0, level = 3 } = {}) {
  const pieces = packCloudPieces(cloud, { segmentId, level });
  let bytes = 0;
  for (const p of pieces) bytes += frameLen({ type: 'PIECE', pieceSeq: 1, key: p.key, chunk: encodeChunk(p.skla) });
  return bytes + frameLen({ type: 'LEVEL_ARRIVED', segmentId, level, pieceCount: pieces.length, firstPieceSeq: 1 });
}

// 기준 렌더(솎기 전 원본 flat_boxes) 캐시: 같은 장면·점 수를 여러 구성으로 잴 때 다시 그리지 않는다.
// 시드·점 수별로 계속 쌓이면 메모리가 늘므로 최근 사용한 SCENE_CACHE_MAX 개만 보관한다(Map 삽입 순서 = 오래된 순, 적중 시 맨 뒤로 옮긴다).
export const SCENE_CACHE_MAX = 2;
const sceneCache = new Map();
/** 시험용: 현재 보관 중인 장면 수와 키(오래된 순). */
export function sceneCacheKeys() { return [...sceneCache.keys()]; }
function scene(seed, count) {
  const key = `${seed}:${count}`;
  let e = sceneCache.get(key);
  if (e) {
    sceneCache.delete(key);
    sceneCache.set(key, e);
  } else {
    const { cloud } = generate({ seed, count });
    const cams = VIEWPOINTS.map((vp) => viewpointToCamera({ eye: vp.eye, target: vp.target, up: vp.up, width: W, height: H, fov_y_deg: vp.fov_y_deg }));
    e = { cloud, cams, refs: cams.map((cam) => renderPoints(cam, cloud, { pointSizeM: POINT_SIZE_M }).color) };
    sceneCache.set(key, e);
    while (sceneCache.size > SCENE_CACHE_MAX) sceneCache.delete(sceneCache.keys().next().value);
  }
  return e;
}

/** 점군 shown 만 그린 8시점 SSIM(기준 = 원본 렌더). 경로는 컬링+LOD 선택 → 조각 왕복 → CPU 참조 래스터러. */
async function viewSsims(sc, shown, pointSizeScale = 1) {
  const h = buildHierarchy(shown, { edge0M: EDGE0_M, levelCount: LEVEL_COUNT, maxLeafPoints: MAX_LEAF });
  const ssims = [];
  let sent = 0;
  for (let v = 0; v < sc.cams.length; v++) {
    const cam = sc.cams[v];
    const r = await cullAndSelectDefault(h, cam, { thresholdPx: TAU, pointSizeM: POINT_SIZE_M });
    const sel = materialize(h, r.selection);
    sent += sel.count;
    const rt = chunkedRoundTrip(sel);
    ssims.push(ssim(sc.refs[v], renderPoints(cam, rt.cloud, { pointSizeM: POINT_SIZE_M * pointSizeScale }).color, W, H, 3));
  }
  return { ssimMin: Math.min(...ssims), ssimMean: ssims.reduce((a, b) => a + b, 0) / ssims.length, ssims, sentMean: sent / sc.cams.length };
}

/**
 * @param {{createThinner?:Function(생략하면 S6_SEND_CONFIG.createThinner), allocate?:Function(생략하면 S6_SEND_CONFIG.allocate), count?:number, seed?:number, sceneSeed?:number, pointSizeScale?:number, bwOnly?:boolean}} [opts]
 *   count: 구간당 최고 수준 점 수(기본 2,500,000 = SPEC 규모). seed: levels 장면 시드(기본 1). sceneSeed: flat_boxes 시드(기본 1).
 *   pointSizeScale: 비교 렌더 점 크기 배율(기본 1).
 * @returns {Promise<{bytes:number, thinned:boolean, levelPoints:number[], levelSource:number[], ratio:number, ssimTargetPoints:number,
 *   ssimTargetBytes:number, ssimMin:number, ssimMean:number, ssims:number[], sentMean:number}>}
 *   bytes 는 levels 장면 구간 4수준의 S6 경로 바이트, ssimTargetBytes 는 SSIM 을 잰 flat_boxes 점군(최고 수준 하나)을 같은 S6 경로로 보낸 바이트다.
 *   두 점군은 다른 장면이라 bytes ≤ 3,000,000 B 가 ssimTargetBytes 를 보장하지 않는다(evaluateFlatBoxesBudget 참고).
 */
export async function evaluateThinner(opts = {}) {
  const count = opts.count ?? 2500000;
  const bw = measureStatusBandwidth({ segments: 1, pointsPerSegment: count, seed: opts.seed ?? 1, ...S6_SEND_CONFIG, ...(opts.allocate !== undefined ? { allocate: opts.allocate } : {}), ...(opts.createThinner !== undefined ? { createThinner: opts.createThinner } : {}) });
  const row = bw.rows[0];
  const top = row.levels[3];
  const ratio = top.points / top.sourcePoints;
  const base = { bytes: row.frameBytes, thinned: row.thinned, levelPoints: row.levels.map((l) => l.points), levelSource: row.levels.map((l) => l.sourcePoints), ratio };
  if (opts.bwOnly) return base;
  const sc = scene(opts.sceneSeed ?? 1, count);
  const makeThinner = opts.createThinner ?? S6_SEND_CONFIG.createThinner;
  const thinned = subset(sc.cloud, makeThinner(sc.cloud.positions, sc.cloud).select(Math.round(sc.cloud.count * ratio)));
  const v = await viewSsims(sc, thinned, opts.pointSizeScale);
  return { ...base, ssimTargetPoints: thinned.count, ssimTargetBytes: s6PathBytes(thinned, { level: 3 }), ...v };
}

// flat_boxes 의 4수준 원본: levels 장면과 같은 8:4:2:1 사다리, 낮은 수준은 최고 수준에서 앞에서부터 균등 간격으로 뽑은 부분집합.
const RATIOS = [8, 4, 2, 1];
function ladder(cloud) {
  return RATIOS.map((d) => {
    const n = Math.max(1, Math.floor(cloud.count / d));
    if (n === cloud.count) return cloud;
    const idx = new Uint32Array(n);
    for (let j = 0; j < n; j++) idx[j] = Math.floor((j * cloud.count) / n);
    return subset(cloud, idx);
  });
}

/**
 * SSIM 을 재는 점군(flat_boxes) 자체를 4수준으로 만들어 S6 송출 경로 바이트로 fitSegmentBudget 예산(3,000,000 B)에 맞추고,
 * 그렇게 고른 점군으로 수준마다 그 수준만 그린 8시점 SSIM 을 잰다(기준 = 원본 렌더). 수준 3 이 정상 상태(최고 수준 도착 후) 화면,
 * 수준 0..2 는 최고 수준 도착 전 화면이다. 바이트와 SSIM 이 같은 점군에서 나온다.
 * @param {{createThinner?:Function, allocate?:Function, count?:number, sceneSeed?:number, levels?:number[]}} [opts]
 *   createThinner·allocate 생략하면 S6_SEND_CONFIG 것. levels: SSIM 을 잴 수준(기본 [0,1,2,3]).
 * @returns {Promise<{bytes:number, thinned:boolean, levelPoints:number[], levelSource:number[], levelBytes:number[],
 *   levels:{level:number, points:number, ssimMin:number, ssimMean:number, ssims:number[], sentMean:number}[]}>}
 */
export async function evaluateFlatBoxesBudget(opts = {}) {
  const sc = scene(opts.sceneSeed ?? 1, opts.count ?? 2500000);
  const makeThinner = opts.createThinner ?? S6_SEND_CONFIG.createThinner;
  const sources = ladder(sc.cloud);
  const thinners = sources.map((c) => makeThinner(c.positions, c));
  const last = [null, null, null, null];
  const build = (level, k) => {
    const kk = Math.min(k, sources[level].count);
    if (last[level]?.k === kk) return last[level];
    const cloud = subset(sources[level], thinners[level].select(kk));
    return (last[level] = { k: kk, cloud, bytes: s6PathBytes(cloud, { level }) });
  };
  const counts = sources.map((c) => c.count);
  const fit = fitSegmentBudget({
    counts,
    maxBytes: SEGMENT_BUDGET_BYTES,
    allocate: opts.allocate ?? S6_SEND_CONFIG.allocate,
    measure: (t) => t.reduce((s, k, level) => s + build(level, k).bytes, 0),
  });
  const built = fit.targets.map((k, level) => build(level, k));
  const levels = [];
  for (const level of opts.levels ?? [0, 1, 2, 3]) levels.push({ level, points: built[level].k, ...(await viewSsims(sc, built[level].cloud)) });
  return {
    bytes: built.reduce((s, b) => s + b.bytes, 0),
    thinned: fit.thinned,
    levelPoints: built.map((b) => b.k),
    levelSource: counts,
    levelBytes: built.map((b) => b.bytes),
    levels,
  };
}
