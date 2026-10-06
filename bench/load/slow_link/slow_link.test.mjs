import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateSlowLink, QUEUE_LIMIT_BYTES } from './index.mjs';
import { validateEvent } from '../../../contracts/load/harness.mjs';

const mk = (linkBytesPerS) => ({
  name: 'slow', kind: 'slow_link', clients: 30, durationS: 20, linkBytesPerS,
  path: [{ t: 0, e: 0, n: 0, u: 100 }, { t: 20, e: 30, n: 0, u: 100 }],
});
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const lat = (r) => r.events.filter((e) => e.kind === 'bytes').map((e) => e.latencyMs);

test('slow link: queue bounded, nothing dropped, delivery capped by link rate', () => {
  const sc = mk(50000);
  const r = simulateSlowLink(sc, { seed: 7 });
  assert.ok(r.maxQueueBytes <= QUEUE_LIMIT_BYTES);
  assert.ok(r.maxQueueBytes > 0);
  assert.equal(r.dropped, 0);
  const total = new Array(30).fill(0);
  for (const e of r.events) {
    assert.deepEqual(validateEvent(e, 30), []);
    if (e.kind === 'bytes') total[e.id] += e.bytes;
  }
  for (let id = 0; id < 30; id++) assert.ok(total[id] <= 50000 * sc.durationS, `client ${id}`);
  assert.ok(total.some((b) => b > 0));
});

test('events sorted, connect/first_frame/close present per client', () => {
  const r = simulateSlowLink(mk(50000), { seed: 3 });
  for (let i = 1; i < r.events.length; i++) {
    const a = r.events[i - 1]; const b = r.events[i];
    assert.ok(a.tMs < b.tMs || (a.tMs === b.tMs && a.id <= b.id));
  }
  for (let id = 0; id < 30; id++) {
    const mine = r.events.filter((e) => e.id === id);
    assert.equal(mine[0].kind, 'connect');
    assert.equal(mine.at(-1).kind, 'close');
    assert.equal(mine.at(-1).tMs, 20000);
    const ff = mine.findIndex((e) => e.kind === 'first_frame');
    assert.ok(ff > 0 && mine[ff - 1].kind === 'bytes' && mine[ff - 1].tMs === mine[ff].tMs);
  }
});

test('slow link latencies exceed fast link latencies', () => {
  const slow = median(lat(simulateSlowLink(mk(50000), { seed: 5 })));
  const fast = median(lat(simulateSlowLink(mk(5000000), { seed: 5 })));
  assert.ok(slow > fast, `${slow} > ${fast}`);
});

test('deterministic per seed, different across seeds', () => {
  const a = simulateSlowLink(mk(50000), { seed: 11 });
  assert.deepEqual(simulateSlowLink(mk(50000), { seed: 11 }), a);
  assert.notDeepEqual(simulateSlowLink(mk(50000), { seed: 12 }).events, a.events);
});

test('rejects non slow_link scenario', () => {
  const sc = { ...mk(1000) };
  assert.throws(() => simulateSlowLink({ ...sc, kind: 'steady', linkBytesPerS: undefined }, { seed: 1 }));
});
