import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCENARIOS, runScenario, main, appendAll } from './run.mjs';
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
  const { violations, serverSamples } = runScenario(steady, { commit: 'abcdef1', statsClock: { clock: 'simulated', now: () => 0, cpuUsage: () => ({ user: 0, system: 0 }) } });
  assert.equal(serverSamples.length, 0);
  assert.deepEqual(violations, ['steady30: server samples: 0 samples, expected 60']);
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
  const perClient = Array.from({ length: 30 }, (_, i) => `steady30: client ${i}: no first frame`);
  assert.deepEqual(violations, [
    'steady30: first-frame p95 is NaN: no first frame was measured',
    ...perClient,
    'steady30: records[0]: bad value',
    'steady30: load.first_frame_p95: non-numeric value',
  ]);
});
test('F-529: a client with no bytes is reported unreachable', () => {
  const events = baseSteady().filter((e) => !(e.kind === 'bytes' && e.id === 4));
  const { violations } = runScenario(steady, { ...OPTS, events });
  assert.deepEqual(violations, ['steady30: client 4 received no bytes', 'steady30: perClient length != clients']);
});
test('F-529: an early close reports the open-connection drop', () => {
  const events = baseSteady();
  const closeIdx = events.findIndex((e) => e.kind === 'close' && e.id === 0);
  const lastConnect = Math.max(...events.filter((e) => e.kind === 'connect').map((e) => e.tMs));
  events[closeIdx] = { ...events[closeIdx], tMs: lastConnect + 1 };
  events.sort((a, b) => a.tMs - b.tMs);
  const { violations } = runScenario(steady, { ...OPTS, events });
  assert.deepEqual(violations, ['steady30: open connections dropped to 29 of 30']);
});
test('F-529: burst scenarios with burstLevels 1..4 have 0 violations', () => {
  for (const b of [1, 2, 3, 4]) {
    const { violations } = runScenario(burstOf(b), OPTS);
    assert.deepEqual(violations, [], `burstLevels ${b}`);
  }
});
test('F-529 / F-539: a non-integer arrival level is rejected by the event log check (exact string)', () => {
  // Since F-539 the injected log is checked first, so the burst checker never sees level 1.5.
  const s = burstOf(2);
  const events = [...simulateClients(s, { seed: 1 }), { id: 0, tMs: 1e9, kind: 'level', level: 1.5 }];
  const { violations } = runScenario(s, { ...OPTS, events });
  assert.deepEqual(violations, [`burst2: event ${events.length - 1}: bad level`]);
});
test('F-529: burst invariant violations: levels beyond burstLevels are not arrivals', () => {
  // a level-3 event in a burstLevels 2 run belongs to the post-burst part and must not be flagged
  const s = burstOf(2);
  const events = [...simulateClients(s, { seed: 1 }), { id: 0, tMs: 1e9, kind: 'level', level: 3 }];
  assert.deepEqual(runScenario(s, { ...OPTS, events }).violations, []);
});
const const3 = (ev, c) => showFromArrivals(ev, c).map((x) => ({ ...x, level: 3 }));
test('F-529: constant-3 shown mutation on a burstLevels 2 burst is reported', () => {
  const s = burstOf(2);
  const log = simulateClients(s, { seed: 1 });
  const mutated = const3(burstArrivals(log, 2), 30);
  assert.ok(mutated.length >= 30, 'mutated.length >= 30');
  const { violations } = runScenario(s, { ...OPTS, events: log, show: const3 });
  const expected = [
    ...mutated.map((x) => `burst2: shown: client ${x.id} level 3 at ${x.tMs}ms out of range 0..1`),
    ...Array.from({ length: 30 }, (_, id) => `burst2: client ${id}: levels arrived but never shown`),
  ].sort();
  assert.deepEqual([...violations].sort(), expected);
});
test('F-529: constant-3 shown mutation, level 3 inside the scenario range but never arrived', () => {
  // burstLevels 2 arrivals only, judged by a 4-level scenario: the shown level 3 is in range yet never arrived
  const log = simulateClients(burstOf(2), { seed: 1 }).filter((e) => e.kind !== 'level' || e.level < 2);
  const mutated = const3(burstArrivals(log, 4), 30);
  const { violations } = runScenario(burstOf(4), { ...OPTS, events: log, show: const3 });
  
  assert.ok(mutated.length >= 30, 'mutated.length >= 30');
  for (const x of mutated) assert.ok(violations.includes(`burst4: client ${x.id}: level 3 at ${x.tMs}ms never arrived`), `client ${x.id}`);
});

// ---- F-535 / F-537: 소수 durationS, 대량 위반, slow_link 표시 ----
const shortPath = [{ t: 0, e: 0, n: 0, u: 100 }, { t: 0.4, e: 1, n: 0, u: 100 }];
test('F-535 / F-541: fractional durationS (1.5, 0.5) has 0 violations, ceil(durationS) samples, last tS = durationS', () => {
  const r15 = runScenario({ ...steady, name: 'steady1_5', durationS: 1.5, clients: 5, path: shortPath }, OPTS);
  assert.deepEqual(r15.violations, []);
  assert.deepEqual(r15.serverSamples.map((x) => x.tS), [1, 1.5]);
  const r05 = runScenario({ ...steady, name: 'steady0_5', durationS: 0.5, clients: 5, path: shortPath }, OPTS);
  assert.deepEqual(r05.violations, []);
  assert.deepEqual(r05.serverSamples.map((x) => x.tS), [0.5]);
});
test('F-537: appendAll 은 대량(200000) 위반도 RangeError 없이 접두어를 붙여 덧붙인다', () => {
  const items = Array.from({ length: 200000 }, (_, i) => `v${i}`);
  const out = ['first'];
  assert.equal(appendAll(out, items, 'x: '), out);
  assert.equal(out.length, 200001);
  assert.deepEqual([out[0], out[1], out[200000]], ['first', 'x: v0', 'x: v199999']);
});
test('F-537: main prints the S5 exclusion note exactly once, in the slow_link report body only', () => {
  const lines = []; const log = console.log;
  console.log = (m) => lines.push(String(m));
  try { assert.equal(main(mkdtempSync(join(tmpdir(), 'load-')), OPTS), 0); } finally { console.log = log; }
  const headings = lines.flatMap((l) => l.split('\n')).filter((l) => l.startsWith('## '));
  assert.deepEqual(headings, ['## steady30', '## burst30', '## slow30']);
  assert.equal(lines.join('\n').split('S5 threshold-excluded scenario').length - 1, 1);
});

// ---- F-538: statsClock handling ----
const zeroCpu = () => ({ user: 0, system: 0 });
test('F-538: default run samples a stub CPU on the simulated clock', () => {
  const { violations, serverSamples } = runScenario(steady, OPTS);
  assert.deepEqual(violations, []);
  assert.equal(serverSamples.length, 60);
  assert.deepEqual(serverSamples.at(-1).tS, 60);
  for (const x of serverSamples) {
    assert.equal(x.cpuPct, null);
    assert.equal(x.cpuSource, 'stub');
    assert.equal(x.source, 'simulated');
    assert.equal(x.clock, 'simulated');
  }
});
test('F-538: statsClock with cpuUsage but no now throws', () => {
  assert.throws(() => runScenario(SCENARIOS[0], { commit: '0000000', statsClock: { cpuUsage: () => process.cpuUsage() } }),
    { message: 'runScenario: statsClock must provide both now and cpuUsage, or neither' });
});
test('F-538: statsClock with now but no cpuUsage throws', () => {
  assert.throws(() => runScenario(steady, { ...OPTS, statsClock: { now: () => 0 } }),
    { message: 'runScenario: statsClock must provide both now and cpuUsage, or neither' });
});
test('F-538: source/clock overrides without now and cpuUsage throw', () => {
  assert.throws(() => runScenario(steady, { ...OPTS, statsClock: { source: 'server-process', clock: 'real' } }),
    { message: 'runScenario: statsClock overrides (source, clock, memoryUsage, cpuStub) need both now and cpuUsage' });
  assert.throws(() => runScenario(steady, { ...OPTS, statsClock: { source: 'server-process' } }),
    { message: 'runScenario: statsClock overrides (source, clock, memoryUsage, cpuStub) need both now and cpuUsage' });
});
test('F-538: unknown statsClock keys throw', () => {
  assert.throws(() => runScenario(steady, { ...OPTS, statsClock: { now: () => 0, cpuUsage: zeroCpu, nowMs: 1 } }),
    { message: 'runScenario: statsClock has unknown key nowMs' });
});
test('F-538: now returning Infinity yields no non-finite tS sample and a missing-sample violation', () => {
  const { violations, serverSamples } = runScenario(steady, { ...OPTS, statsClock: { clock: 'simulated', now: () => Infinity, cpuUsage: zeroCpu } });
  assert.ok(serverSamples.every((x) => Number.isFinite(x.tS)));
  assert.deepEqual(violations, ['steady30: server samples: 0 samples, expected 60']);
});
test('F-538: injected now and cpuUsage give measured samples', () => {
  let t = 0;
  const { violations, serverSamples } = runScenario(steady, { ...OPTS, statsClock: { clock: 'simulated', now: () => (t += 1000), cpuUsage: zeroCpu } });
  assert.deepEqual(violations, []);
  assert.deepEqual(serverSamples.map((x) => x.tS).slice(0, 3), [1, 2, 3]);
  assert.ok(serverSamples.every((x) => x.cpuPct === 0 && x.cpuSource === 'simulated' && x.clock === 'simulated'));
});

// ---- F-539: injected event logs are checked first, stats throws become violations ----
test('F-539: a bad injected log returns its violations without running stats', () => {
  const events = [...baseSteady(), { id: 99, tMs: 1e9, kind: 'connect' }];
  const r = runScenario(steady, { ...OPTS, events });
  assert.deepEqual(r.violations, [`steady30: event ${events.length - 1}: bad id`]);
  assert.deepEqual(r.result, { scenario: steady, records: [], perClient: [] });
  assert.deepEqual(r.serverSamples, []);
});
test('F-539: a non-array injected log is a violation, not a throw', () => {
  for (const events of [null, 'nope', { length: 1 }]) {
    assert.deepEqual(runScenario(steady, { ...OPTS, events }).violations, ['steady30: event log: not an array']);
  }
});
test('F-539: a valid log a stats function rejects becomes a bad-event-log violation', () => {
  const events = [...baseSteady(), { id: 0, tMs: 61000, kind: 'bytes', bytes: 1, latencyMs: 1 }];
  const r = runScenario(steady, { ...OPTS, events });
  assert.deepEqual(r.violations, ['steady30: bytes event 330: bad tMs']);
});
test('F-539: a throwing show in a burst run becomes a violation', () => {
  const show = () => { throw new Error('boom'); };
  assert.deepEqual(runScenario(SCENARIOS[1], { ...OPTS, show }).violations, ['burst30: bad event log: boom']);
});
test('F-539: shipped scenarios keep 0 violations with their own log injected', () => {
  for (const s of SCENARIOS.filter((x) => x.kind !== 'slow_link')) {
    assert.deepEqual(runScenario(s, { ...OPTS, events: simulateClients(s, { seed: 1 }) }).violations, [], s.name);
  }
});

// ---- F-542: huge violation counts go through appendAll (no spread push) ----
const HUGE = 250000;
const hugeShow = () => Array.from({ length: HUGE }, () => ({ id: 0, tMs: 0, level: 9 }));
test('F-542: runScenario carries more than 200000 violations without RangeError', () => {
  const { violations } = runScenario(SCENARIOS[1], { ...OPTS, show: hugeShow });
  assert.equal(violations.length, HUGE + 30);
  assert.equal(violations[0], 'burst30: shown: client 0 level 9 at 0ms out of range 0..3');
  assert.equal(violations[HUGE - 1], 'burst30: shown: client 0 level 9 at 0ms out of range 0..3');
  assert.equal(violations[HUGE], 'burst30: client 0: levels arrived but never shown');
});
test('F-542: main reports more than 200000 violations without RangeError', () => {
  let n = 0; const err = console.error; const log = console.log;
  console.error = () => { n++; }; console.log = () => {};
  try { assert.equal(main(mkdtempSync(join(tmpdir(), 'load-')), { ...OPTS, show: hugeShow }), 1); } finally { console.error = err; console.log = log; }
  assert.equal(n, HUGE + 30);
});
test('F-542: run.mjs never spreads into push', () => {
  const src = readFileSync(new URL('./run.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\.push\(\s*\.\.\./);
});

// ---- F-543 / F-546 / F-547 / F-548 ----
test('F-543: statsClock needs an explicit clock; source/clock are not pre-filled', () => {
  const msg = "runScenario: statsClock.clock must be 'simulated' or 'real'";
  assert.throws(() => runScenario(steady, { ...OPTS, statsClock: { now: () => 0, cpuUsage: zeroCpu } }), { message: msg });
  assert.throws(() => runScenario(steady, { ...OPTS, statsClock: { now: () => 0, cpuUsage: zeroCpu, clock: 'fake' } }), { message: msg });
  let t = 0;
  const r = runScenario(steady, { ...OPTS, statsClock: { clock: 'real', now: () => (t += 1000), cpuUsage: zeroCpu } });
  assert.ok(r.serverSamples.length > 0);
  for (const x of r.serverSamples) { assert.equal(x.clock, 'real'); assert.equal(x.source, 'harness-process'); }
  t = 0;
  const sim = runScenario(steady, { ...OPTS, statsClock: { clock: 'simulated', now: () => (t += 1000), cpuUsage: zeroCpu } });
  for (const x of sim.serverSamples) { assert.equal(x.clock, 'simulated'); assert.equal(x.source, 'simulated'); }
});
test('F-543: a real clock advancing 1 s per call has 0 violations', () => {
  let t = 0;
  const { violations, serverSamples } = runScenario(steady, { ...OPTS, statsClock: { clock: 'real', now: () => t++ * 1000, cpuUsage: zeroCpu } });
  assert.equal(serverSamples.length, 60);
  assert.deepEqual(violations, []);
});
test('F-543: a real clock that finishes in milliseconds violates the durationS rule ', () => {
  const { violations } = runScenario(steady, { ...OPTS, statsClock: { clock: 'real', now: () => performance.now(), cpuUsage: () => process.cpuUsage() } });
  assert.ok(violations.some((v) => v.startsWith('steady30: server sample')), violations.join('\n'));
});

test('F-546: a log with only a duplicate connect reports it (exact string)', () => {
  const one = { ...steady, clients: 1 };
  const events = [{ id: 0, tMs: 0, kind: 'connect' }, { id: 0, tMs: 1, kind: 'connect' }];
  const { violations } = runScenario(one, { ...OPTS, events });
  assert.ok(violations.includes('steady30: client 0: duplicate connect'), violations.join('\n'));
});
test('F-546: durationS 1.2 gives ticks [1, 1.2]', () => {
  const r = runScenario({ ...steady, name: 'steady1_2', durationS: 1.2, clients: 5, path: shortPath }, OPTS);
  assert.deepEqual(r.violations, []);
  assert.deepEqual(r.serverSamples.map((x) => x.tS), [1, 1.2]);
});
test('F-546: durationS 0 is rejected by the scenario check before any stats run', () => {
  const { violations } = runScenario({ ...steady, durationS: 0 }, { ...OPTS, events: baseSteady() });
  assert.deepEqual(violations, ['steady30: bad durationS', 'steady30: path ends after durationS']);
});
// Each stats function throws only while it is the running one (detected through the stack), so every run() guard is exercised.
function throwingLog(fnName) {
  const base = baseSteady();
  const trap = (v) => (key) => ({ enumerable: true, configurable: true, get() {
    if (new Error().stack.split('\n').some((l) => l.includes(`at ${fnName} `) || l.includes(`at ${fnName}.`))) throw new Error(`boom ${fnName}`);
    return v[key];
  } });
  const wrapped = base.map((e) => { const o = {}; for (const k of Object.keys(e)) Object.defineProperty(o, k, trap(e)(k)); return o; });
  return wrapped;
}
for (const [fn, sc] of [['firstFrameStats', steady], ['bandwidthStats', steady], ['countOpenConnections', steady], ['connectionViolations', steady],
  ['unreachableClients', steady], ['perClientFromEvents', steady], ['burstArrivals', SCENARIOS[1]]]) {
  test(`F-546: ${fn} throwing becomes a bad-event-log violation`, () => {
    const events = throwingLog(fn);
    const log = sc.kind === 'burst' ? (() => { const b = simulateClients(sc, { seed: 1 }); return b.map((e) => { const o = {}; for (const k of Object.keys(e)) Object.defineProperty(o, k, { enumerable: true, configurable: true, get() { if (new Error().stack.includes(`at ${fn} `)) throw new Error(`boom ${fn}`); return e[k]; } }); return o; }); })() : events;
    const { violations } = runScenario(sc, { ...OPTS, events: log });
    assert.ok(violations.includes(`${sc.name}: bad event log: boom ${fn}`), `${fn}: ${violations.join('\n')}`);
  });
}

test('F-547: a huge clients count is rejected fast by the scenario check', () => {
  const t0 = Date.now();
  const a = runScenario({ ...SCENARIOS[0], clients: 1e9 }, { ...OPTS, events: [] });
  const b = runScenario({ ...SCENARIOS[0], clients: 1e9 }, OPTS);
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(a.violations, ['steady30: bad clients']);
  assert.deepEqual(b.violations, ['steady30: bad clients']);
  assert.deepEqual(a.result.records, []);
});
test('F-548: null memoryUsage / cpuUsage becomes a server stats violation, not a TypeError', () => {
  let t = 0;
  const mem = runScenario(steady, { ...OPTS, statsClock: { clock: 'simulated', now: () => (t += 1000), cpuUsage: zeroCpu, memoryUsage: () => null } });
  assert.deepEqual(mem.violations, ['steady30: server samples: 0 samples, expected 60']);
  let n = 0;
  const cpu = runScenario(steady, { ...OPTS, statsClock: { clock: 'simulated', now: () => (t += 1000), cpuUsage: () => (n++ === 0 ? zeroCpu() : null) } });
  assert.deepEqual(cpu.violations, ['steady30: server samples: 0 samples, expected 60']);
});
test('F-548: runScenario(null / undefined) throws a clear error', () => {
  for (const s of [null, undefined]) assert.throws(() => runScenario(s), { message: 'runScenario: scenario must be an object' });
});
test('F-543: main passes the server samples to loadReport (cpu/rss line follows the samples, source line follows the records)', () => {
  const lines = []; const log = console.log;
  console.log = (m) => lines.push(String(m));
  let t = 0;
  const statsClock = { clock: 'simulated', source: 'server-process', now: () => (t += 1000), cpuUsage: zeroCpu };
  try { assert.equal(main(mkdtempSync(join(tmpdir(), 'load-')), { ...OPTS, statsClock }), 0); } finally { console.log = log; }
  assert.equal(lines.join('\n').split('cpu/rss source: server-process').length - 1, 3);
  assert.ok(!lines.join('\n').includes('measured on'));  // simulated clock: no measured claim
  assert.equal(lines.join('\n').split('source: simulated, S5/S8 verdict [local]').length - 1, 3);
});
test('F-553: runScenario(S, null) throws a clear opts error; undefined opts keeps the defaults', () => {
  assert.throws(() => runScenario(steady, null), { message: 'runScenario: opts must be an object' });
  assert.throws(() => runScenario(steady, 5), { message: 'runScenario: opts must be an object' });
  assert.throws(() => runScenario(steady, []), { message: 'runScenario: opts must be an object' });
  const r = runScenario(steady, undefined);
  assert.deepEqual(r.violations, []);
  assert.equal(r.serverSamples.length, 60);
});
test('F-553: a throwing cpuUsage becomes exactly one server stats violation with no samples', () => {
  let t = 0;
  const { violations, serverSamples } = runScenario(steady, { ...OPTS, statsClock: { clock: 'simulated', now: () => (t += 1000), cpuUsage: () => { throw new Error('cpu gone'); } } });
  assert.deepEqual(violations, ['steady30: server stats: cpu gone']);
  assert.deepEqual(serverSamples, []);
});
test('F-553: a cpuUsage that always returns null reports the exact sample shortfall', () => {
  let t = 0;
  const { violations } = runScenario(steady, { ...OPTS, statsClock: { clock: 'simulated', now: () => (t += 1000), cpuUsage: () => null } });
  assert.deepEqual(violations, ['steady30: server samples: 0 samples, expected 60']);
});
test('F-560: a null first cpuUsage (baseline) is skipped, not a TypeError; the shortfall is reported once', () => {
  let t = 0; let n = 0;
  const { violations, serverSamples } = runScenario(steady, { ...OPTS, statsClock: { clock: 'simulated', now: () => (t += 1000), cpuUsage: () => (n++ === 0 ? null : zeroCpu()) } });
  assert.equal(serverSamples.length, 59);
  assert.deepEqual(violations, ['steady30: server samples: 59 samples, expected 60']);
});
test('F-560: a real-clock sample shortfall has one wording, reported once', () => {
  let t = 0;
  const { violations } = runScenario(steady, { ...OPTS, statsClock: { clock: 'real', source: 'server-process', now: () => (t += 1000), cpuUsage: () => null } });
  assert.deepEqual(violations, ['steady30: server samples: 0 samples, expected 60']);
});
test('F-558: default SCENARIOS give no violations and 60 samples each', () => {
  for (const s of SCENARIOS) {
    const r = runScenario(s, OPTS);
    assert.deepEqual(r.violations, [], s.name);
    assert.equal(r.serverSamples.length, 60, s.name);
  }
});
