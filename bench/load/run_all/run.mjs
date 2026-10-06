// One-command load run (T16.10): node bench/load/run_all/run.mjs [outDir]
// Runs the steady/burst/slow_link scenarios with 30 clients, writes result JSON, prints the report,
// exits non-zero when a scenario result is invalid or a threshold is exceeded.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateResult, validateScenario } from '../../../contracts/load/index.mjs';
import { simulateClients, countOpenConnections, connectionViolations } from '../clients/index.mjs';
import { simulateSlowLink } from '../slow_link/index.mjs';
import { showFromArrivals, checkBurstInvariants, burstArrivals } from '../burst/index.mjs';
import { createStatsSampler, checkServerSamples } from '../server_stats/index.mjs';
import { perClientFromEvents, unreachableClients } from '../per_client/index.mjs';
import { firstFrameStats, firstFrameViolations } from '../first_frame/index.mjs';
import { bandwidthStats, bandwidthViolations } from '../bandwidth/index.mjs';
import { checkThresholds, loadThresholds } from '../../thresholds/index.mjs';
import { loadReport, CLOUD_APPROXIMATION_METHODS, FIRST_FRAME_P95_CLOUD_NOTE } from '../../../tools/load_report/index.mjs';
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
 * An injected statsClock must provide both now and cpuUsage and an explicit clock ('simulated' | 'real'); source/clock overrides are only accepted with them.
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
  if (statsClock.clock !== 'simulated' && statsClock.clock !== 'real') {
    throw new Error("runScenario: statsClock.clock must be 'simulated' or 'real'");
  }
  // source/clock are NOT pre-filled from the simulated defaults: createStatsSampler applies its own defaults for the given clock.
  return { ...statsClock };
}

/**
 * Runs one scenario and returns { result, violations, notes, serverSamples }.
 * opts.method (default 'sim') labels every record. For a cloud-approximation method (CLOUD_APPROXIMATION_METHODS, e.g. a real-socket
 * run) the first_frame p95 runs from the connect event (handshake completion), so it is not an S5 value: the 3 s threshold result then goes to
 * notes as a reference line carrying the same note as the report row, and never into violations.
 * Every check reads the SAME measured event log. opts.thresholds, opts.statsClock and opts.events (a replacement log, default: simulate) and opts.show (default: showFromArrivals) are injectable.
 * An injected log is checked with checkEventLog first; a bad log returns its violations without running any stats.
 * A stats function that still throws becomes a `<name>: bad event log: ...` violation instead of an exception.
 * serverSamples come from the stats sampler ticked once per simulated second, the last tick at durationS.
 */
export function runScenario(scenario, opts = {}) {
  if (opts === null || (typeof opts !== 'string' && (typeof opts !== 'object' || Array.isArray(opts)))) throw new Error('runScenario: opts must be an object');
  const { commit = commitHash(), thresholds = loadThresholds(), statsClock, events: injected, show = showFromArrivals, method = 'sim' } = typeof opts === 'string' ? { commit: opts } : opts;
  if (scenario === null || typeof scenario !== 'object' || Array.isArray(scenario)) throw new Error('runScenario: scenario must be an object');
  const name = scenario.name;
  let tickMs = 0;
  const samplerOpts = samplerOptions(statsClock, () => tickMs);
  const violations = [];
  const notes = [];
  const empty = () => ({ result: { scenario, records: [], perClient: [] }, violations, notes, serverSamples: [] });
  if (typeof method !== 'string' || method === '') throw new Error('runScenario: method must be a non-empty string');
  const badScenario = validateScenario(scenario);
  if (badScenario.length > 0) {
    appendAll(violations, badScenario, `${name}: `);
    return empty();
  }
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
  const connViol = run(() => connectionViolations(events, scenario.clients));
  const unreachable = run(() => unreachableClients(events, scenario.clients));
  const burst = scenario.kind === 'burst' ? run(() => {
    const arrivals = burstArrivals(events, scenario.burstLevels);
    return checkBurstInvariants(arrivals, show(arrivals, scenario.clients), scenario);
  }) : [];
  const perClient = run(() => perClientFromEvents(events, scenario.clients));
  if (failed) return empty();
  const rec = (metric, value, unit) => ({ metric, value, unit, device: 'headless', method, commit });
  const records = [
    rec('load.first_frame_p95', ff.p95Ms, 'ms'),
    rec('load.bandwidth_total', bw.totalBytes, 'B'),
    rec('load.bandwidth_peak_bytes_per_s', bw.peakBytesPerS, 'B') // contract units have no B/s: the name carries the per-second meaning,
  ];
  const cloud = CLOUD_APPROXIMATION_METHODS.includes(method);
  const referenceOnly = `${name}: reference only (not an S5 verdict), ${FIRST_FRAME_P95_CLOUD_NOTE}: `;
  // firstFrameViolations also states the 3 s limit ('first-frame p95 N ms exceeds limit M ms'); every other message stays a violation.
  for (const v of firstFrameViolations(ff)) {
    if (cloud && /^first-frame p95 \S+ ms exceeds limit /.test(v)) notes.push(referenceOnly + v);
    else violations.push(`${name}: ${v}`);
  }
  appendAll(violations, connViol, `${name}: `);
  appendAll(violations, bandwidthViolations(bw), `${name}: `);
  if (open.min !== scenario.clients) violations.push(`${name}: open connections dropped to ${open.min} of ${scenario.clients}`);
  for (const id of unreachable) violations.push(`${name}: client ${id} received no bytes`);
  appendAll(violations, burst, `${name}: `);
  const result = { scenario, records, perClient };
  appendAll(violations, validateResult(result), `${name}: `);
  // The 3 s limit is a regression threshold of the mock harness (SPEC S5 value); slow_link only reports.
  // A cloud-approximation first_frame p95 is not an S5 value (handshake-complete basis), so its threshold result is a reference note, not a verdict.
  if (scenario.kind !== 'slow_link') {
    if (cloud && thresholds !== null && typeof thresholds === 'object' && !Array.isArray(thresholds) && Object.keys(thresholds).length > 0) {
      // Only the first_frame_p95 threshold is a reference note; every other threshold (e.g. bandwidth) stays a verdict.
      const isFirstFrame = ([metric]) => metric === 'load.first_frame_p95';
      const firstFrameOnly = Object.fromEntries(Object.entries(thresholds).filter(isFirstFrame));
      const rest = Object.fromEntries(Object.entries(thresholds).filter((e) => !isFirstFrame(e)));
      // checkThresholds rejects an empty thresholds object, so an empty side is skipped (an empty whole object takes the else branch and throws).
      if (Object.keys(firstFrameOnly).length > 0) appendAll(notes, checkThresholds(records, firstFrameOnly), referenceOnly);
      if (Object.keys(rest).length > 0) appendAll(violations, checkThresholds(records, rest), `${name}: `);
    } else {
      appendAll(violations, checkThresholds(records, thresholds), `${name}: `);
    }
  }
  // Simulated clock and stub CPU by default, so source reads 'simulated'. Real server verdicts are the [local] follow-up (T16.12 / T17).
  // A sampler or usage function that throws becomes a `server stats: <message>` violation; one that returns null makes the sampler
  // skip the tick (fewer samples), reported by checkServerSamples as `server samples: N samples, expected M`. Neither escapes as an exception.
  let serverSamples = [];
  try {
    const sampler = createStatsSampler(samplerOpts);
    // One tick per started second; the last tick lands exactly on durationS (0.5 s -> [0.5], 1.5 s -> [1, 1.5]).
    const expectedSamples = Math.ceil(scenario.durationS);
    for (let i = 1; i <= expectedSamples; i++) { tickMs = Math.min(i, scenario.durationS) * 1000; sampler.tick(); }
    serverSamples = sampler.samples();
    appendAll(violations, checkServerSamples(serverSamples, { durationS: scenario.durationS }), `${name}: `);
  } catch (e) {
    violations.push(`${name}: server stats: ${e instanceof Error ? e.message : String(e)}`);
    serverSamples = [];
  }
  return { result, violations, notes, serverSamples };
}

export function main(outDir = 'load_out', opts = {}) {
  mkdirSync(outDir, { recursive: true });
  const all = [];
  for (const s of SCENARIOS) {
    const { result, violations, serverSamples } = runScenario(s, opts);
    writeFileSync(`${outDir}/${s.name}.json`, JSON.stringify(result, null, 2) + '\n');
    writeFileSync(`${outDir}/${s.name}.server.json`, JSON.stringify(serverSamples, null, 2) + '\n');
    // slow_link is exempt from the S5 threshold check; loadReport carries that note in the report body.
    if (violations.length === 0) console.log(`## ${s.name}\n${loadReport(result, { serverSamples })}\n`);
    appendAll(all, violations);
  }
  for (const v of all) console.error(`VIOLATION ${v}`);
  return all.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv[2]));
