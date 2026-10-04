import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInitialBundle, PIECE_FRAME_OVERHEAD_BYTES } from './index.mjs';
import { encodeMessage } from '../../proto/codec/index.mjs';
import { encodeFrame, OPCODES } from '../../ws/frame/index.mjs';

const INITIAL_BUNDLE_BYTES = 15_000_000; // 초기 묶음 전체 상한(프레임 바이트 기준, 15,000,000 B). 조각 하나의 크기 상한은 이 모듈이 정하지 않는다.
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

test('예산 넉넉: 총바이트 <= 15MB, 수준 0 만, 가까운 순, 뒤쪽 0', () => {
  const cat = [...grid(100_000, 0), ...grid(100_000, 1), ...grid(100_000, 3)];
  const r = buildInitialBundle({ pose, catalog: cat });
  assert.ok(r.totalBytes <= INITIAL_BUNDLE_BYTES);
  assert.ok(r.items.length > 0);
  assert.ok(r.items.every((i) => i.key.level === 0));
  for (let k = 1; k < r.items.length; k++) assert.ok(boxDist(r.items[k]) >= boxDist(r.items[k - 1]));
  assert.equal(r.droppedCount, 0);
  // 카메라 뒤(y < -50) 격자: 0 개
  const behind = grid(10).map((i) => ({ ...i, bbox: { min: [i.bbox.min[0], i.bbox.min[1] - 200, 0], max: [i.bbox.max[0], i.bbox.max[1] - 200, 1] } }));
  assert.equal(buildInitialBundle({ pose, catalog: behind }).items.length, 0);
});

test('항목 크기 선택 [3000,1000,400], 예산 3500: 3000·400 선택, 중간 1000 버림, droppedCount 1', () => {
  // 예산이 부족하면 건너뛰고 다음을 계속 보는지 확인. droppedCount++ 를 break 로 바꾸면 400 항목을 처리하지 못해 실패.
  const cat = [
    { key: { segmentId: 1, level: 0, lod: 0, chunkIndex: 0, tileX: 0, tileY: 0 }, bytes: 3000,
      bbox: { min: [45, 0, 0], max: [55, 10, 1] } },
    { key: { segmentId: 1, level: 0, lod: 0, chunkIndex: 0, tileX: 1, tileY: 0 }, bytes: 1000,
      bbox: { min: [55, 0, 0], max: [65, 10, 1] } },
    { key: { segmentId: 1, level: 0, lod: 0, chunkIndex: 0, tileX: 2, tileY: 0 }, bytes: 400,
      bbox: { min: [65, 0, 0], max: [75, 10, 1] } }
  ];
  const r = buildInitialBundle({ pose: { ...pose, fovY: 2.0 }, catalog: cat, budgetBytes: 3500 + 2 * PIECE_FRAME_OVERHEAD_BYTES });
  assert.equal(r.items.length, 2);
  assert.equal(r.totalBytes, 3400);
  // WELCOME(27 B) + LEVEL_ARRIVED(31 B) 도 예산에 든다: 3400 + 2×38 + 58
  assert.equal(r.frameBytes, 3534);
  assert.equal(r.droppedCount, 1);
  assert.deepEqual(r.items.map((i) => i.bytes), [3000, 400]);
});

const cell = (i, bytes) => ({
  key: { segmentId: 1, level: 0, lod: 0, chunkIndex: 0, tileX: i, tileY: 0 },
  bytes,
  bbox: { min: [45 + i * 10, 0, 0], max: [55 + i * 10, 10, 1] }
});

test('경계: 초기 묶음 정확히 채우기 (프레임 바이트 15,000,000 B = 4×(2,999,950+38) + (2,999,952+38) + 58)', () => {
  const cat = Array.from({ length: 5 }, (_, i) => cell(i, i < 4 ? 2_999_950 : 2_999_952));
  const r = buildInitialBundle({ pose: { ...pose, fovY: 2.0 }, catalog: cat });
  assert.equal(r.items.length, 5);
  assert.equal(r.totalBytes, 14_999_752);
  assert.equal(r.frameBytes, 15_000_000);
  assert.equal(r.droppedCount, 0);
});

test('경계: 한 바이트 넘으면 버림 (2,999,952 x 5: 프레임 15,000,008 B)', () => {
  const cat = Array.from({ length: 5 }, (_, i) => cell(i, 2_999_952));
  const r = buildInitialBundle({ pose: { ...pose, fovY: 2.0 }, catalog: cat });
  assert.equal(r.items.length, 4);
  assert.equal(r.droppedCount, 1);
  assert.equal(r.frameBytes, 4 * 2_999_990 + 58); // + WELCOME 27 + LEVEL_ARRIVED 31
});

test('경계: 한 바이트 초과 (2,999,950 x 4 + 2,999,953 x 1: 프레임 15,000,001 B)', () => {
  const cat = Array.from({ length: 5 }, (_, i) => cell(i, i < 4 ? 2_999_950 : 2_999_953));
  const r = buildInitialBundle({ pose: { ...pose, fovY: 2.0 }, catalog: cat });
  assert.equal(r.items.length, 4);
  assert.equal(r.droppedCount, 1);
  assert.equal(r.frameBytes, 27 + 3_000_019 + 2_999_988 * 3);
});

test('경계: 초기 묶음 초과 (3MB x 6개): 4개만, 2개 버림', () => {
  // 3,000,038 B x 5 = 15,000,190 > 15,000,000 이므로 4개
  const cat = Array.from({ length: 6 }, (_, i) => cell(i, 3_000_000));
  const r = buildInitialBundle({ pose: { ...pose, fovY: 2.0 }, catalog: cat });
  assert.equal(r.items.length, 4);
  assert.equal(r.totalBytes, 12_000_000);
  assert.equal(r.droppedCount, 2);
});

test('F-202: .skla 합 15,000,000 - 10n 인 합성 묶음의 실제 프레임 합 <= 15,000,000 B, 초과분은 dropped', () => {
  const frameOf = (bytes) => encodeFrame(OPCODES.BINARY, encodeMessage({
    type: 'PIECE', pieceSeq: 1, key: { segmentId: 1, level: 0, lod: 0, chunkIndex: 0, tileX: 0, tileY: 0 }, chunk: new Uint8Array(bytes),
  })).length;
  for (const n of [4, 10, 25]) {
    const total = 15_000_000 - 10 * n;
    const sizes = Array.from({ length: n }, (_, i) => Math.floor(total / n) + (i < total % n ? 1 : 0));
    assert.equal(sizes.reduce((a, b) => a + b, 0), total);
    const cat = sizes.map((b, i) => ({
      key: { segmentId: 1, level: 0, lod: 0, chunkIndex: 0, tileX: i, tileY: 0 },
      bytes: b, bbox: { min: [45, 0, 0], max: [55, 10, 1] },
    }));
    const r = buildInitialBundle({ pose: { ...pose, fovY: 2.0 }, catalog: cat });
    const real = r.items.reduce((a, it) => a + frameOf(it.bytes), 0);
    assert.ok(real <= INITIAL_BUNDLE_BYTES, `n=${n}: 실제 프레임 합 ${real}`);
    assert.ok(r.frameBytes >= real && r.frameBytes <= INITIAL_BUNDLE_BYTES);
    assert.ok(r.droppedCount >= 1, `n=${n}: 초과분이 dropped 로 가야 한다`);
    assert.equal(r.items.length + r.droppedCount, n);
  }
});

test('경계: 3MB 정확히 + 가용 예산 (3,000,000 B)', () => {
  // 3MB 항목이 시야 안에 있으면 들어감
  const cat = [{
    key: { segmentId: 1, level: 0, lod: 0, chunkIndex: 0, tileX: 0, tileY: 0 },
    bytes: 3_000_000,
    bbox: { min: [45, 0, 0], max: [55, 10, 1] }
  }];
  const r = buildInitialBundle({ pose: { ...pose, fovY: 2.0 }, catalog: cat });
  assert.equal(r.items.length, 1);
  assert.equal(r.totalBytes, 3_000_000);
  assert.equal(r.droppedCount, 0);
});

test('타일에서 가장 거친 lod 만', () => {
  const a = grid(10).slice(40, 41)[0];
  const fine = { ...a, key: { ...a.key, lod: 0 } };
  const coarse = { ...a, key: { ...a.key, lod: 3 } };
  const r = buildInitialBundle({ pose: { ...pose, fovY: 2.0 }, catalog: [fine, coarse] });
  assert.deepEqual(r.items, [coarse]);
});
