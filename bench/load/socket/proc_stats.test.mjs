import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseProcStat, readProcStats, createProcSampler } from './proc_stats.mjs';

test('parseProcStat handles comm with spaces and parens', () => {
  const line = '123 ((a b) c)) S 1 123 123 0 -1 4194560 100 0 0 0 250 70 0 0 20 0 1 0 5000 1000000 500 18446744073709551615';
  assert.deepEqual(parseProcStat(line), { utime: 250, stime: 70 });
  assert.equal(parseProcStat('garbage'), null);
  assert.equal(parseProcStat('1 (x) S 1 2'), null);
});

test('readProcStats of a dead pid is null', () => {
  assert.equal(readProcStats(2 ** 22 + 12345), null);
  assert.equal(readProcStats(-1), null);
});

test('readProcStats shows CPU growth and plausible rss for a busy child', async () => {
  const child = spawn(process.execPath, ['-e', 'const e=Date.now()+1200;while(Date.now()<e);setTimeout(()=>{},5000)'], { stdio: 'ignore' });
  try {
    await sleep(100);
    const sampler = createProcSampler({ pid: child.pid });
    const a = readProcStats(child.pid);
    await sleep(1000);
    const b = readProcStats(child.pid);
    sampler.tick();
    assert.ok(a && b);
    const cpu = (s) => s.cpuUsage.user + s.cpuUsage.system;
    assert.ok(cpu(b) > cpu(a), `cpu ${cpu(a)} -> ${cpu(b)}`);
    assert.ok(b.rssBytes > 5 * 1048576 && b.rssBytes < 4 * 1024 ** 3, `rss ${b.rssBytes}`);
    assert.equal(sampler.samples().length, 1);
    assert.equal(sampler.samples()[0].source, 'server-process');
  } finally {
    child.kill('SIGKILL');
  }
});
