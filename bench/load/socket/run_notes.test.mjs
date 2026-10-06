import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStatsSampler } from '../server_stats/index.mjs';
import { main, tickOnRealClock } from './run.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('tickOnRealClock rejects with RangeError (never throws synchronously) for NaN and Infinity durationS', { timeout: 10000 }, async () => {
  const sampler = { tick() {} };
  const now = () => 0;
  for (const durationS of [NaN, Infinity]) {
    // A schedule limited to a few calls: if validation is missing, the call re-arms until the limit and the test
    // fails with a clear message instead of re-arming a 1 ms timer forever.
    const LIMIT = 5;
    let calls = 0;
    let exhausted;
    const limitHit = new Promise((_, rej) => { exhausted = () => rej(new assert.AssertionError({ message: `tickOnRealClock(${durationS}) did not reject; it scheduled ${LIMIT} timers (validation missing)` })); });
    limitHit.catch(() => {});
    const schedule = (fn) => {
      calls += 1;
      if (calls >= LIMIT) { exhausted(); return; }
      queueMicrotask(fn);
    };
    let call;
    try { call = tickOnRealClock(sampler, durationS, now, () => {}, 0, schedule); } catch (e) { assert.fail(`threw synchronously: ${e}`); }
    await assert.rejects(Promise.race([call, limitHit]), RangeError, `durationS=${durationS}`);
  }
});

test('main prints each note to stderr as `NOTE <text>`', { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'socket-notes-'));
  try {
    const clients = 5;
    const durationS = 4;
    const deps = {
      async startServerProcess() { return { port: 0, pid: 4242, async stop() {} }; },
      async runSocketClients() {
        await sleep(durationS * 1000);
        const ev = [];
        for (let id = 0; id < clients; id++) {
          ev.push({ id, tMs: 0, kind: 'connect' });
          ev.push({ id, tMs: 3500, kind: 'bytes', bytes: 2048, latencyMs: 3500 });
          ev.push({ id, tMs: 3500, kind: 'level', level: 0 });
          ev.push({ id, tMs: 3500, kind: 'first_frame' });
          ev.push({ id, tMs: durationS * 1000, kind: 'close' });
        }
        return ev.sort((a, b) => a.tMs - b.tMs || a.id - b.id);
      },
      createProcSampler({ now, t0 }) {
        return createStatsSampler({
          clock: 'real', source: 'server-process', now, t0,
          cpuUsage: () => ({ user: 1000, system: 0 }), memoryUsage: () => ({ rss: 50 * 1048576 }),
        });
      },
    };
    const out = [];
    await main(dir, String(durationS), { clients, commit: 'abc1234', deps }, (s) => out.push(s));
    const lines = out.join('').split('\n').filter((l) => l.startsWith('NOTE '));
    assert.ok(lines.length >= 1, out.join(''));
    assert.ok(lines.some((l) => /first-frame p95/.test(l)), lines.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
