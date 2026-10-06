// T16.4 first-frame latency statistics over a ClientEvent log (see contracts/load/harness.mjs).
// Pure function: no wall clock, no I/O.
// First frame = the time the first level-0 payload arrived and was drawn (contract header definition);
// the 'first_frame' event carries that time, and latency is measured from the client's 'connect'.

import { MAX_CLIENTS } from '../../../contracts/load/index.mjs';

/**
 * Regression threshold of the mock harness (the SPEC S5 value is reused as is).
 * Verdicts against a real server are a separate [local] follow-up.
 */
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
 * so it ranks above every finite value in the percentiles. A first_frame earlier than the client's
 * connect is impossible data and also gets Infinity (never a negative latency).
 * If no client reached a first frame at all, p50Ms and p95Ms are NaN (nothing was measured).
 */
export function firstFrameStats(events, clients) {
  if (!Array.isArray(events)) {
    throw new Error('events must be an array');
  }
  for (const e of events) {
    if (e === null || e === undefined) {
      throw new Error(`events array contains ${e === null ? 'null' : 'undefined'}`);
    }
  }
  if (!Number.isInteger(clients) || clients < 1 || clients > MAX_CLIENTS) {
    throw new RangeError(`clients must be an integer in 1..${MAX_CLIENTS}`);
  }
  const connect = new Array(clients).fill(Infinity);
  const frame = new Array(clients).fill(Infinity);
  for (const e of events) {
    if (!Number.isInteger(e.id) || e.id < 0 || e.id >= clients) continue;
    if (e.kind === 'connect' && e.tMs < connect[e.id]) connect[e.id] = e.tMs;
    else if (e.kind === 'first_frame' && e.tMs < frame[e.id]) frame[e.id] = e.tMs;
  }
  const perClientMs = connect.map((c, id) =>
    Number.isFinite(c) && Number.isFinite(frame[id]) && frame[id] >= c ? frame[id] - c : Infinity);
  if (!perClientMs.some(Number.isFinite)) return { p50Ms: NaN, p95Ms: NaN, perClientMs };
  const sorted = [...perClientMs].sort((a, b) => a - b);
  return { p50Ms: nearestRank(sorted, 0.5), p95Ms: nearestRank(sorted, 0.95), perClientMs };
}

/** Returns violation strings (an input-check violation if stats.p95Ms is not a number); empty only when p95 is a number <= FIRST_FRAME_P95_LIMIT_MS (NaN fails). */
export function firstFrameViolations(stats) {
  if (stats === null || typeof stats !== 'object' || typeof stats.p95Ms !== 'number') {
    return ['first-frame stats input invalid: p95Ms must be a number'];
  }
  if (Number.isNaN(stats.p95Ms)) return ['first-frame p95 is NaN: no first frame was measured'];
  if (stats.p95Ms <= FIRST_FRAME_P95_LIMIT_MS) return [];
  return [`first-frame p95 ${stats.p95Ms} ms exceeds limit ${FIRST_FRAME_P95_LIMIT_MS} ms`];
}
