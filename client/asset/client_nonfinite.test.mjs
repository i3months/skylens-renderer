// F-069 클라이언트 bbox 비유한 거부
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readHeaderClient } from './index.mjs';
import { OFFSETS, AssetFormatError } from '../../contracts/asset/index.mjs';

const golden = () => new Uint8Array(readFileSync(new URL('../../fixtures/asset_golden/point27.skla', import.meta.url)));

test('readHeaderClient: bbox 6값 중 비유한이면 AssetFormatError(bbox)', () => {
  assert.doesNotThrow(() => readHeaderClient(golden()));
  for (const base of [OFFSETS.bboxMin, OFFSETS.bboxMax]) {
    for (let k = 0; k < 3; k++) {
      for (const v of [NaN, Infinity, -Infinity]) {
        const b = golden();
        new DataView(b.buffer).setFloat64(base + 8 * k, v, true);
        assert.throws(() => readHeaderClient(b), (e) => e instanceof AssetFormatError && e.code === 'bbox');
      }
    }
  }
});
