import test from 'node:test';
import assert from 'node:assert/strict';
import { createLevelMachine } from '../state/index.mjs';
import { createPieceLedger } from './index.mjs';

function setup() {
  const released = [];
  const ledger = createPieceLedger(createLevelMachine(), { onRelease: (p) => released.push(p) });
  return { ledger, released };
}
const mk = (tag, n = 2) => Array.from({ length: n }, (_, i) => ({ tag, i, count: 10 }));

test('수준 0→1→2→3 도착 후 낮은 수준 조각은 0, 보관은 마지막 수준 것만', () => {
  const { ledger, released } = setup();
  const sets = [mk('L0'), mk('L1', 3), mk('L2', 4), mk('L3', 5)];
  sets.forEach((s, lv) => ledger.arrive(7, lv, s));
  assert.equal(ledger.heldPieceCount(7), 5);
  assert.equal(ledger.heldPieceCount(), 5);
  const held = ledger.machine.snapshot(7).pieces;
  assert.ok(held.every((p) => p.tag === 'L3'));
  assert.equal(held.filter((p) => p.tag !== 'L3').length, 0);
  assert.equal(released.length, 2 + 3 + 4);
  assert.ok(released.every((p) => p.tag !== 'L3'));
  // 해제된 것은 낮은 수준 조각 객체 그 자체이며 도착 순서대로 정확히 9개다(F-180 ②).
  assert.deepEqual(released, [...sets[0], ...sets[1], ...sets[2]]);
  released.forEach((p, i) => assert.equal(p, [...sets[0], ...sets[1], ...sets[2]][i]));
  // 보관된 것은 마지막 도착 조각 객체 그 자체다.
  held.forEach((p, i) => assert.equal(p, sets[3][i]));
});

test('같은 조각 객체가 해제 콜백에 정확히 한 번씩만 불린다', () => {
  const { ledger, released } = setup();
  for (let lv = 0; lv < 4; lv++) ledger.arrive(1, lv, mk('x' + lv));
  ledger.arrive(1, 3, mk('late'));
  ledger.arrive(1, 0, mk('late0'));
  assert.equal(new Set(released).size, released.length);
});

test('skip 은 해제를 일으키지 않는다', () => {
  const { ledger, released } = setup();
  ledger.arrive(2, 2, mk('a'));
  const before = ledger.machine.snapshot(2).pieces;
  for (const lv of [0, 1, 2]) {
    const r = ledger.arrive(2, lv, mk('s' + lv));
    assert.equal(r.action, 'skip');
  }
  assert.equal(released.length, 0);
  assert.deepEqual(ledger.machine.snapshot(2).pieces, before);
  assert.equal(ledger.heldPieceCount(2), 2);
});

function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('고정 시드 5천 도착: 구간별 보관 = 마지막 accepted 도착 조각, 해제 = 직전 보관 조각 정확히', () => {
  const { ledger, released } = setup();
  const rnd = prng(20240601);
  // 독립 오라클: 구간별 마지막 accepted 도착의 조각 배열(객체 동일성)과 그 수준
  const lastPieces = new Map();
  const lastLevel = new Map();
  let acceptedPieces = 0;
  let replaces = 0;
  for (let i = 0; i < 5000; i++) {
    const seg = Math.floor(rnd() * 1000);
    const lv = Math.floor(rnd() * 4);
    const pieces = mk(`${i}`, 1 + Math.floor(rnd() * 3));
    const prevHeld = lastPieces.get(seg) || [];
    const prevLevel = lastLevel.has(seg) ? lastLevel.get(seg) : -1;
    const releasedBefore = released.length;
    const r = ledger.arrive(seg, lv, pieces);
    const expectAccept = lv > prevLevel;
    assert.equal(r.accepted, expectAccept, `도착 ${i}`);
    if (expectAccept) {
      acceptedPieces += pieces.length;
      lastPieces.set(seg, pieces);
      lastLevel.set(seg, lv);
      // 이번 도착으로 해제된 조각 = 직전 보관 조각 전부, 같은 객체·같은 순서(누적 변이면 여기서 깨진다)
      const now = released.slice(releasedBefore);
      assert.equal(now.length, prevHeld.length, `도착 ${i}: 해제 개수`);
      now.forEach((p, k) => assert.equal(p, prevHeld[k], `도착 ${i}: 해제 조각 ${k}`));
      if (prevLevel >= 0) replaces++;
    } else {
      assert.equal(released.length, releasedBefore, `도착 ${i}: skip 은 해제 없음`);
    }
    // 보관 = 마지막 accepted 도착 조각 그 자체
    const held = ledger.machine.snapshot(seg).pieces;
    const want = lastPieces.get(seg) || [];
    assert.equal(held.length, want.length, `도착 ${i}: 보관 개수`);
    held.forEach((p, k) => assert.equal(p, want[k], `도착 ${i}: 보관 조각 ${k}`));
    assert.equal(released.length + ledger.heldPieceCount(), acceptedPieces);
  }
  // 구간당 replace 는 최대 3 번이라 구간이 적으면 교체 경로가 거의 안 쓰인다(F-180 ①). 1000구간·구간당 평균 5건으로
  // 뽑으면 정확 열거 기대 replace 는 k=5 에서 0.83 → 약 830 건이다. 하한 500 은 그 약 60% 다.
  assert.ok(replaces >= 500, `replace ${replaces}`);
});

test('해제된 조각은 보관 조각에 다시 나타나지 않는다', () => {
  const { ledger, released } = setup();
  const rnd = prng(99);
  for (let i = 0; i < 2000; i++) {
    ledger.arrive(Math.floor(rnd() * 8), Math.floor(rnd() * 4), mk(`${i}`, 1 + Math.floor(rnd() * 3)));
  }
  const gone = new Set(released);
  for (const id of ledger.machine.segments()) {
    for (const p of ledger.machine.snapshot(id).pieces) assert.equal(gone.has(p), false);
  }
});
