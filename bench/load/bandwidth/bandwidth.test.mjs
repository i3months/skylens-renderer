import { test } from "node:test";
import { strict as assert } from "node:assert";
import { bandwidthStats } from "./index.mjs";
import { MAX_DURATION_S } from "../../../contracts/load/index.mjs";
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

test("bandwidthStats throws for NaN, undefined, non-finite, non-number durationS", () => {
  for (const bad of [NaN, undefined, Infinity, -Infinity, null, "10"]) {
    assert.throws(() => bandwidthStats([], bad), RangeError, String(bad));
  }
});

test("bandwidthStats throws for non-finite or negative bytes", () => {
  for (const bad of [NaN, Infinity, -5, undefined, "7"]) {
    const ev = [{ id: 0, tMs: 0, kind: "bytes", bytes: bad, latencyMs: 1 }];
    assert.throws(() => bandwidthStats(ev, 10), RangeError, String(bad));
  }
  const big = [1e308, 1e308].map((b) => ({ id: 0, tMs: 0, kind: "bytes", bytes: b, latencyMs: 1 }));
  assert.throws(() => bandwidthStats(big, 10), RangeError);
});

test("bandwidthStats handles MAX_DURATION_S buckets at the durationS limit", () => {
  const n = MAX_DURATION_S;
  const events = [];
  for (let k = 0; k < n; k++) events.push({ id: 0, tMs: k * 1000, kind: "bytes", bytes: k === 1234 ? 7000 : 10, latencyMs: 1 });
  const r = bandwidthStats(events, MAX_DURATION_S);
  assert.strictEqual(r.totalBytes, 7000 + 10 * (n - 1));
  assert.strictEqual(r.meanBytesPerS, (7000 + 10 * (n - 1)) / MAX_DURATION_S);
  assert.strictEqual(r.peakBytesPerS, 7000);
});

test("bandwidthStats throws for non-finite or negative tMs on bytes events", () => {
  for (const bad of [NaN, Infinity, -Infinity, -1, undefined, "5"]) {
    const ev = [{ id: 0, tMs: bad, kind: "bytes", bytes: 10, latencyMs: 1 }];
    assert.throws(() => bandwidthStats(ev, 10), RangeError, String(bad));
  }
});

test("bandwidthStats ignores tMs of non-bytes events", () => {
  const ev = [{ id: 0, tMs: NaN, kind: "close" }, { id: 0, tMs: 99999, kind: "connect" }];
  assert.strictEqual(bandwidthStats(ev, 10).totalBytes, 0);
});

test("bandwidthStats rejects tMs beyond durationS*1000, accepts exactly durationS*1000", () => {
  const at = (t) => [{ id: 0, tMs: t, kind: "bytes", bytes: 10, latencyMs: 1 }];
  assert.throws(() => bandwidthStats(at(10001), 10), RangeError);
  assert.throws(() => bandwidthStats(at(10000.5), 10), RangeError);
  assert.strictEqual(bandwidthStats(at(10000), 10).totalBytes, 10);
});

test("bandwidthStats applies the MAX_DURATION_S upper bound", () => {
  const ev = [{ id: 0, tMs: 0, kind: "bytes", bytes: 10, latencyMs: 1 }];
  assert.strictEqual(bandwidthStats(ev, MAX_DURATION_S).totalBytes, 10);
  assert.throws(() => bandwidthStats(ev, MAX_DURATION_S + 1), RangeError);
  assert.throws(() => bandwidthStats(ev, MAX_DURATION_S + 1e-9), RangeError);
  assert.throws(() => bandwidthStats(ev, 1e6), RangeError);
});
