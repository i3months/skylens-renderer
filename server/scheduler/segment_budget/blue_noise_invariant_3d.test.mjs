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

// 세 축 모두에서 패스 반경의 칸 경계(좌표 = m·r, 최소점 기준) 양쪽 0.2r 안에 점을 몬 장면.
// 첫 반경은 span·n 만으로 정해지므로 같은 n·span 의 탐침 장면에서 반경을 미리 읽는다.
function cornerScene(n) {
  const t = createThinner(volumeScene(n));
  t.select(3000);
  const radii = t.stats().radii.filter((r) => r > 0).slice(0, 4);
  const rnd = lcg(99);
  const p = new Float32Array(3 * n);
  p.set([0, 0, 0, SPAN, SPAN, SPAN], 0);
  const near = (r) => (1 + Math.floor(rnd() * Math.floor((SPAN - 1) / r))) * r + (rnd() - 0.5) * 0.4 * r;
  for (let i = 2; i < n; i++) {
    const r = radii[i % radii.length];
    p[3 * i] = near(r); p[3 * i + 1] = near(r); p[3 * i + 2] = near(r);
  }
  return p;
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
for (const [name, make] of [['[0,50]³ 균일 체적', () => volumeScene(N)], ['x·y·z 세 축 칸 경계', () => cornerScene(N)]]) {
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
