// 블루노이즈 솎기 근접 중복점 시험(F-593): 수락점과 거의 같은 위치(정확히 같지는 않다)의 점이 남을 때
// 반경을 shrink 로 조금씩 줄이며 O(n) 수락 0 패스를 수십 번 도는 대신, d*(남은 점의 가장 가까운 수락점 거리 최댓값) 아래로 한 번에 내린다.
// shrink 상한·결정성·최소 거리 불변식·F-587 두 기준(수락 0 패스에서 남은 점을 쏟지 않음, 기록된 패스는 모두 수락이 있음)도 본다.
// 입력은 모두 고정 격자 또는 고정 시드다.
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { createBlueNoiseThinner, createThinner, MAX_SHRINK } from './blue_noise_thinner.mjs';

const STEP = 0.01; // 1 cm
const DUP_DX = 3e-6; // 3 µm

/** 1 cm 간격 w×h 평면(z = 0). dup 이면 같은 평면을 x 로 3 µm 옮긴 사본을 뒤에 붙인다(색인 n..2n−1). */
function plane(w, h, dup = false) {
  const n = w * h;
  const p = new Float32Array(3 * n * (dup ? 2 : 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    p[3 * i] = x * STEP; p[3 * i + 1] = y * STEP;
  }
  if (dup) for (let i = 0; i < n; i++) { p[3 * (n + i)] = p[3 * i] + DUP_DX; p[3 * (n + i) + 1] = p[3 * i + 1]; }
  return p;
}

/** 고정 시드 무작위 평면 점(z = 0) + 각 점을 고정 시드로 µm 규모만큼 옮긴 사본. */
function jitterDup(n, seed = 11) {
  let s = seed;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const p = new Float32Array(6 * n);
  for (let i = 0; i < n; i++) { p[3 * i] = 20 * rnd(); p[3 * i + 1] = 20 * rnd(); }
  for (let i = 0; i < n; i++) {
    p[3 * (n + i)] = p[3 * i] + 1e-5 * (0.5 + rnd());
    p[3 * (n + i) + 1] = p[3 * i + 1] + 1e-5 * (rnd() - 0.5);
  }
  return p;
}

/** 가장 가까운 두 점의 거리(x 정렬 뒤 쓸기). */
function minDistFast(p, sel) {
  const ids = Array.from(sel).sort((a, b) => p[3 * a] - p[3 * b]);
  let best = Infinity;
  for (let a = 0; a < ids.length; a++) {
    for (let b = a + 1; b < ids.length; b++) {
      const dx = p[3 * ids[b]] - p[3 * ids[a]];
      if (dx >= best) break;
      const d = Math.hypot(dx, p[3 * ids[b] + 1] - p[3 * ids[a] + 1], p[3 * ids[b] + 2] - p[3 * ids[a] + 2]);
      if (d < best) best = d;
    }
  }
  return best;
}

/** 새 솎기 객체로 select(k) 하나에 걸린 시간(ms). 잡음을 줄이려고 reps 번 재서 최솟값을 쓴다. */
function timeSelect(p, k, reps = 2) {
  let best = Infinity;
  let t = null;
  for (let r = 0; r < reps; r++) {
    t = createBlueNoiseThinner(p);
    const t0 = performance.now();
    t.select(k);
    best = Math.min(best, performance.now() - t0);
  }
  return { ms: best, thinner: t };
}

test('근접 중복 평면(400×400 + x+3 µm 사본): 중복 때문에 생기는 수락 0 패스 ≤ 1, 시간은 사본 없는 평면의 2배 이내', () => {
  const dup = plane(400, 400, true);
  // 비교 기준: 사본 없는 같은 점 수(32만)의 1 cm 평면에서 같은 k. 패스가 O(n) 이므로 점 수를 맞춘다.
  const flat = plane(400, 800);
  const k = 200000;
  // 사본 없는 400×400 평면을 n−1 까지 고를 때의 수락 0 패스 수(격자라 정상으로 생기는 몫).
  const base = createBlueNoiseThinner(plane(400, 400));
  base.select(400 * 400 - 1);
  const baseZero = base.stats().zeroPasses;
  assert.equal(typeof baseZero, 'number', 'stats().zeroPasses 가 있어야 한다');

  const a = timeSelect(flat, k);
  const b = timeSelect(dup, k);
  const st = b.thinner.stats();
  // 허용: 반경이 격자 거리(1, √2, 2 cm …) 사이를 지나며 생기는 몫(사본 없는 평면과 같다) + 사본 거리 3 µm 아래로 내리기 전 한 번.
  // 수정 전에는 사본 때문에 0.9 배씩 3 µm 까지 내려가며 수락 0 패스가 82번(사본 없는 평면 6번) 생겼다.
  assert.ok(st.zeroPasses <= baseZero + 1, `수락 0 패스 ${st.zeroPasses}, 사본 없는 평면 ${baseZero}`);
  // 수락 0 패스는 연달아 생기지 않는다: 기록된 패스(수락 있음) 수 이하.
  assert.ok(st.zeroPasses <= st.passes, `수락 0 ${st.zeroPasses} > 기록 패스 ${st.passes}`);
  // 벽시계는 비율로만 본다(이 컨테이너 실측: 수정 전 약 4.7배, 수정 후 약 0.7~0.85배).
  assert.ok(b.ms <= 2 * a.ms, `사본 평면 ${b.ms.toFixed(0)} ms > 2 × 사본 없는 평면 ${a.ms.toFixed(0)} ms`);

  // F-587: 기록된 패스는 모두 수락이 있고, k 를 넘긴 패스는 남은 점 일괄 수락(반경 0)이 아니다.
  for (let i = 1; i < st.passEnd.length; i++) assert.ok(st.passEnd[i] > st.passEnd[i - 1], `passEnd ${st.passEnd.join(' ')}`);
  let p = 0;
  while (st.passEnd[p] < k) p++;
  assert.ok(st.radii[p] > 0, `radii ${st.radii.join(' ')}`);
  // d* 로 내린 반경은 사본 간격(3 µm, float32 반올림 포함) 바로 아래다.
  assert.ok(st.radii[p] > 0.5 * DUP_DX && st.radii[p] < 2 * DUP_DX, `반경 ${st.radii[p]}`);
  assert.equal(new Set(b.thinner.select(k)).size, k);
});

test('무작위 근접 중복(고정 시드, 사본은 원본에서 µm 규모로 제각각): 수락 0 패스는 연달아 생기지 않고 최소 거리 불변식 유지', () => {
  const n = 20000;
  const p = jitterDup(n);
  const t = createThinner(p);
  const k = Math.floor(1.5 * n);
  const sel = t.select(k);
  assert.equal(sel.length, k);
  assert.equal(new Set(sel).size, k);
  const st = t.stats();
  assert.ok(st.zeroPasses <= st.passes, `수락 0 ${st.zeroPasses} 기록 ${st.passes}`);
  // 수정 전에는 반경이 0.9 배씩 µm 규모까지 내려가며 수락 0 패스가 42번 생겼다(수정 후 5번: 사본 거리가 5~15 µm 로 제각각이라
  // d* 로 내린 뒤 다시 shrink 하는 사이에 가끔 생긴다).
  assert.ok(st.zeroPasses <= 8, `수락 0 패스 ${st.zeroPasses}`);
  // 최소 거리 불변식: 완결 패스 j 까지의 출력은 최소 거리 ≥ radii[j] − eps.
  const eps = 1e-9 * 20;
  for (let j = 0; j < st.passEnd.length; j++) {
    if (st.radii[j] === 0) break;
    const d = minDistFast(p, t.select(st.passEnd[j]));
    assert.ok(d >= st.radii[j] - eps, `패스 ${j} (k=${st.passEnd[j]}) 최소 거리 ${d} < 반경 ${st.radii[j]}`);
  }
  // 결정성: 다른 순서로 물어도 같다.
  const u = createThinner(p);
  u.select(5000);
  assert.deepEqual(u.select(k), sel);
});

test('정확히 같은 위치의 중복점만 남으면 수락 0 패스 한 번 뒤 일괄 수락한다', () => {
  const g = plane(60, 60);
  const twice = new Float32Array(2 * g.length);
  twice.set(g); twice.set(g, g.length);
  const t = createThinner(twice);
  assert.equal(new Set(t.select(7199)).size, 7199);
  const st = t.stats();
  assert.equal(st.radii[st.radii.length - 1], 0);
  assert.equal(st.passEnd[st.passEnd.length - 1], 7200);
  assert.ok(st.zeroPasses <= st.passes);
});

test(`shrink 는 (0, ${MAX_SHRINK}]: 1 에 가까운 값은 RangeError, 상한값은 끝난다`, () => {
  const p = plane(100, 100, true);
  for (const shrink of [0.999999, 0.995, 1, 0, -0.5, NaN]) {
    assert.throws(() => createBlueNoiseThinner(p, null, { shrink }), RangeError, `shrink ${shrink}`);
  }
  const t = createBlueNoiseThinner(p, null, { shrink: MAX_SHRINK });
  const n = p.length / 3;
  assert.equal(new Set(t.select(n - 1)).size, n - 1);
  const st = t.stats();
  // 벽시계 대신 패스 수 상한: d* 로 한 번에 내리므로 shrink 0.99 라도 패스가 수십 번을 넘지 않는다(실측 18, 수락 0 패스 8).
  assert.ok(st.passes <= 40, `shrink ${MAX_SHRINK} 기록 패스 ${st.passes} > 40`);
  assert.ok(st.zeroPasses <= st.passes, `수락 0 ${st.zeroPasses} 기록 ${st.passes}`);
});

/** gc 뒤 arrayBuffers 를 잰다: 해제가 비동기로 끝나므로 더 줄지 않을 때까지(최대 5회) gc + 20 ms 대기를 되풀이한다. */
async function settledArrayBuffers(gc) {
  let prev = Infinity;
  let cur = process.memoryUsage().arrayBuffers;
  for (let i = 0; i < 5; i++) {
    gc();
    await sleep(20);
    cur = process.memoryUsage().arrayBuffers;
    if (cur >= prev) break;
    prev = cur;
  }
  return cur;
}

test('select 뒤에는 칸 해시 표를 상주시키지 않는다(점당 상주 ≈ 37 B + 보관 결과)', async () => {
  // --expose-gc 없이 돌려도 쓸 수 있게 플래그를 켜고 새 문맥에서 gc 를 꺼낸다.
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  const p = plane(400, 400, true);
  const n = p.length / 3;
  const m0 = await settledArrayBuffers(gc);
  const t = createThinner(p);
  t.select(Math.floor(0.5 * n));
  const m1 = await settledArrayBuffers(gc);
  const perPoint = (m1 - m0) / n;
  assert.ok(perPoint < 37 + 2 * 4 * 0.5 + 4, `점당 ${perPoint.toFixed(1)} B`);
  assert.ok(t.select(10).length === 10);
});
