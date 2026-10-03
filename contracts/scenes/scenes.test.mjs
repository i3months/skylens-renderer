import test from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, subSeed, point27ToGauss56, makeResult, packRecords, resultHash, assertSceneResult, LEVEL_STEPS, SCENES, FORMAT_POINT27, FORMAT_GAUSS56 } from './index.mjs';

const cloud = (n) => {
  const r = mulberry32(7);
  const positions = new Float32Array(3 * n).map(() => r() * 10);
  const normals = new Float32Array(3 * n); for (let i = 0; i < n; i++) normals[3 * i + 1] = 1;
  const colors = new Uint8Array(3 * n).map(() => Math.floor(r() * 256));
  return { format: FORMAT_POINT27, count: n, positions, normals, colors };
};
const truth = { bounds: { min: [0, 0, 0], max: [10, 10, 10] } };

test('mulberry32_known_sequence', () => {
  const r = mulberry32(1);
  assert.deepEqual([r(), r(), r()].map((x) => Math.round(x * 1e6)), [627074, 2736, 527447]);
});
test('mulberry32_same_seed_same_sequence_and_range', () => {
  const a = mulberry32(42), b = mulberry32(42);
  for (let i = 0; i < 1000; i++) { const x = a(); assert.equal(x, b()); assert.ok(x >= 0 && x < 1); }
  assert.notEqual(mulberry32(1)(), mulberry32(2)());
});
test('subSeed_distinct_per_index', () => {
  const s = new Set(Array.from({ length: 100 }, (_, i) => subSeed(5, i)));
  assert.equal(s.size, 100);
});
test('levels_steps_fixed', () => assert.deepEqual([...LEVEL_STEPS], [250, 1000, 3500, 7000]));
test('scenes_table_has_eight', () => assert.equal(Object.keys(SCENES).length, 8));
test('pack_records_sizes_27_and_56', () => {
  const c = cloud(5);
  assert.equal(packRecords(c).length, 27 * 5);
  assert.equal(packRecords(point27ToGauss56(c)).length, 56 * 5);
});
test('pack_records_27_layout', () => {
  const c = cloud(2);
  const b = packRecords(c); const dv = new DataView(b.buffer);
  assert.equal(dv.getFloat32(27, true), c.positions[3]);
  assert.equal(dv.getFloat32(27 + 16, true), c.normals[4]);
  assert.deepEqual([...b.subarray(27 + 24, 27 + 27)], [...c.colors.subarray(3, 6)]);
});
test('gauss56_conversion_values', () => {
  const g = point27ToGauss56({ ...cloud(1), colors: Uint8Array.of(255, 0, 128) });
  assert.ok(Math.abs(g.fdc[0] - 0.5 / 0.28209479177387814) < 1e-5);
  assert.ok(Math.abs(g.fdc[1] + 0.5 / 0.28209479177387814) < 1e-5);
  assert.ok(Math.abs(1 / (1 + Math.exp(-g.opacity[0])) - 0.9) < 1e-6);
  assert.deepEqual([...g.rotations], [1, 0, 0, 0]);
});
test('result_hash_stable_and_sensitive', () => {
  const r = makeResult('flat_boxes', 1, FORMAT_POINT27, cloud(10), truth);
  assert.equal(resultHash(r), resultHash(makeResult('flat_boxes', 1, FORMAT_POINT27, cloud(10), truth)));
  const c2 = cloud(10); c2.colors[0] ^= 1;
  assert.notEqual(resultHash(r), resultHash(makeResult('flat_boxes', 1, FORMAT_POINT27, c2, truth)));
});
test('assert_result_accepts_both_formats', () => {
  for (const f of [FORMAT_POINT27, FORMAT_GAUSS56]) assertSceneResult(makeResult('terrain', 3, f, cloud(4), truth), { scene: 'terrain', count: 4 });
});
test('assert_result_rejects_bad', () => {
  const ok = () => makeResult('terrain', 3, FORMAT_POINT27, cloud(4), truth);
  assert.throws(() => assertSceneResult({ ...ok(), scene: 'nope' }), /알 수 없는/);
  assert.throws(() => assertSceneResult({ ...ok(), truth: {} }), /bounds/);
  assert.throws(() => assertSceneResult(ok(), { count: 5 }), /count/);
  const r = ok(); r.cloud.positions[0] = NaN;
  assert.throws(() => assertSceneResult(r), /비유한/);
  const s = ok(); s.cloud.colors = new Uint8Array(3);
  assert.throws(() => assertSceneResult(s), /colors/);
});
