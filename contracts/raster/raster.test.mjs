import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCamera, assertRenderResult, emptyResult, RASTER_API, EMPTY_INDEX } from './index.mjs';

const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const cam = () => ({ width: 960, height: 540, K: { fx: 754.32, fy: 753.85, cx: 480, cy: 270 }, R: [...I], t: [0, 0, 0] });

test('raster_contract_camera_ok', () => { assertCamera(cam()); });
test('raster_contract_camera_rejects', () => {
  const bad = [
    (c) => { c.width = 0; }, (c) => { c.height = 1.5; }, (c) => { c.K.fx = 0; }, (c) => { c.K.fy = NaN; },
    (c) => { c.K.cx = Infinity; }, (c) => { c.R = [...I, 1]; }, (c) => { c.R[0] = 2; },
    (c) => { c.R = [1, 0, 0, 0, 1, 0, 0, 0, -1]; }, (c) => { c.t = [0, 0]; }, (c) => { c.t[1] = NaN; },
  ];
  for (const m of bad) { const c = cam(); m(c); assert.throws(() => assertCamera(c), /^Error: raster:/); }
  assert.throws(() => assertCamera(null), /raster:/);
});
test('raster_contract_empty_result', () => {
  const r = emptyResult(4, 3);
  assertRenderResult(r);
  assert.equal(r.index[0], EMPTY_INDEX);
  r.depth[0] = 2; // 번호는 아직 빈 칸
  assert.throws(() => assertRenderResult(r), /raster:/);
  r.index[0] = 7; r.color[0] = 5;
  assertRenderResult(r);
  r.depth[0] = 0; r.index[0] = -1; // 빈 칸인데 색이 있음
  assert.throws(() => assertRenderResult(r), /raster:/);

  // 깊이 <= 0 인데 픽셀이 차있는 경우 거부
  const r2 = emptyResult(4, 3);
  r2.index[0] = 5;
  r2.color[0] = 100;
  r2.depth[0] = 0; // 음수도 거부
  assert.throws(() => assertRenderResult(r2), /raster:/, '깊이 0 음성 시험');

  r2.depth[0] = -5;
  assert.throws(() => assertRenderResult(r2), /raster:/, '음수 깊이 음성 시험');
});
test('raster_contract_api_modules_listed', () => {
  assert.equal(Object.keys(RASTER_API).length, 10);
  for (const v of Object.values(RASTER_API)) assert.match(v.module, /\.mjs$/);
});
