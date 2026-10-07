// 3D 이웃 칸 검사 불변식 시험(F-594 b). 기존 시험의 장면은 바닥·벽·평면뿐이라 27칸 중 일부(모서리 칸, y·z 의 +1 이웃)를
// 빼도 통과한다. 여기서는 [0,50]³ 체적 장면과 x·y·z 세 축 칸 경계에 모두 걸친 장면에서
// '수락점 쌍 최소 거리 ≥ 그 점이 수락된 패스의 반경' 을 단언한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThinner } from './blue_noise_thinner.mjs';

const N = 20000;
const SPAN = 50;

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

// 두 모서리 점으로 span 을 50 으로 고정한 [0,50]³ 균일 장면.
function volumeScene(n) {
  const rnd = lcg(11);
  const p = new Float32Array(3 * n);
  p.set([0, 0, 0, SPAN, SPAN, SPAN], 0);
  for (let i = 2; i < n; i++) {
    p[3 * i] = SPAN * rnd(); p[3 * i + 1] = SPAN * rnd(); p[3 * i + 2] = SPAN * rnd();
  }
  return p;
}

// 세 축 모두에서 반경 r 의 칸 경계(좌표 = m·r, 최소점 기준) 양쪽 0.05r 안에 점을 몬 장면(±0.1r 안에 거의 전부 든다).
// 첫 패스 반경은 span·n 만으로 정해지지 않고 장면의 수락 수 어림(est)에 따라 바뀌므로, 탐침 반경으로 만든 장면의 실제 radii 는
// 탐침 값과 다르다(반경 → 장면 → 반경 사상은 조각마다 상수라 단순 반복은 순환한다). 그래서 장면을 만든 뒤 그 장면의 실제 radii 를
// 다시 읽고, 그 값으로 다시 만든 장면의 radii 가 상대 1e-6 안에서 같아지는 고정점을 찾는다. 몰 반경 배율을 조금씩 바꿔 가며 찾고,
// 끝내 못 찾으면 시험이 실패한다. 칸 개수(칸 경계 m 의 범위)는 탐침 반경에서 한 번만 정해 장면이 배율에 연속이게 한다.
function actualRadii(p) {
  const t = createThinner(p);
  t.select(3000);
  return t.stats().radii.filter((r) => r > 0).slice(0, 4);
}

function cornerSceneFor(n, radii, cells) {
  const rnd = lcg(99);
  const p = new Float32Array(3 * n);
  p.set([0, 0, 0, SPAN, SPAN, SPAN], 0);
  const near = (k) => (1 + Math.floor(rnd() * cells[k])) * radii[k] + (rnd() - 0.5) * 0.1 * radii[k];
  for (let i = 2; i < n; i++) {
    const k = i % radii.length;
    p[3 * i] = near(k); p[3 * i + 1] = near(k); p[3 * i + 2] = near(k);
  }
  return p;
}

function cornerScene(n) {
  const probe = actualRadii(volumeScene(n));
  assert.equal(probe.length, 4, '탐침 장면에서 양의 반경이 4 개 필요');
  const cells = probe.map((r) => Math.floor((SPAN - 1) / r));
  const ratio = probe.map((r) => r / probe[0]);
  // 배율 0.94 부터 2e-4 씩 올리며 첫 고정점을 찾는다.
  for (let i = 0; i < 400; i++) {
    const x = probe[0] * (0.94 + i * 2e-4);
    const guess = actualRadii(cornerSceneFor(n, ratio.map((q) => q * x), cells));
    if (guess.length !== 4) continue;
    const p = cornerSceneFor(n, guess, cells);
    const actual = actualRadii(p);
    if (actual.length === 4 && actual.every((r, j) => Math.abs(r - guess[j]) <= 1e-6 * guess[j])) return { p, radii: guess };
  }
  assert.fail('장면의 실제 radii 가 몰아 둔 반경과 같아지는 고정점을 찾지 못했다');
}

// 가장 가까운 두 점의 거리(x 정렬 뒤 쓸기).
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

// 불변식(기존 시험과 같은 형태): k 가 패스 끝 누적 수면 출력이 패스 0..j 전체라 최소 거리 ≥ radii[j],
// 그 밖의 k 는 출력 모든 점이 반경 radii[p](p = k 를 처음 넘는 패스) 이상으로 수락됐다. eps 는 span 의 1e-9 배.
for (const [name, make] of [['[0,50]³ 균일 체적', () => volumeScene(N)], ['x·y·z 세 축 칸 경계', () => cornerScene(N).p]]) {
  test(`3D 최소 거리 불변식 (${name}): 완결 패스와 임의 k 에서 거리 ≥ 그 패스 반경 − eps`, () => {
    const p = make();
    const t = createThinner(p);
    const eps = 1e-9 * SPAN;
    for (const k of [800, 3000, 6000]) {
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
    for (let j = 0; j < passEnd.length && passEnd[j] < N; j++) {
      if (!(radii[j] > 0)) continue;
      const d = minDistFast(p, t.select(passEnd[j]));
      assert.ok(d >= radii[j] - eps, `패스 ${j} (k=${passEnd[j]}) 최소 거리 ${d} < 반경 ${radii[j]}`);
    }
  });
}

test('x·y·z 세 축 칸 경계 장면: 실제 radii[0..3] 가 탐침 값과 상대 1e-6 안, 경계 ±0.1r 몰림 비율 > 0.8', () => {
  const { p, radii } = cornerScene(N);
  const actual = actualRadii(p);
  assert.equal(actual.length, 4);
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(actual[i] - radii[i]) <= 1e-6 * radii[i], `radii[${i}] 실제 ${actual[i]} 탐침 ${radii[i]}`);
  }
  // 점 i 는 반경 radii[i % 4] 로 몰았다. 세 좌표 모두 가장 가까운 칸 경계(m·r)와의 거리가 0.1r 이하인 점의 비율.
  let hit = 0;
  for (let i = 2; i < N; i++) {
    const r = actual[i % 4];
    let all = true;
    for (let a = 0; a < 3; a++) {
      const c = p[3 * i + a] / r;
      if (Math.abs(c - Math.round(c)) > 0.1) all = false;
    }
    if (all) hit++;
  }
  const frac = hit / (N - 2);
  assert.ok(frac > 0.8, `경계 몰림 비율 ${frac} <= 0.8`);
});
