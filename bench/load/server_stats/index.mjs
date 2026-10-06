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
  cpuStub = false,
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
      // Zero, negative or non-finite elapsed time: skip the tick, keep the baseline so the next tick spans it.
      if (!(wallUs > 0 && Number.isFinite(wallUs))) return;
      const c = cpuUsage();
      const cpuUs = (c.user - prevCpu.user) + (c.system - prevCpu.system);
      const rssMiB = Math.round((memoryUsage().rss / 1048576) * 100) / 100;
      const cpuPct = cpuStub ? null : (cpuUs / wallUs) * 100;
      out.push({ tS: (t - t0) / 1000, cpuPct, rssMiB, source, clock, cpuSource: cpuStub ? 'stub' : 'measured' });
      prevT = t; prevCpu = c;
    },
    samples() { return out.map((s) => ({ ...s })); },
  };
}

// Returns violation strings for samples that are not usable as evidence. Never throws on bad input.
// cpuPct must be finite and >= 0, except for stub samples (cpuSource 'stub') where it must be exactly null.
export function checkServerSamples(samples) {
  if (!Array.isArray(samples)) return ['server samples: not an array'];
  const v = [];
  let prevT = -Infinity;
  samples.forEach((s, i) => {
    if (s === null || typeof s !== 'object') { v.push(`server sample ${i}: not an object`); return; }
    if (!Number.isFinite(s.tS)) v.push(`server sample ${i}: tS is not finite (${s.tS})`);
    else {
      if (s.tS < 0) v.push(`server sample ${i}: tS is negative (${s.tS})`);
      if (s.tS <= prevT) v.push(`server sample ${i}: tS not increasing`);
      prevT = s.tS;
    }
    if (s.cpuSource === 'stub') {
      if (s.cpuPct !== null) v.push(`server sample ${i}: cpuPct must be null for stub (${s.cpuPct})`);
    } else if (!Number.isFinite(s.cpuPct)) v.push(`server sample ${i}: cpuPct is not finite (${s.cpuPct})`);
    else if (s.cpuPct < 0) v.push(`server sample ${i}: cpuPct is negative (${s.cpuPct})`);
    if (!Number.isFinite(s.rssMiB)) v.push(`server sample ${i}: rssMiB is not finite (${s.rssMiB})`);
    else if (s.rssMiB < 0) v.push(`server sample ${i}: rssMiB is negative (${s.rssMiB})`);
    for (const k of ['source', 'clock']) if (typeof s[k] !== 'string' || s[k] === '') v.push(`server sample ${i}: missing ${k}`);
    if (s.cpuSource !== 'measured' && s.cpuSource !== 'stub') v.push(`server sample ${i}: bad cpuSource`);
  });
  return v;
}
