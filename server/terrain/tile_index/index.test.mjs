import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTileIndex, TILE_INDEX_MAX_TILES, TILE_INDEX_MAX_TOTAL_CELLS } from './index.mjs';
import { TowerAssetError } from '../../../contracts/tower_assets/index.mjs';

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

test('넓이 0 항목과 색인 범위 끝(ROOT.maxX·maxY)에 닿는 항목도 조회된다', () => {
  const items = [
    { id: 1, bounds: { minX: 100, minY: 100, maxX: 100, maxY: 100 } }, // 점 항목
    { id: 2, bounds: { minX: 200, minY: 10, maxX: 200, maxY: 50 } }, // 폭 0 선분
    { id: 3, bounds: { minX: ROOT.maxX, minY: 0, maxX: ROOT.maxX + 50, maxY: 10 } }, // ROOT.maxX 에 닿음
    { id: 4, bounds: { minX: 0, minY: ROOT.maxY, maxX: 10, maxY: ROOT.maxY + 50 } }, // ROOT.maxY 에 닿음
    { id: 5, bounds: { minX: ROOT.minX - 50, minY: 0, maxX: ROOT.minX, maxY: 10 } }, // ROOT.minX 에 닿음
  ];
  const idx = buildTileIndex(ROOT, items);
  assert.deepEqual(idx.query(100, 100), [1]);
  assert.deepEqual(idx.query(200, 30), [2]);
  assert.deepEqual(idx.query(ROOT.maxX, 5), [3]);
  assert.deepEqual(idx.query(5, ROOT.maxY), [4]);
  assert.deepEqual(idx.query(ROOT.minX, 5), [5]);
});

test('입력 검증: id 중복·누락·null 항목·items 아님', () => {
  const b = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  assert.throws(() => buildTileIndex(ROOT, [{ id: 1, bounds: b }, { id: 1, bounds: b }]), TowerAssetError);
  assert.throws(() => buildTileIndex(ROOT, [{ bounds: b }]), TowerAssetError);
  assert.throws(() => buildTileIndex(ROOT, [{ id: null, bounds: b }]), TowerAssetError);
  assert.throws(() => buildTileIndex(ROOT, [null]), TowerAssetError);
  assert.throws(() => buildTileIndex(ROOT, [{ id: 1, bounds: null }]), TowerAssetError);
  assert.throws(() => buildTileIndex(ROOT, null), TowerAssetError);
});

// F-319 ④: 타일 수 상한. 예전에는 tilesIn 이 2,442,969 개 타일을 그대로 돌려줬다.
test('타일 수 상한: 질의·항목이 상한을 넘으면 TowerAssetError, 상한 이하는 통과', () => {
  assert.equal(TILE_INDEX_MAX_TILES, 65536);
  const BIG = { minX: 0, minY: 0, maxX: 64 * 1563, maxY: 64 * 1563 }; // 1563² = 2,442,969 타일
  const idx = buildTileIndex(BIG, []);
  assert.throws(() => idx.tilesIn(BIG), TowerAssetError);
  assert.throws(() => idx.tilesIn(BIG), /상한/);
  // 한 변이 상한을 넘는 가는 띠도 던진다.
  const wide = { minX: 0, minY: 0, maxX: 64 * 65536, maxY: 1 };
  assert.throws(() => buildTileIndex(wide, []).tilesIn(wide), TowerAssetError);
  // 경계: 256×256 = 65536 개는 허용, 256×257 은 거부.
  const ok = { minX: 0, minY: 0, maxX: 64 * 256 - 1, maxY: 64 * 256 - 1 };
  assert.equal(buildTileIndex(BIG, []).tilesIn(ok).length, 65536);
  assert.throws(() => idx.tilesIn({ minX: 0, minY: 0, maxX: 64 * 256 - 1, maxY: 64 * 257 - 1 }), TowerAssetError);
  // 항목 하나가 상한보다 많은 타일을 덮는 경우도 색인을 만들다 말고 던진다(배열을 만들기 전에).
  assert.throws(() => buildTileIndex(BIG, [{ id: 1, bounds: BIG }]), TowerAssetError);
  assert.doesNotThrow(() => buildTileIndex(BIG, [{ id: 1, bounds: ok }]));
});

test('항목 합산 셀 수 상한: 65536 타일짜리 300개는 1초 안에 TowerAssetError (F-319 ⑦)', () => {
  const side = 256 * 64 - 1;
  const items = [];
  for (let i = 0; i < 300; i++) items.push({ id: i, bounds: { minX: 0, minY: 0, maxX: side, maxY: side } });
  const t0 = Date.now();
  assert.throws(() => buildTileIndex({ minX: 0, minY: 0, maxX: side, maxY: side }, items), TowerAssetError);
  assert.ok(Date.now() - t0 < 1000);
});

// F-329 ①: 상한 정확히/상한+1. `>`→`>=`, 상한 값 변경, 한 변 검사 변이를 모두 잡는다.
test('타일 수 상한 경계: 65536 개 통과, 65537 개 거부(가는 띠·정사각·항목)', () => {
  const W = 64 * 70000;
  const root = { minX: 0, minY: 0, maxX: W, maxY: W };
  const idx = buildTileIndex(root, []);
  const box = (nx, ny) => ({ minX: 0, minY: 0, maxX: 64 * nx - 1, maxY: 64 * ny - 1 });
  for (const [nx, ny] of [[65536, 1], [1, 65536], [256, 256], [8192, 8], [2, 32768]]) {
    assert.equal(idx.tilesIn(box(nx, ny)).length, 65536, `${nx}x${ny}`);
    assert.doesNotThrow(() => buildTileIndex(root, [{ id: 1, bounds: box(nx, ny) }]), `${nx}x${ny} 항목`);
  }
  for (const [nx, ny] of [[65537, 1], [1, 65537], [8193, 8], [257, 256]]) {
    assert.throws(() => idx.tilesIn(box(nx, ny)), TowerAssetError, `${nx}x${ny}`);
    assert.throws(() => buildTileIndex(root, [{ id: 1, bounds: box(nx, ny) }]), TowerAssetError, `${nx}x${ny} 항목`);
  }
});

// F-319 ⑦ / F-329: 합산 셀 상한 경계. 정확히 1,000,000 은 통과, 1,000,001 은 거부.
test('항목 합산 셀 수 상한 경계: 1,000,000 통과, 1,000,001 거부', () => {
  assert.equal(TILE_INDEX_MAX_TOTAL_CELLS, 1_000_000);
  const root = { minX: 0, minY: 0, maxX: 64 * 200, maxY: 64 * 200 };
  const sq = (n) => ({ minX: 0, minY: 0, maxX: 64 * n - 1, maxY: 64 * n - 1 });
  const make = (extra) => {
    const items = [];
    for (let i = 0; i < 100; i++) items.push({ id: i, bounds: sq(100) }); // 100×100 = 10000 개씩
    if (extra) items.push({ id: 1000, bounds: sq(1) });
    return items;
  };
  assert.doesNotThrow(() => buildTileIndex(root, make(false)));
  assert.throws(() => buildTileIndex(root, make(true)), /상한/);
});
