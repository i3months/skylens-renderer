import test from 'node:test';
import assert from 'node:assert/strict';
import { packChunk } from './index.mjs';
import { readHeaderStrict } from '../header/index.mjs';
import { AssetFormatError, FORMAT_POINT27 } from '../../../contracts/asset/index.mjs';
import { ANCHOR } from '../../../fixtures/asset_golden/generate.mjs';

// 작은 point27 입력(타일 안, 점 4개)
function input(lod) {
  const n = 4;
  const positions = new Float32Array(3 * n);
  const normals = new Float32Array(3 * n);
  const colors = new Uint8Array(3 * n);
  for (let i = 0; i < n; i++) {
    positions.set([64 + i * 0.5, 10 + i * 0.25, 1 + i * 0.0625], 3 * i);
    normals.set([0, 0, 1], 3 * i);
    colors.set([i * 8, 255 - i * 8, 7], 3 * i);
  }
  return { format: FORMAT_POINT27, segmentId: 7, level: 2, lod, chunkIndex: 0, anchor: ANCHOR, fields: { positions, normals, colors } };
}

for (const lod of [8, 255, -1, 1.5, NaN]) {
  test(`lod ${lod} 은 field 로 던진다`, () => {
    assert.throws(() => packChunk(input(lod)), (e) => e instanceof AssetFormatError && e.code === 'field');
  });
}

for (const lod of [0, 7]) {
  test(`lod ${lod} 은 정상이고 readHeaderStrict 를 통과한다`, () => {
    const out = packChunk(input(lod));
    const h = readHeaderStrict(out, { fileBytes: out.length });
    assert.equal(h.lod, lod);
  });
}
