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
  const cpuSource = cpuStub ? 'stub' : clock === 'simulated' ? 'simulated' : 'measured';
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
      const m = memoryUsage();
      // A usage source that returned null/undefined: skip the tick, keep the baseline.
      if (c === null || typeof c !== 'object' || m === null || typeof m !== 'object') return;
      // No usable CPU baseline yet (the creation-time cpuUsage returned null/undefined): this reading becomes
      // the baseline and the tick is skipped, since there is nothing to measure CPU time against.
      // Non-numeric cpu/rss fields (e.g. memoryUsage() => {}): skip the tick like a null source, keep the baseline.
      if (typeof c.user !== 'number' || typeof c.system !== 'number' || typeof m.rss !== 'number') return;
      if (prevCpu === null || typeof prevCpu !== 'object' || typeof prevCpu.user !== 'number' || typeof prevCpu.system !== 'number') { prevT = t; prevCpu = c; return; }
      const cpuUs = (c.user - prevCpu.user) + (c.system - prevCpu.system);
      const rssMiB = Math.round((m.rss / 1048576) * 100) / 100;
      const cpuPct = cpuStub ? null : (cpuUs / wallUs) * 100;
      out.push({ tS: (t - t0) / 1000, cpuPct, rssMiB, source, clock, cpuSource });
      prevT = t; prevCpu = c;
    },
    samples() { return out.map((s) => ({ ...s })); },
  };
}

// Returns violation strings for samples that are not usable as evidence. Never throws on bad input.
// cpuPct must be finite and >= 0, except for stub samples (cpuSource 'stub') where it must be exactly null.
// cpuSource is 'measured' | 'stub' | 'simulated'; 'measured' needs a real clock, 'simulated' a simulated one.
// durationS option: if the key is present it must be a finite positive number (else a violation).
// Count check (whenever durationS is given, for any clock, also for an empty array): count == ceil(durationS).
// Mixed clock or source is a violation.
// Real-clock timing checks (only when every sample is an object with clock 'real'):
//   first tS within min(1, durationS) +- 0.5; last tS within durationS +- 0.25 (real timers wake late, so the
//   late side gets the same width as the early side; extra samples are still caught by the count check);
//   every interval incl. the first is 0.5..1.5 s, except the last interval of a run, which is the final
//   bucket width (durationS - (ceil(durationS) - 1)) +- 0.5.
//   A correct run ticks at min(i, durationS) for i = 1..ceil(durationS).
// Limit: a fake `now` passed with clock 'real' produces samples indistinguishable from a real clock, so
// this check cannot detect it; the clock label is trusted evidence of the caller, not proof.
export function checkServerSamples(samples, opts) {
  if (!Array.isArray(samples)) return ['server samples: not an array'];
  const v = [];
  const hasDur = opts !== null && typeof opts === 'object' && 'durationS' in opts;
  const durationS = hasDur ? opts.durationS : undefined;
  let prevT = -Infinity;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (s === null || typeof s !== 'object') { v.push(`server sample ${i}: not an object`); continue; }
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
    if (s.cpuSource !== 'measured' && s.cpuSource !== 'stub' && s.cpuSource !== 'simulated') v.push(`server sample ${i}: bad cpuSource`);
    else if (s.cpuSource === 'measured' && s.clock === 'simulated') v.push(`server sample ${i}: measured cpu with simulated clock`);
    else if (s.cpuSource === 'simulated' && s.clock === 'real') v.push(`server sample ${i}: simulated cpu with real clock`);
  }
  if (hasDur && !(Number.isFinite(durationS) && durationS > 0)) {
    v.push(`server samples: durationS must be a finite positive number (${String(durationS)})`);
    return v;
  }
  const objs = samples.filter((s) => s !== null && typeof s === 'object');
  if (objs.length > 0 && !objs.every((s) => s.clock === objs[0].clock)) v.push('server samples: mixed clock');
  if (objs.length > 0 && !objs.every((s) => s.source === objs[0].source)) v.push('server samples: mixed source');
  if (!hasDur) return v;
  const n = samples.length;
  const expected = Math.ceil(durationS);
  if (n !== expected) v.push(`server samples: ${n} samples, expected ${expected}`);
  if (objs.length === n && n > 0 && samples.every((s) => s.clock === 'real')) {
    const E = 1e-9;
    if (samples.every((s) => Number.isFinite(s.tS))) {
      const first = samples[0].tS;
      const want = Math.min(1, durationS);
      if (Math.abs(first - want) > 0.5 + E) v.push(`server sample 0: first tS ${first} is not within 0.5 s of ${want}`);
      const last = samples[n - 1].tS;
      if (Math.abs(last - durationS) > 0.25 + E) v.push(`server samples: last tS ${last} is not within 0.25 s of durationS ${durationS}`);
      for (let i = 1; i < n; i++) {
        const d = samples[i].tS - samples[i - 1].tS;
        const isLast = i === n - 1;
        const mid = isLast ? durationS - (expected - 1) : 1;
        const lo = isLast ? Math.max(0, mid - 0.5) : 0.5;
        const hi = isLast ? mid + 0.5 : 1.5;
        if (d < lo - E || d > hi + E) v.push(`server sample ${i}: interval ${d} s outside ${lo}..${hi}`);
      }
    }
  }
  return v;
}
