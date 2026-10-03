import { test } from 'node:test';
import assert from 'node:assert/strict';
import { psnr, emptyRatio } from './index.mjs';

test('psnr: 모두 1 차이', () => {
  const a = new Uint8Array([10, 20, 30, 40, 50]);
  const b = new Uint8Array([11, 21, 31, 41, 51]);
  const result = psnr(a, b);
  const expected = 10 * Math.log10(65025);
  assert.ok(Math.abs(result - expected) < 1e-4);
});

test('psnr: 0 vs 255', () => {
  const a = new Uint8Array([0, 0, 0]);
  const b = new Uint8Array([255, 255, 255]);
  const result = psnr(a, b);
  assert.equal(result, 0);
});

test('psnr: 같은 값', () => {
  const a = new Uint8Array([100, 150, 200]);
  const b = new Uint8Array([100, 150, 200]);
  const result = psnr(a, b);
  assert.equal(result, Infinity);
});

test('psnr: 길이 다름 거부', () => {
  const a = new Uint8Array([1, 2, 3]);
  const b = new Uint8Array([1, 2]);
  assert.throws(() => psnr(a, b), /psnr:/);
});

test('psnr: 빈 배열 거부', () => {
  const a = new Uint8Array([]);
  const b = new Uint8Array([]);
  assert.throws(() => psnr(a, b), /psnr:/);
});

test('psnr: 길이 100, 1개 픽셀 10 차이 (MSE=1)', () => {
  const a = new Uint8Array(100);
  const b = new Uint8Array(100);
  a[0] = 100;
  b[0] = 110;
  const result = psnr(a, b);
  // MSE = (100-110)² / 100 = 100/100 = 1
  const expected = 10 * Math.log10(65025);
  assert.ok(Math.abs(result - expected) < 1e-4);
});

test('psnr: 비 Uint8Array 거부', () => {
  const a = [10, 20, 30];
  const b = new Uint8Array([11, 21, 31]);
  assert.throws(() => psnr(a, b), /psnr:/);
});

test('emptyRatio: 부분적으로 빈 픽셀', () => {
  const result = {
    index: new Int32Array([0, 1, -1, 3, -1, 5, -1, 7])
  };
  const ratio = emptyRatio(result);
  assert.ok(Math.abs(ratio - 0.375) < 1e-9);
});

test('emptyRatio: 모두 빈 픽셀', () => {
  const result = {
    index: new Int32Array(16).fill(-1)
  };
  const ratio = emptyRatio(result);
  assert.equal(ratio, 1);
});

test('emptyRatio: 모두 채워진 픽셀', () => {
  const result = {
    index: new Int32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
  };
  const ratio = emptyRatio(result);
  assert.equal(ratio, 0);
});

test('emptyRatio: null 입력 거부', () => {
  assert.throws(() => emptyRatio(null), /psnr:/);
});

test('emptyRatio: index 없음 거부', () => {
  assert.throws(() => emptyRatio({}), /psnr:/);
});
