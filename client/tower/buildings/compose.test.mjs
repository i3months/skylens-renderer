// composeLayers 시험(T15.3 .4). 손으로 만든 4×4 사례, 입력 불변, 오류 던짐, 무작위 500 장면 독립 구현 대조.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRenderResult, emptyResult } from '../../../contracts/raster/index.mjs';
import { composeLayers } from './compose.mjs';

const W = 4;
const H = 4;

/** 화소 목록 [{i, d, idx, rgb}] 으로 4×4 결과를 만든다. */
function make(pixels, w = W, h = H) {
  const r = emptyResult(w, h);
  for (const { i, d, idx, rgb } of pixels) {
    r.depth[i] = d;
    r.index[i] = idx;
    r.color.set(rgb, 3 * i);
  }
  return r;
}

function px(r, i) {
  return { d: r.depth[i], idx: r.index[i], rgb: [...r.color.subarray(3 * i, 3 * i + 3)] };
}

function bytes(r) {
  return [Buffer.from(r.color.buffer, r.color.byteOffset, r.color.byteLength), Buffer.from(r.depth.buffer, r.depth.byteOffset, r.depth.byteLength), Buffer.from(r.index.buffer, r.index.byteOffset, r.index.byteLength)];
}

function assertSameBytes(a, b) {
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  const [ca, da, ia] = bytes(a);
  const [cb, db, ib] = bytes(b);
  assert.ok(ca.equals(cb), 'color 바이트 불일치');
  assert.ok(da.equals(db), 'depth 바이트 불일치');
  assert.ok(ia.equals(ib), 'index 바이트 불일치');
}

test('교차 깊이: 화소마다 더 가까운 쪽을 취한다', () => {
  const base = make([
    { i: 0, d: 2, idx: 10, rgb: [1, 2, 3] },
    { i: 1, d: 5, idx: 11, rgb: [4, 5, 6] },
    { i: 15, d: 1.5, idx: 12, rgb: [7, 8, 9] },
  ]);
  const over = make([
    { i: 0, d: 3, idx: 20, rgb: [10, 20, 30] }, // base 가 더 가깝다
    { i: 1, d: 4, idx: 21, rgb: [40, 50, 60] }, // over 가 더 가깝다
    { i: 15, d: 1.25, idx: 22, rgb: [70, 80, 90] }, // over 가 더 가깝다
  ]);
  const r = composeLayers(base, over);
  assertRenderResult(r);
  assert.deepEqual(px(r, 0), { d: 2, idx: 10, rgb: [1, 2, 3] });
  assert.deepEqual(px(r, 1), { d: 4, idx: 21, rgb: [40, 50, 60] });
  assert.deepEqual(px(r, 15), { d: 1.25, idx: 22, rgb: [70, 80, 90] });
});

test('동률: base 유지', () => {
  const base = make([{ i: 5, d: 3, idx: 1, rgb: [9, 9, 9] }]);
  const over = make([{ i: 5, d: 3, idx: 2, rgb: [8, 8, 8] }]);
  const r = composeLayers(base, over);
  assert.deepEqual(px(r, 5), { d: 3, idx: 1, rgb: [9, 9, 9] });
});

test('한쪽만 빈 화소: 다른 쪽을 취한다', () => {
  const base = make([{ i: 2, d: 7, idx: 3, rgb: [1, 1, 1] }]);
  const over = make([{ i: 3, d: 6, idx: 4, rgb: [2, 2, 2] }]);
  const r = composeLayers(base, over);
  assert.deepEqual(px(r, 2), { d: 7, idx: 3, rgb: [1, 1, 1] });
  assert.deepEqual(px(r, 3), { d: 6, idx: 4, rgb: [2, 2, 2] });
});

test('둘 다 빈 화소: 빈 화소(color 0, depth 0, index -1)', () => {
  const r = composeLayers(make([]), make([]));
  assertRenderResult(r);
  for (let i = 0; i < W * H; i += 1) assert.deepEqual(px(r, i), { d: 0, idx: -1, rgb: [0, 0, 0] });
});

test('입력 불변 + 별칭 없음', () => {
  const base = make([{ i: 0, d: 2, idx: 1, rgb: [1, 2, 3] }, { i: 1, d: 9, idx: 2, rgb: [4, 5, 6] }]);
  const over = make([{ i: 0, d: 1, idx: 3, rgb: [7, 8, 9] }, { i: 2, d: 4, idx: 4, rgb: [1, 1, 1] }]);
  const before = [...bytes(base), ...bytes(over)].map((b) => Buffer.from(b));
  const r = composeLayers(base, over);
  const after = [...bytes(base), ...bytes(over)];
  before.forEach((b, k) => assert.ok(b.equals(after[k]), `입력 ${k} 가 바뀜`));
  for (const src of [base, over]) {
    assert.notEqual(r.color.buffer, src.color.buffer);
    assert.notEqual(r.depth.buffer, src.depth.buffer);
    assert.notEqual(r.index.buffer, src.index.buffer);
  }
  // 결과를 고쳐도 입력은 그대로
  r.depth.fill(0);
  r.color.fill(255);
  r.index.fill(-1);
  before.forEach((b, k) => assert.ok(b.equals(bytes(k < 3 ? base : over)[k % 3]), `입력 ${k} 가 결과 수정으로 바뀜`));
});

test('크기 불일치·길이 불일치는 던진다', () => {
  assert.throws(() => composeLayers(make([]), make([], 2, 2)), RangeError);
  assert.throws(() => composeLayers(make([], 4, 2), make([], 2, 4)), RangeError);
  const bad = make([]);
  bad.depth = new Float32Array(15);
  assert.throws(() => composeLayers(make([]), bad), RangeError);
  const bad2 = make([]);
  bad2.color = new Uint8Array(47);
  assert.throws(() => composeLayers(bad2, make([])), RangeError);
  const bad3 = make([]);
  bad3.index = new Int32Array(17);
  assert.throws(() => composeLayers(make([]), bad3), RangeError);
  const bad4 = make([]);
  bad4.depth = new Float64Array(16);
  assert.throws(() => composeLayers(make([]), bad4), TypeError);
  assert.throws(() => composeLayers(null, make([])), TypeError);
});

test('NaN·음수·무한대 깊이는 입력 오류로 던진다', () => {
  for (const bad of [NaN, -1, -0.5, Infinity, -Infinity]) {
    const a = make([{ i: 3, d: 1, idx: 0, rgb: [1, 1, 1] }]);
    const b = make([{ i: 3, d: 1, idx: 0, rgb: [1, 1, 1] }]);
    b.depth[7] = bad; // 한쪽이 비어 있는 화소에서도 던져야 한다
    assert.throws(() => composeLayers(a, b), RangeError, `over ${bad}`);
    assert.throws(() => composeLayers(b, a), RangeError, `base ${bad}`);
  }
});

// ---- 무작위 장면: 독립 구현(시험 안 화소 루프)과 바이트 동일 ----
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomLayer(rand, w, h, emptyP, depthLevels) {
  const r = emptyResult(w, h);
  for (let i = 0; i < w * h; i += 1) {
    if (rand() < emptyP) continue;
    r.depth[i] = Math.fround(1 + Math.floor(rand() * depthLevels) * 0.5); // 적은 단계 수 → 동률이 자주 생김
    r.index[i] = Math.floor(rand() * 1000);
    for (let c = 0; c < 3; c += 1) r.color[3 * i + c] = Math.floor(rand() * 256);
  }
  return r;
}

function reference(a, b) {
  const n = a.width * a.height;
  const color = new Uint8Array(3 * n);
  const depth = new Float32Array(n);
  const index = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i += 1) {
    const pick = a.depth[i] === 0 ? (b.depth[i] === 0 ? null : b) : b.depth[i] === 0 ? a : b.depth[i] < a.depth[i] ? b : a;
    if (!pick) continue;
    depth[i] = pick.depth[i];
    index[i] = pick.index[i];
    for (let c = 0; c < 3; c += 1) color[3 * i + c] = pick.color[3 * i + c];
  }
  return { width: a.width, height: a.height, color, depth, index };
}

test('무작위 500 장면: 독립 구현과 바이트 동일', () => {
  const rand = rng(20240517);
  for (let s = 0; s < 500; s += 1) {
    const w = 1 + Math.floor(rand() * 9);
    const h = 1 + Math.floor(rand() * 9);
    const emptyP = [0, 0.3, 0.7, 1][s % 4];
    const levels = 1 + (s % 5);
    const a = randomLayer(rand, w, h, emptyP, levels);
    const b = randomLayer(rand, w, h, [0.5, 0, 1, 0.3][s % 4], levels);
    const got = composeLayers(a, b);
    assertRenderResult(got);
    assertSameBytes(got, reference(a, b));
  }
});
