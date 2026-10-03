import test from 'node:test';
import assert from 'node:assert/strict';
import { CULL_API, CULL_STAGES, assertLeafMask, andMasks, chunksOfMask } from './index.mjs';

test('CULL_API 는 10 개 모듈을 가리키고 모두 server/ client/ bench/ 아래', () => {
  assert.equal(Object.keys(CULL_API).length, 10);
  for (const v of Object.values(CULL_API)) assert.match(v.module, /^(server\/cull|client\/cull|bench\/cull)\//);
  assert.deepEqual([...CULL_STAGES], ['frustum', 'backface', 'occlusion', 'distance']);
});

test('assertLeafMask: 길이·값 위반은 cull: 오류', () => {
  assertLeafMask(new Uint8Array([0, 1, 1]), 3);
  assert.throws(() => assertLeafMask(new Uint8Array(2), 3), /^Error: cull:/);
  assert.throws(() => assertLeafMask(new Uint8Array([0, 2, 1]), 3), /^Error: cull:/);
  assert.throws(() => assertLeafMask([0, 1, 1], 3), /^Error: cull:/);
});

test('andMasks·chunksOfMask', () => {
  const m = andMasks([new Uint8Array([1, 1, 0, 1]), new Uint8Array([1, 0, 0, 1])], 4);
  assert.deepEqual([...m], [1, 0, 0, 1]);
  assert.deepEqual([...chunksOfMask(m)], [0, 3]);
  assert.equal(chunksOfMask(new Uint8Array(3)).length, 0);
});

test('andMasks: 다른 길이는 오류', () => {
  assert.throws(() => andMasks([new Uint8Array([1, 1, 0, 1])], 3), /^Error: cull:/);
  assert.throws(() => andMasks([new Uint8Array([1, 1])], 4), /^Error: cull:/);
});

test('andMasks: 값 2 는 오류', () => {
  assert.throws(() => andMasks([new Uint8Array([0, 2, 1])], 3), /^Error: cull:/);
});

test('andMasks: 빈 목록은 모두 1', () => {
  const m = andMasks([], 3);
  assert.deepEqual([...m], [1, 1, 1]);
});
