import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleDrape } from './sample.mjs';
import { buildDrapeTile } from '../../../server/terrain/drape/index.mjs';

// 4×4 타일(tx=0, ty=0): 화소 한 변 16 m. 화소 (i, j) 중심 x = 16i+8, y = 64 − (16j+8).
function makeTile(fn, maskFn = () => 255, w = 4, h = 4) {
  const rgb = new Uint8Array(w * h * 3);
  const mask = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const o = j * w + i;
    const c = fn(i, j);
    rgb[o * 3] = c[0]; rgb[o * 3 + 1] = c[1]; rgb[o * 3 + 2] = c[2];
    mask[o] = maskFn(i, j);
  }
  return {
    tx: 0, ty: 0, mip: 0, width: w, height: h, rgb,
    coverage: { complete: true, fraction: 1, mask, bounds: { minX: 0, minY: 0, maxX: 64, maxY: 64 } },
  };
}
const cx = (i) => 16 * i + 8;
const cy = (j) => 64 - (16 * j + 8);
const col = (i, j) => [10 * i + 20 * j, 100 + i, 200 - 5 * j];

test('화소 중심에서 정확히 그 화소 색', () => {
  const t = makeTile(col);
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
    assert.deepEqual(sampleDrape(t, cx(i), cy(j)), col(i, j));
  }
});

test('두 화소 중간 값', () => {
  const t = makeTile(col);
  // (1,1) 과 (2,1) 사이: r = (30+40)/2 = 35, g = (101+102)/2 = 101.5 -> 102, b = 195
  assert.deepEqual(sampleDrape(t, 24 + 8, cy(1)), [35, 102, 195]);
  // (1,1) 과 (1,2) 사이: r = (30+50)/2 = 40, g = 101, b = (195+190)/2 = 192.5 -> 193
  assert.deepEqual(sampleDrape(t, cx(1), 64 - 32), [40, 101, 193]);
});

test('4 화소 중심의 평균', () => {
  const t = makeTile(col);
  // (1,1) (2,1) (1,2) (2,2): r = (30+40+50+60)/4 = 45, g = (101+102+101+102)/4 = 101.5 -> 102, b = (195+195+190+190)/4 = 192.5 -> 193
  assert.deepEqual(sampleDrape(t, 32, 32), [45, 102, 193]);
});

test('경계 밖은 null, 가장자리는 가장 가까운 화소로 고정', () => {
  const t = makeTile(col);
  assert.equal(sampleDrape(t, -0.001, 32), null);
  assert.equal(sampleDrape(t, 64.001, 32), null);
  assert.equal(sampleDrape(t, 32, -0.001), null);
  assert.equal(sampleDrape(t, 32, 64.001), null);
  assert.deepEqual(sampleDrape(t, 0, 64), col(0, 0));
  assert.deepEqual(sampleDrape(t, 64, 0), col(3, 3));
  assert.deepEqual(sampleDrape(t, 2, cy(1)), col(0, 1));
});

test('다른 타일 번호의 범위를 따른다', () => {
  const t = makeTile(col);
  t.tx = 2; t.ty = -1;
  assert.deepEqual(sampleDrape(t, 128 + cx(1), -64 + cy(2)), col(1, 2));
  assert.equal(sampleDrape(t, 32, 32), null);
});

test('mask 0 화소는 제외하고 가중을 다시 정규화', () => {
  const t = makeTile(col, (i, j) => (i === 2 && j === 1 ? 0 : 255));
  // (1,1) 과 (2,1) 중간: (2,1) 제외 -> (1,1) 색 그대로
  assert.deepEqual(sampleDrape(t, 32, cy(1)), col(1, 1));
  // 4 이웃 중심: 3 화소 평균 r = (30+50+60)/3 = 46.67 -> 47, g = (101+101+102)/3 = 101.33 -> 101, b = (195+190+190)/3 = 191.67 -> 192
  assert.deepEqual(sampleDrape(t, 32, 32), [47, 101, 192]);
  // 가중이 다를 때: x = 28 (fx=0.25) 에서 (1,1)=0.75, (2,1) 제외 -> (1,1) 그대로
  assert.deepEqual(sampleDrape(t, 28, cy(1)), col(1, 1));
});

test('mask 가 1..254 인 부분 화소도 색은 동등 가중', () => {
  const t = makeTile(col, () => 1);
  assert.deepEqual(sampleDrape(t, 32, 32), [45, 102, 193]);
});

test('4 이웃이 모두 mask 0 이면 null, 아니면 값', () => {
  const t = makeTile(col, (i) => (i >= 2 ? 0 : 255));
  assert.equal(sampleDrape(t, cx(2), cy(1)), null);
  assert.equal(sampleDrape(t, cx(3), cy(1)), null);
  // 경계(i=1,2 사이)는 (1, *) 만 살아 값이 있다
  assert.deepEqual(sampleDrape(t, 32, cy(1)), col(1, 1));
  const all0 = makeTile(col, () => 0);
  assert.equal(sampleDrape(all0, 32, 32), null);
  assert.equal(sampleDrape(all0, 0, 0), null);
});

test('연속 선형 그라디언트에서 오차 <= 0.5', () => {
  const W = 32, H = 16;
  // 정수 격자에서 선형인 영상(화소값이 정수라 보간 결과의 반올림 오차만 남는다).
  const t = makeTile((i, j) => [2 * i + 5 * j, 250 - 3 * i - 2 * j, 10 + i + 4 * j], undefined, W, H);
  const pw = 64 / W, ph = 64 / H;
  let worst = 0, n = 0;
  for (let a = 0; a < 200; a++) {
    // 화소 중심 범위 안(가장자리 고정 영역 제외)에서 표본
    const u = 0.5 + (W - 1) * ((a * 37) % 200) / 200 + 0.0;
    const v = 0.5 + (H - 1) * ((a * 91) % 200) / 200;
    const x = u * pw, y = 64 - v * ph;
    const got = sampleDrape(t, x, y);
    const ui = u - 0.5, vj = v - 0.5;
    const want = [2 * ui + 5 * vj, 250 - 3 * ui - 2 * vj, 10 + ui + 4 * vj];
    for (let k = 0; k < 3; k++) { worst = Math.max(worst, Math.abs(got[k] - want[k])); n++; }
  }
  assert.ok(n > 0);
  assert.ok(worst <= 0.5 + 1e-9, `worst=${worst}`);
});

test('buildDrapeTile 로 만든 타일과 함께 쓴다', () => {
  const w = 64, h = 64;
  const rgb = new Uint8Array(w * h * 3);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const o = (j * w + i) * 3;
    rgb[o] = i * 4; rgb[o + 1] = 100; rgb[o + 2] = 50;
  }
  // 영상 범위 x 0..64, y 0..32 (아래 절반만 덮음)
  const image = { width: w, height: 32, rgb: rgb.subarray(0, w * 32 * 3), bounds: { minX: 0, minY: 0, maxX: 64, maxY: 32 } };
  const tile = buildDrapeTile(image, 0, 0, 0);
  assert.equal(tile.width, 64);
  assert.equal(sampleDrape(tile, 10.5, 10.5)[0], 40);
  assert.equal(sampleDrape(tile, 10.5, 60), null);
});

test('불량 입력은 null 이 아니라 RangeError', () => {
  const t = makeTile(col);
  assert.throws(() => sampleDrape(t, NaN, 10), RangeError);
  assert.throws(() => sampleDrape(t, 10, NaN), RangeError);
  assert.throws(() => sampleDrape(t, Infinity, 10), RangeError);
  assert.throws(() => sampleDrape(t, undefined, 10), RangeError);
  assert.throws(() => sampleDrape(null, 1, 1), RangeError);
  assert.throws(() => sampleDrape({ ...t, rgb: new Uint8Array(5) }, 1, 1), RangeError);
});
