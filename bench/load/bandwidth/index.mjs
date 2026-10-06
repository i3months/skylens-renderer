// Bandwidth statistics calculation for T16.5.
// Analyzes event logs to compute bandwidth metrics over 1-second buckets.

/**
 * Calculate bandwidth statistics from a client event log.
 * @param {Array} events - Array of client events
 * @param {number} durationS - Total duration in seconds
 * @returns {Object} {totalBytes, meanBytesPerS, peakBytesPerS}
 * @throws {RangeError} if durationS <= 0
 */
export function bandwidthStats(events, durationS) {
  if (durationS <= 0) {
    throw new RangeError("durationS must be positive");
  }

  // Filter to only "bytes" events (skip connect, level, first_frame, close)
  const byteEvents = events.filter(e => e.kind === "bytes");

  // Calculate total bytes
  const totalBytes = byteEvents.reduce((sum, e) => sum + e.bytes, 0);

  // Calculate mean bytes per second
  const meanBytesPerS = totalBytes / durationS;

  // Calculate peak bytes per second (max bytes in any 1-second bucket)
  // Bucket k contains events where tMs is in [1000k, 1000k+1000)
  const buckets = {};
  for (const event of byteEvents) {
    const bucket = Math.floor(event.tMs / 1000);
    if (!buckets[bucket]) {
      buckets[bucket] = 0;
    }
    buckets[bucket] += event.bytes;
  }

  // Find the maximum bytes in any single bucket
  const peakBytesPerS = Object.values(buckets).length > 0
    ? Math.max(...Object.values(buckets))
    : 0;

  return {
    totalBytes,
    meanBytesPerS,
    peakBytesPerS
  };
}
