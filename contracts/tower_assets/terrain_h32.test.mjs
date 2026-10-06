import test from 'node:test';
import assert from 'node:assert/strict';
import * as h from './terrain_h32.mjs';

test('H32 크기 산식', () => {
  assert.equal(h.terrainH32Bytes(65, false), 16 + 4 * 65 * 65);
  assert.equal(h.terrainH32Bytes(65, true), 24 + 2 * 65 * 65);
});
