import { test } from "node:test";
import { strict as assert } from "node:assert";
import { bandwidthStats, bandwidthViolations } from "./index.mjs";
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

test("bandwidthStats reports bad tMs in invalid instead of throwing", () => {
  for (const bad of [NaN, Infinity, -Infinity, -1, undefined, null, "5", 10001]) {
    const ev = [
      { id: 0, tMs: 500, kind: "bytes", bytes: 100, latencyMs: 1 },
      { id: 0, tMs: bad, kind: "bytes", bytes: 10, latencyMs: 1 },
    ];
    const r = bandwidthStats(ev, 10);
    assert.deepStrictEqual(r.invalid, [1], String(bad));
    assert.strictEqual(r.totalBytes, 100, String(bad));
    assert.strictEqual(r.peakBytesPerS, 100, String(bad));
    assert.deepStrictEqual(bandwidthViolations(r), ["bytes event 1: bad tMs"]);
  }
  assert.deepStrictEqual(bandwidthStats(FIXTURE_EVENTS, 10).invalid, []);
  assert.deepStrictEqual(bandwidthViolations(bandwidthStats([], 10)), []);
});

test("bandwidthStats folds tMs === durationS*1000 into the last bucket", () => {
  const ev = [
    { id: 0, tMs: 1500, kind: "bytes", bytes: 100, latencyMs: 1 },
    { id: 0, tMs: 2000, kind: "bytes", bytes: 250, latencyMs: 1 },
  ];
  const r = bandwidthStats(ev, 2);
  assert.strictEqual(r.totalBytes, 350);
  assert.strictEqual(r.peakBytesPerS, 350); // both in bucket 1
  assert.strictEqual(r.meanBytesPerS, 175);
  assert.deepStrictEqual(r.invalid, []);
});

test("bandwidthStats ignores tMs of non-bytes events", () => {
  const ev = [{ id: 0, tMs: NaN, kind: "close" }, { id: 0, tMs: 99999, kind: "connect" }];
  assert.strictEqual(bandwidthStats(ev, 10).totalBytes, 0);
});

test("bandwidthStats flags tMs beyond durationS*1000, accepts exactly durationS*1000", () => {
  const at = (t) => [{ id: 0, tMs: t, kind: "bytes", bytes: 10, latencyMs: 1 }];
  assert.deepStrictEqual(bandwidthStats(at(10001), 10).invalid, [0]);
  assert.deepStrictEqual(bandwidthStats(at(10000.5), 10).invalid, [0]);
  assert.strictEqual(bandwidthStats(at(10000), 10).totalBytes, 10);
});

test("bandwidthStats counts bytes in the last partial bucket (durationS 2.5)", () => {
  const ev = [
    { id: 0, tMs: 100, kind: "bytes", bytes: 10, latencyMs: 1 },
    { id: 0, tMs: 2200, kind: "bytes", bytes: 90, latencyMs: 1 },
    { id: 0, tMs: 2500, kind: "bytes", bytes: 10, latencyMs: 1 },
  ];
  const r = bandwidthStats(ev, 2.5);
  assert.strictEqual(r.totalBytes, 110);
  assert.deepStrictEqual(r.invalid, []);
  // bucket 2 (the partial one) holds 100 bytes over 0.5 s -> 200 B/s; with floor() the last bucket would
  // be index 1, the partial bytes would be merged into a 1.5 s bucket and peak would not be 200.
  assert.strictEqual(r.peakBytesPerS, 200);
  assert.strictEqual(r.meanBytesPerS, 44);
});

test("bandwidthStats peak >= mean with fractional durationS", () => {
  const ev = [
    { id: 0, tMs: 0, kind: "bytes", bytes: 10, latencyMs: 1 },
    { id: 0, tMs: 500, kind: "bytes", bytes: 10, latencyMs: 1 },
  ];
  const r = bandwidthStats(ev, 0.5);
  assert.strictEqual(r.meanBytesPerS, 40);
  assert.strictEqual(r.peakBytesPerS, 40);
  assert.ok(r.peakBytesPerS >= r.meanBytesPerS);
});

test("bandwidthStats property: peak >= mean for several durations and event placements", () => {
  const durations = [0.1, 0.5, 0.999, 1, 1.25, 2.5, 3.7, 10.01, 59.9];
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (const d of durations) {
    for (let trial = 0; trial < 20; trial++) {
      const ev = [];
      const n = 1 + Math.floor(rnd() * 8);
      for (let i = 0; i < n; i++) {
        const tMs = trial % 5 === 0 ? d * 1000 : rnd() * d * 1000;
        ev.push({ id: 0, tMs, kind: "bytes", bytes: Math.floor(rnd() * 1000), latencyMs: 1 });
      }
      const r = bandwidthStats(ev, d);
      assert.deepStrictEqual(r.invalid, [], `d=${d}`);
      assert.ok(r.peakBytesPerS >= r.meanBytesPerS * (1 - 1e-12), `d=${d} peak ${r.peakBytesPerS} < mean ${r.meanBytesPerS}`);
    }
  }
});

test("bandwidthStats applies the MAX_DURATION_S upper bound", () => {
  const ev = [{ id: 0, tMs: 0, kind: "bytes", bytes: 10, latencyMs: 1 }];
  assert.strictEqual(bandwidthStats(ev, MAX_DURATION_S).totalBytes, 10);
  assert.throws(() => bandwidthStats(ev, MAX_DURATION_S + 1), RangeError);
  assert.throws(() => bandwidthStats(ev, MAX_DURATION_S + 1e-9), RangeError);
  assert.throws(() => bandwidthStats(ev, 1e6), RangeError);
});

test("fractional durationS 1.005: event at tMs 1005 is valid and counted (float-safe end)", () => {
  const r = bandwidthStats([{ id: 0, kind: "bytes", tMs: 1005, bytes: 1, latencyMs: 0 }], 1.005);
  assert.deepStrictEqual(r.invalid, []);
  assert.strictEqual(r.totalBytes, 1);
});

test("fractional durationS 1.005: event at tMs 1006 is still invalid", () => {
  const r = bandwidthStats([{ id: 0, kind: "bytes", tMs: 1006, bytes: 1, latencyMs: 0 }], 1.005);
  assert.deepStrictEqual(r.invalid, [0]);
  assert.strictEqual(r.totalBytes, 0);
});
