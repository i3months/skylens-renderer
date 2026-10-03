import test from 'node:test';
import assert from 'node:assert/strict';
import { createLevelMachine } from '../state/index.mjs';

// 고정 시드 PRNG(mulberry32). 같은 시드는 항상 같은 경우를 만든다.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const out = [];
  arr.forEach((x, i) => {
    for (const rest of permutations([...arr.slice(0, i), ...arr.slice(i + 1)])) out.push([x, ...rest]);
  });
  return out;
}

test('4수준 전 순열 24가지: 최종 수준 3, accepted 합 50, 개수 분포 6/11/6/1', () => {
  const perms = permutations([0, 1, 2, 3]);
  assert.equal(perms.length, 24);
  const dist = new Map();
  let total = 0;
  for (const order of perms) {
    const m = createLevelMachine();
    let prefixMax = -1;
    let expected = 0;
    let accepted = 0;
    for (const lv of order) {
      const r = m.arrive(7, lv, [{ count: lv + 1 }]);
      if (lv > prefixMax) { prefixMax = lv; expected++; }
      if (r.accepted) accepted++;
    }
    assert.equal(m.snapshot(7).level, 3, `순열 ${order}`);
    assert.equal(m.pointCount(7), 4);
    assert.equal(accepted, expected, `순열 ${order}`);
    total += accepted;
    dist.set(accepted, (dist.get(accepted) || 0) + 1);
  }
  assert.equal(total, 50);
  assert.deepEqual([1, 2, 3, 4].map((k) => dist.get(k)), [6, 11, 6, 1]);
});

test('추월당한 도착(내림·동일 수준)은 skip, accepted=false, released=[], 보관 조각 불변', () => {
  const m = createLevelMachine();
  const kept = { count: 30 };
  m.arrive(3, 2, [kept]);
  for (const lv of [0, 1, 2, 2, 0]) {
    const before = m.snapshot(3);
    const r = m.arrive(3, lv, [{ count: 999 }]);
    assert.equal(r.action, 'skip');
    assert.equal(r.accepted, false);
    assert.deepEqual(r.released, []);
    assert.equal(r.previousLevel, 2);
    const after = m.snapshot(3);
    assert.equal(after.level, 2);
    assert.equal(after.pieces.length, 1);
    assert.equal(after.pieces[0], kept);
    assert.deepEqual(after, before);
    assert.equal(m.pointCount(3), 30);
  }
});

test('1만 경우 무작위 도착: 구간별 최고 수준 유지, 독립 오라클(Map 최댓값)과 일치', () => {
  const rnd = mulberry32(0x5eed1234);
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  let violations = 0;
  let skips = 0;
  let accepts = 0;
  const report = [];
  const fail = (msg) => { violations++; if (report.length < 5) report.push(msg); };

  for (let c = 0; c < 10000; c++) {
    const segCount = int(1, 6);
    const ids = [];
    while (ids.length < segCount) {
      const id = int(0, 50);
      if (!ids.includes(id)) ids.push(id);
    }
    const n = int(3, 20);
    const m = createLevelMachine({ recordHistory: true });
    const oracle = new Map();      // 구간 -> 최고 수준
    const oraclePieces = new Map(); // 구간 -> 최고 수준 도착의 조각
    for (let i = 0; i < n; i++) {
      const id = ids[int(0, segCount - 1)];
      const lv = int(0, 3);
      const piece = { count: int(1, 100), tag: `${c}:${i}` };
      const prev = oracle.has(id) ? oracle.get(id) : -1;
      const prevPieces = oraclePieces.get(id) || [];
      const r = m.arrive(id, lv, [piece]);
      const expectAccept = lv > prev;
      if (r.accepted !== expectAccept) fail(`경우 ${c}/${i}: accepted ${r.accepted} != ${expectAccept}`);
      if (r.previousLevel !== prev) fail(`경우 ${c}/${i}: previousLevel`);
      if (expectAccept) {
        accepts++;
        oracle.set(id, lv);
        oraclePieces.set(id, [piece]);
        if (r.released.length !== prevPieces.length || r.released.some((p, k) => p !== prevPieces[k])) fail(`경우 ${c}/${i}: released 불일치`);
      } else {
        skips++;
        if (r.action !== 'skip' || r.released.length !== 0) fail(`경우 ${c}/${i}: skip 결과 위반`);
      }
      const s = m.snapshot(id);
      const keep = oraclePieces.get(id);
      if (s.level !== oracle.get(id)) fail(`경우 ${c}/${i}: 수준 ${s.level} != ${oracle.get(id)}`);
      if (s.pieces.length !== keep.length || s.pieces[0] !== keep[0]) fail(`경우 ${c}/${i}: 보관 조각 변동`);
      if (m.pointCount(id) !== keep[0].count) fail(`경우 ${c}/${i}: pointCount`);
    }
    for (const [id, lv] of oracle) {
      if (m.snapshot(id).level !== lv) fail(`경우 ${c}: 최종 수준 ${id}`);
    }
    const known = [...oracle.keys()].sort((a, b) => a - b);
    assert.deepEqual(m.segments(), known);
    const h = m.history();
    if (h.length !== n) fail(`경우 ${c}: 기록 길이`);
  }
  assert.deepEqual(report, []);
  assert.equal(violations, 0);
  assert.ok(skips > 0 && accepts > 0);
  // 고정 시드 기준값: 같은 시드면 항상 같은 합이다.
  assert.equal(accepts, 47182);
  assert.equal(skips, 67768);
});
