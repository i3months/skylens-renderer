// Server process CPU/memory readings from /proc (Linux) for the load harness.
// Note: the sampler's cpuPct resolution is 100/(CLK_TCK*wallS) percent (utime/stime are whole clock ticks),
// so short buckets are coarse: with CLK_TCK=100 and a 1 s bucket, steps of 1 %; a 0.1 s bucket, steps of 10 %.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createStatsSampler } from '../server_stats/index.mjs';

// Linux USER_HZ default: utime/stime in /proc/<pid>/stat are in clock ticks of 1/100 s.
export const DEFAULT_CLK_TCK = 100;
// Default Linux page size; statm counts pages.
export const DEFAULT_PAGE_SIZE = 4096;

function getconf(name, fallback) {
  try {
    const n = Number.parseInt(execFileSync('getconf', [name], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : fallback;
  } catch { return fallback; }
}
let clkTck;
let pageSize;
const tck = () => (clkTck ??= getconf('CLK_TCK', DEFAULT_CLK_TCK));
const pgsz = () => (pageSize ??= getconf('PAGESIZE', DEFAULT_PAGE_SIZE));

// Parses a /proc/<pid>/stat line into { utime, stime } in clock ticks, or null if malformed.
// comm (field 2) may contain spaces and parentheses, so fields are taken after the LAST ')'.
export function parseProcStat(line) {
  if (typeof line !== 'string') return null;
  const end = line.lastIndexOf(')');
  if (end < 0) return null;
  const f = line.slice(end + 1).trim().split(/\s+/);
  // f[0] is field 3 (state); utime is field 14 -> f[11], stime field 15 -> f[12].
  const utime = Number(f[11]);
  const stime = Number(f[12]);
  if (f.length < 13 || !Number.isInteger(utime) || !Number.isInteger(stime) || utime < 0 || stime < 0) return null;
  return { utime, stime };
}

// Parses /proc/<pid>/statm text into { resident } (pages, field 2), or null if malformed.
export function parseStatm(text) {
  if (typeof text !== 'string') return null;
  const f = text.trim().split(/\s+/);
  // Plain decimal digits only: Number() would also accept '1e3' and '0x10'.
  if (f.length < 2 || !/^\d+$/.test(f[1])) return null;
  const resident = Number(f[1]);
  if (!Number.isSafeInteger(resident)) return null;
  return { resident };
}

// Returns { cpuUsage: { user, system } (microseconds), rssBytes } or null if the process is gone or /proc is unreadable.
// read(path) is injectable for tests; it defaults to a utf8 readFileSync.
export function readProcStats(pid, read = (p) => readFileSync(p, 'utf8')) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const st = parseProcStat(read(`/proc/${pid}/stat`));
    const sm = parseStatm(read(`/proc/${pid}/statm`));
    if (!st || !sm) return null;
    const resident = sm.resident;
    const us = 1e6 / tck();
    return { cpuUsage: { user: st.utime * us, system: st.stime * us }, rssBytes: resident * pgsz() };
  } catch { return null; }
}

// Stats sampler over another process; a gone process yields null, which the sampler treats as a skipped tick.
// t0 (optional) is the caller's shared time origin on the now() clock; see createStatsSampler.
export function createProcSampler({ pid, now, t0 } = {}) {
  // Resolve getconf values now, before the sampler's clock starts, so the first tick is not delayed by a subprocess.
  tck();
  pgsz();
  // One /proc snapshot per tick: the sampler calls cpuUsage() first, memoryUsage() right after, for the same tick.
  let snap = null;
  return createStatsSampler({
    cpuUsage: () => { snap = readProcStats(pid); return snap?.cpuUsage ?? null; },
    memoryUsage: () => (snap ? { rss: snap.rssBytes } : null),
    now: now ?? (() => performance.now()),
    t0,
    clock: 'real',
    source: 'server-process',
  });
}
