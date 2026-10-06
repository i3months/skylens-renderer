// 블루노이즈 솎기 격자(양자화) 입력 시험(F-587): 수락 0 패스에서 남은 점을 쏟지 않는다, 체적형 격자에서 첫 패스가 과다 수락하지 않는다,
// 옵션 검증·결과 보관 상한(F-591 ③④).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBlueNoiseThinner, createThinner } from './blue_noise_thinner.mjs';

const STEP = 0.01; // 1 cm

/** 1 cm 간격 w×h 평면(z = 0). 색인 i = y·w + x. */
function plane(w, h) {
  const p = new Float32Array(3 * w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    p[3 * i] = x * STEP; p[3 * i + 1] = y * STEP;
  }
  return p;
}

/** 1 cm 간격 m³ 입방 격자. */
function cube(m) {
  const p = new Float32Array(3 * m * m * m);
  let i = 0;
  for (let z = 0; z < m; z++) for (let y = 0; y < m; y++) for (let x = 0; x < m; x++, i++) {
    p[3 * i] = x * STEP; p[3 * i + 1] = y * STEP; p[3 * i + 2] = z * STEP;
  }
  return p;
}

/** 고른 점 가운데 4-이웃(상하좌우) 중 하나라도 같이 고른 점의 비율. */
function fourNeighborRatio(sel, w, h) {
  const on = new Uint8Array(w * h);
  for (const s of sel) on[s] = 1;
  let c = 0;
  for (const s of sel) {
    const x = s % w, y = (s - x) / w;
    if ((x > 0 && on[s - 1]) || (x < w - 1 && on[s + 1]) || (y > 0 && on[s - w]) || (y < h - 1 && on[s + w])) c++;
  }
  return c / sel.length;
}

test('1 cm 평면 400×400: 수락 0 패스에서 남은 점을 쏟지 않고, select(40000) 의 4-이웃 비율 < 10%', () => {
  const w = 400, h = 400, n = w * h;
  const t = createBlueNoiseThinner(plane(w, h));
  const sel = t.select(40000);
  const { radii, passEnd } = t.stats();
  // 기록된 패스는 모두 수락이 있다(누적 수가 엄격 증가).
  for (let i = 1; i < passEnd.length; i++) assert.ok(passEnd[i] > passEnd[i - 1], `passEnd ${passEnd.join(' ')}`);
  // 40000 을 넘긴 패스는 남은 점 일괄 수락(반경 0)이 아니다.
  let p = 0;
  while (passEnd[p] < 40000) p++;
  assert.ok(radii[p] > 0, `radii ${radii.join(' ')} passEnd ${passEnd.join(' ')}`);
  assert.ok(passEnd[p] < n, `passEnd ${passEnd.join(' ')}`);
  const ratio = fourNeighborRatio(sel, w, h);
  assert.ok(ratio < 0.1, `4-이웃 비율 ${ratio}`);
  // 전부 요청하면 반경이 격자 간격 아래로 내려가 남은 점을 정상 패스로 다 받는다.
  t.select(n - 1);
  const s2 = t.stats();
  assert.equal(s2.passEnd[s2.passEnd.length - 1], n);
  assert.ok(s2.radii[s2.radii.length - 1] > 0);
});

test('1 cm 입방 격자 40³: 첫 패스 수락 ≤ 2·kHint·0.35', () => {
  const m = 40, n = m * m * m;
  const t = createBlueNoiseThinner(cube(m));
  const kHint = Math.round(n * 0.13);
  t.select(100);
  const { passEnd } = t.stats();
  assert.ok(passEnd[0] <= 2 * kHint * 0.35, `passEnd[0] ${passEnd[0]}, 상한 ${2 * kHint * 0.35}`);
  assert.ok(passEnd[0] >= 100);
});

test('격자 입력도 결정적: 요청 순서와 무관', () => {
  const p = plane(200, 150);
  const a = createThinner(p);
  const b = createThinner(p);
  const ka = [9000, 1200, 20000].map((k) => a.select(k));
  const kb = [20000, 9000, 1200].map((k) => b.select(k));
  assert.deepEqual(ka[0], kb[1]);
  assert.deepEqual(ka[1], kb[2]);
  assert.deepEqual(ka[2], kb[0]);
});

test('중복점 섞인 격자: 정확히 k 개, 중복 없음', () => {
  const g = plane(60, 60);
  const twice = new Float32Array(2 * g.length);
  twice.set(g); twice.set(g, g.length);
  const t = createThinner(twice);
  for (const k of [1000, 3600, 5000, 7199]) assert.equal(new Set(t.select(k)).size, k);
});

test('firstFraction·kHint 가 0·NaN·음수·범위 밖이면 RangeError', () => {
  const p = plane(10, 10);
  for (const firstFraction of [0, -0.1, NaN, 1.5, Infinity]) assert.throws(() => createBlueNoiseThinner(p, null, { firstFraction }), RangeError, `firstFraction ${firstFraction}`);
  for (const kHint of [0, -5, NaN, Infinity]) assert.throws(() => createBlueNoiseThinner(p, null, { kHint }), RangeError, `kHint ${kHint}`);
  assert.equal(createBlueNoiseThinner(p, null, { firstFraction: 1, kHint: 0.4 }).select(30).length, 30);
});

test('결과 보관은 최근 2개 k 만: 오래된 k 를 다시 물어도 같은 결과', () => {
  const p = plane(100, 100);
  const t = createThinner(p);
  const first = t.select(1500);
  for (const k of [2000, 2500, 3000]) t.select(k);
  assert.deepEqual(t.select(1500), first);
});
