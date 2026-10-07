// 후보 9(푸아송 원반 근사 솎기) 시험: 결정성·부분집합·색인 범위·모턴 순·k ≥ n 처리·최소 거리.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBlueNoiseThinner, createThinner } from './blue_noise_thinner.mjs';
import { createSpatialThinner } from './index.mjs';

function scene(n, seed = 7) {
  const p = new Float32Array(3 * n);
  let s = seed;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < n; i++) {
    if (i % 4 === 0) { p[3 * i] = 10 * rnd(); p[3 * i + 1] = 5 * rnd(); p[3 * i + 2] = 10; } // 벽
    else { p[3 * i] = 50 * rnd(); p[3 * i + 1] = 0; p[3 * i + 2] = 50 * rnd(); } // 바닥
  }
  return p;
}

function minDist(p, sel) {
  let best = Infinity;
  for (let a = 0; a < sel.length; a++) for (let b = a + 1; b < sel.length; b++) {
    const i = sel[a], j = sel[b];
    const d = Math.hypot(p[3 * i] - p[3 * j], p[3 * i + 1] - p[3 * j + 1], p[3 * i + 2] - p[3 * j + 2]);
    if (d < best) best = d;
  }
  return best;
}

test('결정성: 같은 입력·같은 k 는 요청 순서와 무관하게 같은 결과', () => {
  const p = scene(20000);
  const a = createThinner(p);
  const b = createThinner(p);
  const ka = [3000, 500, 7000].map((k) => a.select(k));
  const kb = [7000, 3000, 500].map((k) => b.select(k));
  assert.deepEqual(ka[0], kb[1]);
  assert.deepEqual(ka[1], kb[2]);
  assert.deepEqual(ka[2], kb[0]);
  assert.deepEqual(a.select(3000), ka[0]);
});

test('부분집합·색인 범위·중복 없음·정확히 k 개·모턴 순', () => {
  const n = 20000;
  const p = scene(n);
  const t = createBlueNoiseThinner(p);
  const rank = new Uint32Array(n);
  createSpatialThinner(p).select(n).forEach((s, r) => { rank[s] = r; });
  for (const k of [1, 2, 37, 1000, 2600, 9999, 19999]) {
    const sel = t.select(k);
    assert.ok(sel instanceof Uint32Array);
    assert.equal(new Set(sel).size, k, `k=${k} 중복 색인`); // 길이는 new Uint32Array(k) 라 항상 k 이므로 서로 다른 색인 수로 본다
    for (const s of sel) assert.ok(s < n, `k=${k} 범위 밖 색인 ${s}`);
    const seen = new Uint8Array(n);
    for (let j = 0; j < k; j++) {
      assert.ok(sel[j] < n);
      assert.equal(seen[sel[j]], 0);
      seen[sel[j]] = 1;
      if (j > 0) assert.ok(rank[sel[j - 1]] < rank[sel[j]]);
    }
  }
});

test('k ≥ n 이면 전부(모턴 순), k = 0 이면 빈 배열, 잘못된 k 는 RangeError', () => {
  const p = scene(500);
  const t = createThinner(p);
  const all = createSpatialThinner(p).select(500);
  assert.deepEqual(t.select(500), all);
  assert.deepEqual(t.select(10000), all);
  assert.equal(t.select(0).length, 0);
  assert.throws(() => t.select(-1), RangeError);
  assert.throws(() => t.select(1.5), RangeError);
  assert.throws(() => createThinner(new Float32Array(4)), TypeError);
});

test('같은 점·한 점·퇴화 입력도 k 개를 돌려준다', () => {
  const same = new Float32Array(300).fill(1.25);
  const t = createThinner(same);
  assert.equal(new Set(t.select(40)).size, 40);
  assert.ok(t.select(40).every((s) => s < 100));
  assert.deepEqual([...createThinner(new Float32Array([1, 2, 3])).select(1)], [0]);
  const dup = scene(2000);
  const twice = new Float32Array(2 * dup.length);
  twice.set(dup); twice.set(dup, dup.length);
  assert.equal(new Set(createThinner(twice).select(3500)).size, 3500);
});

// 칸 경계에 걸친 점이 많은 장면: 패스 반경 r_i 의 칸 경계 평면(x = m·r_i, 칸 좌표는 최소점 기준) 양쪽에 점을 몰아 둔다.
// 재시도 없는 표면 장면(첫 패스 수락 ≤ 2·kHint·0.35)에서는 첫 반경이 span·n 만으로 정해지므로 같은 n·span 의 탐침 장면에서 반경을 미리 읽을 수 있다
// (모서리 두 점으로 span 고정). 체적 장면은 첫 패스를 다시 돌아 반경이 점 배치에 좌우되므로 이 전제가 맞지 않는다.
// 이 전제는 아래 '첫 반경은 ... 표면 장면' 시험이 단언하고, 체적 장면에서 깨진다는 것도 음성 시험으로 단언한다.
function straddleScene(n) {
  const base = scene(n);
  base.set([0, 0, 0, 50, 0, 50], 0);
  const radii = (() => { const t = createThinner(base); t.select(3000); return t.stats().radii.slice(0, 4); })();
  const p = new Float32Array(3 * n);
  p.set([0, 0, 0, 50, 0, 50], 0);
  let s = 99;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let i = 2; i < n; i++) {
    const r = radii[i % radii.length];
    const m = 1 + Math.floor(rnd() * Math.floor(49 / r));
    p[3 * i] = m * r + (rnd() - 0.5) * 0.4 * r; // 경계 양쪽 0.2r 안
    p[3 * i + 2] = 50 * rnd();
  }
  return p;
}

test('첫 반경은 span·n 만으로 정해진다(재시도 없는 표면 장면 한정): 점 배치가 달라도 같다', () => {
  const n = 20000;
  const a = scene(n, 7);
  const b = scene(n, 123);
  const c = straddleScene(n);
  // 두 겹 표면(y = 0, 25): 첫 패스 수락이 약 1.24·target 이라 재시도 문턱이 1.24배 아래로 내려가면 재시도가 생겨 잡힌다.
  // 문턱이 2배에서 위로 벗어나는 쪽은 아래 재시도 문턱 시험이 잡는다: 세 겹(1.79배)·네 겹(2.32배)은 문턱이 (1.79, 2.32)배 밖으로 나가는 변이를,
  // 한 쌍 장면(1.94배·2.05배)은 문턱이 (1.94, 2.05)배 밖으로 나가는 변이를 잡는다(측정값, 같은 시험의 주석 참조).
  const d = new Float32Array(3 * n);
  { let s = 3; const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < n; i++) { d[3 * i] = 50 * rnd(); d[3 * i + 1] = (i % 2) * 25; d[3 * i + 2] = 50 * rnd(); } }
  for (const q of [a, b, c]) q.set([0, 0, 0, 50, 0, 50], 0); // 모서리 두 점으로 span 고정
  d.set([0, 0, 0, 50, 25, 50], 0);
  const target = n * 0.13 * 0.35;
  const rSurface = 50 / Math.sqrt(target); // 표면 가정 첫 반경(span = 50)
  const first = (p) => {
    const t = createThinner(p); t.select(3000);
    const st = t.stats();
    // 첫 패스 수락이 재시도 문턱 2·kHint·firstFraction (kHint = n·0.13, firstFraction = 0.35) 이하인지만 본다.
    // 재시도가 없었다는 것(첫 반경 = 표면 가정 반경)은 아래 radii[0] 동치 단언이 확인한다.
    assert.ok(st.passEnd[0] <= 2 * n * 0.13 * 0.35, `첫 패스 수락 ${st.passEnd[0]} 가 문턱 2·target 을 넘었다`);
    return st.radii[0];
  };
  const r = first(a);
  assert.ok(r > 0);
  assert.equal(first(b), r);
  assert.equal(first(c), r);
  assert.equal(r, rSurface);
  assert.equal(first(d), rSurface);
  const td = createThinner(d); td.select(3000);
  assert.ok(td.stats().passEnd[0] > target, '두 겹 장면의 첫 패스 수락이 target 을 넘어야 문턱 시험이 된다');
});

// 층 수 L 인 표면 장면(y = 0..50 을 L 등분, 모서리 두 점으로 span = 50 고정). 첫 패스 수락이 L 에 거의 비례해 재시도 문턱 근방을 훑는다.
function layers(n, L) {
  const d = new Float32Array(3 * n);
  let s = 3;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < n; i++) { d[3 * i] = 50 * rnd(); d[3 * i + 1] = (i % L) * (50 / (L - 1)); d[3 * i + 2] = 50 * rnd(); }
  d.set([0, 0, 0, 50, 50, 50], 0);
  return d;
}

test('재시도 문턱 2·target: 세 겹(수락 1.79·target)은 재시도 없음, 네 겹(재시도 전 수락 2.32·target)은 재시도', () => {
  const n = 20000;
  const target = n * 0.13 * 0.35; // 910
  const rSurface = 50 / Math.sqrt(target);
  const t3 = createThinner(layers(n, 3)); t3.select(3000);
  const s3 = t3.stats();
  assert.equal(s3.radii[0], rSurface, '세 겹은 첫 패스 수락이 2·target 안이라 재시도 없이 표면 가정 반경');
  // 1.7 은 도출한 경계가 아니라 '이 장면이 문턱 근방(2배 바로 아래)에 있다' 를 확인하는 느슨한 하한이다. 시드 5개(1.778~1.807)·8개(1.782~1.805) 모두 1.7 위라 시드에 흔들리지 않고,
  // 문턱 변이는 위 radii 동치 단언(재시도 여부)이 잡는다.
  assert.ok(s3.passEnd[0] > 1.7 * target && s3.passEnd[0] <= 2 * target, `세 겹 첫 패스 수락 ${s3.passEnd[0]}`);
  const t4 = createThinner(layers(n, 4)); t4.select(3000);
  const s4 = t4.stats();
  // 표면 반경에서의 첫 수락이 2·target 을 넘어 재시도 → 반경이 표면 가정보다 커진다(문턱을 3·target 으로 올리면 재시도가 사라져 실패).
  assert.ok(s4.radii[0] > rSurface * 1.05, `네 겹 첫 반경 ${s4.radii[0]} 가 표면 가정 ${rSurface} 보다 커야 한다(재시도)`);
  assert.ok(s4.passEnd[0] >= target && s4.passEnd[0] <= 2 * target, `네 겹 재시도 뒤 첫 패스 수락 ${s4.passEnd[0]}`);
});

// 세 겹 장면(y = 0, 50/3, 100/3 세 층)에 네 번째 층(y = 50)을 점의 q % 만 얹은 장면. 재시도 없이 돈 첫 패스(표면 가정 반경) 수락을 target 배수로 본 실측:
// q = 1 → 1.936, q = 2 → 2.046 (문턱을 끈 사본으로 잰 값: 세 겹 1.79, 네 겹 2.32 사이를 메운다).
// 그래서 재시도 문턱을 1.9·target 으로 내리면 q = 1 이 재시도되어 실패하고, 2.1·target 으로 올리면 q = 2 가 재시도되지 않아 실패한다.
// 이 시험과 위 시험을 합치면 문턱이 (1.936, 2.046)·target 안에 있는 변이만 살아남는다(실제 문턱 2 는 그 안이라 원본은 통과한다).
function partialLayers(n, q) {
  const d = new Float32Array(3 * n);
  let s = 3;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < n; i++) {
    const L = (i % 100) < q ? 3 : i % 3;
    d[3 * i] = 50 * rnd(); d[3 * i + 1] = L * (50 / 3); d[3 * i + 2] = 50 * rnd();
  }
  d.set([0, 0, 0, 50, 50, 50], 0);
  return d;
}

test('재시도 문턱 2·target 양쪽 근방: 수락 1.94·target 은 재시도 없음, 2.05·target 은 재시도', () => {
  const n = 20000;
  const target = n * 0.13 * 0.35;
  const rSurface = 50 / Math.sqrt(target);
  const tBelow = createThinner(partialLayers(n, 1)); tBelow.select(3000);
  const below = tBelow.stats();
  assert.equal(below.radii[0], rSurface, '수락 1.94·target 은 문턱 2·target 아래라 재시도 없이 표면 가정 반경');
  assert.ok(below.passEnd[0] > 1.9 * target && below.passEnd[0] <= 2 * target, `첫 패스 수락 ${below.passEnd[0]} (${below.passEnd[0] / target}·target)`);
  const tAbove = createThinner(partialLayers(n, 2)); tAbove.select(3000);
  const above = tAbove.stats();
  assert.ok(above.radii[0] > rSurface * 1.05, `수락 2.05·target 은 문턱을 넘어 재시도되어야 한다: 첫 반경 ${above.radii[0]} 표면 가정 ${rSurface}`);
  assert.ok(above.passEnd[0] >= target && above.passEnd[0] <= 2 * target, `재시도 뒤 첫 패스 수락 ${above.passEnd[0]}`);
});

test('체적 장면은 첫 패스를 다시 돌아 첫 반경이 표면 가정 반경보다 커진다(위 전제가 체적에는 맞지 않는다)', () => {
  const n = 20000;
  const mk = (seed) => {
    const p = new Float32Array(3 * n);
    let s = seed;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 3 * n; i++) p[i] = 50 * rnd();
    p.set([0, 0, 0, 50, 50, 50], 0);
    return p;
  };
  const target = n * 0.13 * 0.35;
  const rSurface = 50 / Math.sqrt(target); // span = 50
  const t = createThinner(mk(5));
  t.select(3000);
  const st = t.stats();
  assert.ok(st.radii[0] > rSurface * 1.05, `첫 반경 ${st.radii[0]} 가 표면 가정 ${rSurface} 보다 커야 한다(재시도)`);
  // 상한: 재시도로 키운 반경은 체적 가정 반경 rVol = span/∛target 을 넘지 않는다(이 장면은 상한에 닿지 않는다: 첫 반경이 0.683·rVol 이라 상한 변이는 여기서 잡히지 않고 아래 n=1000 시험이 잡는다).
  const rVol = 50 / Math.cbrt(target);
  assert.ok(st.radii[0] <= rVol * (1 + 1e-9), `첫 반경 ${st.radii[0]} 가 체적 가정 ${rVol} 를 넘었다`);
  // 하한: 재시도를 마친 첫 패스는 목표 수락 수 target 이상이고 2·target 이하다(이 장면은 rVol 에 닿지 않아 2·target 예외가 필요 없다).
  assert.ok(st.passEnd[0] >= target, `첫 패스 수락 ${st.passEnd[0]} 가 target ${target} 아래다`);
  assert.ok(st.passEnd[0] <= 2 * target, `첫 패스 수락 ${st.passEnd[0]} 가 2·target 을 넘었다`);
});

test('체적 장면 재시도 상한: 점이 적어 목표 수락에 못 미쳐도 첫 반경은 체적 가정 반경 rVol 을 넘지 않는다', () => {
  const n = 1000;
  const p = new Float32Array(3 * n);
  let s = 5;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 3 * n; i++) p[i] = 50 * rnd();
  p.set([0, 0, 0, 50, 50, 50], 0);
  const target = n * 0.13 * 0.35;
  const rVol = 50 / Math.cbrt(target);
  const t = createThinner(p); t.select(100);
  const st = t.stats();
  // 상한이 없으면(또는 1.5배로 두면) 어림이 겹쳐 첫 반경이 rVol 의 1.2배쯤으로 커진다. 상한이 있으면 rVol 에서 멈추고 수락은 target 아래일 수 있다.
  assert.ok(st.radii[0] > (50 / Math.sqrt(target)) * 1.05, `첫 반경 ${st.radii[0]} 가 재시도로 커져야 한다`);
  assert.ok(st.radii[0] <= rVol * (1 + 1e-9), `첫 반경 ${st.radii[0]} 가 체적 가정 ${rVol} 를 넘었다`);
  // 점이 적어 rVol 에서도 수락이 target 에 못 미친다: 반경은 rVol 에 정확히 닿고(상한을 0.9·rVol 로 낮추면 실패) 수락은 target 아래다.
  assert.ok(Math.abs(st.radii[0] / rVol - 1) <= 1e-9, `첫 반경 ${st.radii[0]} 가 rVol ${rVol} 에 닿아야 한다`);
  assert.ok(st.passEnd[0] < target, `첫 패스 수락 ${st.passEnd[0]} 가 target ${target} 아래여야 이 시험이 상한 시험이 된다`);
});

test('opts = null 은 기본값으로 본다(TypeError 없음)', () => {
  const p = scene(2000);
  const t = createBlueNoiseThinner(p, undefined, null);
  assert.equal(new Set(t.select(300)).size, 300);
  assert.deepEqual(t.select(300), createBlueNoiseThinner(p).select(300));
});

test('kHint 가 n 보다 훨씬 커도(1e300) 빨리 끝나고 첫 반경이 span·1e-9 이상이다', () => {
  const n = 5000;
  const p = scene(n);
  const t0 = Date.now();
  const t = createBlueNoiseThinner(p, undefined, { kHint: 1e300 });
  const sel = t.select(1000);
  assert.ok(Date.now() - t0 < 5000, `느리다: ${Date.now() - t0} ms`);
  assert.equal(new Set(sel).size, 1000);
  const { radii } = t.stats();
  assert.ok(radii[0] >= 50 * 1e-9, `첫 반경 ${radii[0]}`);
  assert.ok(radii[0] < 50, `첫 반경 ${radii[0]}`);
  // 칸 좌표 최댓값 span / r 이 Int32 안
  assert.ok(50 / radii[0] < 2 ** 31);
  for (const r of radii) assert.ok(r === 0 || 50 / r < 2 ** 31);
  assert.deepEqual(sel, createBlueNoiseThinner(p, undefined, { kHint: n }).select(1000));
});

// 가장 가까운 두 점의 거리(x 정렬 뒤 쓸기, 현재 최소보다 x 가 멀어지면 중단).
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

// (a) 불변식: 패스 i 의 수락점은 앞 패스 점을 포함한 모든 수락점과 r_i 이상 떨어진다.
//   - k 가 패스 끝 누적 수 passEnd[j] 와 같으면 출력은 패스 0..j 전체이므로 최소 거리 ≥ radii[j].
//   - 그 밖의 k 는 출력의 모든 점이 반경 radii[p](p = k 를 처음 넘는 패스) 이상으로 수락됐으므로 최소 거리 ≥ radii[p].
// 부동소수 오차 허용 eps 는 좌표 범위(span)의 1e-9 배(float64 연산 반올림 규모)로만 잡는다.
for (const [name, make] of [['무작위 장면', () => scene(20000)], ['칸 경계 장면', () => straddleScene(20000)]]) {
  test(`최소 거리 불변식 (${name}): 완결 패스와 임의 k 에서 거리 ≥ 그 패스 반경 − eps`, () => {
    const p = make();
    const t = createThinner(p);
    const eps = 1e-9 * 50;
    for (const k of [800, 3000]) {
      t.select(k);
      const { radii, passEnd } = t.stats();
      let q = 0;
      while (passEnd[q] < k) q++;
      assert.ok(radii[q] > 0);
      const d = minDistFast(p, t.select(k));
      assert.ok(d >= radii[q] - eps, `k=${k} 최소 거리 ${d} < 반경 ${radii[q]}`);
    }
    const { radii, passEnd } = t.stats();
    assert.ok(passEnd.length >= 2, '완결 패스가 둘 이상이어야 의미가 있다');
    for (let j = 0; j < passEnd.length && passEnd[j] < 20000; j++) {
      const d = minDistFast(p, t.select(passEnd[j]));
      assert.ok(d >= radii[j] - eps, `패스 ${j} (k=${passEnd[j]}) 최소 거리 ${d} < 반경 ${radii[j]}`);
    }
  });
}

// (b) 마지막 패스를 일부만 뽑을 때의 공간 고름.
//   방문 순서는 모턴 순을 BLOCK 점 블록으로 나눠 블록 안에서만 섞은 것이므로, 패스 p 의 수락 순서는 모턴 블록 b 의 수락점 c_b 개가
//   연속 구간을 이룬다. 등간격 추출(위치 floor((j+0.5)·len/want))은 길이 c_b 의 정수 구간에서 want·c_b/len 개 ± 1 미만을 고른다.
//   그래서 블록마다 |고른 수 − want·c_b/len| ≤ 1 이어야 한다. 앞에서부터 추출하면 뒤 블록이 0 개라 이 한도를 깬다.
const BLOCK = 4096; // blue_noise_thinner.mjs 의 방문 블록 크기와 같아야 한다
test('마지막 패스 부분 추출은 모턴 블록마다 비율대로(등간격) 고른다', () => {
  const n = 40000;
  const p = scene(n);
  const t = createThinner(p);
  const rank = new Uint32Array(n);
  createSpatialThinner(p).select(n).forEach((s, r) => { rank[s] = r; });
  t.select(Math.floor(0.6 * n));
  const { passEnd } = t.stats();
  let checked = 0;
  for (let q = 1; q < passEnd.length; q++) {
    const start = passEnd[q - 1];
    const len = passEnd[q] - start;
    if (len < 8) continue;
    const prev = new Set(t.select(start));
    const full = t.select(passEnd[q]);
    const cnt = new Float64Array(Math.ceil(n / BLOCK));
    for (const s of full) if (!prev.has(s)) cnt[Math.floor(rank[s] / BLOCK)]++;
    for (const f of [0.3, 0.5, 0.8]) {
      const want = Math.round(f * len);
      const picked = new Float64Array(cnt.length);
      for (const s of t.select(start + want)) if (!prev.has(s)) picked[Math.floor(rank[s] / BLOCK)]++;
      for (let b = 0; b < cnt.length; b++) {
        const expect = (want * cnt[b]) / len;
        assert.ok(Math.abs(picked[b] - expect) <= 1, `패스 ${q} want=${want}/${len} 블록 ${b}: 고른 ${picked[b]} 기대 ${expect}`);
      }
      checked++;
    }
  }
  assert.ok(checked >= 3);
});

// (c) 캐시 적중 사본: 같은 k 를 두 번 받아 두 번째를 고친 뒤 세 번째가 첫 번째와 같아야 한다.
test('캐시 적중 사본: 두 번째 결과를 고쳐도 세 번째는 첫 번째와 같다', () => {
  const t = createThinner(scene(5000));
  const first = t.select(700);
  const second = t.select(700);
  const keep = first.slice();
  second.fill(0);
  const third = t.select(700);
  assert.deepEqual(third, keep);
  assert.deepEqual(third, first);
  assert.notStrictEqual(third, second);
});

test('출력 사본: 돌려받은 배열을 고쳐도 다음 결과가 바뀌지 않는다', () => {
  const p = scene(3000);
  const t = createThinner(p);
  const a = t.select(400);
  const copy = a.slice();
  a.fill(0);
  assert.deepEqual(t.select(400), copy);
});
