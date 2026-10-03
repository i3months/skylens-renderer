// F-069 checksum 진입부 형식 검사
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, computeChecksum } from './index.mjs';
import { AssetFormatError } from '../../../contracts/asset/index.mjs';

test('Uint8Array 가 아닌 입력은 AssetFormatError', () => {
  for (const bad of [null, undefined, 'abc', new ArrayBuffer(8), [1, 2]]) {
    assert.throws(() => crc32(bad), AssetFormatError);
    assert.throws(() => computeChecksum(bad), AssetFormatError);
  }
});
