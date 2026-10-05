// gapCellError 의 xy 색인(F-377)이 결과를 바꾸지 않음을 지키는 시험.
// 아래 ref 는 색인 이전의 gapCellError(칸마다 near 전부를 훑음)를 그대로 옮긴 기준 구현이다. 같은 입력에서 { e, w } 또는 null 과
// 남은 칸 예산이 정확히 같아야 한다(색인에서 빠지는 건물은 최솟값을 바꿀 수 없다). 촘촘한 상자 + 긴 상자(big 목록) + 무작위 틈.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gapCellError, distStats } from './index.mjs';

function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const qx = ax + t * dx - px, qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}
function inTri(px, py, t, o) {
  const ax = t[o], ay = t[o + 1], bx = t[o + 2], by = t[o + 3], cx = t[o + 4], cy = t[o + 5];
  const s = Math.sign((bx - ax) * (cy - ay) - (cx - ax) * (by - ay));
  return ((bx - ax) * (py - ay) - (px - ax) * (by - ay)) * s >= 0
    && ((cx - bx) * (py - by) - (px - bx) * (cy - by)) * s >= 0
    && ((ax - cx) * (py - cy) - (px - cx) * (ay - cy)) * s >= 0;
}
function memberDist2(x, y, m, best) {
  if (x >= m.minX && x <= m.maxX && y >= m.minY && y <= m.maxY) {
    const t = m.fill;
    for (let o = 0; o < t.length; o += 6) if (inTri(x, y, t, o)) return 0;
  }
  const s = m.segs;
  for (let o = 0; o < s.length; o += 4) {
    const d = segDist2(x, y, s[o], s[o + 1], s[o + 2], s[o + 3]);
    if (d < best) best = d;
  }
  return best;
}
// 색인 이전 gapCellError(ff98a8d)와 같은 식.
function ref(x0, y0, x1, y1, members, limit, box, budget) {
  const near = [];
  for (const m of members) {
    const ox = Math.max(m.minX - x1, 0, x0 - m.maxX), oy = Math.max(m.minY - y1, 0, y0 - m.maxY);
    if (ox * ox + oy * oy <= limit * limit) near.push(m);
  }
  if (near.length === 0) return null;
  let eMax = 0, wMax = 0;
  const stack = [x0, y0, x1, y1];
  const minDiag = limit * 1e-6;
  while (stack.length) {
    const cy1 = stack.pop(), cx1 = stack.pop(), cy0 = stack.pop(), cx0 = stack.pop();
    if (--budget.cells < 0) return null;
    const mx = (cx0 + cx1) / 2, my = (cy0 + cy1) / 2;
    const half = 0.5 * Math.hypot(cx1 - cx0, cy1 - cy0);
    let c2 = Infinity;
    for (const m of near) c2 = memberDist2(mx, my, m, c2);
    const eC = Math.sqrt(c2);
    const xC = Math.min(mx - box.minX, box.maxX - mx, my - box.minY, box.maxY - my);
    if (Math.min(2 * eC, eC + xC) > limit) return null;
    let eUb2 = (eC + half) * (eC + half);
    for (const m of near) {
      const ox = Math.max(m.minX - cx1, 0, cx0 - m.maxX), oy = Math.max(m.minY - cy1, 0, cy0 - m.maxY);
      if (ox * ox + oy * oy >= eUb2) continue;
      const s = m.segs;
      for (let o = 0; o < s.length; o += 4) {
        const ax = s[o], ay = s[o + 1], bx = s[o + 2], by = s[o + 3];
        let far = segDist2(cx0, cy0, ax, ay, bx, by);
        if (far >= eUb2) continue;
        far = Math.max(far, segDist2(cx1, cy0, ax, ay, bx, by));
        if (far >= eUb2) continue;
        far = Math.max(far, segDist2(cx0, cy1, ax, ay, bx, by));
        if (far >= eUb2) continue;
        far = Math.max(far, segDist2(cx1, cy1, ax, ay, bx, by));
        if (far < eUb2) eUb2 = far;
      }
    }
    const eUb = Math.sqrt(eUb2);
    const xUb = Math.min(cx1 - box.minX, box.maxX - cx0, cy1 - box.minY, box.maxY - cy0);
    const wUb = Math.min(2 * eUb, eUb + xUb);
    if (wUb <= limit) {
      if (eUb > eMax) eMax = eUb;
      if (wUb > wMax) wMax = wUb;
      continue;
    }
    if (half < minDiag) return null;
    stack.push(cx0, cy0, mx, my, mx, cy0, cx1, my, cx0, my, mx, cy1, mx, my, cx1, cy1);
  }
  return { e: eMax, w: wMax };
}

// 축 정렬 직사각형 구성 건물(toFrame 결과 모양: AABB, 넓이 있는 삼각형 fill, 변 segs).
function member(x0, y0, x1, y1) {
  return {
    minX: x0, minY: y0, maxX: x1, maxY: y1,
    fill: Float64Array.from([x0, y0, x1, y0, x1, y1, x0, y0, x1, y1, x0, y1]),
    segs: Float64Array.from([x0, y0, x1, y0, x1, y0, x1, y1, x1, y1, x0, y1, x0, y1, x0, y0]),
  };
}
// 결정적 의사 난수(mulberry32).
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('F-377: 색인 gapCellError 는 기준 구현과 결과·남은 예산이 같다(무작위 300 회)', () => {
  const r = rng(377);
  let hits = 0, nulls = 0, gridded = 0;
  for (let t = 0; t < 300; t++) {
    const k = 3 + Math.floor(r() * 14), sp = 0.5 + r() * 1.5, sz = sp * (0.6 + r() * 0.39);
    const ms = [];
    for (let j = 0; j < k; j++) {
      for (let i = 0; i < k; i++) {
        if (r() < 0.15) continue; // 빠진 자리: 더 큰 틈
        const jx = (r() - 0.5) * 0.1 * sp, jy = (r() - 0.5) * 0.1 * sp;
        ms.push(member(i * sp + jx, j * sp + jy, i * sp + jx + sz, j * sp + jy + sz));
      }
    }
    // 긴 상자(색인의 big 목록으로 가는 것)도 가끔 섞는다.
    if (r() < 0.5) ms.push(member(-sp, -2 * sp, k * sp + sp, -2 * sp + sz));
    if (ms.length > 16) gridded++;
    const W = k * sp;
    const x0 = r() * W * 0.5, y0 = r() * W * 0.5, x1 = x0 + (0.05 + r()) * W * 0.5, y1 = y0 + (0.05 + r()) * W * 0.5;
    const limit = sp * (0.3 + r() * 2);
    const box = { minX: -2 * sp, minY: -2 * sp, maxX: W + sp, maxY: W + sp };
    const cells = r() < 0.2 ? 50 : 1 << 14;
    const b1 = { cells }, b2 = { cells };
    const got = gapCellError(x0, y0, x1, y1, ms, limit, box, b1);
    const want = ref(x0, y0, x1, y1, ms, limit, box, b2);
    assert.deepEqual(got, want, `시행 ${t}`);
    assert.equal(b1.cells, b2.cells, `시행 ${t} 남은 예산`);
    if (got) hits++; else nulls++;
  }
  // 양성 대조: 받아들임·거부·격자 경로가 모두 나와야 한다.
  assert.ok(hits > 20 && nulls > 20 && gridded > 100, `hits ${hits} nulls ${nulls} gridded ${gridded}`);
});

// 작업량: 촘촘한 상자 n 개 위의 큰 틈 직사각형 하나. 칸당 본 건물 수(gapVisits / gapCells)는 n 에 따라 늘지 않아야 한다
// (예전 방식은 칸마다 near 전부 = n). 작성 때 잰 값은 n = 400, 1600 에서 둘 다 약 10.5(색인을 빼면 800, 3200).
test('F-377: 칸당 본 건물 수는 near 수와 무관하다', () => {
  const per = [];
  for (const k of [20, 40]) {
    const ms = [];
    for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) ms.push(member(i * 0.7, j * 0.7, i * 0.7 + 0.6, j * 0.7 + 0.6));
    const W = k * 0.7;
    Object.assign(distStats, { gapCalls: 0, gapNear: 0, gapCells: 0, gapVisits: 0 });
    const g = gapCellError(0, 0, W - 0.1, W - 0.1, ms, 0.25, { minX: 0, minY: 0, maxX: W, maxY: W }, { cells: 1 << 20 });
    assert.ok(g, '틈 0.1 m 는 받아들여져야 한다');
    assert.equal(distStats.gapNear, k * k);
    assert.ok(distStats.gapCells > 1000, `칸 ${distStats.gapCells}`);
    assert.ok(distStats.gapVisits > 0, `색인 조회가 건물을 하나도 넘기지 않았다(방문 ${distStats.gapVisits})`); // 색인이 null 이면 0 이라 비율이 공허하게 통과한다
    per.push(distStats.gapVisits / distStats.gapCells);
  }
  assert.ok(per[1] <= 12, `칸당 건물 ${per.map((p) => p.toFixed(1)).join(', ')}`);
  assert.ok(per[1] <= 2 * per[0] + 1, `n 4배에 칸당 건물 ${per.map((p) => p.toFixed(1)).join(' → ')}`);
});

// F-382: 색인의 big 목록(GAP_IDX_REG = 64 칸보다 많이 걸치는 건물)과 변 한계 조회 반지름(eC + half)이 결과를 바꾸지 않음을 지킨다.
// 큰 건물이 가장 가까운 건물이 되도록 틈 직사각형을 그 곁에 두고, 칸이 큰 큰-틈을 넣는다.
// big 목록을 빼면(for (const k of big) 삭제) 큰 건물이 e 를 정하는 칸에서 e·w 상한(또는 분기 수 = 남은 예산)이 기준과 달라진다.
// 조회 반지름 eC + half 를 따로 지키는 것은 아래 결정적 시험(F-384)이다(여기 무작위 배치는 거의 정사각 칸이라 그 변이를 보장하지 않는다).
test('F-382: big 건물(64 칸 초과)을 섞어도 기준 구현과 결과·남은 예산이 같다', () => {
  const r = rng(382);
  let hits = 0, nulls = 0, bigTrials = 0, bigTotal = 0;
  for (let t = 0; t < 700; t++) {
    const k = 30 + Math.floor(r() * 10), sp = 0.5 + r() * 1.5, sz = sp * (0.6 + r() * 0.39);
    const ms = [];
    for (let j = 0; j < k; j++) {
      for (let i = 0; i < k; i++) {
        if (r() < 0.25) continue;
        ms.push(member(i * sp, j * sp, i * sp + sz, j * sp + sz));
      }
    }
    const W = k * sp;
    // 큰 건물: 정의역 대부분을 덮는 넓은 상자나 긴 상자(칸 64 초과). 틈 직사각형 곁(가장자리)에 놓는다.
    const nBig = 1 + Math.floor(r() * 3);
    for (let b = 0; b < nBig; b++) {
      const kind = Math.floor(r() * 2), th = 3 * W; // 정의역 밖으로 넘치게 두꺼워 정의역에 잘려 칸 수백 개를 덮는다
      const gap = sp * (0.6 + r()) + b * 0.4 * sp; // 격자 가장자리에서 큰 건물까지 (limit 안)
      if (kind === 0) ms.push(member(-3 * W, -gap - th, 3 * W, -gap));
      else ms.push(member(-gap - th, -3 * W, -gap, 3 * W));
    }
    const x0 = -sp * r(), y0 = r() * W * 0.15, x1 = x0 + (0.1 + r() * 0.3) * W, y1 = y0 + (0.1 + r() * 0.3) * W;
    const limit = sp * (r() < 0.5 ? 0.3 + r() * 3 : 8 + r() * 10); // 작은 limit 은 칸이 쪼개지는(조회 반지름 half 가 의미 있는) 경우
    const box = { minX: -W, minY: -W, maxX: 2 * W, maxY: 2 * W };
    const cells = r() < 0.2 ? 1 : 1 << 14; // 1 은 예산 소진 거부
    const b1 = { cells }, b2 = { cells };
    Object.assign(distStats, { gapCalls: 0, gapNear: 0, gapCells: 0, gapVisits: 0, gapBig: 0 });
    const got = gapCellError(x0, y0, x1, y1, ms, limit, box, b1);
    const st = { ...distStats };
    const want = ref(x0, y0, x1, y1, ms, limit, box, b2);
    assert.deepEqual(got, want, `시행 ${t}`);
    assert.equal(b1.cells, b2.cells, `시행 ${t} 남은 예산`);
    if (got) hits++; else nulls++;
    if (st.gapBig > 0) {
      bigTrials++; bigTotal += st.gapBig;
      // 모든 조회가 big 을 한 번씩 훑는다: 칸마다 big 전부를 적어도 한 번(조회는 칸마다 중심 거리·변 한계 두 번 이상이라 실제는 더 크다).
      assert.ok(st.gapVisits >= st.gapCells * st.gapBig, `시행 ${t} big 방문 ${st.gapVisits} < 칸 ${st.gapCells} × big ${st.gapBig}`);
    }
  }
  // 양성 대조: big 경로, 받아들임, 거부가 모두 충분히 나와야 한다.
  assert.ok(bigTrials > 100 && bigTotal > 150, `big 시행 ${bigTrials} big 합 ${bigTotal}`);
  assert.ok(hits > 30 && nulls > 30, `hits ${hits} nulls ${nulls}`);
});

// 큰 limit(칸이 큰 틈)의 무작위 배치: 촘촘한 건물 + 넓은 틈 + limit 이 틈 폭의 몇 배. 기준과의 일치만 지킨다
// (조회 반지름이 eC 로 줄어도 걸리는지는 보장하지 않는다. 그것은 바로 아래 결정적 시험이 지킨다).
test('F-382: 큰 limit 의 넓은 틈에서 변 한계 조회가 기준 구현과 같다', () => {
  const r = rng(3820);
  let hits = 0, nulls = 0;
  for (let t = 0; t < 300; t++) {
    const k = 5 + Math.floor(r() * 8), sp = 1, sz = 0.5 + r() * 0.45;
    const ms = [];
    for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) if (r() > 0.4) ms.push(member(i * sp, j * sp, i * sp + sz, j * sp + sz));
    const W = k * sp;
    const limit = (1 + r() * 8) * sp;
    const x0 = -r() * limit, y0 = -r() * limit, x1 = W + r() * limit, y1 = W + r() * limit;
    const box = { minX: x0 - r(), minY: y0 - r(), maxX: x1 + r(), maxY: y1 + r() };
    const cells = r() < 0.3 ? 120 : 1 << 14;
    const b1 = { cells }, b2 = { cells };
    const got = gapCellError(x0, y0, x1, y1, ms, limit, box, b1);
    const want = ref(x0, y0, x1, y1, ms, limit, box, b2);
    assert.deepEqual(got, want, `시행 ${t}`);
    assert.equal(b1.cells, b2.cells, `시행 ${t} 남은 예산`);
    if (got) hits++; else nulls++;
  }
  assert.ok(hits > 30 && nulls > 30, `hits ${hits} nulls ${nulls}`);
});

// F-384: 변 한계 조회 반지름 eC + half 를 결정적으로 지킨다. 칸이 가늘고 길면(0.5 × 20 인 틈) 칸 밖 거리 d 의 변이라도
// 가장 먼 꼭짓점 거리 sqrt(d² + 10²) 가 eC + half 보다 작아 eUb 를 낮출 수 있다. 칸 중심에서 eC ≈ 4 인 건물 A(이것만이면
// eUb ≈ 13.96)와, 칸에서 d = 7 떨어져 eC + half(≈ 14) 안에 들지만 eC 밖인 건물 B(eUb ≈ 12.73)를 둔다.
// 먼 곳에 건물 1000 채를 깔아 격자 칸 크기(≈ 2)를 B 와 반지름 eC 의 도달 거리(5) 사이 간격(3)보다 작게 한다.
// 조회 반지름을 eC 로 줄이면 B 를 못 봐 e 가 13.96 으로 커지고 기준과 달라진다.
test('F-384: eC 밖 eC + half 안의 건물만 변 한계를 낮추는 배치(결정적)', () => {
  const ms = [member(0.45, 13.95, 0.55, 14.05), member(8, 9.9, 8.1, 10.1)]; // A: 중심에서 4, B: 칸에서 7
  for (let i = 0; i < 1000; i++) { // 칸에서 15 이상 떨어져 조회에 들지 않지만 limit 안이라 near 에 든다
    const x = 16.5 + (i % 30) * 0.11, y = 8 + Math.floor(i / 30) * 0.11;
    ms.push(member(x, y, x + 0.1, y + 0.1));
  }
  const limit = 30, box = { minX: -100, minY: -100, maxX: 100, maxY: 100 };
  const b1 = { cells: 100 }, b2 = { cells: 100 };
  const got = gapCellError(0, 0, 1, 20, ms, limit, box, b1);
  const want = ref(0, 0, 1, 20, ms, limit, box, b2);
  assert.ok(got && got.e < 13, `B 가 e 를 낮춰야 한다: ${JSON.stringify(got)}`);
  assert.deepEqual(got, want);
  assert.equal(b1.cells, b2.cells, '남은 예산');
  assert.equal(b1.cells, 99, '칸 하나로 받아들여져야 한다');
});

// F-383: limit 이 무한이거나 폭이 넘치면(정의역 폭이 유한하지 않거나 칸 크기가 유한하지 않음) nx·ny 가 NaN 이라 RangeError 가 났다.
// 이때는 색인 없이 전부 훑어 기준 구현과 같은 값을 낸다.
test('F-383: 정의역 폭이 유한하지 않은 limit 은 전수 경로로 기준과 같은 값을 낸다', () => {
  const ms = [];
  for (let j = 0; j < 6; j++) for (let i = 0; i < 6; i++) ms.push(member(i, j, i + 0.6, j + 0.6)); // 36 채 > 16
  const box = { minX: 0, minY: 0, maxX: 6, maxY: 6 };
  for (const limit of [Infinity, 1e308, 1e200, 1e154]) {
    const b1 = { cells: 1 << 14 }, b2 = { cells: 1 << 14 };
    let got;
    assert.doesNotThrow(() => { got = gapCellError(0.6, 0.6, 5, 5, ms, limit, box, b1); }, `limit ${limit}`);
    const want = ref(0.6, 0.6, 5, 5, ms, limit, box, b2);
    assert.deepEqual(got, want, `limit ${limit}`);
    assert.equal(b1.cells, b2.cells, `limit ${limit} 남은 예산`);
    assert.ok(got, `limit ${limit} 는 받아들여져야 한다`);
  }
});

// F-383: near ≤ 16 인 작은 입력은 색인을 만들지 않고(오버헤드 없이) 같은 값을 낸다.
test('F-383: near 가 작으면 색인 없이 기준과 같은 값(big 목록도 만들지 않음)', () => {
  const r = rng(383);
  for (let t = 0; t < 100; t++) {
    const n = 2 + Math.floor(r() * 15), ms = [];
    for (let i = 0; i < n; i++) { const x = r() * 6, y = r() * 6; ms.push(member(x, y, x + 0.3 + r(), y + 0.3 + r())); }
    const box = { minX: -1, minY: -1, maxX: 8, maxY: 8 };
    const limit = 0.5 + r() * 3;
    const b1 = { cells: 1 << 14 }, b2 = { cells: 1 << 14 };
    Object.assign(distStats, { gapBig: 0, gapVisits: 0 });
    const got = gapCellError(1, 1, 5, 5, ms, limit, box, b1);
    assert.equal(distStats.gapBig, 0);
    assert.equal(distStats.gapVisits, 0, `시행 ${t} 색인 없이 전수 경로여야 한다`); // 색인을 만들었다면 조회가 방문을 센다
    const want = ref(1, 1, 5, 5, ms, limit, box, b2);
    assert.deepEqual(got, want, `시행 ${t}`);
    assert.equal(b1.cells, b2.cells, `시행 ${t} 남은 예산`);
  }
});
