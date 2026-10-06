// T16.4 first-frame latency statistics over a ClientEvent log (see contracts/load/harness.mjs).
// Pure function: no wall clock, no I/O.
// First frame = the time the first level payload (any level) arrived and was drawn (contract header definition);
// the 'first_frame' event carries that time, and latency is measured from the client's 'connect'.

import { MAX_CLIENTS } from '../../../contracts/load/index.mjs';
import { LEVEL_COUNT } from '../../../contracts/asset/index.mjs';

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
 * firstFrameStats(events, clients) -> { p50Ms, p95Ms, perClientMs, missing, noArrival, outOfOrder }
 * missing = ascending ids whose perClientMs is Infinity (no usable first frame).
 * noArrival = ascending ids that had a first_frame but no level arrival (any level) at or before it (subset of missing).
 * perClientMs[id] = first 'first_frame' tMs minus the client's 'connect' tMs.
 * A first_frame counts only if the same id has a 'level' event (any level) at tMs <= that first_frame's tMs;
 * otherwise the client gets Infinity (never filled in) and, if it had a first_frame, its id is in noArrival.
 * A client with no first_frame (or no connect) gets Infinity; it is never dropped or filled in,
 * so it ranks above every finite value in the percentiles. A first_frame earlier than the client's
 * connect is impossible data and also gets Infinity (never a negative latency).
 * outOfOrder = ascending-id list of { id, reason } for impossible orderings, never silently discarded:
 * 'before_connect' = some first_frame tMs < the client's connect tMs (client needs a connect);
 * 'before_firstArrival' = some first_frame tMs < the client's earliest first level arrival (any level; min over all valid level events, not first seen),
 * including the case where that client has no level arrival (any level) at all. before_connect takes precedence per client.
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
  const firstArrival = new Array(clients).fill(Infinity);
  const frames = Array.from({ length: clients }, () => []);
  for (const e of events) {
    if (!Number.isInteger(e.id) || e.id < 0 || e.id >= clients) continue;
    if (e.kind === 'connect' && e.tMs < connect[e.id]) connect[e.id] = e.tMs;
    else if (e.kind === 'level' && Number.isInteger(e.level) && e.level >= 0 && e.level < LEVEL_COUNT && e.tMs < firstArrival[e.id]) firstArrival[e.id] = e.tMs;
    else if (e.kind === 'first_frame') frames[e.id].push(e.tMs);
  }
  // A first_frame counts only if a level arrival (any level) of the same id is at tMs <= the first_frame tMs.
  const frame = new Array(clients).fill(Infinity);
  const noArrival = [];
  frames.forEach((list, id) => {
    for (const t of list) if (t >= firstArrival[id] && t < frame[id]) frame[id] = t;
    if (list.length > 0 && frame[id] === Infinity) noArrival.push(id);
  });
  const outOfOrder = [];
  frames.forEach((list, id) => {
    if (list.some((t) => t < connect[id])) outOfOrder.push({ id, reason: 'before_connect' });
    else if (list.some((t) => t < firstArrival[id])) outOfOrder.push({ id, reason: 'before_firstArrival' });
  });
  const perClientMs = connect.map((c, id) =>
    Number.isFinite(c) && Number.isFinite(frame[id]) && frame[id] >= c ? frame[id] - c : Infinity);
  const missing = [];
  perClientMs.forEach((ms, id) => { if (!Number.isFinite(ms)) missing.push(id); });
  if (!perClientMs.some(Number.isFinite)) return { p50Ms: NaN, p95Ms: NaN, perClientMs, missing, noArrival, outOfOrder };
  const sorted = [...perClientMs].sort((a, b) => a - b);
  return { p50Ms: nearestRank(sorted, 0.5), p95Ms: nearestRank(sorted, 0.95), perClientMs, missing, noArrival, outOfOrder };
}

/**
 * Returns violation strings (an input-check violation if stats.p95Ms is not a number). Empty only when p95 is a
 * number <= FIRST_FRAME_P95_LIMIT_MS (NaN fails) and no client lacks a first frame. Every client without one yields
 * `client N: no first frame` in id order (`client N: first_frame without level-0 arrival` if it had a first_frame but no arrival); an Infinity p95 caused only by such clients is not reported twice.
 */
export function firstFrameViolations(stats) {
  if (stats === null || typeof stats !== 'object' || typeof stats.p95Ms !== 'number') {
    return ['first-frame stats input invalid: p95Ms must be a number'];
  }
  const bad = [];
  if (stats.missing !== undefined && !Array.isArray(stats.missing)) bad.push('missing must be an array');
  if (stats.perClientMs !== undefined && !Array.isArray(stats.perClientMs)) bad.push('perClientMs must be an array');
  if (stats.noArrival !== undefined && !Array.isArray(stats.noArrival)) bad.push('noArrival must be an array');
  if (stats.outOfOrder !== undefined) {
    if (!Array.isArray(stats.outOfOrder)) bad.push('outOfOrder must be an array');
    else if (!stats.outOfOrder.every((o) => o !== null && typeof o === 'object' && Number.isInteger(o.id) && typeof o.reason === 'string')) {
      bad.push('outOfOrder entries must be { id, reason }');
    }
  }
  if (stats.missing === undefined && stats.perClientMs === undefined) bad.push('missing or perClientMs is required');
  if (bad.length > 0) return [`first-frame stats input invalid: ${bad.join('; ')}`];
  let missing = [];
  // An explicit missing list takes priority over perClientMs.
  if (Array.isArray(stats.missing)) missing = stats.missing;
  else if (Array.isArray(stats.perClientMs)) {
    stats.perClientMs.forEach((ms, id) => { if (!Number.isFinite(ms)) missing.push(id); });
  }
  const out = [];
  if (Number.isNaN(stats.p95Ms)) out.push('first-frame p95 is NaN: no first frame was measured');
  else if (stats.p95Ms > FIRST_FRAME_P95_LIMIT_MS && !(stats.p95Ms === Infinity && missing.length > 0)) {
    out.push(`first-frame p95 ${stats.p95Ms} ms exceeds limit ${FIRST_FRAME_P95_LIMIT_MS} ms`);
  }
  const noArrival = Array.isArray(stats.noArrival) ? stats.noArrival : [];
  const order = new Map();
  if (Array.isArray(stats.outOfOrder)) for (const o of stats.outOfOrder) if (o !== null && typeof o === 'object') order.set(o.id, o.reason);
  // Per client, in id order, exactly one message:
  //  before_connect (missing or not): `client N: first_frame before connect (out of order)`, replaces 'no first frame';
  //  missing otherwise: 'first_frame without level-0 arrival' / 'no first frame' as before;
  //  not missing but an earlier first_frame preceded the level-0 arrival:
  //  `client N: first_frame before level-0 arrival (out of order)`.
  const ids = [...new Set([...missing, ...order.keys()])].sort((a, b) => a - b);
  for (const id of ids) {
    const reason = order.get(id);
    const isMissing = missing.includes(id);
    if (reason === 'before_connect') out.push(`client ${id}: first_frame before connect (out of order)`);
    else if (isMissing) out.push(noArrival.includes(id) ? `client ${id}: first_frame without level-0 arrival` : `client ${id}: no first frame`);
    else if (reason === 'before_firstArrival') out.push(`client ${id}: first_frame before level-0 arrival (out of order)`);
    else if (reason !== undefined) out.push(`client ${id}: first_frame out of order (unknown reason ${JSON.stringify(reason)})`);
  }
  return out;
}
