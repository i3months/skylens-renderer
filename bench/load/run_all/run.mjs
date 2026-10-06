// One-command load run (T16.10): node bench/load/run_all/run.mjs [outDir]
// Runs the steady/burst/slow_link scenarios with 30 clients, writes result JSON, prints the report,
// exits non-zero when a scenario result is invalid or a threshold is exceeded.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateResult } from '../../../contracts/load/index.mjs';
import { simulateClients } from '../clients/index.mjs';
import { simulateSlowLink } from '../slow_link/index.mjs';
import { simulateBurst } from '../burst/index.mjs';
import { perClientFromEvents } from '../per_client/index.mjs';
import { firstFrameStats } from '../first_frame/index.mjs';
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

/** Runs one scenario and returns { result, violations }. */
export function runScenario(scenario, commit = commitHash()) {
  const events = scenario.kind === 'slow_link' ? simulateSlowLink(scenario, { seed: SEED }).events : simulateClients(scenario, { seed: SEED });
  const ff = firstFrameStats(events, scenario.clients);
  const bw = bandwidthStats(events, scenario.durationS);
  const rec = (metric, value, unit) => ({ metric, value, unit, device: 'headless', method: 'sim', commit });
  const records = [
    rec('load.first_frame_p95', ff.p95Ms, 'ms'),
    rec('load.bandwidth_total', bw.totalBytes, 'B'),
    rec('load.bandwidth_peak', bw.peakBytesPerS, 'B'),
  ];
  const violations = [];
  if (!Number.isFinite(ff.p95Ms)) violations.push(`${scenario.name}: first frame p95 is not finite`);
  if (scenario.kind === 'burst') violations.push(...simulateBurst(scenario, { seed: SEED }).violations.map((v) => `${scenario.name}: ${v}`));
  const result = { scenario, records, perClient: perClientFromEvents(events, scenario.clients) };
  violations.push(...validateResult(result).map((v) => `${scenario.name}: ${v}`));
  // The 3 s first-frame limit is the SPEC target for the unconstrained link; slow_link only reports.
  if (scenario.kind !== 'slow_link') violations.push(...checkThresholds(records, loadThresholds()).map((v) => `${scenario.name}: ${v}`));
  return { result, violations };
}

export function main(outDir = 'load_out') {
  mkdirSync(outDir, { recursive: true });
  const all = [];
  for (const s of SCENARIOS) {
    const { result, violations } = runScenario(s);
    writeFileSync(`${outDir}/${s.name}.json`, JSON.stringify(result, null, 2) + '\n');
    if (violations.length === 0) console.log(`## ${s.name}\n${loadReport(result)}\n`);
    all.push(...violations);
  }
  for (const v of all) console.error(`VIOLATION ${v}`);
  return all.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv[2]));
