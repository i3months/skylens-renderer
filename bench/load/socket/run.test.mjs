import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateResult } from '../../../contracts/load/index.mjs';
import { createStatsSampler } from '../server_stats/index.mjs';
import { runSocketLoad, main, socketScenario, SOCKET_METHOD } from './run.mjs';

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
      createProcSampler({ pid, now }) {
        calls.samplerArgs = { pid };
        return createStatsSampler({
          clock: 'real', source: 'server-process', now,
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
