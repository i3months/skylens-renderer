// Server process CPU/memory readings from /proc (Linux) for the load harness.
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

// Returns { cpuUsage: { user, system } (microseconds), rssBytes } or null if the process is gone or /proc is unreadable.
export function readProcStats(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const st = parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    const resident = Number(readFileSync(`/proc/${pid}/statm`, 'utf8').trim().split(/\s+/)[1]);
    if (!st || !Number.isInteger(resident) || resident < 0) return null;
    const us = 1e6 / tck();
    return { cpuUsage: { user: st.utime * us, system: st.stime * us }, rssBytes: resident * pgsz() };
  } catch { return null; }
}

// Stats sampler over another process; a gone process yields null, which the sampler treats as a skipped tick.
export function createProcSampler({ pid, now } = {}) {
  return createStatsSampler({
    cpuUsage: () => readProcStats(pid)?.cpuUsage ?? null,
    memoryUsage: () => { const r = readProcStats(pid); return r ? { rss: r.rssBytes } : null; },
    now: now ?? (() => performance.now()),
    clock: 'real',
    source: 'server-process',
  });
}
