import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTileIndex } from './index.mjs';

// 시드 고정 PRNG(mulberry32)
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

const inB = (b, x, y) => x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
function brute(root, items, x, y) {
  if (!inB(root, x, y)) return [];
  return items.filter((it) => inB(it.bounds, x, y)).map((it) => it.id).sort((p, q) => p - q);
}

const ROOT = { minX: -500, minY: -300, maxX: 1500, maxY: 900 };

test('무작위 항목 2000개 · 조회 20000회가 브루트포스와 일치', () => {
  const rnd = prng(14008);
  const items = [];
  for (let i = 0; i < 2000; i++) {
    const w = rnd() * 150, h = rnd() * 150;
    // 일부는 정수·타일 경계에 맞춰 경계 일치를 자주 만든다
    const snap = i % 4 === 0;
    const minX = snap ? Math.round((rnd() * 2400 - 600) / 64) * 64 : rnd() * 2400 - 600;
    const minY = snap ? Math.round((rnd() * 1500 - 400) / 64) * 64 : rnd() * 1500 - 400;
    items.push({ id: i * 3 + 1, bounds: { minX, minY, maxX: snap ? minX + Math.ceil(w / 64) * 64 : minX + w, maxY: snap ? minY + Math.ceil(h / 64) * 64 : minY + h } });
  }
  const idx = buildTileIndex(ROOT, items);
  let bad = 0;
  for (let q = 0; q < 20000; q++) {
    let x, y;
    if (q % 5 === 0) { // 타일 경계 위 또는 항목 경계 위 점
      const it = items[Math.floor(rnd() * items.length)].bounds;
      x = q % 10 === 0 ? it.minX : it.maxX;
      y = q % 3 === 0 ? it.minY : it.maxY;
    } else {
      x = rnd() * 2400 - 700;
      y = rnd() * 1500 - 450;
    }
    const got = idx.query(x, y), want = brute(ROOT, items, x, y);
    if (got.length !== want.length || got.some((v, i) => v !== want[i])) bad++;
  }
  assert.equal(bad, 0);
});

test('경계: 정확히 타일 경계, 음수 좌표, 범위 밖', () => {
  const items = [
    { id: 7, bounds: { minX: 0, minY: 0, maxX: 64, maxY: 64 } },
    { id: 3, bounds: { minX: -70, minY: -70, maxX: -64, maxY: -64 } },
    { id: 5, bounds: { minX: 60, minY: 60, maxX: 200, maxY: 70 } },
    { id: 9, bounds: { minX: 5000, minY: 5000, maxX: 5100, maxY: 5100 } },
  ];
  const idx = buildTileIndex(ROOT, items);
  assert.deepEqual(idx.query(64, 64), [5, 7]);
  assert.deepEqual(idx.query(0, 0), [7]);
  assert.deepEqual(idx.query(-64, -64), [3]);
  assert.deepEqual(idx.query(-64.0001, -64.0001), [3]);
  assert.deepEqual(idx.query(-0.0001, -0.0001), []);
  assert.deepEqual(idx.query(-1000, 0), []);
  assert.deepEqual(idx.query(5050, 5050), []);
  assert.deepEqual(idx.query(1500, 900), []);
  assert.deepEqual(idx.query(NaN, 0), []);
  // tilesIn: 오름차순, 범위 밖 제외
  assert.deepEqual(idx.tilesIn({ minX: 0, minY: 0, maxX: 63.9, maxY: 63.9 }), [{ tx: 0, ty: 0 }]);
  assert.deepEqual(idx.tilesIn({ minX: 0, minY: 0, maxX: 64, maxY: 10 }), [{ tx: 0, ty: 0 }, { tx: 1, ty: 0 }]);
  assert.deepEqual(idx.tilesIn({ minX: -70, minY: -10, maxX: -60, maxY: 10 }),
    [{ tx: -2, ty: -1 }, { tx: -2, ty: 0 }, { tx: -1, ty: -1 }, { tx: -1, ty: 0 }]);
  assert.deepEqual(idx.tilesIn({ minX: 3000, minY: 0, maxX: 4000, maxY: 10 }), []);
  assert.deepEqual(idx.tilesIn({ minX: 1400, minY: 800, maxX: 9000, maxY: 9000 }).at(-1), { tx: 23, ty: 14 });
  assert.equal(idx.tilesIn({ minX: -9000, minY: -9000, maxX: 9000, maxY: 9000 }).length, 32 * 20);
});

test('여러 타일에 걸친 항목은 모든 타일에서 조회된다', () => {
  const idx = buildTileIndex(ROOT, [{ id: 1, bounds: { minX: 10, minY: 10, maxX: 300, maxY: 20 } }]);
  for (const x of [10, 63.99, 64, 128, 191.5, 192, 300]) assert.deepEqual(idx.query(x, 15), [1]);
  assert.deepEqual(idx.query(301, 15), []);
});

test('결정적: 같은 입력은 같은 출력', () => {
  const items = [{ id: 2, bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 } }, { id: 1, bounds: { minX: 50, minY: 50, maxX: 80, maxY: 80 } }];
  const a = buildTileIndex(ROOT, items), b = buildTileIndex(ROOT, items);
  assert.deepEqual(a.query(60, 60), [1, 2]);
  assert.deepEqual(a.query(60, 60), b.query(60, 60));
  assert.deepEqual(a.tilesIn(ROOT), b.tilesIn(ROOT));
});
