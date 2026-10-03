// 내부 파라미터 해상도 변환 시험(T06.3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { scaleIntrinsics } from './index.mjs';

const K2048 = { fx: 1609.22, fy: 1608.21, cx: 1024, cy: 576 };

test('intrinsics_basis_2048_to_960', () => {
  // renderer_basis §1-2: 2048×1152 → 960×540, 배율 0.46875
  const k = scaleIntrinsics(K2048, 2048, 1152, 960, 540);
  assert.ok(Math.abs(k.fx - 754.32) <= 0.01, `fx ${k.fx}`);
  assert.ok(Math.abs(k.fx - 754.321875) <= 1e-9, `fx ${k.fx}`);
  assert.ok(Math.abs(k.fy - 753.85) <= 0.01, `fy ${k.fy}`);
  assert.equal(k.cx, 480);
  assert.equal(k.cy, 270);
  // 기본값과 명시 'basis' 는 같다
  assert.deepEqual(scaleIntrinsics(K2048, 2048, 1152, 960, 540, { pixelCenter: 'basis' }), k);
});

test('intrinsics_half_pixel_center', () => {
  const k = scaleIntrinsics(K2048, 2048, 1152, 960, 540, { pixelCenter: 'half' });
  assert.ok(Math.abs(k.cx - ((1024 + 0.5) * 0.46875 - 0.5)) <= 1e-12); // 479.734375
  assert.ok(Math.abs(k.cy - ((576 + 0.5) * 0.46875 - 0.5)) <= 1e-12);
  assert.ok(Math.abs(k.fx - 754.321875) <= 1e-9); // 초점거리는 규약과 무관
  // 같은 해상도면 두 규약 모두 그대로
  assert.deepEqual(scaleIntrinsics(K2048, 2048, 1152, 2048, 1152, { pixelCenter: 'half' }), K2048);
});

test('intrinsics_non_integer_ratio', () => {
  // 1000→333: 비율 0.333 (정수 배가 아님)
  const K = { fx: 800, fy: 810, cx: 500.25, cy: 375.5 };
  const k = scaleIntrinsics(K, 1000, 750, 333, 250);
  assert.ok(Math.abs(k.fx - 800 * 0.333) <= 1e-9);
  assert.ok(Math.abs(k.cx - 500.25 * 0.333) <= 1e-9);
  assert.ok(Math.abs(k.fy - 810 * (250 / 750)) <= 1e-9);
  assert.ok(Math.abs(k.cy - 375.5 * (250 / 750)) <= 1e-9);
  // 왕복(늘렸다 줄이기)은 원래 값으로 돌아온다
  const back = scaleIntrinsics(k, 333, 250, 1000, 750);
  for (const n of ['fx', 'fy', 'cx', 'cy']) assert.ok(Math.abs(back[n] - K[n]) <= 1e-9, n);
  const backHalf = scaleIntrinsics(scaleIntrinsics(K, 1000, 750, 333, 250, { pixelCenter: 'half' }), 333, 250, 1000, 750, { pixelCenter: 'half' });
  for (const n of ['fx', 'fy', 'cx', 'cy']) assert.ok(Math.abs(backHalf[n] - K[n]) <= 1e-9, n);
});

test('intrinsics_aspect_change_scales_axes_independently', () => {
  // 16:9 → 4:3: 가로·세로 배율이 다르다(가로 0.5, 세로 0.8333…)
  const k = scaleIntrinsics(K2048, 2048, 1152, 1024, 960);
  assert.ok(Math.abs(k.fx - 1609.22 * 0.5) <= 1e-9);
  assert.ok(Math.abs(k.cx - 512) <= 1e-9);
  assert.ok(Math.abs(k.fy - 1608.21 * (960 / 1152)) <= 1e-9);
  assert.ok(Math.abs(k.cy - 480) <= 1e-9);
  // 가로만 바꾸면 fy·cy 는 그대로(축을 섞는 변이를 잡는다)
  const w = scaleIntrinsics(K2048, 2048, 1152, 1024, 1152);
  assert.equal(w.fy, 1608.21);
  assert.equal(w.cy, 576);
  assert.equal(w.fx, 1609.22 / 2);
});

test('intrinsics_rejects_bad_input', () => {
  const bad = [0, -1, -960, NaN, Infinity, -Infinity, '960', undefined, null];
  for (const x of bad) {
    assert.throws(() => scaleIntrinsics(K2048, x, 1152, 960, 540), /^Error: raster:/);
    assert.throws(() => scaleIntrinsics(K2048, 2048, x, 960, 540), /^Error: raster:/);
    assert.throws(() => scaleIntrinsics(K2048, 2048, 1152, x, 540), /^Error: raster:/);
    assert.throws(() => scaleIntrinsics(K2048, 2048, 1152, 960, x), /^Error: raster:/);
  }
  for (const k of [null, 5, { ...K2048, fx: 0 }, { ...K2048, fy: -1 }, { ...K2048, fx: NaN }, { ...K2048, cx: Infinity }, { ...K2048, cy: undefined }]) {
    assert.throws(() => scaleIntrinsics(k, 2048, 1152, 960, 540), /^Error: raster:/);
  }
  assert.throws(() => scaleIntrinsics(K2048, 2048, 1152, 960, 540, { pixelCenter: 'center' }), /^Error: raster:/);
  // 음수 주점은 허용(계약: cx·cy 는 유한 수)
  assert.equal(scaleIntrinsics({ ...K2048, cx: -10 }, 2048, 1152, 1024, 576).cx, -5);
});
