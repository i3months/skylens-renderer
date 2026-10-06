// Bandwidth statistics for T16.5 over 1-second buckets of the event log.

import { MAX_DURATION_S } from '../../../contracts/load/index.mjs';

/**
 * @param {Array} events - client events
 * @param {number} durationS - scenario duration in seconds, finite, > 0 and <= MAX_DURATION_S
 * @returns {{totalBytes: number, meanBytesPerS: number, peakBytesPerS: number}}
 *   totalBytes in bytes; meanBytesPerS and peakBytesPerS in bytes per second (B/s);
 *   peak = most bytes received in any one 1 s bucket [1000k, 1000k+1000) ms.
 * @throws {RangeError} durationS not a finite number in (0, MAX_DURATION_S], or a bytes event with non-finite/negative bytes,
 *   non-finite/negative tMs, or tMs > durationS * 1000
 */
export function bandwidthStats(events, durationS) {
  if (!(typeof durationS === 'number' && Number.isFinite(durationS) && durationS > 0 && durationS <= MAX_DURATION_S)) {
    throw new RangeError(`durationS must be a finite number in (0, ${MAX_DURATION_S}]`);
  }
  if (!Array.isArray(events)) throw new TypeError('events must be an array');

  let totalBytes = 0;
  const buckets = new Map();
  for (const e of events) {
    if (!e || e.kind !== 'bytes') continue;
    if (!(typeof e.bytes === 'number' && Number.isFinite(e.bytes) && e.bytes >= 0)) {
      throw new RangeError('bytes must be a finite number >= 0');
    }
    if (!(Number.isFinite(e.tMs) && e.tMs >= 0)) {
      throw new RangeError('tMs must be a finite number >= 0');
    }
    // events after the scenario window are an input error; tMs === durationS*1000 is accepted
    if (e.tMs > durationS * 1000) throw new RangeError('tMs must be <= durationS * 1000');
    totalBytes += e.bytes;
    const k = Math.floor(e.tMs / 1000);
    buckets.set(k, (buckets.get(k) ?? 0) + e.bytes);
  }
  if (!Number.isFinite(totalBytes)) throw new RangeError('totalBytes overflowed');

  let peakBytesPerS = 0; // loop, not Math.max(...spread): no argument-count limit
  for (const v of buckets.values()) if (v > peakBytesPerS) peakBytesPerS = v;

  return { totalBytes, meanBytesPerS: totalBytes / durationS, peakBytesPerS };
}
