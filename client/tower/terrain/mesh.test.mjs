// T15.1-A1 지형 메시 이음 시험. 참조 구현은 server/terrain/mesh_lod(시험에서만 가져온다), 합성 DEM 은 여기서 만든다.
// 실행: node --test client/tower/terrain/mesh.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLayerMesh, MAX_ABS_POSITION_M } from './mesh.mjs';
import { createTerrainLayer } from './index.mjs';
import { buildTerrainTile, terrainTileToMesh } from '../../../server/terrain/mesh_lod/index.mjs';

// 257×257 표본, 1 m 셀 → 64 m 타일 4×4 = 16장.
const N = 257;
function makeDem(f) {
  const h = new Float32Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) h[j * N + i] = f(i, j);
  return { originX: 0, originY: 0, cellM: 1, width: N, height: N, heights: h };
}
const dem = makeDem((x, y) => 0.1 * x + 0.05 * y + 3 * Math.sin(x / 9) * Math.cos(y / 7));

function tilesAt(lod, coords) {
  return coords.map(([tx, ty]) => buildTerrainTile(dem, tx, ty, lod));
}

test('빈 배열은 빈 메시를 돌려준다', () => {
  const m = buildLayerMesh([]);
  assert.equal(m.positions.length, 0);
  assert.equal(m.indices.length, 0);
  assert.equal(m.tileOfTriangle.length, 0);
  assert.ok(m.positions instanceof Float32Array && m.indices instanceof Uint32Array && m.tileOfTriangle instanceof Int32Array);
});

for (const lod of [0, 1, 2, 3]) {
  test(`LOD ${lod}: 타일별 정점·인덱스가 참조 구현과 일치한다`, () => {
    const tiles = tilesAt(lod, [[0, 0], [1, 0], [2, 1], [3, 3]]);
    const m = buildLayerMesh(tiles);
    const c = tiles[0].cells;
    const vN = c * c * 3;
    const iN = (c - 1) * (c - 1) * 6;
    assert.equal(m.positions.length, 4 * vN);
    assert.equal(m.indices.length, 4 * iN);
    tiles.forEach((t, n) => {
      const ref = terrainTileToMesh(t);
      assert.deepEqual(Array.from(m.positions.subarray(n * vN, (n + 1) * vN)), Array.from(ref.positions));
      const got = Array.from(m.indices.subarray(n * iN, (n + 1) * iN), (v) => v - n * c * c);
      assert.deepEqual(got, Array.from(ref.indices));
    });
  });
}

test('tileOfTriangle 은 삼각형마다 입력 배열 순서의 타일 번호를 준다', () => {
  const tiles = tilesAt(2, [[3, 2], [0, 0], [1, 1]]); // 순서가 (tx,ty) 순이 아님
  const m = buildLayerMesh(tiles);
  const per = (tiles[0].cells - 1) ** 2 * 2;
  assert.equal(m.tileOfTriangle.length, 3 * per);
  for (let n = 0; n < 3; n++) for (let k = 0; k < per; k++) assert.equal(m.tileOfTriangle[n * per + k], n);
});

test('모든 삼각형이 위에서 볼 때 반시계이고 인덱스가 범위 안이다', () => {
  const m = buildLayerMesh(tilesAt(1, [[0, 0], [1, 0]]));
  const P = m.positions;
  const nv = P.length / 3;
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
    assert.ok(a < nv && b < nv && c < nv);
    const cross = (P[b * 3] - P[a * 3]) * (P[c * 3 + 1] - P[a * 3 + 1]) - (P[b * 3 + 1] - P[a * 3 + 1]) * (P[c * 3] - P[a * 3]);
    assert.ok(cross > 0, `삼각형 ${t / 3} 가 반시계가 아니다`);
  }
});

test('경계 정점: 이웃 타일 가장자리 x·y 가 비트 일치한다', () => {
  const tiles = tilesAt(2, [[1, 0], [2, 0], [1, 1]]);
  const m = buildLayerMesh(tiles);
  const c = tiles[0].cells;
  const v = (n, i, j) => (n * c * c + j * c + i) * 3;
  for (let j = 0; j < c; j++) {
    const a = v(0, c - 1, j), b = v(1, 0, j); // 동쪽 가장자리 = 이웃 서쪽 가장자리
    assert.equal(m.positions[a], 128);
    assert.ok(Object.is(m.positions[a], m.positions[b]));
    assert.ok(Object.is(m.positions[a + 1], m.positions[b + 1]));
    assert.equal(m.positions[a + 2], m.positions[b + 2]); // 같은 DEM 표본이므로 높이도 같다
  }
  for (let i = 0; i < c; i++) {
    const a = v(0, i, c - 1), b = v(2, i, 0); // 북쪽 가장자리 = 이웃 남쪽 가장자리
    assert.equal(m.positions[a + 1], 64);
    assert.ok(Object.is(m.positions[a + 1], m.positions[b + 1]));
    assert.ok(Object.is(m.positions[a], m.positions[b]));
  }
});

// cells=7 (cells-1=6, 간격 64/6 이 2의 거듭제곱이 아님): 경계 비트 일치와 안쪽 정점 위치(Float32 로 한 번만 반올림)를 확인한다.
//   cells=50 은 tx=-1 에서 x0+(c-1)·step 이 (tx+1)·64 와 Float32 로 달라지는 경우라 마지막 열/행 특수 처리를 죽인다.
for (const c of [7, 50]) test(`경계 정점: 간격이 2의 거듭제곱이 아닌 cells=${c} 에서도 비트 일치하고 안쪽 위치가 식과 같다`, () => {
  const mk = (tx, ty) => ({ tx, ty, lod: 3, cells: c, heights: new Float32Array(c * c).fill(1) });
  const tiles = [mk(-3, 0), mk(-2, 0), mk(-3, 1), mk(5, 7), mk(6, 7), mk(5, 8), mk(-1, -1), mk(0, -1), mk(-1, 0)];
  const m = buildLayerMesh(tiles);
  const v = (n, i, j) => (n * c * c + j * c + i) * 3;
  const step = 64 / (c - 1);
  for (const [w, e, nn] of [[0, 1, 2], [3, 4, 5], [6, 7, 8]]) {
    for (let j = 0; j < c; j++) {
      const a = v(w, c - 1, j), b = v(e, 0, j); // 동쪽 가장자리 = 이웃 서쪽 가장자리
      assert.ok(Object.is(m.positions[a], m.positions[b]));
      assert.ok(Object.is(m.positions[a + 1], m.positions[b + 1]));
      assert.equal(m.positions[a], (tiles[w].tx + 1) * 64);
    }
    for (let i = 0; i < c; i++) {
      const a = v(w, i, c - 1), b = v(nn, i, 0); // 북쪽 가장자리 = 이웃 남쪽 가장자리
      assert.ok(Object.is(m.positions[a], m.positions[b]));
      assert.ok(Object.is(m.positions[a + 1], m.positions[b + 1]));
      assert.equal(m.positions[a + 1], (tiles[w].ty + 1) * 64);
    }
  }
  // 안쪽 정점: 원점 + i·(64/6) 을 double 로 계산한 뒤 Float32 로 한 번 반올림한 값과 비트 일치.
  tiles.forEach((t, n) => {
    for (let j = 0; j < c - 1; j++) {
      for (let i = 0; i < c - 1; i++) {
        const k = v(n, i, j);
        assert.ok(Object.is(m.positions[k], Math.fround(t.tx * 64 + i * step)), `타일 ${n} (${i},${j}) x`);
        assert.ok(Object.is(m.positions[k + 1], Math.fround(t.ty * 64 + j * step)), `타일 ${n} (${i},${j}) y`);
      }
    }
  });
});

test('음수 타일 번호도 64·tx 로 놓인다', () => {
  const h = new Float32Array(9).fill(5);
  const m = buildLayerMesh([{ tx: -2, ty: -1, lod: 3, cells: 3, heights: h }]);
  assert.equal(m.positions[0], -128);
  assert.equal(m.positions[1], -64);
  assert.equal(m.positions[(2 * 3 + 2) * 3], -64);
  assert.equal(m.positions[(2 * 3 + 2) * 3 + 1], 0);
});

test('cells=2 최소 타일은 정점 4개·삼각형 2개', () => {
  const m = buildLayerMesh([{ tx: 0, ty: 0, lod: 3, cells: 2, heights: new Float32Array([1, 2, 3, 4]) }]);
  assert.equal(m.positions.length, 12);
  assert.deepEqual(Array.from(m.indices), [0, 1, 3, 0, 3, 2]);
  assert.deepEqual(Array.from(m.positions), [0, 0, 1, 64, 0, 2, 0, 64, 3, 64, 64, 4]);
});

test('입력 검증 음성 사례는 terrain: 접두의 RangeError', () => {
  const ok = () => ({ tx: 0, ty: 0, lod: 0, cells: 3, heights: new Float32Array(9) });
  const bad = (x) => ({ ...ok(), ...x });
  const cases = {
    '배열 아님(null)': null,
    '배열 아님(객체)': {},
    '타일이 null': [null],
    'cells 비정수': [bad({ cells: 2.5 })],
    'cells 1': [bad({ cells: 1, heights: new Float32Array(1) })],
    'heights 길이 불일치': [bad({ heights: new Float32Array(8) })],
    'heights 가 일반 배열': [bad({ heights: [0, 0, 0, 0, 0, 0, 0, 0, 0] })],
    'heights NaN': [bad({ heights: new Float32Array([0, 0, 0, 0, NaN, 0, 0, 0, 0]) })],
    'heights Infinity': [bad({ heights: new Float32Array([0, 0, 0, 0, 0, 0, 0, Infinity, 0]) })],
    'tx 비정수': [bad({ tx: 0.5 })],
    'tx Float32 초과': [bad({ tx: 1e37 })],
    'ty Float32 초과': [bad({ ty: -1e37 })],
    'ty NaN': [bad({ ty: NaN })],
    '(tx,ty) 중복': [ok(), ok()],
    'cells 가 타일마다 다름': [ok(), bad({ tx: 1, cells: 2, heights: new Float32Array(4) })],
  };
  for (const [name, input] of Object.entries(cases)) {
    assert.throws(() => buildLayerMesh(input), (e) => e instanceof RangeError && e.message.startsWith('terrain:'), name);
  }
});

// 경계: 64·(tx+1) ≤ 2^24 인 가장 큰 정수 tx (음수 쪽은 -MAX_TX-1 = -2^18 이 64·tx = -2^24 로 경계).
const MAX_TX = MAX_ABS_POSITION_M / 64 - 1;

test('1 m 구별 한계(2^24 m) 안쪽 최대 타일은 통과하고 바로 바깥은 RangeError', () => {
  assert.equal(MAX_TX, 2 ** 18 - 1);
  const heights = new Float32Array(4);
  const m = buildLayerMesh([
    { tx: MAX_TX, ty: 0, cells: 2, heights },
    { tx: MAX_TX - 1, ty: 0, cells: 2, heights },
    { tx: -MAX_TX - 1, ty: -MAX_TX - 1, cells: 2, heights },
  ]);
  assert.ok(m.positions.every(Number.isFinite));
  // 경계 타일 정점 x 가 이웃 타일 정점 x 와 Float32 에서 구별된다.
  const xs = (n) => [m.positions[n * 12], m.positions[n * 12 + 3]];
  const [a0, a1] = xs(0);
  const [b0, b1] = xs(1);
  assert.notEqual(a0, a1);
  assert.equal(a1, MAX_ABS_POSITION_M);
  assert.equal(b1, a0);
  assert.notEqual(b0, a0);
  assert.notEqual(Math.fround(a1 - 1), a1);
  assert.throws(() => buildLayerMesh([{ tx: MAX_TX + 1, ty: 0, cells: 2, heights }]), RangeError);
  assert.throws(() => buildLayerMesh([{ tx: 0, ty: MAX_TX + 1, cells: 2, heights }]), RangeError);
  assert.throws(() => buildLayerMesh([{ tx: -MAX_TX - 2, ty: 0, cells: 2, heights }]), RangeError);
  assert.throws(() => buildLayerMesh([{ tx: 0, ty: -MAX_TX - 2, cells: 2, heights }]), RangeError);
  assert.throws(() => buildLayerMesh([{ tx: 2 ** 30 * 1e7, ty: 0, cells: 2, heights }]), RangeError);
  assert.throws(() => buildLayerMesh([{ tx: 2 ** 30, ty: 0, cells: 2, heights }]), RangeError);
});

test('범위 밖 tx 는 층 accept 가 RangeError 로 거부하고 수준 -1 이 유지되며 render 는 빈 결과다', () => {
  const L = createTerrainLayer();
  assert.throws(() => L.accept(0, [{ tx: 1e37, ty: 0, cells: 3, heights: new Float32Array(9) }]), RangeError);
  assert.equal(L.state().level, -1);
  const out = L.render({ width: 8, height: 8, K: { fx: 8, fy: 8, cx: 4, cy: 4 }, R: [1, 0, 0, 0, -1, 0, 0, 0, -1], t: [0, 0, 100] });
  assert.ok(out.index.every((v) => v === -1) && out.color.every((v) => v === 0));
});
