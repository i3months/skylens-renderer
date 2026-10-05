// 합성 DEM·시점 도우미(fixtures.mjs) 시험. 기준 수치는 시험 안에 박아 두었다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeHillDem, towerViewpoints, EYE_RAISED, TOWER_EYE_MIN_U_M } from './fixtures.mjs';
import { buildTerrainTile, terrainMissingTiles } from '../../../server/terrain/mesh_lod/index.mjs';
import { assertCamera } from '../../../contracts/raster/index.mjs';

const bytes = (dem) => Buffer.from(dem.heights.buffer, dem.heights.byteOffset, dem.heights.byteLength);
const spec = JSON.parse(readFileSync(new URL('../../../fixtures/viewpoints/synthetic.json', import.meta.url), 'utf8'));

function heightAt(dem, x, y) {
  // DEM 밖은 가장자리 값으로 고정한다(눈이 DEM 밖에 있는 시점이 있다).
  const fi = Math.min(Math.max((x - dem.originX) / dem.cellM, 0), dem.width - 1), fj = Math.min(Math.max((y - dem.originY) / dem.cellM, 0), dem.height - 1);
  const i = Math.min(Math.floor(fi), dem.width - 2), j = Math.min(Math.floor(fj), dem.height - 2);
  const u = fi - i, v = fj - j, w = dem.width, h = dem.heights;
  return (h[j * w + i] * (1 - u) + h[j * w + i + 1] * u) * (1 - v) + (h[(j + 1) * w + i] * (1 - u) + h[(j + 1) * w + i + 1] * u) * v;
}

test('makeHillDem 기본 형상: 4×4 타일, 셀 2 m, 원점 -128', () => {
  const d = makeHillDem();
  assert.equal(d.cellM, 2);
  assert.equal(d.originX, -128);
  assert.equal(d.originY, -128);
  assert.equal(d.width, 129);
  assert.equal(d.height, 129);
  assert.ok(d.heights instanceof Float32Array);
  assert.equal(d.heights.length, 129 * 129);
});

test('makeHillDem 같은 시드는 같은 바이트, 다른 시드는 다름', () => {
  assert.ok(bytes(makeHillDem({ seed: 7 })).equals(bytes(makeHillDem({ seed: 7 }))));
  assert.ok(!bytes(makeHillDem({ seed: 7 })).equals(bytes(makeHillDem({ seed: 8 }))));
});

test('makeHillDem 높이 범위: 0 이상 15 m 이하(기본), 실제로 변화가 있다', () => {
  const d = makeHillDem();
  let lo = Infinity, hi = -Infinity;
  for (const v of d.heights) { if (v < lo) lo = v; if (v > hi) hi = v; }
  assert.ok(lo >= 0, `최저 ${lo}`);
  assert.ok(hi <= 15, `최고 ${hi}`);
  assert.ok(hi - lo > 2, `기복 ${hi - lo}`);
  const d2 = makeHillDem({ amplitudeM: 40, seed: 3 });
  let hi2 = -Infinity;
  for (const v of d2.heights) if (v > hi2) hi2 = v;
  assert.ok(hi2 <= 60 && hi2 > 10, `최고 ${hi2}`);
});

test('makeHillDem 모든 타일이 buildTerrainTile(lod 0) 을 통과하고 결측이 없다', () => {
  for (const opts of [{}, { tilesX: 2, tilesY: 3, tileMinX: 1, tileMinY: -5, cellM: 4, seed: 9 }]) {
    const d = makeHillDem(opts);
    assert.deepEqual(terrainMissingTiles(d), []);
    const { tilesX = 4, tilesY = 4, tileMinX = -2, tileMinY = -2, cellM = 2 } = opts;
    let n = 0;
    for (let ty = tileMinY; ty < tileMinY + tilesY; ty++) {
      for (let tx = tileMinX; tx < tileMinX + tilesX; tx++) {
        const t = buildTerrainTile(d, tx, ty, 0);
        assert.equal(t.cells, 64 / cellM + 1);
        n++;
      }
    }
    assert.equal(n, tilesX * tilesY);
  }
  assert.equal(makeHillDem().width, 129);
});

test('towerViewpoints 8개의 이름·해상도·assertCamera', () => {
  const cams = towerViewpoints();
  assert.equal(cams.length, 8);
  assert.deepEqual(cams.map((c) => c.name), [
    'aerial_overview', 'aerial_oblique_ne', 'top_down', 'street_level', 'low_close_box', 'tower_high', 'tower_mid', 'edge_far',
  ]);
  for (const c of cams) {
    assert.equal(c.width, 160);
    assert.equal(c.height, 90);
    assert.doesNotThrow(() => assertCamera(c));
  }
});

test('눈 위치 ENU 가 synthetic.json 의 scene→ENU 와 일치(올린 만큼만 다름)', () => {
  const cams = towerViewpoints();
  const raised = { street_level: 17, low_close_box: 17, edge_far: 17 };
  assert.equal(TOWER_EYE_MIN_U_M, 17);
  assert.deepEqual(Object.keys(EYE_RAISED).sort(), Object.keys(raised).sort());
  spec.viewpoints.forEach((vp, k) => {
    const c = cams[k];
    const [R, t] = [c.R, c.t];
    // 눈 = -Rᵀ t
    const eye = [0, 1, 2].map((a) => -(R[a] * t[0] + R[3 + a] * t[1] + R[6 + a] * t[2]));
    const [sx, sy, sz] = vp.eye;
    const expU = raised[vp.name] ?? sy;
    assert.ok(Math.abs(eye[0] - sx) < 1e-6, `${vp.name} 동`);
    assert.ok(Math.abs(eye[1] - -sz) < 1e-6, `${vp.name} 북`);
    assert.ok(Math.abs(eye[2] - expU) < 1e-6, `${vp.name} 위 ${eye[2]} != ${expU}`);
  });
});

test('눈 높이 > 지형 높이 + 2 이고 카메라가 지형 중심을 시야에 둔다', () => {
  const dem = makeHillDem();
  const cams = towerViewpoints();
  const center = [0, 0, heightAt(dem, 0, 0)];
  cams.forEach((c) => {
    const { R, t, K } = c;
    const eye = [0, 1, 2].map((a) => -(R[a] * t[0] + R[3 + a] * t[1] + R[6 + a] * t[2]));
    assert.ok(eye[2] > heightAt(dem, eye[0], eye[1]) + 2, `${c.name} 눈 ${eye[2]}`);
    const p = [0, 1, 2].map((r) => R[r * 3] * center[0] + R[r * 3 + 1] * center[1] + R[r * 3 + 2] * center[2] + t[r]);
    assert.ok(p[2] > 0, `${c.name} 깊이 ${p[2]}`);
    const px = K.fx * (p[0] / p[2]) + K.cx, py = K.fy * (p[1] / p[2]) + K.cy;
    assert.ok(px >= 0 && px < c.width && py >= 0 && py < c.height, `${c.name} 투영 (${px}, ${py})`);
  });
});
