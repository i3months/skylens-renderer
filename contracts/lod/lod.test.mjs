import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCloud, assertLevelParams, edgeOfLevel, LOD_API, MAX_LEVELS } from './index.mjs';

const cloud = (n) => ({ format: 1, count: n, positions: new Float32Array(3 * n), normals: new Float32Array(3 * n), colors: new Uint8Array(3 * n) });

test('assertCloud 는 올바른 점군을 받는다', () => assert.equal(assertCloud(cloud(4)), 4));
test('assertCloud 는 count 불일치를 거부한다', () => {
  const c = cloud(4); c.count = 3;
  assert.throws(() => assertCloud(c), /lod: count/);
});
test('assertCloud 는 format 2 와 비유한 좌표를 거부한다', () => {
  assert.throws(() => assertCloud({ ...cloud(1), format: 2 }), /format 1/);
  const c = cloud(1); c.positions[1] = NaN;
  assert.throws(() => assertCloud(c), /유한/);
});
test('assertLevelParams 경계', () => {
  assertLevelParams(0.05, 1); assertLevelParams(0.05, MAX_LEVELS);
  for (const [e, l] of [[0, 3], [NaN, 3], [-1, 3], [0.1, 0], [0.1, MAX_LEVELS + 1], [0.1, 2.5]]) assert.throws(() => assertLevelParams(e, l), /lod:/);
});
test('edgeOfLevel 은 단계마다 2배', () => assert.deepEqual([0, 1, 2, 3].map((l) => edgeOfLevel(0.05, l)), [0.05, 0.1, 0.2, 0.4]));
test('LOD_API 모듈 경로가 겹치지 않는다', () => {
  const mods = Object.values(LOD_API).map((a) => a.module);
  assert.equal(new Set(mods).size, mods.length);
});
