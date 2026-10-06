// Server CPU/memory sampler for the load harness (T16.2). Clock and usage sources are injected.
// tS is the real elapsed time since creation; no nominal interval is used or reported.
// cpuPct is total CPU time over wall time, so a fully busy 2-core process reads 200.
// Samples carry `source` and `clock` labels. `clock` ('simulated' | 'real') is a required explicit
// argument, never inferred from whether `now` was injected. A simulated clock needs both `now` and
// `cpuUsage` injected (against the real process.cpuUsage it would fabricate a CPU figure that looks
// like measurement) and defaults source to 'simulated'; a real clock defaults source to
// 'harness-process' (a real server run passes 'server-process'). A real clock with only one of
// `now`/`cpuUsage` injected is refused as well.
export function createStatsSampler({
  cpuUsage: cpuIn,
  memoryUsage = () => process.memoryUsage(),
  now: nowIn,
  clock,
  source,
} = {}) {
  if (clock !== 'simulated' && clock !== 'real') throw new Error("createStatsSampler: clock must be 'simulated' or 'real'");
  if (clock === 'simulated' && !(cpuIn && nowIn)) throw new Error('createStatsSampler: a simulated clock needs both now and cpuUsage injected');
  source ??= clock === 'simulated' ? 'simulated' : 'harness-process';
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
