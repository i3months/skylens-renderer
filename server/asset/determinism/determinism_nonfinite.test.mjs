// F-069 checkDeterminism: packFn 결과 형식 검사
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDeterminism } from './index.mjs';
import { AssetFormatError } from '../../../contracts/asset/index.mjs';

test('packFn 이 Uint8Array 가 아니면 AssetFormatError', () => {
  for (const bad of [null, undefined, 'abc', [1, 2], new ArrayBuffer(2)]) {
    assert.throws(() => checkDeterminism({}, 2, () => bad), AssetFormatError);
  }
  // 첫 호출은 정상, 두 번째에서 비정상: times=2 라 times 검사가 아니라 결과 형식 검사에서 던져야 한다
  let n = 0;
  assert.throws(() => checkDeterminism({}, 2, () => (n++ === 0 ? new Uint8Array(2) : null)), AssetFormatError);
  assert.throws(() => checkDeterminism({}, 2, () => null), AssetFormatError);
});
