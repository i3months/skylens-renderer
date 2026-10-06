// T15.10b-B3: 8시점 SSIM 측정 도우미. client/tower/terrain/ssim_views.test.mjs 2부 절차의 사본이다.
// - 기준 영상: 같은 DEM 의 LOD 0 타일 메시(terrainTileToMesh)를 ref_trace(독립 광선 교차, 정점 법선 보간)로 그린 것, 음영 = server/raster_ref/shade.
// - 대상: 층과 같은 경로(정점 법선 보간 램버트, rasterizeTriangles). 클라이언트 층(createTerrainLayer)은 묶음 안 cells 가 같아야 해서
//   타일별 간격 변형은 넣을 수 없다. 그래서 buildLayerMesh 를 이 파일에 복사해 cells 가 섞인 묶음을 받게 했다(정점·삼각형·법선 규칙은 같다).
//   cells 가 같은 묶음에서 이 사본이 제품 buildLayerMesh 와 비트 단위로 같은지는 b3_measure.mjs 가 대조한다.
// - 시점: towerViewpoints()(160×90, 눈 높이 17 m 미만이면 17 m 로 올림 — 결정 0046 의 S9 와 다른 점 그대로).
import { createTracer } from '../../../client/tower/terrain/ref_trace.mjs';
import { rasterizeTriangles } from '../../../client/tower/terrain/raster.mjs';
import { faceNormalEnu, shadeLambert } from '../../../client/tower/terrain/shade.mjs';
import { emptyResult } from '../../../contracts/raster/index.mjs';
import { TERRAIN_DEFAULTS } from '../../../contracts/controlview/terrain.mjs';
import { lambert as serverLambert } from '../../../server/raster_ref/shade/index.mjs';
import { terrainTileToMesh } from '../../../server/terrain/mesh_lod/index.mjs';
import { ssim } from '../../../server/metrics/ssim/index.mjs';

const TILE = 64;

/** ssim_views.test.mjs concatMeshes 사본: 타일 메시들을 하나로(정점 공유 없음). */
export function concatMeshes(meshes) {
  let nv = 0, ni = 0;
  for (const m of meshes) { nv += m.positions.length; ni += m.indices.length; }
  const positions = new Float32Array(nv);
  const indices = new Uint32Array(ni);
  let pv = 0, pi = 0;
  for (const m of meshes) {
    positions.set(m.positions, pv);
    const base = pv / 3;
    for (let k = 0; k < m.indices.length; k++) indices[pi + k] = m.indices[k] + base;
    pv += m.positions.length; pi += m.indices.length;
  }
  return { positions, indices };
}

/** client/tower/terrain/mesh.mjs buildLayerMesh 의 사본. 다른 점: 타일마다 cells 가 달라도 된다. */
export function buildMixedLayerMesh(tiles) {
  let nv = 0, nt = 0;
  for (const t of tiles) { nv += t.cells * t.cells; nt += (t.cells - 1) * (t.cells - 1) * 2; }
  const positions = new Float32Array(nv * 3);
  const indices = new Uint32Array(nt * 3);
  const tileOfTriangle = new Int32Array(nt);
  const edgeVerts = []; // 가장자리 정점의 positions 오프셋
  let vBase = 0, p = 0, tri = 0;
  tiles.forEach((t, n) => {
    const c = t.cells;
    const step = TILE / (c - 1);
    const x0 = t.tx * TILE, y0 = t.ty * TILE;
    for (let j = 0; j < c; j++) {
      for (let i = 0; i < c; i++) {
        const k = (vBase + j * c + i) * 3;
        positions[k] = i === c - 1 ? (t.tx + 1) * TILE : x0 + i * step;
        positions[k + 1] = j === c - 1 ? (t.ty + 1) * TILE : y0 + j * step;
        positions[k + 2] = t.heights[j * c + i];
        if (i === 0 || j === 0 || i === c - 1 || j === c - 1) edgeVerts.push(k);
      }
    }
    for (let j = 0; j < c - 1; j++) {
      for (let i = 0; i < c - 1; i++) {
        const a = vBase + j * c + i, b = a + 1, d = a + c, e = d + 1;
        indices[p++] = a; indices[p++] = b; indices[p++] = e;
        indices[p++] = a; indices[p++] = e; indices[p++] = d;
      }
    }
    const tc = (c - 1) * (c - 1) * 2;
    tileOfTriangle.fill(n, tri, tri + tc);
    tri += tc;
    vBase += c * c;
  });
  // 정점 법선: 면 외적 합 → 가장자리 정점은 위치 (x,y,z) 가 같은 것끼리 합 공유 → 단위화(mesh.mjs vertexNormals 와 같은 규칙).
  const acc = new Float64Array(positions.length);
  for (let o = 0; o < indices.length; o += 3) {
    const a = 3 * indices[o], b = 3 * indices[o + 1], d = 3 * indices[o + 2];
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[d] - positions[a], vy = positions[d + 1] - positions[a + 1], vz = positions[d + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    acc[a] += nx; acc[a + 1] += ny; acc[a + 2] += nz;
    acc[b] += nx; acc[b + 1] += ny; acc[b + 2] += nz;
    acc[d] += nx; acc[d + 1] += ny; acc[d + 2] += nz;
  }
  if (tiles.length > 1) {
    const groups = new Map();
    for (const k of edgeVerts) {
      const key = `${positions[k]},${positions[k + 1]},${positions[k + 2]}`;
      const g = groups.get(key);
      if (g) g.push(k); else groups.set(key, [k]);
    }
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      let sx = 0, sy = 0, sz = 0;
      for (const k of g) { sx += acc[k]; sy += acc[k + 1]; sz += acc[k + 2]; }
      for (const k of g) { acc[k] = sx; acc[k + 1] = sy; acc[k + 2] = sz; }
    }
  }
  const normals = new Float32Array(positions.length);
  for (let k = 0; k < acc.length; k += 3) {
    const x = acc[k], y = acc[k + 1], z = acc[k + 2];
    const len = Math.hypot(x, y, z);
    if (len > 0 && Number.isFinite(len)) { normals[k] = x / len; normals[k + 1] = y / len; normals[k + 2] = z / len; } else normals[k + 2] = 1;
  }
  return { positions, indices, tileOfTriangle, normals };
}

/** 층 render 와 같은 경로로 그린다(createTerrainLayer: 삼각형 색 한 번 + 화소별 정점 법선 램버트). */
export function renderMixed(cams, tiles) {
  const mesh = buildMixedLayerMesh(tiles);
  const { lightDirEnu, baseRgb, ambient } = TERRAIN_DEFAULTS;
  const lambert = shadeLambert([0, 0, 1], lightDirEnu, baseRgb, ambient).lambert;
  const triCount = mesh.indices.length / 3;
  const colors = new Array(triCount);
  for (let t = 0; t < triCount; t++) colors[t] = shadeLambert(faceNormalEnu(mesh.positions, mesh.indices, t), lightDirEnu, baseRgb, ambient);
  return cams.map((cam) => {
    const out = emptyResult(cam.width, cam.height);
    rasterizeTriangles(cam, mesh, (tri) => colors[tri], out, { lambert });
    return out;
  });
}

/** 기준 영상 8시점(LOD 0 타일 메시, 정점 법선, 서버 램버트). */
export function referenceImages(cams, lod0Tiles) {
  const refMesh = concatMeshes(lod0Tiles.map((t) => terrainTileToMesh(t)));
  const tracer = createTracer(refMesh, { normals: 'vertex' });
  const shadeFn = (normal) => serverLambert(normal, TERRAIN_DEFAULTS.lightDirEnu, TERRAIN_DEFAULTS.baseRgb, { ambient: TERRAIN_DEFAULTS.ambient });
  return cams.map((c) => tracer(c, shadeFn));
}

/** 시점별 SSIM 배열(ssim_views 와 같은 전체 창 평균, 3채널). */
export function ssimViews(cams, imgs, refs) {
  return cams.map((c, v) => ssim(imgs[v].color, refs[v].color, c.width, c.height, 3));
}
