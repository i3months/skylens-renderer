// 현황판 화질 측정(T13.10): 원본 점 렌더(기준) 대 '조각으로 나눠 받아 복호한 뒤 그린' 렌더의 SSIM.
// 측정 경로(CPU, 브라우저 없음): 시점마다 컬링+LOD 선택(server/cull/combine) → 선택 점을 64 m 타일 조각으로 팩(codec 0)
//   → codec 1 부호화 → 클라이언트 복호기(client/codec decodeChunkClient)로 복호 → 평면에서 위치·색을 복원 → CPU 참조 래스터러로 그린다.
// 이 경로가 재는 것은 코덱·LOD·컬링 손실뿐이다. client/raster(WebGL) 자체의 그리기 차이는 포함하지 않는다(브라우저 경로는 [local]).
import { readFileSync } from 'node:fs';
import { generate } from '../../fixtures/scenes/flat_boxes/index.mjs';
import { viewpointToCamera } from '../../tools/render_views/index.mjs';
import { renderPoints } from '../../server/raster_ref/zbuffer/index.mjs';
import { ssim } from '../../server/metrics/ssim/index.mjs';
import { packChunk } from '../../server/asset/pack/index.mjs';
import { groupByTile } from '../../server/asset/tile_index/index.mjs';
import { encodeChunk } from '../../server/codec/chunk/index.mjs';
import { decodeChunkClient } from '../../client/codec/index.mjs';
import { FORMAT_POINT27 } from '../../contracts/asset/index.mjs';
import { buildHierarchy, materialize } from '../../server/lod/select/index.mjs';
import { cullAndSelectDefault } from '../../server/cull/combine/index.mjs';

export const W = 320, H = 180, TAU = 0.5, POINT_SIZE_M = 0.75, LEVEL_COUNT = 6, MAX_LEAF = 2048, EDGE0_M = 0.5;

export const VIEWPOINTS = JSON.parse(readFileSync(new URL('../../fixtures/viewpoints/synthetic.json', import.meta.url), 'utf8')).viewpoints;

/** 점군을 타일 조각으로 팩·부호화하고, 클라이언트 복호기로 복호해 한 점군으로 합친다. */
export function chunkedRoundTrip(cloud, { lossyColor = false } = {}) {
  const groups = groupByTile(cloud.positions);
  const parts = [];
  let total = 0, bytes = 0;
  groups.forEach((g, ci) => {
    const n = g.indices.length;
    const positions = new Float32Array(3 * n), normals = new Float32Array(3 * n), colors = new Uint8Array(3 * n);
    g.indices.forEach((src, k) => {
      for (let a = 0; a < 3; a++) {
        positions[3 * k + a] = cloud.positions[3 * src + a];
        normals[3 * k + a] = cloud.normals[3 * src + a];
        colors[3 * k + a] = cloud.colors[3 * src + a];
      }
    });
    const raw = packChunk({ format: FORMAT_POINT27, segmentId: 1, level: 0, lod: 0, chunkIndex: ci, anchor: { lat: 0, lon: 0, alt: 0 }, fields: { positions, normals, colors } });
    const enc = encodeChunk(raw, { lossyColor });
    bytes += enc.length;
    const { header, planes } = decodeChunkClient(enc);
    const step = 2 ** -header.quantExp;
    const pos = new Float32Array(3 * n), col = new Uint8Array(3 * n);
    const pp = [planes.pos_e, planes.pos_n, planes.pos_u];
    for (let i = 0; i < n; i++) {
      for (let a = 0; a < 3; a++) pos[3 * i + a] = header.bboxMin[a] + pp[a][i] * step;
      col[3 * i] = planes.color_r[i]; col[3 * i + 1] = planes.color_g[i]; col[3 * i + 2] = planes.color_b[i];
    }
    // 법선은 CPU 참조 래스터러가 쓰지 않는 값이라 복호 평면에서 옮기지 않는다(위치·색만 그린다).
    parts.push({ pos, col, n });
    total += n;
  });
  const out = { format: FORMAT_POINT27, count: total, positions: new Float32Array(3 * total), normals: new Float32Array(3 * total), colors: new Uint8Array(3 * total) };
  let o = 0;
  for (const p of parts) { out.positions.set(p.pos, 3 * o); out.colors.set(p.col, 3 * o); o += p.n; }
  return { cloud: out, chunks: groups.length, bytes };
}

/**
 * 합성 장면 flat_boxes 의 시점 8곳을 잰다. 기준 = 원본 점군 렌더, 비교 = 시점별 컬링+LOD 선택 점을 조각 왕복한 렌더.
 * @returns {Promise<{rows:{vp:string, ssim:number, points:number, chunks:number, bytes:number}[], min:number, total:number}>}
 */
export async function measureStatusQuality({ count = 200000, lossyColor = false, mutate } = {}) {
  const { cloud } = generate({ seed: 1, count });
  const h = buildHierarchy(cloud, { edge0M: EDGE0_M, levelCount: LEVEL_COUNT, maxLeafPoints: MAX_LEAF });
  const rows = [];
  for (const vp of VIEWPOINTS) {
    const cam = viewpointToCamera({ eye: vp.eye, target: vp.target, up: vp.up, width: W, height: H, fov_y_deg: vp.fov_y_deg });
    const r = await cullAndSelectDefault(h, cam, { thresholdPx: TAU, pointSizeM: POINT_SIZE_M });
    const sel = materialize(h, r.selection);
    let rt = chunkedRoundTrip(sel, { lossyColor });
    if (mutate) rt = { ...rt, cloud: mutate(rt.cloud) };
    const a = renderPoints(cam, cloud, { pointSizeM: POINT_SIZE_M });
    const b = renderPoints(cam, rt.cloud, { pointSizeM: POINT_SIZE_M });
    rows.push({ vp: vp.name, ssim: ssim(a.color, b.color, W, H, 3), points: sel.count, chunks: rt.chunks, bytes: rt.bytes });
  }
  return { rows, min: Math.min(...rows.map((r) => r.ssim)), total: cloud.count };
}
