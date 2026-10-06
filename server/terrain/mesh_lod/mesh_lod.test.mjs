// T14.1 지형 메시 LOD 시험. 합성 DEM(경사·언덕·계단·잡음)과 알려진 정답, 기준 숫자는 리터럴.
// 실행: node --test server/terrain/mesh_lod/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  TERRAIN_LOD_COUNT,
  TERRAIN_LOD_MAX_ERROR_M,
  terrainLodMaxErrorM,
  TowerAssetError,
} from '../../../contracts/tower_assets/index.mjs';
import * as stubs from '../../../contracts/tower_assets/stubs.mjs';
import * as lodMod from './index.mjs';
import { buildTerrainTile, measureTerrainError, terrainTileToMesh, terrainLodStride, terrainMissingTiles } from './index.mjs';

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

// 독립 검산(F-305, ④): 구현의 대각선 규약을 다시 쓰지 않는다. terrainTileToMesh 가 내놓은 positions·indices 를
// 그대로 읽어, 점이 들어 있는 삼각형을 무게중심 좌표로 찾아 그 삼각형 위에서 z 를 보간한다.
// 기준 표면 = 같은 타일의 LOD 0 메시(정점 = DEM 표본). 0.25 m 간격(per=4)으로 최대 차이를 잰다.
function meshHeightAt(mesh, x, y) {
  const P = mesh.positions, I = mesh.indices;
  // 정규 격자 메시라 점이 놓인 칸의 삼각형 둘만 후보로 한다(칸 번호는 정점 좌표에서 구한다).
  const c = Math.round(Math.sqrt(P.length / 3));
  const x0 = P[0], y0 = P[1], x1 = P[(c - 1) * 3], y1 = P[((c - 1) * c) * 3 + 1];
  const ci = Math.min(c - 2, Math.max(0, Math.floor(((x - x0) / (x1 - x0)) * (c - 1))));
  const cj = Math.min(c - 2, Math.max(0, Math.floor(((y - y0) / (y1 - y0)) * (c - 1))));
  const base = (cj * (c - 1) + ci) * 6;
  const eps = 1e-9;
  for (let t = 0; t < 2; t++) {
    const [a, b, d] = [I[base + t * 3], I[base + t * 3 + 1], I[base + t * 3 + 2]];
    const ax = P[a * 3], ay = P[a * 3 + 1], bx = P[b * 3], by = P[b * 3 + 1], dx = P[d * 3], dy = P[d * 3 + 1];
    // 무게중심: p = a + s·(b−a) + t·(d−a) 를 풀어 s, t 를 얻는다.
    const s2 = ((x - ax) * (dy - ay) - (y - ay) * (dx - ax)) / ((bx - ax) * (dy - ay) - (by - ay) * (dx - ax));
    const t2 = ((y - ay) * (bx - ax) - (x - ax) * (by - ay)) / ((bx - ax) * (dy - ay) - (by - ay) * (dx - ax));
    if (s2 >= -eps && t2 >= -eps && s2 + t2 <= 1 + eps) {
      return P[a * 3 + 2] + s2 * (P[b * 3 + 2] - P[a * 3 + 2]) + t2 * (P[d * 3 + 2] - P[a * 3 + 2]);
    }
  }
  throw new Error(`점 (${x}, ${y}) 을 덮는 삼각형이 없다`);
}
function bruteError(dem, tile, per = 4) {
  const ref = terrainTileToMesh(buildTerrainTile(dem, tile.tx, tile.ty, 0));
  const got = terrainTileToMesh(tile);
  let max = 0;
  const m = 64 * per;
  for (let b = 0; b <= m; b++) for (let a = 0; a <= m; a++) {
    const x = tile.tx * 64 + a / per, y = tile.ty * 64 + b / per;
    max = Math.max(max, Math.abs(meshHeightAt(ref, x, y) - meshHeightAt(got, x, y)));
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
// 결정 0057(T15.10d): 실제 상한 = min(TERRAIN_LOD_MAX_ERROR_M, 0.25·cellM). 이 DEM 들은 1 m 셀이라 LOD1~3 상한이 모두 0.25 m 다.
const EXPECTED = {
  // 평면: 쌍선형이 정확 → Float32 반올림 수준 오차만, 명목 간격 그대로.
  slope: { cells: [65, 33, 17, 9], max: [0, 0.0000019073486328125, 0.00000286102294921875, 0.00000286102294921875] }, // 실측 고정(회귀용)
  // 언덕(유리 함수): 곡률 오차가 간격²에 비례(약 4배씩).
  // F-305 로 오차를 쌍선형 대신 메시(삼각형) 표면 기준으로 재면서 max 가 바뀌었다
  // (이전 0.03726768493652344, 0.14631986618041992, 0.5442428588867188). 간격·해시는 그대로.
  // 결정 0057: LOD3 간격 8(0.5656 m) 이 상한 0.25 m 를 넘어 간격 4(0.1478 m)로 내려가 LOD2 와 같은 타일이 된다(이전 cells 9, max 0.5656108856201172).
  hill: { cells: [65, 33, 17, 17], max: [0, 0.03736114501953125, 0.14777565002441406, 0.14777565002441406] }, // 실측 고정(회귀용)
  // 1.5 m 계단(16 m 마다): 간격 2 → 0.75(>0.5) 라 LOD1 은 원본, LOD2 는 간격 2(0.75 ≤ 1).
  // LOD3: 상한 2 m 였을 때는 간격 8(1.3125 ≤ 2). T15.1c 에서 상한이 1 m 로 줄어 간격 8(1.3125)·4(1.5·3/4 = 1.125) 가 모두 넘으므로
  // 간격 2(0.75) 로 내려가 LOD2 와 같은 타일이 된다(해시도 LOD2 와 같다). 간격 8 의 정답은 아래 '알려진 정답' 시험이 직접 만든 타일로 지킨다.
  // max 는 해석 근거로 식을 쓴다(실측 고정 아님): 간격 2 는 계단 턱 한 칸이 절반 어긋나 1.5/2 (LOD2·LOD3 이 이 값).
  // 간격 8(1.5·7/8 = 1.3125)·간격 4(1.5·3/4 = 1.125)는 여기 max 에 나오지 않는다 — 두 값은 아래 '알려진 정답' 시험이 직접 만든 타일로 단언한다.
  // 결정 0057: 간격 2 오차 0.75 가 1 m 셀 상한 0.25 m 를 넘어 LOD1~3 모두 원본(이전 cells [65, 65, 33, 33], max [0, 0, 0.75, 0.75]).
  steps: { cells: [65, 65, 65, 65], max: [0, 0, 0, 0] },
  // 0.4 m 폭 잡음 + 경사: 모든 LOD 가 명목 간격으로 상한 안.
  // F-305 메시 표면 기준으로 LOD2 max 가 0.3806000351905823 → 0.3891999423503876 로 바뀌었다. 간격·해시는 그대로.
  // 결정 0057: 간격 2·4·8 의 오차(0.3926·0.3892·0.3905 m)가 1 m 셀 상한 0.25 m 를 넘어 LOD1~3 모두 원본.
  //   (이전 cells [65, 33, 17, 9]. 같은 무늬를 2 m 셀로 두면 상한 0.5 m 라 명목 간격이 유지된다 — 아래 '셀 크기' 시험.)
  noise: { cells: [65, 65, 65, 65], max: [0, 0, 0, 0] },
  // 2 m 폭 잡음: LOD1·2 는 상한을 못 맞춰 원본으로 물러난다. LOD3 도 상한 1 m(T15.1c, 이전 2 m 에서는 간격 8·최대 1.9522499740123749)
  // 를 어떤 간격으로도 못 맞춰 원본으로 물러난다.
  noiseBig: { cells: [65, 65, 65, 65], max: [0, 0, 0, 0] },
};
// LOD 별 16장 heights 바이트(타일 순서 ty, tx) 의 sha256. 초월함수 없는 DEM 만 고정한다. 실측 고정(회귀용).
// 결정 0057: steps·noise 는 LOD1~3 이 원본이라 네 해시가 LOD0 과 같다. 이전 해시: steps LOD2·3 7c63444d…3978,
//   noise LOD1 d5c34ff3…1ea7·LOD2 69c71df0…2350·LOD3 9a867ed9…1d32.
const EXPECTED_HASH = {
  steps: Array(4).fill('63a8f38a8cada2250a3defca87686e308a78c03d905d1c9c0bc8a7beb3f62a85'),
  noise: Array(4).fill('b8a58588a067859ad4ad991e2f95de4a103efbe26d921040fdb3192958eab385'),
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
      const cap = terrainLodMaxErrorM(lod, dem.cellM);
      assert.ok(cap <= TERRAIN_LOD_MAX_ERROR_M[lod]);
      assert.ok(got[lod].max <= cap, `${name} LOD${lod} ${got[lod].max} > ${cap}`);
      assert.equal(got[lod].cells, exp.cells[lod], `${name} LOD${lod} cells`);
      assert.equal(got[lod].max, exp.max[lod], `${name} LOD${lod} max`);
    }
    if (EXPECTED_HASH[name]) assert.deepEqual(got.map((g) => g.hash), EXPECTED_HASH[name]);
  });
}

test('measureTerrainError = 0.25 m 표본 메시 표면 독립 검산(연속 영역 최대)', () => {
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

test('알려진 정답: 계단 간격 8 타일 (0,0) 은 x=0,8,..,64 표본, 오차 최대점 x=15 에서 1.5·7/8, LOD3 은 원본 간격으로 내려간다', () => {
  const dem = DEMS.steps();
  // 간격 8 타일을 직접 만든다(T15.1c 상한 1 m 에서는 자동 선택이 간격 8 을 쓰지 않는다).
  const t = { tx: 0, ty: 0, lod: 3, cells: 9, heights: new Float32Array(81) };
  for (let j = 0; j < 9; j++) for (let i = 0; i < 9; i++) t.heights[j * 9 + i] = dem.heights[j * 8 * N + i * 8];
  assert.deepEqual([...t.heights.subarray(0, 9)], [0, 0, 1.5, 1.5, 3, 3, 4.5, 4.5, 6]);
  assert.equal(measureTerrainError(dem, t).maxErrorM, 1.3125);
  // 간격 4 타일도 직접 만든다: 턱 직전 표본에서 1.5·3/4 = 1.125 (계단 턱 간격 16 / 4 = 4 칸 중 3/4 지점).
  const t4 = { tx: 0, ty: 0, lod: 3, cells: 17, heights: new Float32Array(17 * 17) };
  for (let j = 0; j < 17; j++) for (let i = 0; i < 17; i++) t4.heights[j * 17 + i] = dem.heights[j * 4 * N + i * 4];
  assert.equal(measureTerrainError(dem, t4).maxErrorM, 1.125);
  // 1.3125·1.125·0.75(간격 2) 모두 1 m 셀 상한 0.25 m(결정 0057)를 넘어 LOD3 은 간격 1(오차 0).
  //   (T15.1c 상한 1 m 만 있을 때는 간격 2·오차 0.75 였다.)
  assert.equal(terrainLodStride(dem, 3), 1);
  assert.equal(measureTerrainError(dem, buildTerrainTile(dem, 0, 0, 3)).maxErrorM, 0);
  // LOD0 은 원본 표본 그대로.
  const t0 = buildTerrainTile(dem, 1, 0, 0);
  assert.equal(t0.heights[15], 6); // x = 64 + 15 = 79 → floor(79/16) = 4 → 4·1.5 = 6
  assert.equal(t0.heights[16], 7.5); // x = 80 → 5·1.5
});

test('해석값 대조: 경사 평면 z = 0.1x + 0.05y + 10 의 제품 LOD3(간격 8) 타일 첫 행·열이 해석값과 같다', () => {
  const dem = DEMS.slope();
  assert.equal(terrainLodStride(dem, 3), 8);
  for (const [tx, ty] of [[0, 0], [2, 1]]) {
    const t = buildTerrainTile(dem, tx, ty, 3);
    assert.equal(t.cells, 9);
    // 표본 i 는 DEM 셀 x = tx·64 + 8i, y = ty·64 + 8j 의 해석값(DEM 이 Float32 라 fround).
    for (let i = 0; i < 9; i++) {
      assert.equal(t.heights[i], Math.fround(0.1 * (tx * 64 + 8 * i) + 0.05 * (ty * 64) + 10), `첫 행 i=${i}`);
    }
    for (let j = 0; j < 9; j++) {
      assert.equal(t.heights[j * 9], Math.fround(0.1 * (tx * 64) + 0.05 * (ty * 64 + 8 * j) + 10), `첫 열 j=${j}`);
    }
  }
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

// F-305 감독 재현: 4 m(8 표본)마다 ±2.5 m 체커보드 노드 사이를 쌍선형으로 채운 129² DEM(cellM 0.5, 타일 1장).
// 쌍선형 기준으로는 4 m 간격이 오차 0 이지만, 대각선 삼각형 메시는 비틀린 칸 가운데에서 2.5 m 어긋난다.
function checkerDem() {
  const W = 129, h = new Float32Array(W * W);
  const node = (a, b) => (((a + b) & 1) ? -2.5 : 2.5);
  for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
    const a = Math.floor(i / 8), b = Math.floor(j / 8), fx = (i % 8) / 8, fy = (j % 8) / 8;
    const a1 = Math.min(a + 1, 16), b1 = Math.min(b + 1, 16);
    h[j * W + i] = (node(a, b) * (1 - fx) + node(a1, b) * fx) * (1 - fy) + (node(a, b1) * (1 - fx) + node(a1, b1) * fx) * fy;
  }
  return { originX: 0, originY: 0, cellM: 0.5, width: W, height: W, heights: h };
}

test('F-305 체커보드: 간격 8 메시 오차 ≥ 2.5 m 를 잡고, 간격이 줄어 모든 LOD 메시 오차 ≤ 상한', () => {
  const dem = checkerDem();
  // 이전 구현이 고르던 LOD3 타일(간격 8, cells 17)을 직접 만들어 잰다.
  const old = { tx: 0, ty: 0, lod: 3, cells: 17, heights: new Float32Array(17 * 17) };
  for (let j = 0; j < 17; j++) for (let i = 0; i < 17; i++) old.heights[j * 17 + i] = dem.heights[j * 8 * 129 + i * 8];
  const mOld = measureTerrainError(dem, old).maxErrorM;
  assert.ok(mOld >= 2.5, `간격 8 measure ${mOld} < 2.5`);
  assert.ok(Math.abs(bruteError(dem, old) - mOld) <= 1e-9);
  for (let lod = 0; lod < TERRAIN_LOD_COUNT; lod++) {
    const t = buildTerrainTile(dem, 0, 0, lod);
    const m = measureTerrainError(dem, t).maxErrorM;
    const b = bruteError(dem, t, 8);
    assert.ok(m <= TERRAIN_LOD_MAX_ERROR_M[lod], `LOD${lod} measure ${m}`);
    assert.ok(b <= TERRAIN_LOD_MAX_ERROR_M[lod], `LOD${lod} 메시 보간 오차 ${b}`);
    assert.ok(Math.abs(m - b) <= 1e-9, `LOD${lod} measure ${m} vs brute ${b}`);
    if (lod === 3) assert.ok(t.cells > 17, `LOD3 간격이 줄지 않았다 (cells ${t.cells})`);
  }
});

test('F-315 ②: |origin| 이 상한을 넘으면 즉시 TowerAssetError (무한 루프 없음)', () => {
  const dem = DEMS.slope();
  for (const o of [1e20, -1e20, 1e7 + 64]) {
    assert.throws(() => terrainLodStride({ ...dem, originX: o }, 1), TowerAssetError);
    assert.throws(() => terrainLodStride({ ...dem, originY: o }, 1), TowerAssetError);
    assert.throws(() => terrainMissingTiles({ ...dem, originX: o }), TowerAssetError);
  }
});

test('F-315 ③·F-314 ⑥: 유한하지 않은 높이 → 즉시 TowerAssetError, 결측 타일 목록', () => {
  const dem = DEMS.slope();
  for (const bad of [NaN, Infinity, -Infinity]) {
    const t = buildTerrainTile(dem, 0, 0, 1);
    t.heights[5] = bad;
    assert.throws(() => measureTerrainError(dem, t), TowerAssetError);
    assert.throws(() => terrainTileToMesh(t), TowerAssetError);
  }
  assert.deepEqual(terrainMissingTiles(dem), []);
  const d = DEMS.noise();
  d.heights[10] = NaN; // 타일 (0,0) 만
  d.heights[200 * N + 64] = Infinity; // x=64 경계: 타일 (0,3)·(1,3) 공유
  assert.deepEqual(terrainMissingTiles(d), [{ tx: 0, ty: 3 }, { tx: 1, ty: 3 }, { tx: 0, ty: 0 }].sort((p, q) => p.ty - q.ty || p.tx - q.tx));
  // 결측 타일을 뺀 판정이라 간격은 정상 DEM 과 같다(결정 0057 이후 noise 는 1 m 셀이라 LOD1~3 모두 간격 1).
  const clean = DEMS.noise();
  for (let lod = 0; lod < TERRAIN_LOD_COUNT; lod++) assert.equal(terrainLodStride(d, lod), terrainLodStride(clean, lod));
  // 결측 판정이 상한과 무관하게 동작함을 명목 간격에서도 본다: 같은 무늬를 2 m 셀로(상한 0.5 m) 두면 명목 간격이고, 결측을 넣어도 같다.
  const d2 = { ...DEMS.noise(), cellM: 2 };
  d2.heights[10] = NaN;
  for (let lod = 0; lod < TERRAIN_LOD_COUNT; lod++) assert.equal(terrainLodStride(d2, lod), 1 << lod);
});

// ---- 변형 시험 보강(F-318 ①②③) ----
function singleTileDem(f) {
  const W = 65, h = new Float32Array(W * W);
  for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) h[j * W + i] = f(i, j);
  return { originX: 0, originY: 0, cellM: 1, width: W, height: W, heights: h };
}

test('① 간격 판정은 첫 타일에서 멈추지 않는다: (0,0) 만 평평하고 나머지는 잡음', () => {
  const dem = makeDem((x, y, i, j) => (i <= 64 && j <= 64 ? 3 : 2 * hashNoise(i, j)));
  // 타일 (0,0) 은 간격 2 에서 오차 0 이지만 다른 타일은 0.5 m 를 넘는다 → 전역 간격은 1.
  assert.equal(terrainLodStride(dem, 1), 1);
  assert.equal(terrainLodStride(dem, 2), 1); // 잡음 폭 2 m 라 LOD2 상한 1 m 도 간격 2 로는 못 맞춘다
  for (const lod of [1, 2]) {
    for (const [tx, ty] of TILES) {
      const t = buildTerrainTile(dem, tx, ty, lod);
      assert.equal(t.cells, 65, `LOD${lod} (${tx},${ty}) cells`);
      assert.ok(measureTerrainError(dem, t).maxErrorM <= terrainLodMaxErrorM(lod, dem.cellM), `LOD${lod} (${tx},${ty}) 오차 상한`);
    }
  }
  // 대조: 평평한 타일만 따로 보면 간격 2 로도 오차 0.
  const flatOnly = singleTileDem(() => 3);
  assert.equal(terrainLodStride(flatOnly, 1), 2);
});

test('② 마지막 행·열만 솟은 DEM: 가장자리 칸 보간이 범위를 넘지 않고 오차가 정확히 1 m', () => {
  for (const [name, f] of [['행', (i, j) => (j === 64 && i % 2 === 1 ? 1 : 0)], ['열', (i, j) => (i === 64 && j % 2 === 1 ? 1 : 0)]]) {
    const dem = singleTileDem(f);
    // 간격 2 타일을 직접 만든다(자동 선택은 오차 1 > 0.5 라 원본으로 물러난다).
    const cells = 33, heights = new Float32Array(cells * cells);
    for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) heights[j * cells + i] = dem.heights[(j * 2) * 65 + i * 2];
    const m = measureTerrainError(dem, { tx: 0, ty: 0, lod: 1, cells, heights }).maxErrorM;
    assert.equal(m, 1, `마지막 ${name}`);
  }
  // 마지막 행·열의 마지막 홀수 표본 하나만 솟은 경우: 열 쪽 Math.min 이 빠지면 범위 밖 읽기로 NaN 이 나와
  // 그 점의 오차가 조용히 버려진다(여럿이 솟으면 다른 점이 가려 준다). 점 하나라야 드러난다.
  for (const [name, f] of [['행 한 점', (i, j) => (j === 64 && i === 63 ? 1 : 0)], ['열 한 점', (i, j) => (i === 64 && j === 63 ? 1 : 0)]]) {
    const dem = singleTileDem(f);
    const hp = new Float32Array(33 * 33);
    for (let j = 0; j < 33; j++) for (let i = 0; i < 33; i++) hp[j * 33 + i] = dem.heights[(j * 2) * 65 + i * 2];
    const m = measureTerrainError(dem, { tx: 0, ty: 0, lod: 1, cells: 33, heights: hp }).maxErrorM;
    assert.equal(m, 1, `마지막 ${name}`);
  }
  // 마지막 행 전체가 솟은 경우: 정점이 모두 솟고 바로 아래 홀수 행만 0.5 어긋난다.
  const whole = singleTileDem((i, j) => (j === 64 ? 1 : 0));
  const hs = new Float32Array(33 * 33);
  for (let j = 0; j < 33; j++) for (let i = 0; i < 33; i++) hs[j * 33 + i] = whole.heights[(j * 2) * 65 + i * 2];
  assert.equal(measureTerrainError(whole, { tx: 0, ty: 0, lod: 1, cells: 33, heights: hs }).maxErrorM, 0.5);
});

test('③ 오차 상한 경계: 상한 그대로면 유지, 상한 + 0.04 m 면 간격을 줄인다', () => {
  // 홀수 표본 (1, 0) 하나만 d 만큼 솟게 해 모든 LOD 간격에서 오차가 정확히 d.
  const spike = (d) => singleTileDem((i, j) => (i === 1 && j === 0 ? d : 0));
  const nominalCells = { 1: 33, 2: 17, 3: 9 };
  for (const lod of [1, 2, 3]) {
    const cap = terrainLodMaxErrorM(lod, 1); // 1 m 셀: 0.25 m(결정 0057)
    assert.equal(cap, 0.25);
    const keep = buildTerrainTile(spike(cap), 0, 0, lod);
    assert.equal(keep.cells, nominalCells[lod], `LOD${lod} 상한 ${cap} 은 허용`);
    assert.equal(measureTerrainError(spike(cap), keep).maxErrorM, cap);
    const reduce = buildTerrainTile(spike(cap + 0.04), 0, 0, lod);
    assert.ok(reduce.cells > nominalCells[lod], `LOD${lod} ${cap + 0.04} 는 간격을 줄여야 한다 (cells ${reduce.cells})`);
    assert.ok(measureTerrainError(spike(cap + 0.04), reduce).maxErrorM <= cap);
  }
});

test('결정 0057 셀 크기: 같은 높이 무늬라도 1 m 셀은 상한 0.25 m, 2 m 셀은 0.5 m, 4 m 셀은 절대표 [0, 0.5, 1, 1]', () => {
  // noise 무늬(간격 2·4·8 오차 0.39 m 안팎, 기울기 무관 무늬)를 셀 크기만 바꿔 같은 표본으로 둔다.
  const base = DEMS.noise();
  const strides = (cellM) => [0, 1, 2, 3].map((l) => terrainLodStride({ ...base, heights: base.heights.slice(), cellM }, l));
  assert.deepEqual(strides(1), [1, 1, 1, 1]);
  assert.deepEqual(strides(2), [1, 2, 4, 8]);
  assert.deepEqual(strides(4), [1, 2, 4, 8]);
  // steps(턱 1.5 m): 간격 2 오차 0.75. 4 m 셀이면 상한이 절대표와 같아 T15.1c 결과(LOD2·3 간격 2)가 그대로다.
  const st = DEMS.steps();
  assert.deepEqual([0, 1, 2, 3].map((l) => terrainLodStride({ ...st, heights: st.heights.slice(), cellM: 4 }, l)), [1, 1, 2, 2]);
  assert.deepEqual([0, 1, 2, 3].map((l) => terrainLodStride({ ...st, heights: st.heights.slice(), cellM: 2 }, l)), [1, 1, 1, 1]);
});
