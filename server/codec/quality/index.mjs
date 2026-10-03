// T09.10 양자화 후 화질: 원 f32 점 렌더 대 codec 1 왕복(위치 u16·법선 oct·색 무손실/QUANT2) 렌더의 SSIM.
// 시점·래스터러·점 크기 규칙은 server/cull/combine/combine_quality.test.mjs 와 같다(320×180, 점 지름 0.75 m, 8 시점).
import { readFileSync } from 'node:fs';
import { generate as genFlat } from '../../../fixtures/scenes/flat_boxes/index.mjs';
import { generate as genTerrain } from '../../../fixtures/scenes/terrain/index.mjs';
import { generate as genHoles } from '../../../fixtures/scenes/holes/index.mjs';
import { viewpointToCamera } from '../../../tools/render_views/index.mjs';
import { renderPoints } from '../../raster_ref/zbuffer/index.mjs';
import { ssim } from '../../metrics/ssim/index.mjs';
import { packChunk } from '../../asset/pack/index.mjs';
import { unpackChunk } from '../../asset/unpack/index.mjs';
import { groupByTile } from '../../asset/tile_index/index.mjs';
import { FORMAT_POINT27 } from '../../../contracts/asset/index.mjs';
import { encodeChunk, decodeChunk } from '../chunk/index.mjs';

export const QUALITY_MIN_SSIM = 0.98;
export const W = 320, H = 180, POINT_SIZE_M = 0.75;

const FLAT_VP = JSON.parse(readFileSync(new URL('../../../fixtures/viewpoints/synthetic.json', import.meta.url), 'utf8')).viewpoints
  .map((vp) => ({ name: vp.name, eye: vp.eye, target: vp.target, up: vp.up, fov: vp.fov_y_deg }));
const GROUND_VP = [
  { name: 'top_down_150', eye: [0, 150, 0.01], target: [0, 15, 0] },
  { name: 'oblique_sw_120', eye: [-140, 120, -140], target: [0, 15, 0] },
  { name: 'east_90', eye: [140, 90, 0], target: [-20, 15, 0] },
  { name: 'south_60', eye: [0, 60, 140], target: [0, 15, 0] },
  { name: 'low_ne_30', eye: [100, 30, 100], target: [0, 15, -30] },
  { name: 'west_45', eye: [-120, 45, 60], target: [40, 10, -20] },
  { name: 'far_north_150', eye: [60, 150, -160], target: [0, 15, 20] },
  { name: 'inside_100', eye: [-50, 100, -50], target: [50, 10, 50] },
].map((vp) => ({ ...vp, up: [0, 1, 0], fov: 90 }));

export const SCENES = {
  flat_boxes: { gen: () => genFlat({ seed: 1, count: 200000 }), vps: FLAT_VP },
  terrain: { gen: () => genTerrain({ seed: 1, count: 200000 }), vps: GROUND_VP },
  holes: { gen: () => genHoles({ seed: 1, count: 100000 }), vps: GROUND_VP },
};

/** 점군(format 1) → 타일별 조각 → packChunk(codec 0) → encodeChunk → decodeChunk → toSource 복원 → 합친 점군. */
export function codecRoundTrip(cloud, { lossyColor = false } = {}) {
  const groups = groupByTile(cloud.positions);
  const parts = [];
  let total = 0, rawBytes = 0, codecBytes = 0;
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
    const raw = packChunk({
      format: FORMAT_POINT27, segmentId: 1, level: 0, lod: 0, chunkIndex: ci,
      anchor: { lat: 0, lon: 0, alt: 0 }, fields: { positions, normals, colors },
    });
    const enc = encodeChunk(raw, { lossyColor });
    const back = decodeChunk(enc);
    const { fields } = unpackChunk(back);
    parts.push(fields);
    total += n; rawBytes += raw.length; codecBytes += enc.length;
  });
  const out = { format: FORMAT_POINT27, count: total, positions: new Float32Array(3 * total), normals: new Float32Array(3 * total), colors: new Uint8Array(3 * total) };
  let o = 0;
  for (const f of parts) {
    out.positions.set(f.positions, 3 * o); out.normals.set(f.normals, 3 * o); out.colors.set(f.colors, 3 * o);
    o += f.positions.length / 3;
  }
  return { cloud: out, chunks: groups.length, rawBytes, codecBytes };
}

/**
 * 한 장면 8 시점: 원본 렌더 대 왕복 후 렌더의 SSIM.
 * @returns {{sceneId: string, rows: {vp: string, ssim: number}[], min: number, chunks: number, rawBytes: number, codecBytes: number}}
 */
export function codecQualityEight(sceneId, { lossyColor = false, pointSizeM = POINT_SIZE_M, mutate } = {}) {
  const sc = SCENES[sceneId];
  if (!sc) throw new Error(`quality: 알 수 없는 장면 ${sceneId}`);
  const { cloud } = sc.gen();
  let rt = codecRoundTrip(cloud, { lossyColor });
  if (mutate) rt.cloud = mutate(rt.cloud); // 시험 전용: 왕복 결과를 일부러 훼손(변이)
  if (rt.cloud.count !== cloud.count) throw new Error(`quality: 점 수 불일치 ${rt.cloud.count} != ${cloud.count}`);
  const rows = sc.vps.map((vp) => {
    const cam = viewpointToCamera({ eye: vp.eye, target: vp.target, up: vp.up, width: W, height: H, fov_y_deg: vp.fov });
    const a = renderPoints(cam, cloud, { pointSizeM });
    const b = renderPoints(cam, rt.cloud, { pointSizeM });
    return { vp: vp.name, ssim: ssim(a.color, b.color, W, H, 3) };
  });
  return { sceneId, rows, min: Math.min(...rows.map((r) => r.ssim)), chunks: rt.chunks, rawBytes: rt.rawBytes, codecBytes: rt.codecBytes };
}
