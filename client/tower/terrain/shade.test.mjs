// 지형 음영(T15.1-A3) 시험: 면 법선, 램버트 식, server 참조 lambert 와의 일치, 오류 처리.
import test from 'node:test';
import assert from 'node:assert/strict';
import { faceNormalEnu, shadeLambert } from './shade.mjs';
import { lambert } from '../../../server/raster_ref/shade/index.mjs';

const near = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

// 간단한 선형 합동 난수(재현 가능).
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

test('평평한 지형의 법선은 [0,0,1]', () => {
  const pos = new Float32Array([0, 0, 5, 10, 0, 5, 10, 10, 5, 0, 10, 5]);
  const idx = new Uint32Array([0, 1, 2, 0, 2, 3]);
  assert.deepEqual(faceNormalEnu(pos, idx, 0), [0, 0, 1]);
  assert.deepEqual(faceNormalEnu(pos, idx, 1), [0, 0, 1]);
});

test('45도 경사(동쪽으로 오르막)의 법선은 [-√½, 0, √½]', () => {
  // z = x 평면: 동으로 1 m 가면 1 m 상승.
  const pos = new Float32Array([0, 0, 0, 1, 0, 1, 1, 1, 1, 0, 1, 0]);
  const idx = new Uint32Array([0, 1, 2]);
  const n = faceNormalEnu(pos, idx, 0);
  const h = Math.SQRT1_2;
  near(n[0], -h); near(n[1], 0); near(n[2], h);
});

test('45도 경사(북쪽으로 오르막)의 법선은 [0, -√½, √½]', () => {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 1]);
  const idx = new Uint32Array([0, 1, 2]);
  const n = faceNormalEnu(pos, idx, 0);
  near(n[0], 0); near(n[1], -Math.SQRT1_2); near(n[2], Math.SQRT1_2);
});

test('삼각형 순서를 뒤집으면 법선이 반대(nz<0)', () => {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  assert.deepEqual(faceNormalEnu(pos, new Uint32Array([0, 1, 2]), 0), [0, 0, 1]);
  assert.deepEqual(faceNormalEnu(pos, new Uint32Array([0, 2, 1]), 0), [0, 0, -1]);
});

test('면적 0 삼각형은 [0,0,1]', () => {
  const pos = new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 2, 2, 2]);
  assert.deepEqual(faceNormalEnu(pos, new Uint32Array([0, 1, 2]), 0), [0, 0, 1]);
  // 한 직선 위의 세 점
  assert.deepEqual(faceNormalEnu(pos, new Uint32Array([0, 3, 4]), 0), [0, 0, 1]);
});

test('tri 번호로 인덱스 버퍼의 해당 삼각형을 고른다', () => {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const idx = new Uint32Array([0, 1, 2, 0, 3, 1]);
  assert.deepEqual(faceNormalEnu(pos, idx, 0), [0, 0, 1]);
  assert.deepEqual(faceNormalEnu(pos, idx, 1), [0, 1, 0]);
});

test('평평한 면: 광원이 정확히 위면 base 그대로', () => {
  assert.deepEqual(shadeLambert([0, 0, 1], [0, 0, 5], [150, 160, 140], 0.3), [150, 160, 140]);
});

test('광원 반대쪽이면 ambient 만: 150·0.3=45, 160·0.3=48, 140·0.3=42', () => {
  assert.deepEqual(shadeLambert([0, 0, 1], [0, 0, -1], [150, 160, 140], 0.3), [45, 48, 42]);
  assert.deepEqual(shadeLambert([0, 0, 1], [1, 0, 0], [150, 160, 140], 0.3), [45, 48, 42]); // 수직(n·l=0)
});

test('45도 경사 해석값: n·l = √½ 일 때 I = 0.3+0.7·√½ = 0.79497', () => {
  const n = [-Math.SQRT1_2, 0, Math.SQRT1_2];
  // 광원이 천정: n·l = √½. 100·0.794975 = 79.4975 → 79, 200·… = 158.995 → 159.
  assert.deepEqual(shadeLambert(n, [0, 0, 1], [100, 200, 0], 0.3), [79, 159, 0]);
  // 광원이 법선 방향: I = 1.
  assert.deepEqual(shadeLambert(n, [-3, 0, 3], [100, 200, 255], 0.3), [100, 200, 255]);
});

test('lightDir 길이에 무관(정규화)', () => {
  const a = shadeLambert([0, 0, 1], [0.3, 0.2, 0.9], [150, 160, 140], 0.3);
  const b = shadeLambert([0, 0, 1], [30, 20, 90], [150, 160, 140], 0.3);
  assert.deepEqual(a, b);
});

test('결과는 0..255 정수로 클램프', () => {
  assert.deepEqual(shadeLambert([0, 0, 1], [0, 0, 1], [300, -10, 255], 0.3), [255, 0, 255]);
  for (const v of shadeLambert([0, 0, 1], [0, 0, 1], [1.4, 254.6, 0.5], 0)) assert.ok(Number.isInteger(v));
});

test('ambient 경계 0 과 1', () => {
  assert.deepEqual(shadeLambert([0, 0, 1], [0, 0, -1], [150, 160, 140], 0), [0, 0, 0]);
  assert.deepEqual(shadeLambert([0, 0, 1], [0, 0, -1], [150, 160, 140], 1), [150, 160, 140]);
});

test('잘못된 입력은 던진다', () => {
  const ok = [0, 0, 1], b = [1, 2, 3];
  assert.throws(() => shadeLambert(ok, [0, 0, 0], b, 0.3), RangeError);
  assert.throws(() => shadeLambert(ok, [NaN, 0, 1], b, 0.3), TypeError);
  assert.throws(() => shadeLambert(ok, [Infinity, 0, 1], b, 0.3), TypeError);
  assert.throws(() => shadeLambert(ok, [0, 1], b, 0.3), TypeError);
  assert.throws(() => shadeLambert([0, 0, 0], ok, b, 0.3), RangeError);
  assert.throws(() => shadeLambert(ok, ok, b, -0.01), RangeError);
  assert.throws(() => shadeLambert(ok, ok, b, 1.01), RangeError);
  assert.throws(() => shadeLambert(ok, ok, b, NaN), RangeError);
  assert.throws(() => shadeLambert(ok, ok, [1, 2], 0.3), TypeError);
  assert.throws(() => shadeLambert(ok, ok, [1, 2, 3, 4], 0.3), TypeError);
  assert.throws(() => shadeLambert(ok, ok, [1, NaN, 3], 0.3), TypeError);
});

test('server 참조 lambert 와 랜덤 법선·광원 500개에서 같은 결과', () => {
  const r = rng(20260101);
  const rv = () => [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1];
  let lit = 0, dark = 0;
  for (let k = 0; k < 500; k += 1) {
    const n = rv(), l = rv();
    const scale = 0.5 + r() * 20;
    const base = [Math.floor(r() * 256), Math.floor(r() * 256), Math.floor(r() * 256)];
    const ambient = k % 5 === 0 ? [0, 1][(k / 5) % 2] : r();
    const got = shadeLambert(n, l.map((x) => x * scale), base, ambient);
    const want = lambert(n, l, base, { ambient });
    assert.deepEqual(got, want, `k=${k}`);
    const d = (n[0] * l[0] + n[1] * l[1] + n[2] * l[2]);
    if (d > 0) lit += 1; else dark += 1;
  }
  assert.ok(lit > 100 && dark > 100, `양쪽 분포 확인 lit=${lit} dark=${dark}`);
});
