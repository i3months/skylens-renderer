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
    per.push(distStats.gapVisits / distStats.gapCells);
  }
  assert.ok(per[1] <= 12, `칸당 건물 ${per.map((p) => p.toFixed(1)).join(', ')}`);
  assert.ok(per[1] <= 2 * per[0] + 1, `n 4배에 칸당 건물 ${per.map((p) => p.toFixed(1)).join(' → ')}`);
});
