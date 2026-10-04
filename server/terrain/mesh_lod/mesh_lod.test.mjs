// T14.1 지형 메시 LOD 시험. 합성 DEM(경사·언덕·계단·잡음)과 알려진 정답, 기준 숫자는 리터럴.
// 실행: node --test server/terrain/mesh_lod/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  TERRAIN_LOD_COUNT,
  TERRAIN_LOD_MAX_ERROR_M,
  TowerAssetError,
} from '../../../contracts/tower_assets/index.mjs';
import * as stubs from '../../../contracts/tower_assets/stubs.mjs';
import * as lodMod from './index.mjs';
import { buildTerrainTile, measureTerrainError, terrainTileToMesh, terrainLodStride } from './index.mjs';

// 257×257 표본, 1 m 셀 → 64 m 타일 4×4 = 16장(가장자리 공유).
const N = 257;
function makeDem(f, { originX = 0, originY = 0 } = {}) {
  const h = new Float32Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) h[j * N + i] = f(originX + i, originY + j, i, j);
  return { originX, originY, cellM: 1, width: N, height: N, heights: h };
}
// 정수 해시 잡음 ∈ [−0.5, 0.5] (Math 초월함수 없이 결정적).
function hashNoise(i, j) {
  let x = (i * 73856093) ^ (j * 19349663);
  x = Math.imul(x ^ (x >>> 13), 0x5bd1e995);
  x ^= x >>> 15;
  return ((x >>> 0) % 1001) / 1000 - 0.5;
}
const DEMS = {
  slope: () => makeDem((x, y) => 0.1 * x + 0.05 * y + 10),
  hill: () => makeDem((x, y) => 30 / (1 + ((x - 128) ** 2 + (y - 128) ** 2) / 1600)),
  steps: () => makeDem((x) => 1.5 * Math.floor(x / 16)),
  noise: () => makeDem((x, y, i, j) => 0.02 * x + 0.4 * hashNoise(i, j)),
  noiseBig: () => makeDem((x, y, i, j) => 2 * hashNoise(i, j)),
};
const TILES = [];
for (let ty = 0; ty < 4; ty++) for (let tx = 0; tx < 4; tx++) TILES.push([tx, ty]);

// 독립 검산: DEM 쌍선형과 타일 쌍선형을 0.25 m 간격으로 직접 표본해 최대 차이를 잰다.
function demBilinear(dem, x, y) {
  const u = (x - dem.originX) / dem.cellM, v = (y - dem.originY) / dem.cellM;
  const i = Math.min(Math.floor(u), dem.width - 2), j = Math.min(Math.floor(v), dem.height - 2);
  const fx = u - i, fy = v - j, h = dem.heights, w = dem.width;
  return (h[j * w + i] * (1 - fx) + h[j * w + i + 1] * fx) * (1 - fy) + (h[(j + 1) * w + i] * (1 - fx) + h[(j + 1) * w + i + 1] * fx) * fy;
}
function tileBilinear(tile, x, y) {
  const n = tile.cells - 1, step = 64 / n;
  const u = (x - tile.tx * 64) / step, v = (y - tile.ty * 64) / step;
  const i = Math.min(Math.floor(u), n - 1), j = Math.min(Math.floor(v), n - 1);
  const fx = u - i, fy = v - j, h = tile.heights, c = tile.cells;
  return (h[j * c + i] * (1 - fx) + h[j * c + i + 1] * fx) * (1 - fy) + (h[(j + 1) * c + i] * (1 - fx) + h[(j + 1) * c + i + 1] * fx) * fy;
}
function bruteError(dem, tile) {
  let max = 0;
  for (let b = 0; b <= 256; b++) for (let a = 0; a <= 256; a++) {
    const x = tile.tx * 64 + a / 4, y = tile.ty * 64 + b / 4;
    max = Math.max(max, Math.abs(demBilinear(dem, x, y) - tileBilinear(tile, x, y)));
  }
  return max;
}

function sweep(dem) {
  const out = [];
  for (let lod = 0; lod < TERRAIN_LOD_COUNT; lod++) {
    let max = 0, cells = 0;
    const hash = createHash('sha256');
    for (const [tx, ty] of TILES) {
      const t = buildTerrainTile(dem, tx, ty, lod);
      cells = t.cells;
      max = Math.max(max, measureTerrainError(dem, t).maxErrorM);
      hash.update(new Uint8Array(t.heights.buffer, t.heights.byteOffset, t.heights.byteLength));
    }
    out.push({ cells, max, hash: hash.digest('hex') });
  }
  return out;
}

// 기준 숫자(리터럴). cells = 한 변 정점 수, max = 16장 가운데 최대 오차(m).
const EXPECTED = {
  // 평면: 쌍선형이 정확 → Float32 반올림 수준 오차만, 명목 간격 그대로.
  slope: { cells: [65, 33, 17, 9], max: [0, 0.0000019073486328125, 0.00000286102294921875, 0.00000286102294921875] },
  // 언덕(유리 함수): 곡률 오차가 간격²에 비례(약 4배씩).
  hill: { cells: [65, 33, 17, 9], max: [0, 0.03726768493652344, 0.14631986618041992, 0.5442428588867188] },
  // 1.5 m 계단(16 m 마다): 간격 2 → 0.75(>0.5) 라 LOD1 은 원본, LOD2 는 간격 2(0.75 ≤ 1), LOD3 은 간격 8(1.3125 ≤ 2).
  steps: { cells: [65, 65, 33, 9], max: [0, 0, 0.75, 1.3125] },
  // 0.4 m 폭 잡음 + 경사: 모든 LOD 가 명목 간격으로 상한 안.
  noise: { cells: [65, 33, 17, 9], max: [0, 0.3926001787185669, 0.3806000351905823, 0.3904501795768738] },
  // 2 m 폭 잡음: LOD1·2 는 상한을 못 맞춰 원본으로 물러나고, LOD3 만 간격 8 로 2 m 안.
  noiseBig: { cells: [65, 65, 65, 9], max: [0, 0, 0, 1.9522499740123749] },
};
// LOD 별 16장 heights 바이트(타일 순서 ty, tx) 의 sha256. 초월함수 없는 DEM 만 고정한다.
const EXPECTED_HASH = {
  steps: ['63a8f38a8cada2250a3defca87686e308a78c03d905d1c9c0bc8a7beb3f62a85',
    '63a8f38a8cada2250a3defca87686e308a78c03d905d1c9c0bc8a7beb3f62a85',
    '7c63444da97f7af8e6a4b02065ecde273f26157072cfbf36b75dbba0d34d3978',
    'adf86fb32999845e716886625c4881f5bb0f742645cd19ca5995b9c69044fe74'],
  noise: ['b8a58588a067859ad4ad991e2f95de4a103efbe26d921040fdb3192958eab385',
    'd5c34ff3eedfa474db3bb2c407b5c278650107929e6a9c8a595f60e4f2f11ea7',
    '69c71df00d2a0fdf23ea9c339a044ea88b781fc70c7a7361f67bc47ea4eb2350',
    '9a867ed91eeb8827772854c00fbee7e6e46cf04a69e8cd985bcd7a7436091d32'],
};

test('stubs 서명과 같은 이름으로 export', () => {
  for (const name of ['buildTerrainTile', 'measureTerrainError', 'terrainTileToMesh']) {
    assert.equal(typeof stubs[name], 'function');
    assert.equal(typeof lodMod[name], 'function');
  }
});

for (const [name, mk] of Object.entries(DEMS)) {
  test(`오차 상한 단계별: ${name}`, () => {
    const dem = mk();
    const got = sweep(dem);
    const exp = EXPECTED[name];
    for (let lod = 0; lod < TERRAIN_LOD_COUNT; lod++) {
      assert.ok(got[lod].max <= TERRAIN_LOD_MAX_ERROR_M[lod], `${name} LOD${lod} ${got[lod].max} > ${TERRAIN_LOD_MAX_ERROR_M[lod]}`);
      assert.equal(got[lod].cells, exp.cells[lod], `${name} LOD${lod} cells`);
      assert.equal(got[lod].max, exp.max[lod], `${name} LOD${lod} max`);
    }
    if (EXPECTED_HASH[name]) assert.deepEqual(got.map((g) => g.hash), EXPECTED_HASH[name]);
  });
}

test('measureTerrainError = 0.25 m 표본 독립 검산(연속 영역 최대)', () => {
  for (const name of ['hill', 'steps', 'noise']) {
    const dem = DEMS[name]();
    for (let lod = 1; lod < TERRAIN_LOD_COUNT; lod++) {
      for (const [tx, ty] of [[0, 0], [1, 2], [3, 3]]) {
        const t = buildTerrainTile(dem, tx, ty, lod);
        const m = measureTerrainError(dem, t).maxErrorM;
        const b = bruteError(dem, t);
        assert.ok(Math.abs(m - b) <= 1e-9, `${name} L${lod} (${tx},${ty}) measure ${m} vs brute ${b}`);
      }
    }
  }
});

test('알려진 정답: 계단 LOD3 (0,0) 은 x=0,8,..,64 표본, 오차 최대점 x=15 에서 1.5·7/8', () => {
  const dem = DEMS.steps();
  const t = buildTerrainTile(dem, 0, 0, 3);
  assert.deepEqual([...t.heights.subarray(0, 9)], [0, 0, 1.5, 1.5, 3, 3, 4.5, 4.5, 6]);
  assert.equal(measureTerrainError(dem, t).maxErrorM, 1.3125);
  // LOD0 은 원본 표본 그대로.
  const t0 = buildTerrainTile(dem, 1, 0, 0);
  assert.equal(t0.heights[15], 6); // x = 64 + 15 = 79 → floor(79/16) = 4 → 4·1.5 = 6
  assert.equal(t0.heights[16], 7.5); // x = 80 → 5·1.5
});

test('가장자리 일치: 같은 LOD 이웃 타일의 공유 가장자리 높이·좌표가 비트 단위로 같다', () => {
  for (const [name, mk] of Object.entries(DEMS)) {
    const dem = mk();
    for (let lod = 0; lod < TERRAIN_LOD_COUNT; lod++) {
      const tiles = new Map();
      for (const [tx, ty] of TILES) tiles.set(`${tx},${ty}`, buildTerrainTile(dem, tx, ty, lod));
      for (const [tx, ty] of TILES) {
        const a = tiles.get(`${tx},${ty}`), c = a.cells;
        const right = tiles.get(`${tx + 1},${ty}`), up = tiles.get(`${tx},${ty + 1}`);
        if (right) {
          assert.equal(right.cells, c);
          const ma = terrainTileToMesh(a), mr = terrainTileToMesh(right);
          for (let j = 0; j < c; j++) {
            assert.ok(Object.is(a.heights[j * c + c - 1], right.heights[j * c]), `${name} L${lod} 동쪽 ${tx},${ty} j=${j}`);
            for (let k = 0; k < 3; k++) assert.ok(Object.is(ma.positions[(j * c + c - 1) * 3 + k], mr.positions[j * c * 3 + k]));
          }
        }
        if (up) {
          assert.equal(up.cells, c);
          const ma = terrainTileToMesh(a), mu = terrainTileToMesh(up);
          for (let i = 0; i < c; i++) {
            assert.ok(Object.is(a.heights[(c - 1) * c + i], up.heights[i]), `${name} L${lod} 북쪽 ${tx},${ty} i=${i}`);
            for (let k = 0; k < 3; k++) assert.ok(Object.is(ma.positions[((c - 1) * c + i) * 3 + k], mu.positions[i * 3 + k]));
          }
        }
      }
    }
  }
});

test('결정성: 같은 입력 → 같은 바이트(새 DEM 객체·캐시 없음 포함)', () => {
  for (const name of ['hill', 'steps', 'noiseBig']) {
    const a = sweep(DEMS[name]());
    const b = sweep(DEMS[name]());
    assert.deepEqual(a, b);
    const d = DEMS[name]();
    const m1 = terrainTileToMesh(buildTerrainTile(d, 2, 1, 2));
    const m2 = terrainTileToMesh(buildTerrainTile(DEMS[name](), 2, 1, 2));
    assert.deepEqual(Buffer.from(m1.positions.buffer), Buffer.from(m2.positions.buffer));
    assert.deepEqual(Buffer.from(m1.indices.buffer), Buffer.from(m2.indices.buffer));
  }
});

test('메시: 정점 수·삼각형 수·위에서 반시계·ENU 좌표', () => {
  const dem = DEMS.slope();
  const t = buildTerrainTile(dem, 1, 2, 3); // cells 9
  const m = terrainTileToMesh(t);
  assert.equal(m.positions.length, 9 * 9 * 3);
  assert.equal(m.indices.length, 8 * 8 * 6);
  // 첫 정점 = 타일 왼쪽 아래 (64, 128), 높이 = 0.1·64 + 0.05·128 + 10 = 22.8 (Float32).
  assert.deepEqual([...m.positions.subarray(0, 3)], [64, 128, Math.fround(22.8)]);
  // 마지막 정점 = (128, 192).
  assert.deepEqual([...m.positions.subarray(m.positions.length - 3, m.positions.length - 1)], [128, 192]);
  assert.deepEqual([...m.indices.subarray(0, 6)], [0, 1, 10, 0, 10, 9]);
  for (let k = 0; k < m.indices.length; k += 3) {
    const [a, b, c] = [m.indices[k], m.indices[k + 1], m.indices[k + 2]];
    const ax = m.positions[a * 3], ay = m.positions[a * 3 + 1];
    const cross = (m.positions[b * 3] - ax) * (m.positions[c * 3 + 1] - ay) - (m.positions[b * 3 + 1] - ay) * (m.positions[c * 3] - ax);
    assert.ok(cross > 0, `삼각형 ${k / 3} 반시계 아님`);
  }
});

test('원점이 음수·타일 경계 정렬인 DEM 도 같은 결과(평행 이동)', () => {
  const f = (x, y, i, j) => 0.02 * i + 0.4 * hashNoise(i, j);
  const a = makeDem(f);
  const b = makeDem(f, { originX: -128, originY: -64 });
  for (let lod = 0; lod < TERRAIN_LOD_COUNT; lod++) {
    const ta = buildTerrainTile(a, 1, 1, lod);
    const tb = buildTerrainTile(b, -1, 0, lod);
    assert.deepEqual(Buffer.from(ta.heights.buffer), Buffer.from(tb.heights.buffer));
    assert.equal(terrainLodStride(a, lod), terrainLodStride(b, lod));
  }
});

test('잘못된 입력은 TowerAssetError', () => {
  const dem = DEMS.slope();
  assert.throws(() => buildTerrainTile(dem, 4, 0, 0), TowerAssetError); // 범위 밖
  assert.throws(() => buildTerrainTile(dem, -1, 0, 0), TowerAssetError);
  assert.throws(() => buildTerrainTile(dem, 0, 0, 4), TowerAssetError); // lod 범위
  assert.throws(() => buildTerrainTile(dem, 0.5, 0, 0), TowerAssetError);
  assert.throws(() => buildTerrainTile({ ...dem, cellM: 5 }, 0, 0, 0), TowerAssetError); // 64/5 비정수
  assert.throws(() => buildTerrainTile({ ...dem, originX: 0.5 }, 0, 0, 0), TowerAssetError); // 경계 어긋남
  assert.throws(() => buildTerrainTile({ ...dem, heights: new Float32Array(3) }, 0, 0, 0), TowerAssetError);
  const bad = DEMS.slope();
  bad.heights[10] = NaN;
  assert.throws(() => buildTerrainTile(bad, 0, 0, 1), TowerAssetError);
  assert.ok(buildTerrainTile(bad, 1, 0, 1)); // 다른 타일은 그대로 만들 수 있다
  assert.throws(() => measureTerrainError(dem, { tx: 0, ty: 0, lod: 0, cells: 8, heights: new Float32Array(64) }), TowerAssetError);
  assert.throws(() => terrainTileToMesh({ tx: 0, ty: 0, lod: 0, cells: 1, heights: new Float32Array(1) }), TowerAssetError);
});
