// One-command load run (T16.10): node bench/load/run_all/run.mjs [outDir]
// Runs the steady/burst/slow_link scenarios with 30 clients, writes result JSON, prints the report,
// exits non-zero when a scenario result is invalid or a threshold is exceeded.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateResult } from '../../../contracts/load/index.mjs';
import { simulateClients, countOpenConnections } from '../clients/index.mjs';
import { simulateSlowLink } from '../slow_link/index.mjs';
import { showFromArrivals, checkBurstInvariants } from '../burst/index.mjs';
import { createStatsSampler } from '../server_stats/index.mjs';
import { perClientFromEvents, unreachableClients } from '../per_client/index.mjs';
import { firstFrameStats, firstFrameViolations } from '../first_frame/index.mjs';
import { bandwidthStats } from '../bandwidth/index.mjs';
import { checkThresholds, loadThresholds } from '../../thresholds/index.mjs';
import { loadReport } from '../../../tools/load_report/index.mjs';

const path = [{ t: 0, e: 0, n: 0, u: 100 }, { t: 30, e: 150, n: 0, u: 100 }];
export const SCENARIOS = [
  { name: 'steady30', kind: 'steady', clients: 30, durationS: 60, path },
  { name: 'burst30', kind: 'burst', clients: 30, durationS: 60, path, burstLevels: 4 },
  { name: 'slow30', kind: 'slow_link', clients: 30, durationS: 60, path, linkBytesPerS: 125000 },
];
const SEED = 1;

function commitHash() {
  try { return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return '0000000'; }
}

/**
 * Runs one scenario and returns { result, violations, serverSamples }.
 * Every check reads the SAME measured event log. opts.thresholds and opts.statsClock are injectable.
 * serverSamples come from the stats sampler of this harness process ticked once per simulated second.
 */
export function runScenario(scenario, opts = {}) {
  const { commit = commitHash(), thresholds = loadThresholds(), statsClock } = typeof opts === 'string' ? { commit: opts } : opts;
  const slow = scenario.kind === 'slow_link' ? simulateSlowLink(scenario, { seed: SEED }) : null;
  const events = slow ? slow.events : simulateClients(scenario, { seed: SEED });
  const ff = firstFrameStats(events, scenario.clients);
  const bw = bandwidthStats(events, scenario.durationS);
  const rec = (metric, value, unit) => ({ metric, value, unit, device: 'headless', method: 'sim', commit });
  const records = [
    rec('load.first_frame_p95', ff.p95Ms, 'ms'),
    rec('load.bandwidth_total', bw.totalBytes, 'B'),
    rec('load.bandwidth_peak_bytes_per_s', bw.peakBytesPerS, 'B') // contract units have no B/s: the name carries the per-second meaning,
  ];
  const violations = [];
  violations.push(...firstFrameViolations(ff).map((v) => `${scenario.name}: ${v}`));
  const open = countOpenConnections(events);
  if (open.min !== scenario.clients) violations.push(`${scenario.name}: open connections dropped to ${open.min} of ${scenario.clients}`);
  for (const id of unreachableClients(events, scenario.clients)) violations.push(`${scenario.name}: client ${id} received no bytes`);
  if (scenario.kind === 'burst') {
    const arrivals = events.filter((e) => e.kind === 'level');
    const shown = showFromArrivals(events, scenario.clients);
    violations.push(...checkBurstInvariants(arrivals, shown, scenario).map((v) => `${scenario.name}: ${v}`));
  }
  const result = { scenario, records, perClient: perClientFromEvents(events, scenario.clients) };
  violations.push(...validateResult(result).map((v) => `${scenario.name}: ${v}`));
  // The 3 s limit is a regression threshold of the mock harness (SPEC S5 value); slow_link only reports.
  if (scenario.kind !== 'slow_link') violations.push(...checkThresholds(records, thresholds).map((v) => `${scenario.name}: ${v}`));
  const clock = statsClock ?? {};
  let tickMs = 0;
  const sampler = createStatsSampler({ now: () => tickMs, ...clock });
  for (let t = 1; t <= scenario.durationS; t++) { tickMs = t * 1000; sampler.tick(); }
  const serverSamples = sampler.samples();
  if (serverSamples.length < scenario.durationS) violations.push(`${scenario.name}: ${serverSamples.length} server samples, expected ${scenario.durationS}`);
  return { result, violations, serverSamples };
}

export function main(outDir = 'load_out', opts = {}) {
  mkdirSync(outDir, { recursive: true });
  const all = [];
  for (const s of SCENARIOS) {
    const { result, violations, serverSamples } = runScenario(s, opts);
    writeFileSync(`${outDir}/${s.name}.json`, JSON.stringify(result, null, 2) + '\n');
    writeFileSync(`${outDir}/${s.name}.server.json`, JSON.stringify(serverSamples, null, 2) + '\n');
    if (violations.length === 0) console.log(`## ${s.name}\n${loadReport(result)}\n`);
    all.push(...violations);
  }
  for (const v of all) console.error(`VIOLATION ${v}`);
  return all.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv[2]));
