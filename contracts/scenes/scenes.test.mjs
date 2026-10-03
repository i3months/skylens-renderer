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

import { checkCount, normalizeSeed, checkFormat } from './index.mjs';
test('check_count_accepts_integers_and_default', () => {
  assert.equal(checkCount(0, 5), 0); assert.equal(checkCount(1, 5), 1); assert.equal(checkCount(undefined, 5), 5);
});
test('check_count_rejects_bad', () => {
  for (const v of [NaN, -5, 10.5, Infinity, '3', null]) assert.throws(() => checkCount(v, 5), /count/);
});
test('normalize_seed_default_and_rejects', () => {
  assert.equal(normalizeSeed(undefined), 1); assert.equal(normalizeSeed(0xffffffff), 0xffffffff);
  for (const v of [1.5, NaN, 'abc', -1, 2 ** 32]) assert.throws(() => normalizeSeed(v), /seed/);
});
test('check_format_only_1_or_2', () => {
  assert.equal(checkFormat(undefined), 1); assert.equal(checkFormat(2), 2);
  for (const v of [3, 0, '1', null]) assert.throws(() => checkFormat(v), /format/);
});

// ---- F-083: 56 B 포장 검사(장면 모듈에 의존하지 않는 인라인 점군) ----
const C0 = 0.28209479177387814;
const f32 = Math.fround;
test('pack56_offsets_per_field', () => {
  const c = cloud(6);
  const g = makeResult('terrain', 1, FORMAT_GAUSS56, c, truth).cloud;
  const b = packRecords(g); const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  assert.equal(b.length, 56 * 6);
  for (let i = 0; i < 6; i++) {
    const o = 56 * i; const F = (k) => dv.getFloat32(o + 4 * k, true);
    for (let k = 0; k < 3; k++) assert.equal(F(k), c.positions[3 * i + k], `위치 ${i}/${k}`);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(F(3 + k) - (c.colors[3 * i + k] / 255 - 0.5) / C0) < 1e-5, `f_dc ${i}/${k}`);
    assert.ok(Math.abs(F(6) - Math.log(9)) < 1e-6, 'opacity 로짓 = logit(0.9)');
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(F(7 + k) - Math.log(0.05)) < 1e-6, `scale ${k} = ln 0.05`);
    assert.deepEqual([F(10), F(11), F(12), F(13)], [1, 0, 0, 0]);
  }
});
test('format1_and_2_share_positions_from_same_input', () => {
  const r1 = makeResult('terrain', 1, FORMAT_POINT27, cloud(20), truth);
  const r2 = makeResult('terrain', 1, FORMAT_GAUSS56, cloud(20), truth);
  assert.deepEqual([...r2.cloud.positions], [...r1.cloud.positions]);
  assert.ok(r2.cloud.positions.some((x) => x !== 0));
});
test('gauss56_fdc_inverse_recovers_colors', () => {
  const c = cloud(30);
  const g = point27ToGauss56(c);
  for (let i = 0; i < 90; i++) assert.ok(Math.abs((g.fdc[i] * C0 + 0.5) * 255 - c.colors[i]) < 1e-2, `fdc ${i}`);
});
test('gauss56_scales_are_log_sigma', () => {
  const g = point27ToGauss56(cloud(4), 0.05);
  for (const s of g.scales) assert.ok(Math.abs(s - Math.log(0.05)) < 1e-6);
  assert.ok(g.scales[0] < 0, '로그 값이면 음수(σ=0.05 그대로면 양수)');
  const h = point27ToGauss56(cloud(2), 2);
  assert.ok(Math.abs(h.scales[0] - Math.log(2)) < 1e-6);
});

// ---- F-085 ⑦ / F-086 ② / F-088 ④ ----
test('assert_result_rejects_bounds_min_gt_max_seed_and_format_mismatch', () => {
  const ok = () => makeResult('terrain', 3, FORMAT_POINT27, cloud(4), truth);
  assert.throws(() => assertSceneResult({ ...ok(), truth: { bounds: { min: [0, 0, 5], max: [1, 1, 1] } } }), /min>max/);
  for (const seed of [-1, 2 ** 32, 1.5, NaN]) assert.throws(() => assertSceneResult({ ...ok(), seed }), /seed/);
  assert.throws(() => assertSceneResult({ ...ok(), format: FORMAT_GAUSS56 }), /format/);
  const g = makeResult('terrain', 3, FORMAT_GAUSS56, cloud(4), truth);
  assert.throws(() => assertSceneResult({ ...g, format: FORMAT_POINT27 }), /format/);
});
test('assert_result_rejects_nonfinite_numbers_in_truth', () => {
  const mk = (t) => makeResult('terrain', 3, FORMAT_POINT27, cloud(4), t);
  const b = { min: [0, 0, 0], max: [1, 1, 1] };
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.throws(() => assertSceneResult(mk({ bounds: b, extra: { deep: [1, bad] } })), /비유한/);
    assert.throws(() => assertSceneResult(mk({ bounds: { min: [0, 0, 0], max: [1, 1, bad] } })), /비유한|min>max/);
  }
  assertSceneResult(mk({ bounds: b, extra: { deep: [1, 2] } }));
});
test('make_result_rejects_bad_format', () => {
  for (const f of [3, 0, '1', null]) assert.throws(() => makeResult('terrain', 1, f, cloud(2), truth), /format/);
  assert.equal(makeResult('terrain', 1, undefined, cloud(2), truth).format, 1);
});
test('assert_result_checks_27b_normals_finite_and_unit', () => {
  const ok = () => makeResult('terrain', 3, FORMAT_POINT27, cloud(4), truth);
  assertSceneResult(ok());
  for (const v of [NaN, Infinity]) { const r = ok(); r.cloud.normals[4] = v; assert.throws(() => assertSceneResult(r), /normals/); }
  const z = ok(); z.cloud.normals.fill(0); assert.throws(() => assertSceneResult(z), /단위 길이/);
  const l = ok(); l.cloud.normals[3] = 0.5; l.cloud.normals[4] = 1; assert.throws(() => assertSceneResult(l), /단위 길이/);
});
