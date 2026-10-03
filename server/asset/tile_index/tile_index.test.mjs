// 타일 색인 시험: 고정 시드 무작위 점으로 분류·순서·분할을 검사한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tileOf, tileBounds, groupByTile } from './index.mjs';
import { TILE_SIZE_M } from '../../../contracts/asset/index.mjs';

// 고정 시드 PRNG (mulberry32)
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const N = 10000;

function makePoints() {
  const rnd = prng(20260502);
  const p = new Float64Array(3 * N);
  for (let i = 0; i < N; i++) {
    let e = (rnd() - 0.5) * 1000; // -500..500 m, 음수 포함
    let n = (rnd() - 0.5) * 1000;
    const r = rnd();
    if (r < 0.15) e = 64 * Math.round(e / 64); // 경계 e = 64k
    else if (r < 0.25) n = 64 * Math.round(n / 64);
    else if (r < 0.3) e = -1e-9; // 0 바로 아래
    p[3 * i] = e;
    p[3 * i + 1] = n;
    p[3 * i + 2] = (rnd() - 0.5) * 200;
  }
  return p;
}

function calculateExpectations() {
  const pos = makePoints();
  const tiles = new Set();
  let minTileY = Infinity;
  let maxTileY = -Infinity;
  for (let i = 0; i < N; i++) {
    const e = pos[3 * i];
    const n = pos[3 * i + 1];
    const tileX = Math.floor(e / 64);
    const tileY = Math.floor(n / 64);
    tiles.add(`${tileX},${tileY}`);
    minTileY = Math.min(minTileY, tileY);
    maxTileY = Math.max(maxTileY, tileY);
  }
  return { groups: tiles.size, firstTileY: minTileY, lastTileY: maxTileY };
}

const EXPECT = calculateExpectations();

test('tile_size', () => assert.equal(TILE_SIZE_M, 64));

test('tileOf: 기준값(경계·음수)', () => {
  assert.deepEqual(tileOf(0, 0), { tileX: 0, tileY: 0 });
  assert.deepEqual(tileOf(63.999, 64), { tileX: 0, tileY: 1 });
  assert.deepEqual(tileOf(64, 128), { tileX: 1, tileY: 2 });
  assert.deepEqual(tileOf(-0.001, -64), { tileX: -1, tileY: -1 });
  assert.deepEqual(tileOf(-64.001, -0), { tileX: -2, tileY: 0 });
  assert.ok(Object.is(tileOf(-0, -0).tileX, 0));
});

test('tileBounds: 기준값', () => {
  assert.deepEqual(tileBounds(0, 0), { eMin: 0, eMax: 64, nMin: 0, nMax: 64 });
  assert.deepEqual(tileBounds(-1, 2), { eMin: -64, eMax: 0, nMin: 128, nMax: 192 });
  assert.throws(() => tileBounds(0.5, 0), RangeError);
  assert.throws(() => tileBounds(0, 2 ** 31), RangeError);
});

test('tile_index_lookup', () => {
  const pos = makePoints();
  const groups = groupByTile(pos);

  assert.equal(groups.length, EXPECT.groups);
  assert.equal(groups[0].tileY, EXPECT.firstTileY);
  assert.equal(groups.at(-1).tileY, EXPECT.lastTileY);

  const seen = new Uint8Array(N);
  let total = 0;
  let misclassified = 0;
  let prev = null;
  for (const g of groups) {
    // 정렬: tileY 오름차순 → tileX 오름차순
    if (prev) assert.ok(g.tileY > prev.tileY || (g.tileY === prev.tileY && g.tileX > prev.tileX));
    prev = g;
    assert.ok(g.indices instanceof Uint32Array && g.indices.length > 0);
    const b = tileBounds(g.tileX, g.tileY);
    assert.equal(b.eMax - b.eMin, 64);
    assert.equal(b.nMax - b.nMin, 64);
    for (let k = 0; k < g.indices.length; k++) {
      const i = g.indices[k];
      if (k > 0) assert.ok(i > g.indices[k - 1], '점 번호 오름차순');
      const e = pos[3 * i];
      const n = pos[3 * i + 1];
      if (!(e >= b.eMin && e < b.eMax && n >= b.nMin && n < b.nMax)) misclassified++;
      const t = tileOf(e, n);
      if (t.tileX !== g.tileX || t.tileY !== g.tileY) misclassified++;
      seen[i]++;
      total++;
    }
  }
  assert.equal(misclassified, 0);
  assert.equal(total, N);
  assert.ok(seen.every((c) => c === 1), '모든 점이 정확히 한 그룹');
});

test('groupByTile: Float32 입력과 빈 입력', () => {
  const p = new Float32Array([64, 0, 5, -0.5, 0, 1, 10, -64, 0]);
  const g = groupByTile(p);
  assert.deepEqual(
    g.map((x) => [x.tileX, x.tileY, [...x.indices]]),
    [[0, -1, [2]], [-1, 0, [1]], [1, 0, [0]]],
  );
  assert.deepEqual(groupByTile(new Float64Array(0)), []);
});

test('비유한 값·i32 범위 밖은 던진다', () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.throws(() => tileOf(bad, 0), RangeError);
    assert.throws(() => tileOf(0, bad), RangeError);
    assert.throws(() => groupByTile(new Float64Array([0, 0, bad])), RangeError);
    assert.throws(() => groupByTile(new Float64Array([bad, 0, 0])), RangeError);
  }
  const lim = 64 * 2 ** 31; // 타일 번호 2^31 → i32 초과
  assert.throws(() => tileOf(lim, 0), RangeError);
  assert.throws(() => tileOf(0, -lim - 64), RangeError);
  assert.deepEqual(tileOf(lim - 1, -lim), { tileX: 2147483647, tileY: -2147483648 });
  assert.throws(() => groupByTile(new Float64Array([lim, 0, 0])), RangeError);
  assert.throws(() => groupByTile(new Float64Array(4)), RangeError);
});
