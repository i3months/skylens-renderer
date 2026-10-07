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

// 세 축 모두에서 반경 r 의 칸 경계(좌표 = m·r, 최소점 기준)에서 ±HALF·r 안에 점을 몬 장면(흔들림 반폭 HALF = 0.05r).
// 점 i 는 반경 CORNER_RADII[i % 4] 의 칸 경계에 몰고, 칸 번호는 1..CORNER_CELLS[i % 4] 에서 고른다.
// (참고: 0.125 는 이전 ±0.2r 흔들림에서 ±0.1r 안에 드는 비율 0.5³ 이었다. ±0.1r 이 물리적으로 불가한 것이 아니며,
//  지금 ±0.05r 흔들림에서는 ±0.1r 안 비율이 1.0 이다.)
const HALF = 0.05;

// 고정점 반경·칸 수. 실시간 솎기로 탐색해 얻은 값을 상수로 박았다(솎기를 바꿔도 이 장면은 변하지 않아야 불변식이 돈다).
// 장면의 실제 radii 가 이 반경과 같아지는 고정점(첫 패스 반경이 장면의 수락 수 어림에 따라 바뀌므로 반경 → 장면 → 반경 사상의 고정점)이며,
// 실시간 솎기와의 일치는 아래 별도 시험('고정점 상수 대조')에서 확인한다.
const CORNER_RADII = [3.3332902384566028, 2.9999612146109427, 2.6999650931498484, 2.4299685838348637];
const CORNER_CELLS = [13, 15, 17, 19];

function actualRadii(p) {
  const t = createThinner(p);
  t.select(3000);
  return t.stats().radii.filter((r) => r > 0).slice(0, 4);
}

function cornerSceneFor(n, radii, cells) {
  const rnd = lcg(99);
  const p = new Float32Array(3 * n);
  p.set([0, 0, 0, SPAN, SPAN, SPAN], 0);
  const near = (k) => (1 + Math.floor(rnd() * cells[k])) * radii[k] + (rnd() - 0.5) * 2 * HALF * radii[k];
  for (let i = 2; i < n; i++) {
    const k = i % radii.length;
    p[3 * i] = near(k); p[3 * i + 1] = near(k); p[3 * i + 2] = near(k);
  }
  return p;
}

// 상수로 만든 코너 장면(모듈 수준 캐시: 한 번만 만든다).
let cornerCache = null;
function cornerScene() {
  cornerCache ??= cornerSceneFor(N, CORNER_RADII, CORNER_CELLS);
  return cornerCache;
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
for (const [name, make] of [['[0,50]³ 균일 체적', () => volumeScene(N)], ['x·y·z 세 축 칸 경계', () => cornerScene()]]) {
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

// 실시간 솎기와 상수 대조: 탐침 장면의 칸 수·상수 반경으로 만든 장면의 실제 radii 가 상수와 상대 1e-6 안.
test('고정점 상수 대조: 탐침 장면 칸 수 = 상수, 코너 장면의 실제 radii[0..3] 가 상수와 상대 1e-6 안', () => {
  const probe = actualRadii(volumeScene(N));
  assert.equal(probe.length, 4, '탐침 장면에서 양의 반경이 4 개 필요');
  assert.deepEqual(probe.map((r) => Math.floor((SPAN - 1) / r)), CORNER_CELLS);
  const actual = actualRadii(cornerScene());
  assert.equal(actual.length, 4);
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(actual[i] - CORNER_RADII[i]) <= 1e-6 * CORNER_RADII[i], `radii[${i}] 실제 ${actual[i]} 상수 ${CORNER_RADII[i]}`);
  }
});

test('x·y·z 세 축 칸 경계 장면: 흔들림 반폭 ≤ 0.05r(+float32 오차), 경계 ±0.1r 몰림 비율 1.0', () => {
  const p = cornerScene();
  // 점 i 는 반경 CORNER_RADII[i % 4] 로 몰았다. 세 좌표의 가장 가까운 칸 경계(m·r)와의 거리 중 최댓값(r 단위)을 점마다 구한다.
  let maxDev = 0;
  let hit = 0;
  for (let i = 2; i < N; i++) {
    const r = CORNER_RADII[i % 4];
    let dev = 0;
    for (let a = 0; a < 3; a++) {
      const c = p[3 * i + a] / r;
      dev = Math.max(dev, Math.abs(c - Math.round(c)));
    }
    if (dev > maxDev) maxDev = dev;
    if (dev <= 0.1) hit++;
  }
  // float32 저장 오차(좌표 ≤ 50, 상대 6e-8)는 r 단위로 1e-4 아래다.
  assert.ok(maxDev <= HALF + 1e-4, `흔들림 반폭 ${maxDev} > ${HALF}`);
  assert.ok(maxDev >= HALF - 5e-3, `흔들림 반폭 ${maxDev} 이 ${HALF} 에 못 미침(장면이 경계에서 덜 흔들림)`);
  const frac = hit / (N - 2);
  assert.equal(frac, 1, `경계 ±0.1r 몰림 비율 ${frac} != 1`);
});
