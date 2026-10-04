import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInitialBundle } from './index.mjs';

const MiB = 1024 * 1024;
// 10x10 격자, 타일 한 변 10 m, x 0..100, y 0..100, 지면 z 0..1. 카메라는 (50,-50,0.5)에서 +y(월드)를 본다.
// 카메라 +z 를 +y 월드로 돌리는 회전: x축 기준 +90도 → quat=(sin45,0,0,cos45): (0,0,1)→(0,-sin90?..) 아래에서 앞 방향을 검증한다.
const s = Math.SQRT1_2;
const pose = { pos: [50, -50, 0.5], quat: [-s, 0, 0, s], fovY: 0.8 };

function grid(bytes, level = 0, lod = 0) {
  const c = [];
  for (let ty = 0; ty < 10; ty++) for (let tx = 0; tx < 10; tx++) {
    c.push({ key: { segmentId: 1, level, lod, chunkIndex: 0, tileX: tx, tileY: ty },
      bytes, bbox: { min: [tx * 10, ty * 10, 0], max: [tx * 10 + 10, ty * 10 + 10, 1] } });
  }
  return c;
}

test('앞 방향은 +y', () => {
  // 카메라 뒤(y<-50) 에만 있는 조각은 0, 앞쪽은 있음
  const back = { key: { segmentId: 2, level: 0, lod: 0, chunkIndex: 0, tileX: 0, tileY: -9 }, bytes: 5, bbox: { min: [45, -100, 0], max: [55, -90, 1] } };
  const front = { key: { segmentId: 2, level: 0, lod: 0, chunkIndex: 0, tileX: 0, tileY: 5 }, bytes: 5, bbox: { min: [45, 0, 0], max: [55, 10, 1] } };
  const r = buildInitialBundle({ pose, catalog: [back, front] });
  assert.deepEqual(r.items, [front]);
});

function boxDist(i) {
  let s = 0;
  for (let k = 0; k < 3; k++) {
    const g = Math.max(i.bbox.min[k] - pose.pos[k], 0, pose.pos[k] - i.bbox.max[k]);
    s += g * g;
  }
  return Math.sqrt(s);
}

test('예산 넉넉: 총바이트 <= 15MiB, 수준 0 만, 가까운 순, 뒤쪽 0', () => {
  const cat = [...grid(100_000, 0), ...grid(100_000, 1), ...grid(100_000, 3)];
  const r = buildInitialBundle({ pose, catalog: cat });
  assert.ok(r.totalBytes <= 15 * MiB);
  assert.ok(r.items.length > 0);
  assert.ok(r.items.every((i) => i.key.level === 0));
  for (let k = 1; k < r.items.length; k++) assert.ok(boxDist(r.items[k]) >= boxDist(r.items[k - 1]));
  assert.equal(r.droppedCount, 0);
  // 카메라 뒤(y < -50) 격자: 0 개
  const behind = grid(10).map((i) => ({ ...i, bbox: { min: [i.bbox.min[0], i.bbox.min[1] - 200, 0], max: [i.bbox.max[0], i.bbox.max[1] - 200, 1] } }));
  assert.equal(buildInitialBundle({ pose, catalog: behind }).items.length, 0);
});

test('예산 부족: droppedCount 손계산', () => {
  // 시야 안 20 개(1 MiB), 카메라 뒤 5 개, 시야 밖 옆 5 개. 예산 15 MiB → 15 담고 5 버림.
  const mk = (n, x, y) => ({ key: { segmentId: 3, level: 0, lod: 0, chunkIndex: 0, tileX: n, tileY: 0 }, bytes: MiB,
    bbox: { min: [x - 1, y - 1, 0], max: [x + 1, y + 1, 1] } });
  const cat = [];
  for (let n = 0; n < 20; n++) cat.push(mk(n, 50, 0 + n * 3));       // 정면 앞
  for (let n = 20; n < 25; n++) cat.push(mk(n, 50, -100 - n));       // 뒤
  for (let n = 25; n < 30; n++) cat.push(mk(n, 5000, 0));            // 옆 멀리(각 90도 부근)
  const r = buildInitialBundle({ pose: { ...pose, fovY: 0.5 }, catalog: cat });
  assert.equal(r.items.length, 15);
  assert.equal(r.totalBytes, 15 * MiB);
  assert.equal(r.droppedCount, 5);
  assert.deepEqual(r.items.map((i) => i.key.tileX), Array.from({ length: 15 }, (_, k) => k));
});

test('고정 숫자: 예산 3500 바이트, 항목 1000 바이트 → 3 개 담고 나머지 버림', () => {
  const cat = grid(1000).filter((i) => i.key.tileY === 0); // 카메라 바로 앞 줄 10 타일, 모두 시야 안
  const r = buildInitialBundle({ pose: { ...pose, fovY: 2.0 }, catalog: cat, budgetBytes: 3500 });
  assert.equal(r.items.length, 3);
  assert.equal(r.totalBytes, 3000);
  assert.equal(r.droppedCount, 7);
});

test('타일에서 가장 거친 lod 만', () => {
  const a = grid(10).slice(40, 41)[0];
  const fine = { ...a, key: { ...a.key, lod: 0 } };
  const coarse = { ...a, key: { ...a.key, lod: 3 } };
  const r = buildInitialBundle({ pose: { ...pose, fovY: 2.0 }, catalog: [fine, coarse] });
  assert.deepEqual(r.items, [coarse]);
});
