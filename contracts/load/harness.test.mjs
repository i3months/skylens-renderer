import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEvent, rng, FIXTURE_EVENTS, FIXTURE_SCENARIO } from './harness.mjs';
import { validateScenario } from './index.mjs';

test('T16.0b: fixture satisfies contract', () => {
  assert.deepEqual(validateScenario(FIXTURE_SCENARIO), []);
  for (const e of FIXTURE_EVENTS) assert.deepEqual(validateEvent(e, 3), []);
});
test('T16.0b: event validation', () => {
  assert.deepEqual(validateEvent({ id: 3, tMs: 0, kind: 'connect' }, 3), ['bad id']);
  assert.deepEqual(validateEvent({ id: 0, tMs: -1, kind: 'connect' }, 3), ['bad tMs']);
  assert.deepEqual(validateEvent({ id: 0, tMs: 0, kind: 'x' }, 3), ['bad kind']);
  assert.deepEqual(validateEvent({ id: 0, tMs: 0, kind: 'bytes', bytes: 1.5, latencyMs: -1 }, 3), ['bad bytes', 'bad latencyMs']);
  assert.deepEqual(validateEvent({ id: 0, tMs: 0, kind: 'level', level: 4 }, 3), ['bad level']);
  assert.deepEqual(validateEvent(null, 3), ['event must be an object']);
});
test('T16.0b: rng deterministic', () => {
  const a = rng(7); const b = rng(7);
  const xs = [a(), a(), a()];
  assert.deepEqual(xs, [b(), b(), b()]);
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.notEqual(rng(8)(), xs[0]);
});

test('T16.0b: validateEvent id/event shape validation', () => {
  const ok = { tMs: 0, kind: 'connect' };
  for (const id of [-1, 1.5, 3, '0', NaN, undefined]) assert.deepEqual(validateEvent({ ...ok, id }, 3), ['bad id']);
  assert.deepEqual(validateEvent({ ...ok, id: 2 }, 3), []);
  assert.deepEqual(validateEvent({ ...ok, id: 0 }, 3), []);
  for (const e of [[], null, 'connect', 5, undefined]) assert.deepEqual(validateEvent(e, 3), ['event must be an object']);
});
test('T16.0b: validateEvent level/tMs/kind/bytes/latencyMs validation', () => {
  const lv = (level) => ({ id: 0, tMs: 0, kind: 'level', level });
  for (const level of [-1, 4, 1.5]) assert.deepEqual(validateEvent(lv(level), 3), ['bad level']);
  for (const level of [0, 3]) assert.deepEqual(validateEvent(lv(level), 3), []);
  for (const tMs of [NaN, Infinity, -1]) assert.deepEqual(validateEvent({ id: 0, tMs, kind: 'connect' }, 3), ['bad tMs']);
  assert.deepEqual(validateEvent({ id: 0, tMs: 0, kind: 'bogus' }, 3), ['bad kind']);
  const by = (bytes, latencyMs) => ({ id: 0, tMs: 0, kind: 'bytes', bytes, latencyMs });
  for (const bytes of [-1, 1.5]) assert.deepEqual(validateEvent(by(bytes, 0), 3), ['bad bytes']);
  for (const latencyMs of [NaN, -1, Infinity]) assert.deepEqual(validateEvent(by(0, latencyMs), 3), ['bad latencyMs']);
  assert.deepEqual(validateEvent(by(0, 0), 3), []);
});
test('T16.0b: validateEvent kind allowed keys', () => {
  assert.deepEqual(validateEvent({ id: 0, tMs: 0, kind: 'connect', bytes: 1 }, 3), ['unexpected key bytes']);
  assert.deepEqual(validateEvent({ id: 0, tMs: 0, kind: 'close', level: 0 }, 3), ['unexpected key level']);
  assert.deepEqual(validateEvent({ id: 0, tMs: 0, kind: 'first_frame', latencyMs: 1 }, 3), ['unexpected key latencyMs']);
  assert.deepEqual(validateEvent({ id: 0, tMs: 0, kind: 'level', level: 1, bytes: 1 }, 3), ['unexpected key bytes']);
  assert.deepEqual(validateEvent({ id: 0, tMs: 0, kind: 'bytes', bytes: 1, latencyMs: 1, level: 1 }, 3), ['unexpected key level']);
  assert.deepEqual(validateEvent({ id: 0, tMs: 0, kind: 'connect', extra: 1, more: 2 }, 3), ['unexpected key extra', 'unexpected key more']);
});
test('T16.0b: rng(7) first 3 values fixed', () => {
  const r = rng(7);
  assert.deepEqual([r(), r(), r()], [0.011704753153026104, 0.06195825757458806, 0.97690763277933]);
});
test('T16.0b: rng seed must be integer 0..2^32-1', () => {
  for (const s of [1.7, -1, 2 ** 32, NaN, Infinity, '7', null, undefined]) assert.throws(() => rng(s), RangeError);
  assert.doesNotThrow(() => rng(0));
  assert.doesNotThrow(() => rng(2 ** 32 - 1));
});

test('T16.2: createStatsSampler documentation signature and defaults are correct', () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const harnessSrc = readFileSync(join(__dirname, 'harness.mjs'), 'utf8');

  // Check that createStatsSampler({ ... clock ... appears exactly once in the file
  const createStatsSamplerMatches = harnessSrc.match(/createStatsSampler\(\{\s*cpuUsage,\s*memoryUsage,\s*now,\s*clock,\s*source,\s*cpuStub\s*\}\)/g);
  assert.equal(createStatsSamplerMatches ? createStatsSamplerMatches.length : 0, 1, 'createStatsSampler signature should appear exactly once');

  // Check that the old incorrect phrasing is gone
  const oldIncorrectPhrase = "'harness-process' and clock 'simulated'";
  const occurrences = (harnessSrc.match(new RegExp(oldIncorrectPhrase, 'g')) || []).length;
  assert.equal(occurrences, 0, `"${oldIncorrectPhrase}" should not occur in harness.mjs`);
});

test('F-550: FIXTURE_EVENTS validate, are sorted, and carry level-0 arrivals before first_frame', () => {
  for (const e of FIXTURE_EVENTS) assert.deepEqual(validateEvent(e, 3), [], JSON.stringify(e));
  for (let i = 1; i < FIXTURE_EVENTS.length; i++) assert.ok(FIXTURE_EVENTS[i - 1].tMs <= FIXTURE_EVENTS[i].tMs, `index ${i}`);
  for (const id of [0, 1]) {
    const mine = FIXTURE_EVENTS.filter((e) => e.id === id);
    const ff = mine.find((e) => e.kind === 'first_frame');
    const lv0 = mine.find((e) => e.kind === 'level' && e.level === 0);
    assert.ok(ff, `client ${id} first_frame`);
    assert.ok(lv0 && lv0.tMs <= ff.tMs, `client ${id} level-0 arrival at or before first_frame`);
  }
  const c2 = FIXTURE_EVENTS.filter((e) => e.id === 2);
  assert.ok(!c2.some((e) => e.kind === 'first_frame' || e.kind === 'level'));
});

test('F-550: harness header documents noArrival, clock, tMs order and the serverSamples fallback', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'harness.mjs'), 'utf8');
  const header = src.slice(0, src.indexOf('import '));
  for (const re of [/noArrival/, /\bclock\b/, /(non-decreasing tMs|tMs order|monotonic)/i, /serverSamples[^\n]*fallback|fallback[^\n]*serverSamples/]) {
    assert.ok(re.test(header), String(re));
  }
});
