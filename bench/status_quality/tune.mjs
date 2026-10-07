// T13.HQ 현황판 화질 측정 도구(사람 결정: 대역폭 상한 없음, 화질 우선). 새로 작성한 코드이며 외부 코드를 차용하지 않았다.
// 솎기·구간 바이트 예산 없이 원본 점 전부를 S6 송출 구성(codec 1, 무손실)으로 보낸다고 보고, 같은 점군에서
//   (1) S6 송출 경로 웹소켓 프레임 바이트(출력 전용, 문턱 없음)와 (2) 8시점 SSIM(기준 = 원본 렌더)을 잰다.
// SSIM 경로: 컬링+LOD 선택 → 64 m 타일 조각 팩 → codec 1 → 클라이언트 복호 → CPU 참조 래스터러(WebGL 제외).
import { viewpointToCamera } from '../../tools/render_views/index.mjs';
import { renderPoints } from '../../server/raster_ref/zbuffer/index.mjs';
import { ssim } from '../../server/metrics/ssim/index.mjs';
import { buildHierarchy, materialize } from '../../server/lod/select/index.mjs';
import { cullAndSelectDefault } from '../../server/cull/combine/index.mjs';
import { packCloudPieces } from '../proto/measure.mjs';
import { encodeChunk } from '../../server/codec/chunk/index.mjs';
import { encodeMessage } from '../../server/proto/codec/index.mjs';
import { encodeFrame, OPCODES } from '../../server/ws/frame/index.mjs';
import { W, H, TAU, POINT_SIZE_M, LEVEL_COUNT, MAX_LEAF, EDGE0_M, chunkedRoundTrip } from './index.mjs';
import { variantOf } from './variants.mjs';

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

// 기준 렌더(솎기 전 원본 장면) 캐시: 같은 장면·점 수를 여러 구성으로 잴 때 다시 그리지 않는다.
// 시드·점 수별로 계속 쌓이면 메모리가 늘므로 최근 사용한 SCENE_CACHE_MAX 개만 보관한다(Map 삽입 순서 = 오래된 순, 적중 시 맨 뒤로 옮긴다).
// 키는 flat_boxes 면 '시드:점수'(기존 그대로), 변형 장면이면 '변형:시드:점수' 다.
export const SCENE_CACHE_MAX = 2;
const sceneCache = new Map();
/** 시험용: 현재 보관 중인 장면 수와 키(오래된 순). */
export function sceneCacheKeys() { return [...sceneCache.keys()]; }
function scene(seed, count, variant = 'flat_boxes') {
  const v = variantOf(variant);
  const key = variant === 'flat_boxes' ? `${seed}:${count}` : `${variant}:${seed}:${count}`;
  let e = sceneCache.get(key);
  if (e) {
    sceneCache.delete(key);
    sceneCache.set(key, e);
  } else {
    const cloud = v.generate(seed, count);
    const cams = v.viewpoints.map((vp) => viewpointToCamera({ eye: vp.eye, target: vp.target, up: vp.up, width: W, height: H, fov_y_deg: vp.fov_y_deg }));
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

// 장면(flat_boxes·변형)의 4수준 원본: levels 장면과 같은 8:4:2:1 사다리, 낮은 수준은 최고 수준에서 앞에서부터 균등 간격으로 뽑은 부분집합.
// 송출은 수준마다 이 원본 점 전부다(솎지 않는다).
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
 * 장면(기본 flat_boxes) 원본 점 전부(4수준 사다리)를 S6 송출 경로로 보냈을 때의 바이트와, 고른 수준만 그린 8시점 SSIM.
 * 수준 3(최고 수준 = 원본 점 전부)이 정상 상태 화면이다.
 * @param {{count?:number, sceneSeed?:number, levels?:number[], pointSizeScale?:number, bwOnly?:boolean, variant?:string}} [opts]
 *   count: 최고 수준 점 수(기본 2,500,000 = SPEC 규모, buildings 는 생성 가능한 최대 49,284 — variants.mjs). sceneSeed: 장면 시드(기본 1).
 *   levels: SSIM 을 잴 수준(기본 [3]).
 *   variant: 'flat_boxes'(기본) | 'depth_noise' | 'buildings' (T13.HQ 계약, 알 수 없는 값은 RangeError). 변형마다 장면 생성기와
 *   고정 시점 8곳이 다르고(variants.mjs), 경로(원본 점 전부·codec 1·컬링+LOD·CPU 래스터)·320x180 은 같다.
 * @returns {Promise<{bytes:number, levelPoints:number[], levelBytes:number[],
 *   levels:{level:number, points:number, ssimMin:number, ssimMean:number, ssims:number[], sentMean:number}[]}>}
 */
export async function evaluateFullSend(opts = {}) {
  const variant = opts.variant ?? 'flat_boxes';
  const sc = scene(opts.sceneSeed ?? 1, opts.count ?? variantOf(variant).defaultCount, variant);
  const sources = ladder(sc.cloud);
  const levelBytes = sources.map((c, level) => s6PathBytes(c, { level }));
  const out = { bytes: levelBytes.reduce((a, b) => a + b, 0), levelPoints: sources.map((c) => c.count), levelBytes, levels: [] };
  if (opts.bwOnly) return out;
  for (const level of opts.levels ?? [3]) out.levels.push({ level, points: sources[level].count, ...(await viewSsims(sc, sources[level], opts.pointSizeScale)) });
  return out;
}
