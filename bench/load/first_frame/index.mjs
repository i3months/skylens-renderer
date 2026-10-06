// T16.4 first-frame latency statistics over a ClientEvent log (see contracts/load/harness.mjs).
// Pure function: no wall clock, no I/O.

/** SPEC target: p95 first-frame latency <= 3 s (headless reference). */
export const FIRST_FRAME_P95_LIMIT_MS = 3000;

/** Nearest-rank percentile of an ascending array: the ceil(p*n)-th smallest. Infinity sorts last. */
function nearestRank(sortedAsc, p) {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const rank = Math.min(n, Math.max(1, Math.ceil(p * n)));
  return sortedAsc[rank - 1];
}

/**
 * firstFrameStats(events, clients) -> { p50Ms, p95Ms, perClientMs }
 * perClientMs[id] = first 'first_frame' tMs minus the client's 'connect' tMs.
 * A client with no first_frame (or no connect) gets Infinity; it is never dropped or filled in,
 * so it ranks above every finite value in the percentiles.
 */
export function firstFrameStats(events, clients) {
  const connect = new Array(clients).fill(Infinity);
  const frame = new Array(clients).fill(Infinity);
  for (const e of events) {
    if (!Number.isInteger(e.id) || e.id < 0 || e.id >= clients) continue;
    if (e.kind === 'connect' && e.tMs < connect[e.id]) connect[e.id] = e.tMs;
    else if (e.kind === 'first_frame' && e.tMs < frame[e.id]) frame[e.id] = e.tMs;
  }
  const perClientMs = connect.map((c, id) =>
    Number.isFinite(c) && Number.isFinite(frame[id]) ? frame[id] - c : Infinity);
  const sorted = [...perClientMs].sort((a, b) => a - b);
  return { p50Ms: nearestRank(sorted, 0.5), p95Ms: nearestRank(sorted, 0.95), perClientMs };
}

/** Returns violation strings; empty when p95 <= FIRST_FRAME_P95_LIMIT_MS. */
export function firstFrameViolations(stats) {
  if (stats.p95Ms <= FIRST_FRAME_P95_LIMIT_MS) return [];
  return [`first-frame p95 ${stats.p95Ms} ms exceeds limit ${FIRST_FRAME_P95_LIMIT_MS} ms`];
}
