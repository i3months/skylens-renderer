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

const path = [{ t: 0, e: 0, n: 0, u: 100 }, { t: 30, e: 150, n: 0, u: 100 }];
export const SCENARIOS = [
  { name: 'steady30', kind: 'steady', clients: 30, durationS: 60, path },
  { name: 'burst30', kind: 'burst', clients: 30, durationS: 60, path, burstLevels: 4 },
  { name: 'slow30', kind: 'slow_link', clients: 30, durationS: 60, path, linkBytesPerS: 125000 },
];
const SEED = 1;

// 대량 위반에서도 인자 개수 한도(RangeError)에 걸리지 않도록 반복문으로 접두어를 붙여 덧붙인다.
export function appendAll(target, items, prefix = '') {
  for (const x of items) target.push(prefix + x);
  return target;
}

function commitHash() {
  try { return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return '0000000'; }
}

/**
 * Runs one scenario and returns { result, violations, serverSamples }.
 * Every check reads the SAME measured event log. opts.thresholds, opts.statsClock and opts.events (a replacement log, default: simulate) and opts.show (default: showFromArrivals) are injectable.
 * serverSamples come from the stats sampler of this harness process ticked once per simulated second.
 */
export function runScenario(scenario, opts = {}) {
  const { commit = commitHash(), thresholds = loadThresholds(), statsClock, events: injected, show = showFromArrivals } = typeof opts === 'string' ? { commit: opts } : opts;
  const events = injected ?? (scenario.kind === 'slow_link'
    ? simulateSlowLink(scenario, { seed: SEED }).events
    : simulateClients(scenario, { seed: SEED }));
  const ff = firstFrameStats(events, scenario.clients);
  const bw = bandwidthStats(events, scenario.durationS);
  const rec = (metric, value, unit) => ({ metric, value, unit, device: 'headless', method: 'sim', commit });
  const records = [
    rec('load.first_frame_p95', ff.p95Ms, 'ms'),
    rec('load.bandwidth_total', bw.totalBytes, 'B'),
    rec('load.bandwidth_peak_bytes_per_s', bw.peakBytesPerS, 'B') // contract units have no B/s: the name carries the per-second meaning,
  ];
  const violations = [];
  appendAll(violations, firstFrameViolations(ff), `${scenario.name}: `);
  const open = countOpenConnections(events);
  if (open.min !== scenario.clients) violations.push(`${scenario.name}: open connections dropped to ${open.min} of ${scenario.clients}`);
  for (const id of unreachableClients(events, scenario.clients)) violations.push(`${scenario.name}: client ${id} received no bytes`);
  if (scenario.kind === 'burst') {
    const arrivals = burstArrivals(events, scenario.burstLevels);
    const shown = show(arrivals, scenario.clients);
    appendAll(violations, checkBurstInvariants(arrivals, shown, scenario), `${scenario.name}: `);
  }
  const result = { scenario, records, perClient: perClientFromEvents(events, scenario.clients) };
  appendAll(violations, validateResult(result), `${scenario.name}: `);
  // The 3 s limit is a regression threshold of the mock harness (SPEC S5 value); slow_link only reports.
  if (scenario.kind !== 'slow_link') appendAll(violations, checkThresholds(records, thresholds), `${scenario.name}: `);
  // 모의 시계와 모의 CPU(항상 0)이므로 source 도 'simulated' 로 표시한다. 실제 서버 판정은 [local] 후속(T16.12 / T17).
  let tickMs = 0;
  const sampler = createStatsSampler({ clock: 'simulated', source: 'simulated', now: () => tickMs, cpuUsage: () => ({ user: 0, system: 0 }), ...statsClock });
  // tick 루프는 정수 초만 돌므로 기대 샘플 수도 소수 durationS 를 내림한다.
  const expectedSamples = Math.floor(scenario.durationS);
  for (let t = 1; t <= expectedSamples; t++) { tickMs = t * 1000; sampler.tick(); }
  const serverSamples = sampler.samples();
  if (serverSamples.length < expectedSamples) violations.push(`${scenario.name}: ${serverSamples.length} server samples, expected ${expectedSamples}`);
  appendAll(violations, checkServerSamples(serverSamples), `${scenario.name}: `);
  return { result, violations, serverSamples };
}

export function main(outDir = 'load_out', opts = {}) {
  mkdirSync(outDir, { recursive: true });
  const all = [];
  for (const s of SCENARIOS) {
    const { result, violations, serverSamples } = runScenario(s, opts);
    writeFileSync(`${outDir}/${s.name}.json`, JSON.stringify(result, null, 2) + '\n');
    writeFileSync(`${outDir}/${s.name}.server.json`, JSON.stringify(serverSamples, null, 2) + '\n');
    // slow_link 는 S5 문턱 검사 대상이 아니므로 시나리오 줄에 드러낸다(보고서 본문 형식은 loadReport 소관).
    const note = s.kind === 'slow_link' ? ' (S5 문턱 제외 시나리오)' : '';
    if (violations.length === 0) console.log(`## ${s.name}${note}\n${loadReport(result)}\n`);
    appendAll(all, violations);
  }
  for (const v of all) console.error(`VIOLATION ${v}`);
  return all.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv[2]));
