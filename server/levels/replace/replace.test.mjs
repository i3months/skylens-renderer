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

test('고정 시드 5천 열에서 해제 조각 수 + 보관 조각 수 = 받은 accepted 조각 수', () => {
  const { ledger, released } = setup();
  const rnd = prng(20240601);
  let acceptedPieces = 0;
  for (let i = 0; i < 5000; i++) {
    const seg = Math.floor(rnd() * 12);
    const lv = Math.floor(rnd() * 4);
    const pieces = mk(`${i}`, Math.floor(rnd() * 4));
    const r = ledger.arrive(seg, lv, pieces);
    if (r.accepted) acceptedPieces += pieces.length;
    assert.equal(released.length + ledger.heldPieceCount(), acceptedPieces);
  }
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
