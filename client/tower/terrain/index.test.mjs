// 지형 층(createTerrainLayer) 시험: accept 원자성, 수준 교체 렌더, 조명 반영, 기본 인자, 셰이딩 1회.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerrainLayer } from './index.mjs';
import { shadeLambert } from './shade.mjs';

/** 위에서 수직으로 내려다보는 카메라. 영상 오른쪽 = 동, 아래쪽 = 남. */
function nadir(camX, camY, camZ, f = 60, w = 64, h = 64) {
  return { width: w, height: h, K: { fx: f, fy: f, cx: w / 2, cy: h / 2 }, R: [1, 0, 0, 0, -1, 0, 0, 0, -1], t: [-camX, camY, camZ] };
}
const cam = () => nadir(32, 32, 80);

/** 동쪽으로 올라가는 경사 타일(cells×cells). */
function slope(tx, ty, cells, rise = 20) {
  const heights = new Float32Array(cells * cells);
  for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) heights[j * cells + i] = (rise * i) / (cells - 1);
  return { tx, ty, lod: 0, cells, heights };
}
const bump = (tx, ty, cells) => {
  const t = slope(tx, ty, cells, 0);
  t.heights[0] = 9;
  return t;
};
const nanTile = (cells = 3) => ({ tx: 0, ty: 0, lod: 0, cells, heights: new Float32Array(cells * cells).fill(NaN) });
const same = (a, b) => Buffer.compare(Buffer.from(a.color), Buffer.from(b.color)) === 0 && Buffer.compare(Buffer.from(a.index.buffer), Buffer.from(b.index.buffer)) === 0;

test('accept 가 새 메시 실패(NaN 높이)로 던지면 상태가 그대로이고 같은 수준 재시도가 replace 다', () => {
  const L = createTerrainLayer();
  assert.equal(L.accept(1, [slope(0, 0, 3)]), 'first');
  const before = L.state();
  assert.equal(before.level, 1);
  assert.throws(() => L.accept(2, [nanTile()]), RangeError);
  assert.deepEqual(L.state(), before);
  assert.equal(L.accept(2, [slope(0, 0, 4)]), 'replace');
  assert.equal(L.state().level, 2);
});

test('cells:1 타일과 일반 배열 heights 도 던지고 상태를 바꾸지 않는다', () => {
  const L = createTerrainLayer();
  L.accept(1, [slope(0, 0, 3)]);
  const before = L.state();
  assert.throws(() => L.accept(2, [{ tx: 0, ty: 0, cells: 1, heights: new Float32Array(1) }]));
  assert.deepEqual(L.state(), before);
  assert.throws(() => L.accept(2, [{ tx: 0, ty: 0, cells: 2, heights: [0, 0, 0, 0] }]), RangeError);
  assert.deepEqual(L.state(), before);
  assert.equal(L.accept(2, [slope(0, 0, 2)]), 'replace');
});

test('첫 accept 가 실패해도 수준 -1 인 채로 남고 이후 같은 수준이 first 다', () => {
  const L = createTerrainLayer();
  assert.throws(() => L.accept(0, [nanTile()]));
  assert.deepEqual(L.state(), { level: -1, tileCount: 0, triangleCount: 0 });
  assert.equal(L.accept(0, [slope(0, 0, 3)]), 'first');
});

test('낮은 수준(skip)은 잘못된 묶음이어도 검증만 하고 상태를 바꾸지 않는다', () => {
  const L = createTerrainLayer();
  L.accept(3, [slope(0, 0, 3)]);
  const before = L.state();
  assert.equal(L.accept(1, [slope(0, 0, 4)]), 'skip');
  assert.deepEqual(L.state(), before);
  assert.throws(() => L.accept(1, 'x'));
});

test('accept(0)→accept(1) 뒤 render 는 수준 1 만 넣은 층의 render 와 같다', () => {
  const a = createTerrainLayer();
  a.accept(0, [bump(0, 0, 3)]);
  a.accept(1, [slope(0, 0, 5)]);
  const b = createTerrainLayer();
  b.accept(1, [slope(0, 0, 5)]);
  const ra = a.render(cam()), rb = b.render(cam());
  assert.ok(same(ra, rb));
  assert.deepEqual(a.state(), b.state());
  // 수준 0 만 그린 영상과는 달라야 한다(교체가 실제로 일어났다).
  const c = createTerrainLayer();
  c.accept(0, [bump(0, 0, 3)]);
  assert.ok(!same(ra, c.render(cam())));
});

test('opts.lightDirEnu 가 바뀌면 같은 장면의 색이 바뀐다', () => {
  const mk = (lightDirEnu) => {
    const L = createTerrainLayer({ lightDirEnu });
    L.accept(0, [slope(0, 0, 4)]);
    return L.render(cam());
  };
  assert.ok(!same(mk([-1, 0, 1]), mk([1, 0, 1])));
  assert.ok(same(mk([-1, 0, 1]), mk([-2, 0, 2]))); // 방향이 같으면(정규화 후) 같다
});

test('tiles 는 수준별 화면 전체 완전 묶음이다: 높은 수준 묶음에 없는 타일은 남지 않는다', () => {
  const L = createTerrainLayer();
  L.accept(0, [slope(0, 0, 3), slope(1, 0, 3)]);
  assert.equal(L.state().tileCount, 2);
  L.accept(1, [slope(0, 0, 5)]); // (1,0) 은 누적되지 않고 빠진다
  assert.equal(L.state().tileCount, 1);
});

test('createTerrainLayer(null)/(undefined) 는 기본 인자로 던지지 않는다', () => {
  for (const o of [null, undefined]) {
    const L = createTerrainLayer(o);
    L.accept(0, [slope(0, 0, 3)]);
    assert.ok(L.render(cam()).index.some((v) => v >= 0));
  }
});

test('셰이딩은 accept 에서만 삼각형당 한 번 부르고 render 는 부르지 않는다', () => {
  let calls = 0;
  const shade = (...args) => { calls++; return shadeLambert(...args); };
  const L = createTerrainLayer({ shade });
  assert.equal(calls, 0);
  L.accept(0, [slope(0, 0, 3)]);
  assert.equal(calls, L.state().triangleCount);
  const n = calls;
  L.render(cam());
  L.render(cam());
  L.render(nadir(10, 10, 60));
  assert.equal(calls, n);
  // 실패한 accept 와 skip 은 셰이딩하지 않는다.
  assert.throws(() => L.accept(1, [nanTile()]));
  L.accept(0, [slope(0, 0, 3)]);
  assert.equal(calls, n);
});

test('accept 순서를 되돌리면(상태 먼저 커밋) 원자성 시험이 실패해야 한다: 상태는 던지기 전에 바뀌지 않는다', () => {
  // 회귀 감시: 실패한 accept 직후 level 이 올라 있으면 다음 같은 수준 accept 가 skip 이 된다.
  const L = createTerrainLayer();
  L.accept(1, [slope(0, 0, 3)]);
  assert.throws(() => L.accept(2, [nanTile()]));
  assert.notEqual(L.accept(2, [slope(0, 0, 3)]), 'skip');
});
