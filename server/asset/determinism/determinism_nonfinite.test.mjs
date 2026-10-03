// F-069 checkDeterminism: packFn 결과 형식 검사
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDeterminism } from './index.mjs';
import { AssetFormatError } from '../../../contracts/asset/index.mjs';

test('packFn 이 Uint8Array 가 아니면 AssetFormatError', () => {
  for (const bad of [null, undefined, 'abc', [1, 2], new ArrayBuffer(2)]) {
    assert.throws(() => checkDeterminism({}, 2, () => bad), AssetFormatError);
  }
  assert.throws(() => checkDeterminism({}, 1, () => null), AssetFormatError);
});
