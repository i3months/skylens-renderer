// Server CPU/memory sampler for the load harness (T16.2). Clock and usage sources are injected.
// tS is the real elapsed time since creation; no nominal interval is used or reported.
// cpuPct is total CPU time over wall time, so a fully busy 2-core process reads 200.
// Samples carry `source` and `clock` labels. Defaults describe the mock: a harness process on a
// simulated clock. A real server run injects source 'server-process' and clock 'real'.
// A custom `now` and a custom `cpuUsage` must come together: a simulated clock against the real
// process.cpuUsage would fabricate a CPU figure that looks like measurement.
export function createStatsSampler({
  cpuUsage: cpuIn,
  memoryUsage = () => process.memoryUsage(),
  now: nowIn,
  source = 'harness-process',
  clock = nowIn ? 'simulated' : 'real',
} = {}) {
  if (Boolean(cpuIn) !== Boolean(nowIn)) throw new Error('createStatsSampler: inject both now and cpuUsage, or neither');
  const cpuUsage = cpuIn ?? (() => process.cpuUsage());
  const now = nowIn ?? (() => performance.now());
  const out = [];
  const t0 = now();
  let prevT = t0;
  let prevCpu = cpuUsage();
  return {
    tick() {
      const t = now();
      const wallUs = (t - prevT) * 1000;
      // Zero (or negative) elapsed time: skip the tick, keep the baseline so the next tick spans it.
      if (wallUs <= 0) return;
      const c = cpuUsage();
      const cpuUs = (c.user - prevCpu.user) + (c.system - prevCpu.system);
      const rssMiB = Math.round((memoryUsage().rss / 1048576) * 100) / 100;
      out.push({ tS: (t - t0) / 1000, cpuPct: (cpuUs / wallUs) * 100, rssMiB, source, clock });
      prevT = t; prevCpu = c;
    },
    samples() { return out.map((s) => ({ ...s })); },
  };
}

// Returns violation strings for samples that are not usable as evidence: non-finite values or missing labels.
export function checkServerSamples(samples) {
  const v = [];
  samples.forEach((s, i) => {
    for (const k of ['cpuPct', 'rssMiB']) if (!Number.isFinite(s[k])) v.push(`server sample ${i}: ${k} is not finite (${s[k]})`);
    for (const k of ['source', 'clock']) if (typeof s[k] !== 'string' || s[k] === '') v.push(`server sample ${i}: missing ${k}`);
  });
  return v;
}
