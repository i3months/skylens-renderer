// Bandwidth statistics for T16.5 over 1-second buckets of the event log.

import { MAX_DURATION_S } from '../../../contracts/load/index.mjs';

/**
 * @param {Array} events - client events
 * @param {number} durationS - scenario duration in seconds, finite, > 0 and <= MAX_DURATION_S
 * @returns {{totalBytes: number, meanBytesPerS: number, peakBytesPerS: number, invalid: number[]}}
 *   totalBytes in bytes; meanBytesPerS and peakBytesPerS in bytes per second (B/s);
 *   invalid = indexes of bytes events with non-finite/negative tMs or tMs > durationS*1000 (excluded from totals);
 *   tMs === durationS*1000 is folded into the last bucket.
 *   peak = highest per-bucket rate in B/s: bucket bytes / bucket width in seconds, over buckets [1000k, 1000k+1000) ms.
 *   Full buckets are 1 s wide (peak = most bytes in one second). With fractional durationS the last bucket is only
 *   durationS - floor-part wide, so its rate is bytes / that width; this guarantees peak >= mean always.
 * @throws {RangeError} durationS not a finite number in (0, MAX_DURATION_S], or a bytes event with non-finite/negative bytes
 *   (bad tMs does not throw, see invalid)
 */
export function bandwidthStats(events, durationS) {
  if (!(typeof durationS === 'number' && Number.isFinite(durationS) && durationS > 0 && durationS <= MAX_DURATION_S)) {
    throw new RangeError(`durationS must be a finite number in (0, ${MAX_DURATION_S}]`);
  }
  if (!Array.isArray(events)) throw new TypeError('events must be an array');

  let totalBytes = 0;
  const invalid = [];
  const lastBucket = Math.ceil(durationS) - 1;
  const buckets = new Map();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e || e.kind !== 'bytes') continue;
    if (!(typeof e.bytes === 'number' && Number.isFinite(e.bytes) && e.bytes >= 0)) {
      throw new RangeError('bytes must be a finite number >= 0');
    }
    // bad tMs never throws: the event is reported in `invalid` and excluded from every total.
    // tMs === durationS*1000 is accepted and folded into the last bucket.
    if (!(typeof e.tMs === 'number' && Number.isFinite(e.tMs) && e.tMs >= 0 && e.tMs <= durationS * 1000)) {
      invalid.push(i);
      continue;
    }
    totalBytes += e.bytes;
    const k = Math.min(Math.floor(e.tMs / 1000), lastBucket);
    buckets.set(k, (buckets.get(k) ?? 0) + e.bytes);
  }
  if (!Number.isFinite(totalBytes)) throw new RangeError('totalBytes overflowed');

  // Peak is a rate: each bucket's bytes are divided by the bucket's width in seconds. All buckets are 1 s wide
  // except the last one, whose width is durationS - lastBucket (in (0, 1]; exactly 1 for integral durationS).
  // Dividing by the real width keeps peak >= mean (mean is the width-weighted average of the bucket rates).
  let peakBytesPerS = 0;
  for (const [k, v] of buckets) {
    const widthS = k === lastBucket ? durationS - lastBucket : 1;
    const rate = v / widthS;
    if (rate > peakBytesPerS) peakBytesPerS = rate;
  }

  return { totalBytes, meanBytesPerS: totalBytes / durationS, peakBytesPerS, invalid };
}

/** Violation strings for a bandwidthStats result: one `bytes event i: bad tMs` per invalid event. */
export function bandwidthViolations(bw) {
  return (bw?.invalid ?? []).map((i) => `bytes event ${i}: bad tMs`);
}
