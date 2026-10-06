import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseProcStat, readProcStats, createProcSampler } from './proc_stats.mjs';

test('parseProcStat handles comm with spaces and parens', () => {
  const line = '123 ((a b) c)) S 1 123 123 0 -1 4194560 100 0 0 0 250 70 0 0 20 0 1 0 5000 1000000 500 18446744073709551615';
  assert.deepEqual(parseProcStat(line), { utime: 250, stime: 70 });
  assert.equal(parseProcStat('garbage'), null);
  assert.equal(parseProcStat('1 (x) S 1 2'), null);
});

test('parseProcStat rejects negative and non-integer utime/stime', () => {
  const mk = (u, st) => `1 (x) S 1 1 1 0 -1 0 0 0 0 0 ${u} ${st} 0 0 20 0 1 0 5 1000 500`;
  assert.deepEqual(parseProcStat(mk(7, 8)), { utime: 7, stime: 8 });
  for (const [u, st] of [[-1, 5], [5, -1], [1.5, 5], [5, 2.5], ['abc', 5], [5, 'x']]) {
    assert.equal(parseProcStat(mk(u, st)), null, `${u} ${st}`);
  }
});

test('readProcStats of a dead pid is null', () => {
  assert.equal(readProcStats(2 ** 22 + 12345), null);
  assert.equal(readProcStats(-1), null);
});

test('readProcStats: busy child CPU delta in microseconds and rss plausible', async () => {
  const src = `const fs=require('fs');const e=Date.now()+1300;
const sm=fs.readFileSync('/proc/self/statm','utf8').trim().split(/\\s+/).map(Number);
console.log(JSON.stringify({rss:process.memoryUsage().rss,vszPages:sm[0],rssPages:sm[1]}));
while(Date.now()<e);setTimeout(()=>{},5000)`;
  const child = spawn(process.execPath, ['-e', src], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    let buf = '';
    const info = await new Promise((resolve, reject) => {
      child.stdout.on('data', (d) => { buf += d; if (buf.includes('\n')) resolve(JSON.parse(buf.split('\n')[0])); });
      child.on('error', reject);
      child.on('exit', () => reject(new Error('child exited early')));
    });
    const page = Number(execFileSync('getconf', ['PAGESIZE'], { encoding: 'utf8' }).trim());
    const sampler = createProcSampler({ pid: child.pid });
    await sleep(100);
    const a = readProcStats(child.pid);
    await sleep(1000);
    const b = readProcStats(child.pid);
    sampler.tick();
    assert.ok(a && b);
    const cpu = (s) => s.cpuUsage.user + s.cpuUsage.system;
    const delta = cpu(b) - cpu(a);
    assert.ok(delta >= 0.5e6 && delta <= 1.5e6, `cpu delta ${delta} us not in 0.5e6..1.5e6 for ~1 s busy`);
    const vszBytes = info.vszPages * page;
    assert.ok(b.rssBytes < vszBytes, `rss ${b.rssBytes} should be < vsz ${vszBytes}`);
    assert.ok(b.rssBytes >= 0.3 * info.rss && b.rssBytes <= 3 * info.rss, `rss ${b.rssBytes} vs child memoryUsage().rss ${info.rss}`);
    assert.equal(sampler.samples().length, 1);
    assert.equal(sampler.samples()[0].source, 'server-process');
  } finally {
    child.kill('SIGKILL');
  }
});

test('first sample tS is not delayed by getconf (fresh module instance)', async () => {
  const mod = await import('./proc_stats.mjs?fresh-getconf');
  let offset = 0;
  const now = () => performance.now() + offset;
  const sampler = mod.createProcSampler({ pid: process.pid, now });
  offset = 1000; // jump the injected clock exactly 1 s; only real time spent since creation shows up on top
  sampler.tick();
  const [s] = sampler.samples();
  assert.ok(s, 'tick produced a sample');
  assert.ok(s.tS - 1.0 < 0.002, `first tS ${s.tS} is ${((s.tS - 1) * 1000).toFixed(2)} ms late`);
});
