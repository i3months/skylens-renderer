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
