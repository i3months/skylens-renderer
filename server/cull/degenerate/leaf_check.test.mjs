import test from 'node:test';
import assert from 'node:assert/strict';
import { checkLeafIndexOneToOne } from './leaf_check.mjs';

const oc = (leafIndex, boxMin, boxMax, leafCount) => ({
  leafIndex: Int32Array.from(leafIndex), boxMin: Float32Array.from(boxMin), boxMax: Float32Array.from(boxMax), leafCount, nodeCount: leafIndex.length,
});

test('leaf_check: 정상 입력은 통과하고 scratch 를 쓴다', () => {
  const s = new Uint8Array(2);
  checkLeafIndexOneToOne(oc([-1, 0, 1], [0, 0, 0, 0, 0, 0, 1, 1, 1], [1, 1, 1, 1, 1, 1, 2, 2, 2], 2), s);
  assert.deepEqual([...s], [1, 1]);
});
test('leaf_check: 비정수·NaN leafIndex 는 cull: 오류 (Float32Array 포함)', () => {
  const b = [0, 0, 0, 0, 0, 0], e = [1, 1, 1, 1, 1, 1];
  const raw = (leafIndex) => ({ ...oc([0, 1], b, e, 2), leafIndex });
  assert.throws(() => checkLeafIndexOneToOne(raw([0, 1.5])), /^Error: cull:.*정수/);
  assert.throws(() => checkLeafIndexOneToOne(raw([0, NaN])), /^Error: cull:/);
  assert.throws(() => checkLeafIndexOneToOne(raw(Float32Array.from([0, 1.5]))), /^Error: cull:.*정수/);
  assert.throws(() => checkLeafIndexOneToOne(raw(Float32Array.from([0, NaN]))), /^Error: cull:/);
  checkLeafIndexOneToOne(raw(Float32Array.from([0, 1])));
});
test('leaf_check: 중복·범위 밖·개수 불일치·±Inf 는 cull: 오류', () => {
  const b = [0, 0, 0, 0, 0, 0], e = [1, 1, 1, 1, 1, 1];
  assert.throws(() => checkLeafIndexOneToOne(oc([0, 0], b, e, 2)), /^Error: cull:/);
  assert.throws(() => checkLeafIndexOneToOne(oc([0, 2], b, e, 2)), /^Error: cull:/);
  assert.throws(() => checkLeafIndexOneToOne(oc([0, -1], b, e, 2)), /^Error: cull:/);
  assert.throws(() => checkLeafIndexOneToOne(oc([0, 1], [0, 0, 0, -Infinity, 0, 0], e, 2)), /^Error: cull:/);
  assert.throws(() => checkLeafIndexOneToOne(oc([0, 1], b, [1, 1, 1, 1, Infinity, 1], 2)), /^Error: cull:/);
});
