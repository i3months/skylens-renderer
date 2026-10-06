// Real-socket load run (T16.12): node bench/load/socket/run.mjs [outDir] [durationS]
// Starts the product transport in a child process on loopback, connects `clients` real sockets, samples the server
// process once per real second, then builds the load result from the measured event log. See ./contract.mjs.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateResult } from '../../../contracts/load/index.mjs';
import { runScenario, appendAll } from '../run_all/run.mjs';
import { checkServerSamples } from '../server_stats/index.mjs';
import { loadReport } from '../../../tools/load_report/index.mjs';
import { SOCKET_HOST } from './contract.mjs';

export const SCENARIO_NAME = 'socket30';
// Record method for a run over real sockets. loadReport treats only 'sim' as simulated, so this label is what the
// report's `source:` line shows. It names the cloud approximation (loopback), not a device measurement.
export const SOCKET_METHOD = 'loopback-socket';

/**
 * Scenario for a real-socket run. The path is the steady30 path, clipped to durationS because the scenario
 * contract refuses a path that ends after durationS (a short run keeps the same direction of travel).
 */
export function socketScenario(clients, durationS) {
  return {
    name: SCENARIO_NAME,
    kind: 'steady',
    clients,
    durationS,
    path: [{ t: 0, e: 0, n: 0, u: 100 }, { t: Math.min(30, durationS), e: 150, n: 0, u: 100 }],
  };
}

async function realDeps() {
  const [{ startServerProcess }, { runSocketClients }, { createProcSampler }] = await Promise.all([
    import('./server_proc.mjs'),
    import('./clients.mjs'),
    import('./proc_stats.mjs'),
  ]);
  return { startServerProcess, runSocketClients, createProcSampler };
}

const message = (e) => (e instanceof Error ? e.message : String(e));

// A tick that fires more than this late is skipped instead of run (see tickOnRealClock).
export const MAX_TICK_LATE_MS = 1000;

/**
 * Ticks sampler on the clock at t0 + i*1000 ms for i = 1..ceil(durationS), the last tick at durationS.
 * t0 is shared with the sampler (runSocketLoad passes the same t0 to createProcSampler), so tS and the tick
 * targets share one origin. Each timer is aimed at its absolute target, so lateness does not accumulate, and now()
 * is re-checked when a timer fires: an early firing waits again, so a tick never runs before its target.
 * A tick that is more than MAX_TICK_LATE_MS past its target (the event loop was blocked) is skipped rather than
 * run in a burst with the backed-up ones; the missing sample shows up in checkServerSamples' count.
 * Rejects with a RangeError if now() does not advance across a timer (a stopped injected clock would re-arm forever).
 * Also rejects (rather than throwing) with a RangeError for a non-finite or non-positive durationS; the default
 * t0 = now() is evaluated before that check, so a now() that throws still throws synchronously (runSocketLoad passes t0).
 * Resolves after the last tick.
 */
export function tickOnRealClock(sampler, durationS, now, onError, t0 = now(), schedule = setTimeout) {
  if (!(Number.isFinite(durationS) && durationS > 0)) return Promise.reject(new RangeError(`tickOnRealClock: durationS must be a finite number > 0, got ${durationS}`));
  const n = Math.ceil(durationS);
  let i = 0;
  return new Promise((resolve, reject) => {
    const next = () => {
      i += 1;
      if (i > n) { resolve(); return; }
      const targetMs = Math.min(i * 1000, durationS * 1000);
      const arm = () => {
        const armedAt = now();
        schedule(() => {
          const at = now();
          const elapsed = at - t0;
          if (elapsed < targetMs) {
            if (!(at > armedAt)) { reject(new RangeError('tickOnRealClock: now() did not advance across a timer')); return; }
            arm();
            return;
          }
          if (elapsed - targetMs <= MAX_TICK_LATE_MS) {
            try { sampler.tick(); } catch (e) { onError(e); }
          }
          next();
        }, Math.max(0, targetMs - (armedAt - t0)));
      };
      arm();
    };
    next();
  });
}

/**
 * Runs the real-socket load scenario and returns { result, violations, serverSamples, report }.
 * deps (startServerProcess, runSocketClients, createProcSampler, now) are injectable; missing ones come from
 * ./server_proc.mjs, ./clients.mjs, ./proc_stats.mjs and performance.now. report is null when the result is invalid.
 * runScenario's own simulated server samples are discarded; serverSamples are the real-clock samples of the
 * server process, checked with checkServerSamples. Every violation is prefixed with `socket30: `.
 */
export async function runSocketLoad({ clients = 30, durationS = 10, commit, deps = {} } = {}) {
  if (!(Number.isFinite(durationS) && durationS > 0)) throw new RangeError(`durationS must be a finite number > 0, got ${durationS}`);
  if (!(Number.isInteger(clients) && clients > 0)) throw new RangeError(`clients must be a positive integer, got ${clients}`);
  const needed = ['startServerProcess', 'runSocketClients', 'createProcSampler'];
  const d = needed.every((k) => typeof deps[k] === 'function') ? { ...deps } : { ...(await realDeps()), ...deps };
  const now = d.now ?? (() => performance.now());
  const scenario = socketScenario(clients, durationS);
  const prefix = `${SCENARIO_NAME}: `;
  const violations = [];
  const notes = [];

  const server = await d.startServerProcess({ host: SOCKET_HOST });
  let events;
  let serverSamples = [];
  try {
    const t0 = now();
    const sampler = d.createProcSampler({ pid: server.pid, now, t0 });
    const ticking = tickOnRealClock(sampler, durationS, now, (e) => violations.push(`${prefix}server stats: ${message(e)}`), t0, d.setTimeout);
    const clientRun = d.runSocketClients({ host: SOCKET_HOST, port: server.port, clients, durationS });
    const [clientOutcome, tickOutcome] = await Promise.allSettled([clientRun, ticking]);
    if (tickOutcome.status === 'rejected') violations.push(`${prefix}server stats: ${message(tickOutcome.reason)}`);
    if (clientOutcome.status === 'rejected') violations.push(`${prefix}clients: ${message(clientOutcome.reason)}`);
    else events = clientOutcome.value;
    serverSamples = sampler.samples();
  } finally {
    await server.stop();
  }

  let result = { scenario, records: [], perClient: [] };
  if (events !== undefined) {
    const run = runScenario(scenario, { events, commit, method: SOCKET_METHOD });
    // runScenario's verdicts all read the measured log; its simulated-clock samples are dropped here.
    appendAll(violations, run.violations);
    notes.push(...run.notes);
    result = run.result;
  }
  // With no samples checkServerSamples would add a second '0 samples' violation; the one naming the cause replaces it.
  if (serverSamples.length === 0) violations.push(`${prefix}server samples: 0 samples, likely cause: /proc not available (non-Linux?)`);
  else appendAll(violations, checkServerSamples(serverSamples, { durationS }), prefix);

  let report = null;
  if (validateResult(result).length === 0) report = loadReport(result, { serverSamples });
  return { result, violations, notes, serverSamples, report };
}

export async function main(outDir = 'load_out/socket', durationArg, opts = {}, writeErr = (s) => process.stderr.write(s)) {
  const durationS = durationArg === undefined ? 10 : Number(durationArg);
  if (!(Number.isFinite(durationS) && durationS > 0)) {
    console.error(`usage: node bench/load/socket/run.mjs [outDir] [durationS]  (bad durationS: ${durationArg})`);
    return 2;
  }
  const { result, violations, notes, serverSamples, report } = await runSocketLoad({ ...opts, durationS });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/${SCENARIO_NAME}.json`, JSON.stringify(result, null, 2) + '\n');
  writeFileSync(`${outDir}/${SCENARIO_NAME}.server.json`, JSON.stringify(serverSamples, null, 2) + '\n');
  const body = report ?? 'no report: result is invalid';
  const violationLines = violations.map((v) => `- ${v}`).join('\n');
  writeFileSync(`${outDir}/report.md`, `## ${SCENARIO_NAME}\n${body}\n${notes.length ? `\nreference only (not S5 verdicts):\n${notes.map((n) => `- ${n}`).join('\n')}\n` : ''}${violations.length ? `\nviolations:\n${violationLines}\n` : ''}`);
  console.log(`## ${SCENARIO_NAME}\n${body}\n`);
  for (const n of notes) writeErr(`NOTE ${n}\n`);
  for (const v of violations) console.error(`VIOLATION ${v}`);
  return violations.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv[2], process.argv[3]).then(
    (code) => process.exit(code),
    (e) => { console.error(e instanceof Error ? e.stack : String(e)); process.exit(1); },
  );
}
