import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { crc32, computeChecksum, verifyChecksum } from './index.mjs';
import { OFFSETS } from '../../../contracts/asset/index.mjs';

const enc = (s) => new TextEncoder().encode(s);
const golden = (name) => new Uint8Array(fs.readFileSync(new URL(`../../../fixtures/asset_golden/${name}.skla`, import.meta.url)));

// 고정 시드 PRNG (mulberry32)
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('crc32 기준값', () => {
  assert.equal(crc32(enc('abc')), 0x352441c2);
  assert.equal(crc32(enc('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('crc32 prev 이어붙이기', () => {
  const all = enc('123456789');
  for (let i = 0; i <= all.length; i++) {
    assert.equal(crc32(all.subarray(i), crc32(all.subarray(0, i))), 0xcbf43926);
  }
  assert.equal(crc32(new Uint8Array(0), 0xcbf43926), 0xcbf43926);
});

test('crc32 가 node:zlib 과 무작위 1,000개 일치', () => {
  const r = rng(12345);
  for (let i = 0; i < 1000; i++) {
    const b = new Uint8Array(Math.floor(r() * 300));
    for (let k = 0; k < b.length; k++) b[k] = Math.floor(r() * 256);
    assert.equal(crc32(b), zlib.crc32(b));
  }
});

test('골든 두 개 체크섬 기준값과 verifyChecksum', () => {
  const g56 = golden('gauss56');
  const p27 = golden('point27');
  assert.equal(computeChecksum(g56), 449099646);
  assert.equal(computeChecksum(p27), 3589071242);
  assert.equal(verifyChecksum(g56), true);
  assert.equal(verifyChecksum(p27), true);
});

test('잘린·짧은 입력은 거짓', () => {
  const g = golden('point27');
  assert.equal(verifyChecksum(g.subarray(0, 100)), false);
  assert.equal(verifyChecksum(g.subarray(0, g.length - 1)), false);
});

test('checksum_detects_flip', () => {
  const r = rng(20260101);
  for (const name of ['point27', 'gauss56']) {
    const orig = golden(name);
    const dv = new DataView(orig.buffer, orig.byteOffset, orig.byteLength);
    const end = dv.getUint16(OFFSETS.headerSize, true) + dv.getUint32(OFFSETS.bodyBytes, true);
    const buf = orig.slice();
    for (let i = 0; i < 1000; i++) {
      const bit = Math.floor(r() * end * 8);
      const byte = bit >> 3;
      buf[byte] ^= 1 << (bit & 7);
      assert.equal(verifyChecksum(buf), false, `${name} bit ${bit}`);
      buf[byte] ^= 1 << (bit & 7);
    }
    // checksum 필드 자체의 32비트는 전부 따로 확인
    for (let bit = OFFSETS.checksum * 8; bit < (OFFSETS.checksum + 4) * 8; bit++) {
      buf[bit >> 3] ^= 1 << (bit & 7);
      assert.equal(verifyChecksum(buf), false, `${name} checksum bit ${bit}`);
      buf[bit >> 3] ^= 1 << (bit & 7);
    }
    assert.equal(verifyChecksum(buf), true);
  }
});
