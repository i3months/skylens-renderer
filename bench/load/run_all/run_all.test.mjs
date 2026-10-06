import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCENARIOS, runScenario, main } from './run.mjs';
import { validateScenario } from '../../../contracts/load/index.mjs';

const steady = SCENARIOS[0];
const slow = SCENARIOS[2];

test('T16.10: 시나리오 3종 유효, 30 클라이언트', () => {
  assert.equal(SCENARIOS.length, 3);
  for (const s of SCENARIOS) { assert.deepEqual(validateScenario(s), []); assert.equal(s.clients, 30); }
});
test('T16.10: 시나리오별 실행이 위반 0·결과 유효, 기록 3개, 서버 샘플 60개', () => {
  for (const s of SCENARIOS) {
    const { result, violations, serverSamples } = runScenario(s, { commit: 'abcdef1' });
    assert.deepEqual(violations, [], s.name);
    assert.equal(result.perClient.length, 30);
    assert.equal(result.records.length, 3);
    assert.equal(serverSamples.length, 60, s.name);
    assert.deepEqual(serverSamples.map((x) => x.tS).slice(0, 3), [1, 2, 3]);
  }
});
test('T16.10: 낮춘 문턱이면 위반 1건 이상, 문구 고정', () => {
  const { violations } = runScenario(steady, { commit: 'abcdef1', thresholds: { 'load.first_frame_p95': { max: 1 } } });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /^steady30: load\.first_frame_p95: .* > max 1$/);
});
test('T16.10: 문턱 주입이 slow_link 는 면제', () => {
  const { violations } = runScenario(slow, { commit: 'abcdef1', thresholds: { 'load.first_frame_p95': { max: 1 } } });
  assert.deepEqual(violations, []);
});
test('T16.10: 서버 샘플 시계가 끊기면 샘플 부족 위반', () => {
  const { violations, serverSamples } = runScenario(steady, { commit: 'abcdef1', statsClock: { now: () => 0 } });
  assert.equal(serverSamples.length, 0);
  assert.deepEqual(violations, ['steady30: 0 server samples, expected 60']);
});
test('T16.10: main 은 위반이 있으면 종료 코드 1, 없으면 0', () => {
  const quiet = console.error; const log = console.log;
  console.error = () => {}; console.log = () => {};
  try {
    assert.equal(main(mkdtempSync(join(tmpdir(), 'load-')), { commit: 'abcdef1', thresholds: { 'load.first_frame_p95': { max: 1 } } }), 1);
    assert.equal(main(mkdtempSync(join(tmpdir(), 'load-')), { commit: 'abcdef1' }), 0);
  } finally { console.error = quiet; console.log = log; }
});

// ---- F-529: injected event logs, exact violation strings ----
import { simulateClients } from '../clients/index.mjs';
import { showFromArrivals, burstArrivals } from '../burst/index.mjs';

const OPTS = { commit: 'abcdef1' };
const burstOf = (burstLevels) => ({ ...SCENARIOS[1], name: `burst${burstLevels}`, burstLevels });
const baseSteady = () => simulateClients(steady, { seed: 1 });

test('F-529: recorded metric names are fixed', () => {
  const { result } = runScenario(steady, OPTS);
  assert.deepEqual(result.records.map((r) => r.metric),
    ['load.first_frame_p95', 'load.bandwidth_total', 'load.bandwidth_peak_bytes_per_s']);
});
test('F-529: no first frame at all -> NaN p95 violation', () => {
  const events = baseSteady().filter((e) => e.kind !== 'first_frame');
  const { violations } = runScenario(steady, { ...OPTS, events });
  assert.ok(violations.includes('steady30: first-frame p95 is NaN: no first frame was measured'), violations.join('|'));
});
test('F-529: a client with no bytes is reported unreachable', () => {
  const events = baseSteady().filter((e) => !(e.kind === 'bytes' && e.id === 4));
  const { violations } = runScenario(steady, { ...OPTS, events });
  assert.ok(violations.includes('steady30: client 4 received no bytes'), violations.join('|'));
});
test('F-529: an early close reports the open-connection drop', () => {
  const events = baseSteady();
  const closeIdx = events.findIndex((e) => e.kind === 'close' && e.id === 0);
  events[closeIdx] = { ...events[closeIdx], tMs: 1 };
  events.sort((a, b) => a.tMs - b.tMs);
  const { violations } = runScenario(steady, { ...OPTS, events });
  assert.ok(violations.some((v) => /^steady30: open connections dropped to 29 of 30$/.test(v)), violations.join('|'));
});
test('F-529: burst scenarios with burstLevels 1..4 have 0 violations', () => {
  for (const b of [1, 2, 3, 4]) {
    const { violations } = runScenario(burstOf(b), OPTS);
    assert.deepEqual(violations, [], `burstLevels ${b}`);
  }
});
test('F-529: burst invariant violations: arrival out of range (exact string)', () => {
  const s = burstOf(2);
  const events = [...simulateClients(s, { seed: 1 }), { id: 0, tMs: 5, kind: 'level', level: 1.5 }];
  const { violations } = runScenario(s, { ...OPTS, events });
  assert.deepEqual(violations, ['burst2: arrival: client 0 level 1.5 at 5ms out of range 0..1']);
});
test('F-529: burst invariant violations: levels beyond burstLevels are not arrivals', () => {
  // a level-3 event in a burstLevels 2 run belongs to the post-burst part and must not be flagged
  const s = burstOf(2);
  const events = [...simulateClients(s, { seed: 1 }), { id: 0, tMs: 5000, kind: 'level', level: 3 }];
  assert.deepEqual(runScenario(s, { ...OPTS, events }).violations, []);
});
const const3 = (ev, c) => showFromArrivals(ev, c).map((x) => ({ ...x, level: 3 }));
test('F-529: constant-3 shown mutation on a burstLevels 2 burst is reported', () => {
  const s = burstOf(2);
  const log = simulateClients(s, { seed: 1 });
  const mutated = const3(burstArrivals(log, 2), 30);
  const { violations } = runScenario(s, { ...OPTS, events: log, show: const3 });
  const expected = [
    ...mutated.map((x) => `burst2: shown: client ${x.id} level 3 at ${x.tMs}ms out of range 0..1`),
    ...Array.from({ length: 30 }, (_, id) => `burst2: client ${id}: levels arrived but never shown`),
  ].sort();
  assert.ok(mutated.length >= 30);
  assert.deepEqual([...violations].sort(), expected);
});
test('F-529: constant-3 shown mutation, level 3 inside the scenario range but never arrived', () => {
  // burstLevels 2 arrivals only, judged by a 4-level scenario: the shown level 3 is in range yet never arrived
  const log = simulateClients(burstOf(2), { seed: 1 }).filter((e) => e.kind !== 'level' || e.level < 2);
  const mutated = const3(burstArrivals(log, 4), 30);
  const { violations } = runScenario(burstOf(4), { ...OPTS, events: log, show: const3 });
  for (const x of mutated) assert.ok(violations.includes(`burst4: client ${x.id}: level 3 at ${x.tMs}ms never arrived`), `client ${x.id}`);
});
