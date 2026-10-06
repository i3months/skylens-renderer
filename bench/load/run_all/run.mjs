// One-command load run (T16.10): node bench/load/run_all/run.mjs [outDir]
// Runs the steady/burst/slow_link scenarios with 30 clients, writes result JSON, prints the report,
// exits non-zero when a scenario result is invalid or a threshold is exceeded.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateResult } from '../../../contracts/load/index.mjs';
import { simulateClients, countOpenConnections } from '../clients/index.mjs';
import { simulateSlowLink } from '../slow_link/index.mjs';
import { showFromArrivals, checkBurstInvariants, burstArrivals } from '../burst/index.mjs';
import { createStatsSampler, checkServerSamples } from '../server_stats/index.mjs';
import { perClientFromEvents, unreachableClients } from '../per_client/index.mjs';
import { firstFrameStats, firstFrameViolations } from '../first_frame/index.mjs';
import { bandwidthStats } from '../bandwidth/index.mjs';
import { checkThresholds, loadThresholds } from '../../thresholds/index.mjs';
import { loadReport } from '../../../tools/load_report/index.mjs';
import { checkEventLog, guarded } from './event_log.mjs';

const path = [{ t: 0, e: 0, n: 0, u: 100 }, { t: 30, e: 150, n: 0, u: 100 }];
export const SCENARIOS = [
  { name: 'steady30', kind: 'steady', clients: 30, durationS: 60, path },
  { name: 'burst30', kind: 'burst', clients: 30, durationS: 60, path, burstLevels: 4 },
  { name: 'slow30', kind: 'slow_link', clients: 30, durationS: 60, path, linkBytesPerS: 125000 },
];
const SEED = 1;

// Appends with a loop (and an optional prefix) so huge violation lists never hit the argument-count limit (RangeError).
export function appendAll(target, items, prefix = '') {
  for (const x of items) target.push(prefix + x);
  return target;
}

function commitHash() {
  try { return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return '0000000'; }
}

const STATS_CLOCK_KEYS = new Set(['now', 'cpuUsage', 'memoryUsage', 'source', 'clock', 'cpuStub']);

/**
 * Builds the server stats sampler options. Without statsClock the run uses the simulated clock (tickMs) and a stub
 * CPU (cpuStub: samples carry cpuPct null, cpuSource 'stub'), so no CPU figure is presented as measured.
 * An injected statsClock must provide both now and cpuUsage; source/clock overrides are only accepted with them.
 */
function samplerOptions(statsClock, nowSimulated) {
  const simulated = { clock: 'simulated', source: 'simulated', now: nowSimulated, cpuUsage: () => ({ user: 0, system: 0 }) };
  if (statsClock === undefined) return { ...simulated, cpuStub: true };
  if (statsClock === null || typeof statsClock !== 'object' || Array.isArray(statsClock)) {
    throw new Error('runScenario: statsClock must be an object');
  }
  for (const k of Object.keys(statsClock)) if (!STATS_CLOCK_KEYS.has(k)) throw new Error(`runScenario: statsClock has unknown key ${k}`);
  const hasNow = typeof statsClock.now === 'function';
  const hasCpu = typeof statsClock.cpuUsage === 'function';
  if (hasNow !== hasCpu) throw new Error('runScenario: statsClock must provide both now and cpuUsage, or neither');
  if (!hasNow) {
    throw new Error('runScenario: statsClock overrides (source, clock, memoryUsage, cpuStub) need both now and cpuUsage');
  }
  return { ...simulated, ...statsClock };
}

/**
 * Runs one scenario and returns { result, violations, serverSamples }.
 * Every check reads the SAME measured event log. opts.thresholds, opts.statsClock and opts.events (a replacement log, default: simulate) and opts.show (default: showFromArrivals) are injectable.
 * An injected log is checked with checkEventLog first; a bad log returns its violations without running any stats.
 * A stats function that still throws becomes a `<name>: bad event log: ...` violation instead of an exception.
 * serverSamples come from the stats sampler ticked once per simulated second, the last tick at durationS.
 */
export function runScenario(scenario, opts = {}) {
  const { commit = commitHash(), thresholds = loadThresholds(), statsClock, events: injected, show = showFromArrivals } = typeof opts === 'string' ? { commit: opts } : opts;
  const name = scenario.name;
  let tickMs = 0;
  const samplerOpts = samplerOptions(statsClock, () => tickMs);
  const violations = [];
  const empty = () => ({ result: { scenario, records: [], perClient: [] }, violations, serverSamples: [] });
  if (injected !== undefined) {
    const bad = checkEventLog(injected, scenario.clients);
    if (bad.length > 0) {
      appendAll(violations, bad, `${name}: `);
      return empty();
    }
  }
  const events = injected ?? (scenario.kind === 'slow_link'
    ? simulateSlowLink(scenario, { seed: SEED }).events
    : simulateClients(scenario, { seed: SEED }));
  let failed = false;
  const run = (fn) => {
    const r = guarded(name, fn);
    if ('violation' in r) { violations.push(r.violation); failed = true; return undefined; }
    return r.value;
  };
  const ff = run(() => firstFrameStats(events, scenario.clients));
  const bw = run(() => bandwidthStats(events, scenario.durationS));
  const open = run(() => countOpenConnections(events));
  const unreachable = run(() => unreachableClients(events, scenario.clients));
  const burst = scenario.kind === 'burst' ? run(() => {
    const arrivals = burstArrivals(events, scenario.burstLevels);
    return checkBurstInvariants(arrivals, show(arrivals, scenario.clients), scenario);
  }) : [];
  const perClient = run(() => perClientFromEvents(events, scenario.clients));
  if (failed) return empty();
  const rec = (metric, value, unit) => ({ metric, value, unit, device: 'headless', method: 'sim', commit });
  const records = [
    rec('load.first_frame_p95', ff.p95Ms, 'ms'),
    rec('load.bandwidth_total', bw.totalBytes, 'B'),
    rec('load.bandwidth_peak_bytes_per_s', bw.peakBytesPerS, 'B') // contract units have no B/s: the name carries the per-second meaning,
  ];
  appendAll(violations, firstFrameViolations(ff), `${name}: `);
  if (open.min !== scenario.clients) violations.push(`${name}: open connections dropped to ${open.min} of ${scenario.clients}`);
  for (const id of unreachable) violations.push(`${name}: client ${id} received no bytes`);
  appendAll(violations, burst, `${name}: `);
  const result = { scenario, records, perClient };
  appendAll(violations, validateResult(result), `${name}: `);
  // The 3 s limit is a regression threshold of the mock harness (SPEC S5 value); slow_link only reports.
  if (scenario.kind !== 'slow_link') appendAll(violations, checkThresholds(records, thresholds), `${name}: `);
  // Simulated clock and stub CPU by default, so source reads 'simulated'. Real server verdicts are the [local] follow-up (T16.12 / T17).
  const sampler = createStatsSampler(samplerOpts);
  // One tick per started second; the last tick lands exactly on durationS (0.5 s -> [0.5], 1.5 s -> [1, 1.5]).
  const expectedSamples = Math.ceil(scenario.durationS);
  for (let i = 1; i <= expectedSamples; i++) { tickMs = Math.min(i, scenario.durationS) * 1000; sampler.tick(); }
  const serverSamples = sampler.samples();
  if (serverSamples.length < expectedSamples) violations.push(`${name}: ${serverSamples.length} server samples, expected ${expectedSamples}`);
  appendAll(violations, checkServerSamples(serverSamples), `${name}: `);
  return { result, violations, serverSamples };
}

export function main(outDir = 'load_out', opts = {}) {
  mkdirSync(outDir, { recursive: true });
  const all = [];
  for (const s of SCENARIOS) {
    const { result, violations, serverSamples } = runScenario(s, opts);
    writeFileSync(`${outDir}/${s.name}.json`, JSON.stringify(result, null, 2) + '\n');
    writeFileSync(`${outDir}/${s.name}.server.json`, JSON.stringify(serverSamples, null, 2) + '\n');
    // slow_link is exempt from the S5 threshold check; loadReport carries that note in the report body.
    if (violations.length === 0) console.log(`## ${s.name}\n${loadReport(result)}\n`);
    appendAll(all, violations);
  }
  for (const v of all) console.error(`VIOLATION ${v}`);
  return all.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv[2]));
