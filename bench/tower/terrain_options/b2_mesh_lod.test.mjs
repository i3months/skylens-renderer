// b2_mesh_lod 변형의 지표 검증. 측정 스크립트(b2_measure)가 쓰는 세 부분을 독립 계산과 대조한다.
// (1) 높이 상한만 준 복사본이 서버 terrainLodStride·buildTerrainTile 과 같다(복사 정확성).
// (2) 면 법선 오차(주 정의)가 메시(terrainTileToMesh) 삼각형을 직접 짝지어 잰 무차별 값과 같다.
// (3) 정점 법선 격자가 클라이언트 buildLayerMesh 의 정점 법선과 같고, 보조 정의 값이 그 메시로 직접 보간해 잰 값과 같다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLodRule, tileMinNormalCos, tileMinVertexNormalCos, vertexNormalGrid, cosToDeg } from './b2_mesh_lod.mjs';
import { terrainLodStride, buildTerrainTile, terrainTileToMesh } from '../../../server/terrain/mesh_lod/index.mjs';
import { terrainLodMaxErrorM } from '../../../contracts/tower_assets/index.mjs';
import { makeHillDem } from '../../../client/tower/terrain/fixtures.mjs';
import { buildLayerMesh } from '../../../client/tower/terrain/mesh.mjs';

const TILES = [];
for (let ty = -1; ty < 1; ty++) for (let tx = -1; tx < 1; tx++) TILES.push([tx, ty]);
const smallDem = (seed, noiseRatio) => makeHillDem({ tilesX: 2, tilesY: 2, tileMinX: -1, tileMinY: -1, seed, noiseRatio });

test('(1) 서버 실효 상한(결정 0057, 셀 크기 반영) 복사본은 서버와 간격·타일 높이가 같다', () => {
  for (const r of [0, 0.015]) {
    for (const seed of [1, 5, 7, 10, 12]) {
      const dem = makeHillDem({ seed, noiseRatio: r });
      const rule = createLodRule({ name: 't', heightCapsM: [0, 1, 2, 3].map((l) => terrainLodMaxErrorM(l, dem.cellM)) });
      for (let lod = 0; lod < 4; lod++) {
        assert.equal(rule.lodStride(dem, lod), terrainLodStride(dem, lod), `시드 ${seed} 잡음 ${r} LOD${lod}`);
        assert.deepEqual(rule.buildTile(dem, 0, -1, lod).heights, buildTerrainTile(dem, 0, -1, lod).heights);
      }
    }
  }
});

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const angDeg = (u, v) => {
  const c = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (Math.hypot(...u) * Math.hypot(...v));
  return (Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI;
};
const vtx = (m, k) => [m.positions[3 * k], m.positions[3 * k + 1], m.positions[3 * k + 2]];
/** 점 (x, y) 를 담는 삼각형 번호와 무게중심 좌표(위에서 본 xy). 변 위면 아무 쪽이나. */
function locate(m, x, y) {
  for (let t = 0; t < m.indices.length / 3; t++) {
    const [A, B, C] = [0, 1, 2].map((q) => vtx(m, m.indices[3 * t + q]));
    const det = (B[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (B[1] - A[1]);
    const l1 = ((x - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (y - A[1])) / det;
    const l2 = ((B[0] - A[0]) * (y - A[1]) - (x - A[0]) * (B[1] - A[1])) / det;
    const l0 = 1 - l1 - l2;
    if (l0 >= -1e-9 && l1 >= -1e-9 && l2 >= -1e-9) return { t, w: [l0, l1, l2] };
  }
  throw new Error(`(${x}, ${y}) 를 담는 삼각형 없음`);
}

test('(2) 면 법선 오차: 원본 삼각형 무게중심을 담는 거친 삼각형과의 각 최댓값(무차별)과 같다', () => {
  const dem = smallDem(7, 0.015);
  const n0 = 32;
  let checked = 0;
  for (const stride of [2, 4, 8]) {
    for (const [tx, ty] of TILES) {
      const i0 = (tx + 1) * n0, j0 = (ty + 1) * n0;
      const got = cosToDeg(tileMinNormalCos(dem, i0, j0, n0, stride));
      const fine = terrainTileToMesh(buildTerrainTile(dem, tx, ty, 0));
      const coarseTile = { tx, ty, lod: 0, cells: n0 / stride + 1, heights: new Float32Array((n0 / stride + 1) ** 2) };
      for (let j = 0; j <= n0 / stride; j++) for (let i = 0; i <= n0 / stride; i++) coarseTile.heights[j * coarseTile.cells + i] = dem.heights[(j0 + j * stride) * dem.width + i0 + i * stride];
      const coarse = terrainTileToMesh(coarseTile);
      const coarseN = (t) => { const [A, B, C] = [0, 1, 2].map((q) => vtx(coarse, coarse.indices[3 * t + q])); return cross(sub(B, A), sub(C, A)); };
      let max = 0;
      for (let t = 0; t < fine.indices.length / 3; t++) {
        const [A, B, C] = [0, 1, 2].map((q) => vtx(fine, fine.indices[3 * t + q]));
        const { t: ct } = locate(coarse, (A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3);
        max = Math.max(max, angDeg(cross(sub(B, A), sub(C, A)), coarseN(ct)));
      }
      assert.ok(Math.abs(got - max) < 1e-3, `간격 ${stride} 타일 (${tx},${ty}): ${got} 대 무차별 ${max}`);
      checked++;
    }
  }
  assert.equal(checked, 12);
  // 간격 1 은 오차 0
  assert.equal(tileMinNormalCos(dem, 0, 0, n0, 1), 1);
});

test('(3) 정점 법선 격자 = buildLayerMesh 법선, 보조 정의 = 그 메시로 보간한 값(무차별)', () => {
  const dem = smallDem(5, 0.015);
  const n0 = 32;
  const fineGrid = vertexNormalGrid(dem, 1, 0, 0);
  const fineMesh = buildLayerMesh(TILES.map(([tx, ty]) => buildTerrainTile(dem, tx, ty, 0)));
  for (const stride of [2, 4, 8]) {
    const grid = vertexNormalGrid(dem, stride, 0, 0);
    const cells = n0 / stride + 1;
    const tiles = TILES.map(([tx, ty]) => {
      const i0 = (tx + 1) * n0, j0 = (ty + 1) * n0, h = new Float32Array(cells * cells);
      for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) h[j * cells + i] = dem.heights[(j0 + j * stride) * dem.width + i0 + i * stride];
      return { tx, ty, lod: 0, cells, heights: h };
    });
    const mesh = buildLayerMesh(tiles);
    // 격자 대 클라이언트 법선
    let maxDiff = 0;
    tiles.forEach((tl, n) => {
      const i0 = (tl.tx + 1) * n0 / stride, j0 = (tl.ty + 1) * n0 / stride;
      for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) {
        const k = 3 * (n * cells * cells + j * cells + i), g = 3 * ((j0 + j) * grid.nx + i0 + i);
        maxDiff = Math.max(maxDiff, angDeg([mesh.normals[k], mesh.normals[k + 1], mesh.normals[k + 2]], [grid.n[g], grid.n[g + 1], grid.n[g + 2]]));
      }
    });
    assert.ok(maxDiff < 1e-3, `간격 ${stride} 법선 차 ${maxDiff}°`);
    // 보조 정의 대 무차별(타일 (0,0) 하나: 원본 표본마다 거친 삼각형을 찾아 클라이언트 법선을 보간)
    const n = TILES.findIndex(([tx, ty]) => tx === 0 && ty === 0);
    const i0 = n0, j0 = n0;
    const samples = [];
    const got = cosToDeg(tileMinVertexNormalCos(fineGrid, grid, i0, j0, n0, stride, -Infinity, samples));
    assert.equal(samples.length, (n0 + 1) ** 2);
    const one = { positions: mesh.positions, indices: mesh.indices.subarray(n * (cells - 1) ** 2 * 6, (n + 1) * (cells - 1) ** 2 * 6) };
    const fineCells = n0 + 1;
    const nf = TILES.findIndex(([tx, ty]) => tx === 0 && ty === 0);
    let max = 0;
    for (let j = 0; j <= n0; j++) for (let i = 0; i <= n0; i++) {
      const x = i * dem.cellM, y = j * dem.cellM;
      const { t, w } = locate(one, x, y);
      const v = [0, 0, 0];
      for (let q = 0; q < 3; q++) { const k = 3 * one.indices[3 * t + q]; for (let a = 0; a < 3; a++) v[a] += w[q] * mesh.normals[k + a]; }
      const f = 3 * (nf * fineCells * fineCells + j * fineCells + i);
      const a = angDeg(v, [fineMesh.normals[f], fineMesh.normals[f + 1], fineMesh.normals[f + 2]]);
      // 표본점마다 대조한다(최댓값만 보면 최대점이 거친 정점 근처일 때 보간 가중치 오류를 놓친다).
      assert.ok(Math.abs(cosToDeg(samples[j * (n0 + 1) + i]) - a) < 1e-3, `간격 ${stride} 표본 (${i},${j}): ${cosToDeg(samples[j * (n0 + 1) + i])} 대 ${a}`);
      max = Math.max(max, a);
    }
    assert.ok(Math.abs(got - max) < 1e-3, `간격 ${stride}: ${got} 대 무차별 ${max}`);
  }
});

test('(4) 상한 판정: 법선 상한을 주면 그 상한을 넘는 간격을 고르지 않는다', () => {
  const dem = makeHillDem({ seed: 7, noiseRatio: 0 });
  const rule = createLodRule({ name: 't', normalCapDeg: [null, 7.5, 7.5, 7.5] });
  for (let lod = 1; lod < 4; lod++) {
    const s = rule.lodStride(dem, lod);
    const st = rule.strideStats(dem, s);
    assert.ok(st.maxNormalErrDeg <= 7.5, `LOD${lod} 간격 ${s}: ${st.maxNormalErrDeg}°`);
    if (s < Math.min(1 << lod, 8)) assert.ok(rule.strideStats(dem, s * 2).maxNormalErrDeg > 7.5, `LOD${lod} 거부된 간격 ${2 * s} 는 상한을 넘어야 한다`);
  }
});
