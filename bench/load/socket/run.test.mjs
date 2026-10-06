import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateResult } from '../../../contracts/load/index.mjs';
import { createStatsSampler } from '../server_stats/index.mjs';
import { runSocketLoad, main, socketScenario, tickOnRealClock, SOCKET_METHOD } from './run.mjs';

const COMMIT = 'abc1234';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fake client log: every client connects at 0, gets one level payload, and closes at durationS
// (earlyCloseId closes at 500 ms instead, so only clients - 1 connections stay open).
function fakeLog(clients, durationS, earlyCloseId) {
  const ev = [];
  for (let id = 0; id < clients; id++) ev.push({ id, tMs: 0, kind: 'connect' });
  for (let id = 0; id < clients; id++) {
    const t = 100 + id;
    ev.push({ id, tMs: t, kind: 'bytes', bytes: 2048, latencyMs: t });
    ev.push({ id, tMs: t, kind: 'level', level: 0 });
    ev.push({ id, tMs: t, kind: 'first_frame' });
  }
  if (earlyCloseId !== undefined) ev.push({ id: earlyCloseId, tMs: 500, kind: 'close' });
  for (let id = 0; id < clients; id++) if (id !== earlyCloseId) ev.push({ id, tMs: durationS * 1000, kind: 'close' });
  return ev.sort((a, b) => a.tMs - b.tMs || a.id - b.id);
}

function fakeDeps({ earlyCloseId } = {}) {
  const calls = { started: 0, stopped: 0, clientArgs: null, samplerArgs: null };
  return {
    calls,
    deps: {
      async startServerProcess(opts) { calls.started++; calls.startOpts = opts; return { port: 0, pid: 4242, async stop() { calls.stopped++; } }; },
      async runSocketClients(args) {
        calls.clientArgs = args;
        await sleep(args.durationS * 1000);
        return fakeLog(args.clients, args.durationS, earlyCloseId);
      },
      createProcSampler({ pid, now, t0 }) {
        calls.samplerArgs = { pid, t0 };
        return createStatsSampler({
          clock: 'real', source: 'server-process', now, t0,
          cpuUsage: () => ({ user: 1000, system: 0 }), memoryUsage: () => ({ rss: 50 * 1048576 }),
        });
      },
    },
  };
}

test('socketScenario clips the path to durationS and is a valid scenario', () => {
  assert.equal(socketScenario(30, 2).path.at(-1).t, 2);
  assert.equal(socketScenario(30, 60).path.at(-1).t, 30);
});

test('runSocketLoad with fakes: valid result, real-clock samples, no violations', async () => {
  const { deps, calls } = fakeDeps();
  const out = await runSocketLoad({ clients: 30, durationS: 2, commit: COMMIT, deps });
  assert.deepEqual(out.violations, []);
  assert.deepEqual(validateResult(out.result), []);
  assert.equal(out.result.scenario.name, 'socket30');
  assert.ok(out.result.records.every((r) => r.method === SOCKET_METHOD && r.commit === COMMIT));
  assert.equal(out.serverSamples.length, 2);
  assert.ok(out.serverSamples.every((s) => s.source === 'server-process' && s.clock === 'real'));
  assert.ok(Math.abs(out.serverSamples[1].tS - 2) <= 0.25);
  assert.match(out.report, /server-process/);
  assert.match(out.report, new RegExp(`source: ${SOCKET_METHOD}`));
  assert.equal(calls.started, 1);
  assert.equal(calls.stopped, 1);
  assert.equal(calls.samplerArgs.pid, 4242);
  assert.equal(calls.clientArgs.port, 0);
  assert.equal(calls.clientArgs.clients, 30);
});

test('runSocketLoad flags a run where only 29 of 30 connections stay open', async () => {
  const { deps } = fakeDeps({ earlyCloseId: 7 });
  const out = await runSocketLoad({ clients: 30, durationS: 2, commit: COMMIT, deps });
  assert.ok(out.violations.includes('socket30: open connections dropped to 29 of 30'), out.violations.join('\n'));
});

test('runSocketLoad stops the server and reports a client failure', async () => {
  const { deps, calls } = fakeDeps();
  deps.runSocketClients = async () => { throw new Error('boom'); };
  const out = await runSocketLoad({ clients: 30, durationS: 1, commit: COMMIT, deps });
  assert.equal(calls.stopped, 1);
  assert.ok(out.violations.includes('socket30: clients: boom'));
  assert.equal(out.report, null);
});

test('runSocketLoad rejects bad durationS / clients before starting a server', async () => {
  for (const bad of [{ durationS: NaN }, { durationS: 0 }, { durationS: Infinity }, { durationS: -1 }, { clients: 0 }, { clients: 1.5 }, { clients: NaN }]) {
    const { deps, calls } = fakeDeps();
    const t0 = Date.now();
    await assert.rejects(runSocketLoad({ commit: COMMIT, deps, ...bad }), RangeError, JSON.stringify(bad));
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(calls.started, 0);
  }
});

test('runSocketLoad with fakes and 5 clients', async () => {
  const { deps, calls } = fakeDeps();
  const out = await runSocketLoad({ clients: 5, durationS: 1, commit: COMMIT, deps });
  assert.deepEqual(out.violations, []);
  assert.equal(out.result.scenario.clients, 5);
  assert.equal(calls.clientArgs.clients, 5);
  assert.deepEqual(validateResult(out.result), []);
});

test('runSocketLoad with durationS 1.5 takes 2 samples, the last at 1.5 s', async () => {
  const { deps } = fakeDeps();
  const out = await runSocketLoad({ clients: 30, durationS: 1.5, commit: COMMIT, deps });
  assert.equal(out.serverSamples.length, 2);
  assert.ok(Math.abs(out.serverSamples.at(-1).tS - 1.5) <= 0.25, String(out.serverSamples.at(-1).tS));
});

test('a sampler that throws once (on the last tick) is reported with the socket30 prefix', async () => {
  const { deps } = fakeDeps();
  const make = deps.createProcSampler;
  deps.createProcSampler = (a) => {
    const s = make(a);
    let n = 0;
    return { samples: () => s.samples(), tick() { if (++n === 2) throw new Error('proc gone'); return s.tick(); } };
  };
  const out = await runSocketLoad({ clients: 30, durationS: 2, commit: COMMIT, deps });
  assert.ok(out.violations.includes('socket30: server stats: proc gone'), out.violations.join('\n'));
  assert.ok(out.violations.includes('socket30: server samples: 1 samples, expected 2'), out.violations.join('\n'));
  assert.ok(out.violations.every((v) => v.startsWith('socket30: ')));
});

test('real server process, real sockets and real proc sampler: 30 clients for 2 s', async () => {
  const pids = [];
  const { startServerProcess } = await import('./server_proc.mjs');
  const out = await runSocketLoad({
    clients: 30, durationS: 2, commit: COMMIT,
    deps: { startServerProcess: async (o) => { const p = await startServerProcess(o); pids.push(p.pid); return p; } },
  });
  assert.deepEqual(out.violations, []);
  assert.equal(out.serverSamples.length, 2);
  // The sampler shares run's t0: every tS sits on its target, early or late (getconf must not shift it).
  out.serverSamples.forEach((s, i) => assert.ok(Math.abs(s.tS - Math.min(i + 1, 2)) < 0.002, `tS[${i}] = ${s.tS}`));
  assert.equal(out.report.split('(handshake-complete basis, not an S5 value)').length - 1, 1, out.report);
  assert.match(out.report, /first_frame_p95.*\(handshake-complete basis, not an S5 value\)/);
  for (const s of out.serverSamples) {
    assert.equal(s.clock, 'real');
    assert.equal(s.source, 'server-process');
    assert.equal(s.cpuSource, 'measured');
  }
  assert.deepEqual(validateResult(out.result), []);
  assert.equal(out.result.scenario.clients, 30);
  assert.equal(pids.length, 1);
  assert.throws(() => process.kill(pids[0], 0));
});

test('main writes result, samples and report.md and returns 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'socket-run-'));
  try {
    const { deps } = fakeDeps();
    const code = await main(dir, '1', { commit: COMMIT, deps });
    assert.equal(code, 0);
    assert.deepEqual(validateResult(JSON.parse(readFileSync(join(dir, 'socket30.json'), 'utf8'))), []);
    assert.equal(JSON.parse(readFileSync(join(dir, 'socket30.server.json'), 'utf8')).length, 1);
    assert.match(readFileSync(join(dir, 'report.md'), 'utf8'), /server-process/);
    assert.equal(await main(dir, 'x', { commit: COMMIT, deps }), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('zero server samples names the likely cause: /proc not available (non-Linux?)', async () => {
  const { deps } = fakeDeps();
  deps.createProcSampler = () => ({ samples: () => [], tick() {} });
  const out = await runSocketLoad({ clients: 5, durationS: 1, commit: COMMIT, deps });
  assert.ok(out.violations.some((v) => v.startsWith('socket30: ') && v.includes('/proc not available (non-Linux?)')), out.violations.join('\n'));
  assert.equal(out.violations.filter((v) => v.includes('0 samples')).length, 1, out.violations.join('\n'));
});

test('tick times are anchored to the shared t0 despite late and early timer firings', async () => {
  let t = 5000;
  const now = () => t;
  const t0 = 4800; // not now(): ticks are measured from the t0 passed in
  const ticks = [];
  const lateness = [30, 0, 400, 0];
  let k = 0;
  const schedule = (fn, delay) => {
    // Fire 'late' by lateness[k], or 'early' by 10 ms on the 4th timer (re-check must re-arm it).
    const extra = lateness[k++] ?? 0;
    t += delay + extra - (k === 4 ? 10 : 0);
    fn();
  };
  const sampler = { tick() { ticks.push(t - t0); } };
  await tickOnRealClock(sampler, 3.5, now, (e) => { throw e; }, t0, schedule);
  // 4 ticks (ceil 3.5); tick 3 fired 400 ms late, so tick 4 (target 3500) is not pushed out further than its target.
  assert.equal(ticks.length, 4);
  assert.deepEqual(ticks.slice(0, 2), [1030, 2000]);
  assert.ok(ticks[2] >= 3000 && ticks[2] === 3400, String(ticks[2]));
  assert.ok(ticks[3] >= 3500, String(ticks[3]));
});

test('report states the cloud approximation and the literal loopback-socket method, not a device measurement', async () => {
  const { deps } = fakeDeps();
  const out = await runSocketLoad({ clients: 5, durationS: 1, commit: COMMIT, deps });
  assert.equal(SOCKET_METHOD, 'loopback-socket');
  assert.ok(out.report.includes('(cloud approximation)'), out.report);
  assert.ok(/first_frame_p95.*\(handshake-complete basis, not an S5 value\)/.test(out.report), out.report);
  assert.ok(out.report.includes('[local]'), out.report);
  assert.ok(!out.report.includes('measured on loopback-socket'), out.report);
  assert.ok(out.report.includes('loopback-socket'), out.report);
  assert.ok(out.result.records.every((r) => r.method === 'loopback-socket'));
});

// Injected clock at a non-zero origin; every timer fires exactly at its delay. createProcSampler advances the clock
// by 8 ms before it builds the sampler (the cost of getconf), which only a shared t0 can absorb.
function fakeClockDeps(extra = {}) {
  const clock = { t: 5000 };
  const { deps } = fakeDeps();
  const make = deps.createProcSampler;
  deps.runSocketClients = async (args) => fakeLog(args.clients, args.durationS);
  deps.createProcSampler = (a) => { clock.t += 8; return make(a); };
  deps.now = () => clock.t;
  deps.setTimeout = (fn, delay) => { clock.t += delay; fn(); };
  return { clock, deps: { ...deps, ...extra } };
}

test('runSocketLoad with an injected clock: serverSamples[i].tS === min(i + 1, durationS) exactly', async () => {
  const { deps, clock } = fakeClockDeps();
  const out = await runSocketLoad({ clients: 5, durationS: 2.5, commit: COMMIT, deps });
  assert.deepEqual(out.serverSamples.map((s) => s.tS), [1, 2, 2.5]);
  assert.equal(clock.t, 5000 + 2500);
});

test('runSocketLoad passes the t0 it ticks against to the sampler', async () => {
  const { deps } = fakeClockDeps();
  let seen;
  const make = deps.createProcSampler;
  deps.createProcSampler = (a) => { seen = a; return make(a); };
  await runSocketLoad({ clients: 5, durationS: 1, commit: COMMIT, deps });
  assert.equal(seen.t0, 5000);
});

test('tickOnRealClock with a stopped clock rejects with RangeError instead of re-arming forever', async () => {
  let calls = 0;
  const schedule = (fn) => { if (++calls > 100) throw new Error('re-armed forever'); fn(); };
  const ticks = [];
  await assert.rejects(tickOnRealClock({ tick() { ticks.push(1); } }, 2, () => 0, (e) => { throw e; }, 0, schedule), RangeError);
  assert.deepEqual(ticks, []);
  assert.ok(calls <= 3, String(calls));
});

test('runSocketLoad with a stopped injected clock ends and reports it', async () => {
  const { deps } = fakeClockDeps();
  deps.now = () => 0;
  deps.setTimeout = (fn) => { fn(); };
  const out = await runSocketLoad({ clients: 5, durationS: 2, commit: COMMIT, deps });
  assert.ok(out.violations.some((v) => v.startsWith('socket30: server stats: ') && v.includes('did not advance')), out.violations.join('\n'));
});

test('a timer 2500 ms late does not release a burst of back-to-back ticks', async () => {
  let t = 0;
  const now = () => t;
  const ticks = [];
  let k = 0;
  const schedule = (fn, delay) => { t += delay + (k++ === 0 ? 2500 : 0); fn(); };
  await tickOnRealClock({ tick() { ticks.push(t); } }, 4, now, (e) => { throw e; }, 0, schedule);
  assert.ok(ticks.length < 4, `${ticks}`);
  for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i] - ticks[i - 1] >= 500, `ticks ${ticks}`);
  assert.equal(ticks.at(-1), 4000);
});
