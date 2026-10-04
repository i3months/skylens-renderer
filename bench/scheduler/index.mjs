// Scheduler absolute-time bench (F-208). Not part of `npm test`: absolute times depend on the machine.
// Usage: node bench/scheduler/index.mjs
// Prints the best-of-N CPU time (user+system) against the targets and reports met/missed as measured.
// The targets (0.3 s for 100k ascending enqueue, 50 ms for 20k one-group enqueue) are report-only; the test suite
// asserts deterministic counts observed from the test side instead (server/scheduler/scheduler.test.mjs, F-221).
import os from 'node:os';
import { createScheduler } from '../../server/scheduler/index.mjs';

const cpuNow = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};
const perfKey = (i, extra = {}) => ({ segmentId: i, level: 0, lod: 0, chunkIndex: 0, tileX: 0, tileY: 0, ...extra });
const best = (n, fn) => Math.min(...Array.from({ length: n }, fn));

function ascending(n) {
  const s = createScheduler({ budgetBytesPerTick: 1e9, maxPending: Math.max(n, 100000) });
  const t0 = cpuNow();
  for (let i = 0; i < n; i++) if (!s.enqueue({ key: perfKey(i), bytes: 1, priority: i, level: 0 })) throw new Error('rejected');
  return cpuNow() - t0;
}
function oneGroup(n) {
  const s = createScheduler({ budgetBytesPerTick: 1e9 });
  const t0 = cpuNow();
  for (let i = 0; i < n; i++) if (!s.enqueue({ key: perfKey(1, { chunkIndex: i }), bytes: 1, priority: i % 7, level: 0 })) throw new Error('rejected');
  return cpuNow() - t0;
}

// F-213: per-replacement cost must not grow with maxSentGroups (report-only; was a timing assertion in the tests).
function replacements(cap, n) {
  const s = createScheduler({ budgetBytesPerTick: 1e9, maxSentGroups: cap });
  const t0 = cpuNow();
  for (let i = 0; i < n; i++) {
    s.enqueue({ key: perfKey(i), bytes: 1, priority: 0, level: 0 });
    s.nextBatch();
  }
  return cpuNow() - t0;
}

const cpus = os.cpus();
const load = os.loadavg();
console.log(`\n=== Scheduler benchmark (report-only, exit code always 0) ===`);
console.log(`node ${process.version}, ${os.platform()}/${os.arch()}, ${cpus.length} CPU cores (${cpus[0]?.model ?? 'unknown'}), load average ${load.map((x) => x.toFixed(2)).join(' / ')} (1/5/15 min)`);

const cases = [
  { name: '100k ascending enqueue', targetMs: 300, runs: 5, fn: () => ascending(100000) },
  { name: '20k one-group enqueue', targetMs: 50, runs: 5, fn: () => oneGroup(20000) },
];
let missed = 0;
for (const c of cases) {
  c.fn(); // warm-up
  const ms = best(c.runs, c.fn);
  const met = ms <= c.targetMs;
  if (!met) missed++;
  console.log(`${c.name}: ${ms.toFixed(1)} ms CPU (best of ${c.runs}), target ${c.targetMs} ms -> ${met ? 'MET' : 'MISSED'}`);
}
const N = 250000;
const small = best(3, () => replacements(1000, N));
const big = best(3, () => replacements(65536, N));
console.log(`${N} replacements: maxSentGroups 1000 ${(small / N * 1000).toFixed(2)} us/op, 65536 ${(big / N * 1000).toFixed(2)} us/op (x${(big / small).toFixed(2)}, info only)`);
console.log();
console.log(`Summary: ${missed === 0 ? 'all targets met' : `${missed} target(s) missed`}`);
console.log(`Note: Targets are report-only and do not affect exit code. The scheduler test suite (F-221) asserts deterministic counts instead.`);
console.log(`Load average after run: ${os.loadavg().map((x) => x.toFixed(2)).join(' / ')}`);
