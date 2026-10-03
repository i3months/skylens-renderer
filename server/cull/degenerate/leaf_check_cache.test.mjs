import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLeafIndexOneToOne } from './leaf_check.mjs';

// 노드 5개: 0=내부, 1..4=리프 0..3
const make = () => ({
  leafIndex: Int32Array.from([-1, 0, 1, 2, 3]),
  boxMin: new Float32Array(15),
  boxMax: new Float32Array(15).fill(1),
  leafCount: 4,
  nodeCount: 5,
});

test('cull: 같은 계층을 두 번 검사하면 첫 호출만 전체 검사, 두 번째는 캐시 적중', () => {
  const oc = make();
  assert.equal(checkLeafIndexOneToOne(oc), true);
  assert.equal(checkLeafIndexOneToOne(oc), false);
  assert.equal(checkLeafIndexOneToOne(oc), false);
});

test('cull: 캐시 적중이면 scratch 를 건드리지 않는다', () => {
  const oc = make();
  const s = new Float64Array(4);
  assert.equal(checkLeafIndexOneToOne(oc, s), true);
  s.fill(0);
  assert.equal(checkLeafIndexOneToOne(oc, s), false);
  assert.ok(s.every((x) => x === 0));
});

test('cull: 표본에 걸리는 제자리 변조(중복 leafIndex)는 다시 검사해 던진다', () => {
  const oc = make();
  checkLeafIndexOneToOne(oc);
  oc.leafIndex[2] = 0;
  assert.throws(() => checkLeafIndexOneToOne(oc), /^Error: cull:/);
});

test('cull: 표본에 걸리는 제자리 변조(상자 Infinity)는 다시 검사해 던진다', () => {
  const oc = make();
  checkLeafIndexOneToOne(oc);
  oc.boxMax[7] = -Infinity;
  assert.throws(() => checkLeafIndexOneToOne(oc), /유한하지 않음/);
});

test('cull: boxMin·boxMax 를 다른 배열로 바꿔 끼우면 다시 검사한다', () => {
  const oc = make();
  checkLeafIndexOneToOne(oc);
  const bad = new Float32Array(15); bad[4] = Infinity;
  assert.throws(() => checkLeafIndexOneToOne({ ...oc, boxMin: bad }), /유한하지 않음/);
  const badMax = new Float32Array(15).fill(1); badMax[10] = Infinity;
  assert.throws(() => checkLeafIndexOneToOne({ ...oc, boxMax: badMax }), /유한하지 않음/);
});

test('cull: leafCount·nodeCount 가 바뀌면 다시 검사한다', () => {
  const oc = make();
  checkLeafIndexOneToOne(oc);
  assert.throws(() => checkLeafIndexOneToOne({ ...oc, leafCount: 3 }), /^Error: cull:/);
  assert.throws(() => checkLeafIndexOneToOne({ ...oc, nodeCount: 4 }), /^Error: cull:/);
});

test('cull: 실패한 검사는 캐시되지 않아 같은 입력에서 계속 던진다', () => {
  const oc = make();
  oc.boxMin[3] = Infinity;
  assert.throws(() => checkLeafIndexOneToOne(oc), /유한하지 않음/);
  assert.throws(() => checkLeafIndexOneToOne(oc), /유한하지 않음/);
});

test('cull: ±Infinity 는 둘 다 거부하고 NaN 은 통과한다', () => {
  for (const [arr, i, v] of [['boxMin', 3, Infinity], ['boxMin', 4, -Infinity], ['boxMax', 5, Infinity], ['boxMax', 13, -Infinity]]) {
    const oc = make(); oc[arr][i] = v;
    assert.throws(() => checkLeafIndexOneToOne(oc), /유한하지 않음/);
  }
  const ok = make(); ok.boxMin[4] = NaN;
  assert.doesNotThrow(() => checkLeafIndexOneToOne(ok));
});

// 노드 100개(> SENTINEL_SAMPLES=32): 0=내부, 1..99=리프 0..98. 표본(step=3: 0,3,6,...,99)이 전수가 아니다.
const makeBig = () => {
  const n = 100;
  const leafIndex = new Int32Array(n);
  leafIndex[0] = -1;
  for (let i = 1; i < n; i++) leafIndex[i] = i - 1;
  return { leafIndex, boxMin: new Float32Array(3 * n), boxMax: new Float32Array(3 * n).fill(1), leafCount: n - 1, nodeCount: n };
};

test('cull: 표본이 전수가 아닌 계층에서 표본 밖 노드에 Infinity 가 든 새 배열로 바꿔 끼우면 동일성 비교로 다시 검사한다', () => {
  const oc = makeBig();
  assert.equal(checkLeafIndexOneToOne(oc), true);
  // 노드 1·2 는 표본(0,3,6,...,99) 밖이다. 새 배열이므로 값 표본만으로는 못 잡고 boxMin·boxMax 동일성 비교만이 잡는다.
  const badMin = Float32Array.from(oc.boxMin); badMin[3 * 1 + 1] = Infinity;
  assert.throws(() => checkLeafIndexOneToOne({ ...oc, boxMin: badMin }), /^Error: cull:.*유한하지 않음/);
  const badMax = Float32Array.from(oc.boxMax); badMax[3 * 2 + 2] = -Infinity;
  assert.throws(() => checkLeafIndexOneToOne({ ...oc, boxMax: badMax }), /^Error: cull:.*유한하지 않음/);
});

test('cull: 캐시 적중 시 표본 밖 노드는 한 번도 읽지 않는다(전체 검사를 실제로 건너뜀)', () => {
  const oc = makeBig();
  const reads = { leaf: [], min: [], max: [] };
  const spy = (arr, log, per) => new Proxy(arr, {
    get(t, p) {
      if (typeof p === 'string' && /^\d+$/.test(p)) log.push(Math.floor(Number(p) / per));
      return Reflect.get(t, p);
    },
  });
  const spied = { ...oc, leafIndex: spy(oc.leafIndex, reads.leaf, 1), boxMin: spy(oc.boxMin, reads.min, 3), boxMax: spy(oc.boxMax, reads.max, 3) };
  const outside = (n) => !(n % 3 === 0 || n === 99); // 표본 노드: 0,3,...,99 와 마지막
  const outsideReads = () => [...reads.leaf, ...reads.min, ...reads.max].filter(outside).length;
  const clear = () => { reads.leaf.length = reads.min.length = reads.max.length = 0; };

  assert.equal(checkLeafIndexOneToOne(spied), true);
  assert.ok(outsideReads() > 0, '첫 호출은 표본 밖 노드도 읽는 전체 검사여야 한다');

  clear();
  assert.equal(checkLeafIndexOneToOne(spied), false);
  assert.equal(outsideReads(), 0, '적중 시 표본 밖 노드를 읽으면 전체 검사를 건너뛴 것이 아니다');
});
