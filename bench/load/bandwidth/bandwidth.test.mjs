import { test } from "node:test";
import { strict as assert } from "node:assert";
import { bandwidthStats } from "./index.mjs";
import { FIXTURE_EVENTS } from "../../../contracts/load/harness.mjs";

test("bandwidthStats with FIXTURE_EVENTS", () => {
  const result = bandwidthStats(FIXTURE_EVENTS, 10);
  assert.strictEqual(result.totalBytes, 9000, "totalBytes should be 9000");
  assert.strictEqual(result.meanBytesPerS, 900, "meanBytesPerS should be 900");
  assert.strictEqual(result.peakBytesPerS, 8000, "peakBytesPerS should be 8000 (bucket 1 has 5000+3000)");
});

test("bandwidthStats with empty events", () => {
  const result = bandwidthStats([], 10);
  assert.strictEqual(result.totalBytes, 0, "totalBytes should be 0");
  assert.strictEqual(result.meanBytesPerS, 0, "meanBytesPerS should be 0");
  assert.strictEqual(result.peakBytesPerS, 0, "peakBytesPerS should be 0");
});

test("bandwidthStats with no bytes events", () => {
  const events = [
    { id: 0, tMs: 0, kind: "connect" },
    { id: 0, tMs: 100, kind: "first_frame" },
    { id: 0, tMs: 5000, kind: "close" }
  ];
  const result = bandwidthStats(events, 10);
  assert.strictEqual(result.totalBytes, 0, "totalBytes should be 0");
  assert.strictEqual(result.meanBytesPerS, 0, "meanBytesPerS should be 0");
  assert.strictEqual(result.peakBytesPerS, 0, "peakBytesPerS should be 0");
});

test("bandwidthStats boundary: tMs 999 vs 1000 in different buckets", () => {
  const events = [
    { id: 0, tMs: 999, kind: "bytes", bytes: 500, latencyMs: 100 },
    { id: 0, tMs: 1000, kind: "bytes", bytes: 600, latencyMs: 100 }
  ];
  const result = bandwidthStats(events, 2);
  assert.strictEqual(result.totalBytes, 1100, "totalBytes should be 1100");
  assert.strictEqual(result.peakBytesPerS, 600, "peakBytesPerS should be 600 (bucket 1, as 999 is in bucket 0)");
});

test("bandwidthStats throws RangeError for durationS <= 0", () => {
  assert.throws(
    () => bandwidthStats([], 0),
    RangeError,
    "should throw RangeError for durationS = 0"
  );
  assert.throws(
    () => bandwidthStats([], -1),
    RangeError,
    "should throw RangeError for durationS < 0"
  );
});
