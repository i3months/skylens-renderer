// 계약 입력 한계 시험(F-095 ⑦): 점 번호 하한, 해상도 상한, 극단값의 비유한 반환 거부.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertRenderResult, assertCamera, emptyResult, MAX_PIXELS } from './index.mjs';
import { unproject } from '../../server/raster_ref/unproject/index.mjs';
import { splatRadiusPx } from '../../server/raster_ref/splat/index.mjs';
import { scaleIntrinsics } from '../../server/raster_ref/intrinsics/index.mjs';

const cam = (over = {}) => ({ width: 4, height: 4, K: { fx: 2, fy: 2, cx: 2, cy: 2 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0], ...over });

test('assertRenderResult: 점 번호 −5 등 −1 보다 작은 값은 거부', () => {
  const r = emptyResult(2, 2);
  r.index[1] = -5; r.depth[1] = 3; // 깊이·번호 짝은 맞지만 번호가 −1 미만
  assert.throws(() => assertRenderResult(r), /^Error: raster:/);
  r.index[1] = 0; // 같은 영상에서 번호 0 은 통과
  assertRenderResult(r);
});

test('해상도 상한: emptyResult·assertCamera·assertRenderResult 가 raw RangeError 대신 raster: 오류', () => {
  assert.throws(() => emptyResult(1e5, 1e5), /^Error: raster:/);
  assert.throws(() => assertCamera(cam({ width: 1e5, height: 1e5 })), /^Error: raster:/);
  assert.throws(() => emptyResult(MAX_PIXELS + 1, 1), /^Error: raster:/);
  assert.throws(() => assertRenderResult({ width: 1e5, height: 1e5, color: new Uint8Array(0), depth: new Float32Array(0), index: new Int32Array(0) }), /^Error: raster:/);
  assertCamera(cam({ width: 8192, height: 8192 })); // 상한 경계는 허용
});

test('unproject: 극단 깊이로 비유한 결과가 나오면 raster: 오류', () => {
  assert.throws(() => unproject(cam({ K: { fx: 1e-300, fy: 1e-300, cx: 2, cy: 2 } }), 1e300, 1e300, 1e300), /^Error: raster:/);
  assert.ok(unproject(cam(), 2, 2, 5).every(Number.isFinite));
});

test('splatRadiusPx: 극단 입력으로 반경이 무한이면 raster: 오류', () => {
  assert.throws(() => splatRadiusPx(cam({ K: { fx: 1e300, fy: 1, cx: 2, cy: 2 } }), 1e-300, 1e300), /^Error: raster:/);
  assert.equal(splatRadiusPx(cam(), 1, 1), 1);
});

test('scaleIntrinsics: 극단 배율로 f 가 0·무한이 되면 raster: 오류', () => {
  const K = { fx: 1e-300, fy: 1, cx: 1, cy: 1 };
  assert.throws(() => scaleIntrinsics(K, 1e300, 1, 1, 1), /^Error: raster:/); // fx 언더플로 → 0
  assert.throws(() => scaleIntrinsics({ fx: 1e300, fy: 1, cx: 1, cy: 1 }, 1, 1, 1e300, 1), /^Error: raster:/); // fx 넘침
  assert.deepEqual(scaleIntrinsics({ fx: 2, fy: 4, cx: 1, cy: 2 }, 2, 2, 4, 4), { fx: 4, fy: 8, cx: 2, cy: 4 });
});
