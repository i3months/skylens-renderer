// Server CPU/memory sampler for the load harness (T16.2). Clock and usage sources are injected.
export function createStatsSampler({
  intervalMs = 1000,
  cpuUsage = () => process.cpuUsage(),
  memoryUsage = () => process.memoryUsage(),
  now = () => performance.now(),
} = {}) {
  const out = [];
  const t0 = now();
  let prevT = t0;
  let prevCpu = cpuUsage();
  let first = true;
  return {
    intervalMs,
    tick() {
      const t = now();
      const c = cpuUsage();
      const wallUs = (t - prevT) * 1000;
      const cpuUs = (c.user - prevCpu.user) + (c.system - prevCpu.system);
      const cpuPct = first || wallUs <= 0 ? 0 : (cpuUs / wallUs) * 100;
      out.push({ tS: (t - t0) / 1000, cpuPct, rssMB: memoryUsage().rss / 1048576 });
      prevT = t; prevCpu = c; first = false;
    },
    samples() { return out.map((s) => ({ ...s })); },
  };
}
