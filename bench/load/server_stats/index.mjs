// Server CPU/memory sampler for the load harness (T16.2). Clock and usage sources are injected.
// tS is the real elapsed time since creation; no nominal interval is used or reported.
// cpuPct is total CPU time over wall time, so a fully busy 2-core process reads 200.
export function createStatsSampler({
  cpuUsage = () => process.cpuUsage(),
  memoryUsage = () => process.memoryUsage(),
  now = () => performance.now(),
} = {}) {
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
      out.push({ tS: (t - t0) / 1000, cpuPct: (cpuUs / wallUs) * 100, rssMiB });
      prevT = t; prevCpu = c;
    },
    samples() { return out.map((s) => ({ ...s })); },
  };
}
