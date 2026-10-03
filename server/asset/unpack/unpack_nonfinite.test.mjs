// F-069 unpack 비유한 출력 방지: 변형 시험 + 골든 변조 2만 건(고정 시드)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { unpackChunk } from './index.mjs';
import { OFFSETS, AssetFormatError } from '../../../contracts/asset/index.mjs';

const load = (n) => new Uint8Array(readFileSync(new URL(`../../../fixtures/asset_golden/${n}.skla`, import.meta.url)));
const f64 = (b, o, v) => new DataView(b.buffer, b.byteOffset).setFloat64(o, v, true);
const isBbox = (e) => e instanceof AssetFormatError && e.code === 'bbox';

test('bboxMin=[1e308,0,0] → AssetFormatError(bbox)', () => {
  for (const n of ['point27', 'gauss56']) {
    const b = load(n);
    f64(b, OFFSETS.bboxMin, 1e308);
    assert.throws(() => unpackChunk(b), isBbox);
  }
});

test('bboxMax 비유한 → AssetFormatError(bbox)', () => {
  for (let k = 0; k < 3; k++) {
    const b = load('point27');
    f64(b, OFFSETS.bboxMax + 8 * k, NaN);
    assert.throws(() => unpackChunk(b), isBbox);
  }
});

test('골든 변조 2만 건: 성공한 출력에 비유한 0', () => {
  let s = 0x9e3779b9;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
  let bad = 0, ok = 0;
  for (let t = 0; t < 20000; t++) {
    const b = load(t % 2 ? 'gauss56' : 'point27');
    const flips = 1 + (rnd() % 3);
    for (let f = 0; f < flips; f++) {
      // 헤더 bbox 영역을 자주 건드린다
      const off = rnd() % 4 === 0 ? OFFSETS.bboxMin + (rnd() % 48) : rnd() % b.length;
      b[off] = rnd() & 255;
    }
    let r;
    try { r = unpackChunk(b); } catch (e) { assert.ok(e instanceof AssetFormatError, String(e)); continue; }
    ok++;
    for (const arr of Object.values(r.fields)) for (const v of arr) if (!Number.isFinite(v)) bad++;
  }
  assert.equal(bad, 0);
  assert.ok(ok > 0);
});
