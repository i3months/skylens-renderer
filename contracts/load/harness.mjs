// Load harness contract (T16.1-T16.10). All harness modules are pure functions over an event log;
// no sockets, no wall clock (time is the event's tMs). Same seed + same scenario gives the same log.
// Decisions: see research decisions/0060 (contract) and 0061 (harness). Coordinates are GeoAnchor-relative ENU, 1 unit = 1 m.
//
// ClientEvent: { id: int 0..clients-1, tMs: number >= 0 (ms from scenario start),
//   kind: 'connect' | 'bytes' | 'level' | 'first_frame' | 'close',
//   bytes?: int >= 0 (kind 'bytes': payload bytes received),
//   level?: int 0..LEVEL_COUNT-1 (kind 'level': highest level that arrived, a replacement not an accumulation),
//   latencyMs?: number >= 0 (kind 'bytes': request-to-receive delay of that payload) }
//
// Module signatures (default export is none; use the named export):
//   T16.1  bench/load/clients/index.mjs      simulateClients(scenario, { seed }) -> ClientEvent[]   (sorted by tMs, then id)
//   T16.2  bench/load/server_stats/index.mjs createStatsSampler({ cpuUsage, memoryUsage, now, clock, source, cpuStub }) -> { tick(), samples() }
//                                            samples() -> [{ tS, cpuPct, rssMiB, source, clock, cpuSource }] one per tick. clock 'simulated' defaults source to 'simulated' and
//                                            cpuSource to 'simulated'; clock 'real' defaults source to 'harness-process' (a server run passes 'server-process') and cpuSource to 'measured'.
//                                            cpuStub true makes cpuPct null and cpuSource 'stub' (source is unchanged).
//                                            checkServerSamples(samples, { durationS }?) -> string[] violation strings, never throws; a non-finite sample is a violation;
//                                            cpuSource must be 'measured' | 'stub' | 'simulated', and 'measured' needs clock 'real' (a simulated clock never carries a measured CPU).
//                                            Mixed check: whenever samples exist, mixed clock or mixed source is a violation (with or without durationS; only a non-finite-positive durationS returns first, see below).
//                                            Count check: when durationS is given and finite positive, for ALL clocks (empty array included) count = ceil(durationS);
//                                            real-clock timing checks (real only): first tS ≈ min(1,durationS)±0.5, last tS within durationS±0.25, every interval 0.5..1.5 s except the last (final bucket width ±0.5);
//                                            durationS not finite-positive is a violation.
//   T16.3  bench/load/per_client/index.mjs   perClientFromEvents(events, clients) -> perClient[] (validateResult shape)
//   T16.4  bench/load/first_frame/index.mjs  firstFrameStats(events, clients) -> { p50Ms, p95Ms, perClientMs[], missing, noArrival, outOfOrder };
//                                            noArrival lists ascending ids with a first_frame but no level arrival (a subset of missing); a first_frame counts only with an arrival of any level of the same id at tMs <= the first_frame tMs, otherwise that client's perClientMs is Infinity and firstFrameViolations says `client N: first_frame without level arrival (any level)`;
//                                            outOfOrder = ascending-id list of { id, reason } for impossible orderings: 'before_connect' (first_frame before client's connect), 'before_firstArrival' (first_frame before earliest level arrival of any level); firstFrameViolations reports any other reason as a violation
//   T16.5  bench/load/bandwidth/index.mjs    bandwidthStats(events, durationS) -> { totalBytes, meanBytesPerS, peakBytesPerS, invalid }; bandwidthViolations(stats) -> string[]
//   T16.6  bench/load/burst/index.mjs        showFromArrivals(events, clients) -> shown [{id, tMs, level}]  (feeds each 'level' event of the
//                                            measured log into the product level machine client/levels createLevelMachine, one segment per
//                                            client; the harness never computes a max itself)
//                                            checkBurstInvariants(arrivals, shown, scenario) -> string[]  (arrivals = 'level' events of the
//                                            measured log, both sorted by tMs; each shown entry must be an arrived level, the highest arrived
//                                            so far, and never followed by a lower one; overtaken levels are skipped, never filled in)
//                                            simulateBurst(scenario, { seed }) -> { arrivals, shown, violations }  (uses simulateClients)
//   Burst scenario: every client's levels 0..burstLevels-1 carry ONE tMs (maximum bundle delay), so they arrive together.
//   First frame (one definition, clients and slow_link): tMs of the first payload of the first level that arrived (levels may be skipped) and was drawn.
//   T16.7  bench/load/slow_link/index.mjs    simulateSlowLink(scenario, { seed }) -> { events: ClientEvent[], maxQueueBytes, undeliveredBytes, dropped }
//                                            (sender queue bounded by backpressure; bytes are delayed, never invented; at the end the bytes still
//                                            queued are reported as undeliveredBytes, dropped = size of payload held back by backpressure then discarded at close; latencyMs
//                                            measured from payload request time, including wait time due to backpressure)
//   T16.8  tools/load_report/index.mjs       loadReport(result, opts) -> markdown table string (SPEC section 4 rows); opts.serverSamples (checked with checkServerSamples first, passing result.scenario.durationS) feeds a separate `cpu/rss source:` line; the `source:` line is 'simulated' whenever a record method is 'sim' For a cloud-approximation source (method 'loopback-socket') the first_frame_p95 row carries the note (handshake-complete basis, not an S5 value).
//   T16.9  bench/thresholds/index.mjs        checkThresholds(records, thresholds) -> string[] violations; thresholds.json beside it
//   T16.10 bench/load/run_all/run.mjs        node run.mjs -> runs every scenario, writes result JSON, exits non-zero on violations
//                                            runScenario(scenario, opts) and main(outDir, opts): opts.commit (default: commitHash()), opts.thresholds (default: loadThresholds()),
//                                            opts.statsClock (optional), opts.events (alternate log, default: simulated), opts.show (default: showFromArrivals) injectable.
//                                            In burst scenarios arrivals are generated from burstArrivals. Violations checked against the same measurement log; runScenario returns { result, violations, serverSamples } (serverSamples is NOT part of result).
//                                            Injected logs must have non-decreasing tMs (checkEventLog rejects the whole log otherwise); statsClock.clock is required whenever statsClock is given;
//                                            loadReport(result, opts) also accepts result.serverSamples as a fallback when opts.serverSamples is absent (opts wins).
//                                            An injected log also goes through validateScenario(scenario) first. statsClock: both now and cpuUsage or neither, unknown keys throw; source/clock are NOT pre-filled (createStatsSampler defaults apply);
//                                            a 'real' statsClock is checked by checkServerSamples(samples, { durationS }). checkBurstInvariants additionally reports
//                                            `client N: burst level K missing`, `burst levels not at one instant`, and `level K arrived more than once at Tms` for duplicates.
import { LEVEL_COUNT } from '../asset/index.mjs';

export const EVENT_KINDS = ['connect', 'bytes', 'level', 'first_frame', 'close'];

const KIND_KEYS = {
  connect: [], first_frame: [], close: [], bytes: ['bytes', 'latencyMs'], level: ['level'],
};
const COMMON_KEYS = ['id', 'tMs', 'kind'];

// Pre-compute allowed keys for each kind to avoid creating new Sets per event
const ALLOWED_KEYS_BY_KIND = {
  connect: new Set([...COMMON_KEYS, ...KIND_KEYS.connect]),
  first_frame: new Set([...COMMON_KEYS, ...KIND_KEYS.first_frame]),
  close: new Set([...COMMON_KEYS, ...KIND_KEYS.close]),
  bytes: new Set([...COMMON_KEYS, ...KIND_KEYS.bytes]),
  level: new Set([...COMMON_KEYS, ...KIND_KEYS.level]),
};

/** Returns violation strings for one event; empty means valid. */
export function validateEvent(e, clients) {
  const isInt = Number.isInteger;
  if (e === null || typeof e !== 'object' || Array.isArray(e)) return ['event must be an object'];
  const errs = [];
  if (!(isInt(e.id) && e.id >= 0 && e.id < clients)) errs.push('bad id');
  if (!(Number.isFinite(e.tMs) && e.tMs >= 0)) errs.push('bad tMs');
  if (!EVENT_KINDS.includes(e.kind)) errs.push('bad kind');
  if (e.kind === 'bytes') {
    if (!(isInt(e.bytes) && e.bytes >= 0)) errs.push('bad bytes');
    if (!(Number.isFinite(e.latencyMs) && e.latencyMs >= 0)) errs.push('bad latencyMs');
  }
  if (e.kind === 'level' && !(isInt(e.level) && e.level >= 0 && e.level < LEVEL_COUNT)) errs.push('bad level');
  if (EVENT_KINDS.includes(e.kind)) {
    const allowed = ALLOWED_KEYS_BY_KIND[e.kind];
    for (const k of Object.keys(e)) if (!allowed.has(k)) errs.push(`unexpected key ${k}`);
  }
  return errs;
}

/** Shared deterministic PRNG (mulberry32) so every module draws the same way from a seed. */
export function rng(seed) {
  if (!(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff)) throw new RangeError('seed must be an integer in 0..2^32-1');
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const FIXTURE_SCENARIO = {
  name: 'fixture', kind: 'steady', clients: 3, durationS: 10,
  path: [{ t: 0, e: 0, n: 0, u: 100 }, { t: 10, e: 30, n: 0, u: 100 }],
};
/** Tiny valid log for FIXTURE_SCENARIO: client 0 level arrival and first frame at 1200 ms, 1 at 2000 ms, 2 at 2800 ms. */
export const FIXTURE_EVENTS = [
  { id: 0, tMs: 0, kind: 'connect' }, { id: 1, tMs: 0, kind: 'connect' }, { id: 2, tMs: 0, kind: 'connect' },
  { id: 0, tMs: 1000, kind: 'bytes', bytes: 5000, latencyMs: 100 },
  { id: 0, tMs: 1200, kind: 'level', level: 0 }, { id: 0, tMs: 1200, kind: 'first_frame' },
  { id: 1, tMs: 1800, kind: 'bytes', bytes: 3000, latencyMs: 300 },
  { id: 1, tMs: 2000, kind: 'level', level: 0 }, { id: 1, tMs: 2000, kind: 'first_frame' },
  { id: 2, tMs: 2600, kind: 'bytes', bytes: 1000, latencyMs: 900 },
  { id: 2, tMs: 2800, kind: 'level', level: 0 }, { id: 2, tMs: 2800, kind: 'first_frame' },
  { id: 0, tMs: 9000, kind: 'close' }, { id: 1, tMs: 9000, kind: 'close' }, { id: 2, tMs: 9000, kind: 'close' },
];
