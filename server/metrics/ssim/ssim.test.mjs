// T06.8 SSIM 시험. 단순 이중 루프 기준 구현과 대조하고, 상수 영상은 해석해로 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ssim } from './index.mjs';

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

function noisy(w, h, ch, seed, base = 128, amp = 60) {
  const r = rng(seed);
  const u = new Uint8Array(w * h * ch);
  for (let i = 0; i < u.length; i++) u[i] = Math.max(0, Math.min(255, Math.round(base + (r() - 0.5) * 2 * amp)));
  return u;
}

// 느린 기준 구현: 창마다 2차원 가중합을 직접 계산(분리 필터를 쓰지 않음). 매개변수를 바꿔 변이도 만든다.
function naive(a, b, w, h, ch, { sigma = 1.5, k1 = 0.01, k2 = 0.03 } = {}) {
  const N = 11, c1 = (k1 * 255) ** 2, c2 = (k2 * 255) ** 2;
  const g = [];
  let gs = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const v = Math.exp(-(((x - 5) ** 2) + ((y - 5) ** 2)) / (2 * sigma * sigma));
    g.push(v); gs += v;
  }
  let tot = 0;
  for (let c = 0; c < ch; c++) {
    let sum = 0, cnt = 0;
    for (let y0 = 0; y0 + N <= h; y0++) for (let x0 = 0; x0 + N <= w; x0++) {
      let ma = 0, mb = 0, eaa = 0, ebb = 0, eab = 0;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const wt = g[y * N + x] / gs;
        const i = ((y0 + y) * w + x0 + x) * ch + c;
        ma += wt * a[i]; mb += wt * b[i];
        eaa += wt * a[i] * a[i]; ebb += wt * b[i] * b[i]; eab += wt * a[i] * b[i];
      }
      const sa = eaa - ma * ma, sb = ebb - mb * mb, sab = eab - ma * mb;
      sum += ((2 * ma * mb + c1) * (2 * sab + c2)) / ((ma * ma + mb * mb + c1) * (sa + sb + c2));
      cnt++;
    }
    tot += sum / cnt;
  }
  return tot / ch;
}

test('같은 영상은 1', () => {
  for (const ch of [1, 3]) {
    const a = noisy(24, 20, ch, 1);
    assert.ok(Math.abs(ssim(a, a, 24, 20, ch) - 1) <= 1e-12);
  }
});

test('상수 영상 a=100, b=150 은 해석해와 일치', () => {
  // (2*100*150 + 6.5025) / (100^2 + 150^2 + 6.5025) = 30006.5025 / 32506.5025 (분산 항은 C2/C2 = 1)
  const want = 30006.5025 / 32506.5025;
  for (const ch of [1, 3]) {
    const w = 13, h = 11;
    const a = new Uint8Array(w * h * ch).fill(100);
    const b = new Uint8Array(w * h * ch).fill(150);
    assert.ok(Math.abs(ssim(a, b, w, h, ch) - want) <= 1e-12, `ch=${ch}`);
  }
});

test('잡음 쌍이 단순 이중 루프 구현과 1e-9 이내로 일치', () => {
  for (const [w, h, ch, s] of [[11, 11, 1, 3], [30, 17, 1, 4], [25, 21, 3, 5]]) {
    const a = noisy(w, h, ch, s), b = noisy(w, h, ch, s + 100, 120, 70);
    const got = ssim(a, b, w, h, ch), want = naive(a, b, w, h, ch);
    assert.ok(got < 0.99 && Math.abs(got - want) <= 1e-9, `${w}x${h}x${ch}: ${got} vs ${want}`);
  }
});

test('대칭이며 1 이하', () => {
  for (let s = 1; s <= 5; s++) {
    const a = noisy(26, 22, 3, s), b = noisy(26, 22, 3, s + 50);
    const ab = ssim(a, b, 26, 22, 3), ba = ssim(b, a, 26, 22, 3);
    assert.ok(Math.abs(ab - ba) <= 1e-12);
    assert.ok(ab <= 1);
  }
});

test('변이: σ 또는 K1 을 바꾼 구현은 실제 값과 달라진다', () => {
  const a = noisy(30, 30, 1, 7, 12, 8), b = noisy(30, 30, 1, 8, 14, 8);
  const real = ssim(a, b, 30, 30, 1);
  assert.ok(Math.abs(real - naive(a, b, 30, 30, 1)) <= 1e-9);
  assert.ok(Math.abs(real - naive(a, b, 30, 30, 1, { sigma: 1.6 })) > 1e-6, 'σ 변이가 통과함');
  assert.ok(Math.abs(real - naive(a, b, 30, 30, 1, { k1: 0.02 })) > 1e-6, 'K1 변이가 통과함');
  // 상수 영상 해석해는 K1 에 민감하다
  const c = new Uint8Array(121).fill(100), d = new Uint8Array(121).fill(150);
  assert.ok(Math.abs(ssim(c, d, 11, 11, 1) - naive(c, d, 11, 11, 1, { k1: 0.02 })) > 1e-6);
});

test('입력 검사', () => {
  const a = new Uint8Array(11 * 11);
  assert.throws(() => ssim(new Uint8Array(100), new Uint8Array(100), 10, 10, 1), /ssim:.*창/);
  assert.throws(() => ssim(a, new Uint8Array(120), 11, 11, 1), /ssim:/);
  assert.throws(() => ssim(a, a, 11, 11, 2), /ssim:/);
  const f = new Float64Array(121); f[5] = NaN;
  assert.throws(() => ssim(a, f, 11, 11, 1), /ssim:/);
  assert.throws(() => ssim(a, a, 11.5, 11, 1), /ssim:/);
});

test('960x540x3 소요 시간 보고', () => {
  const a = noisy(960, 540, 3, 11), b = noisy(960, 540, 3, 12, 128, 40);
  const t = performance.now();
  const v = ssim(a, b, 960, 540, 3);
  const ms = performance.now() - t;
  console.log(`ssim 960x540x3: ${ms.toFixed(0)} ms, 값 ${v.toFixed(6)}`);
  assert.ok(v > 0 && v < 1);
});
