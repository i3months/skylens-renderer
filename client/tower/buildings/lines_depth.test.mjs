import test from 'node:test';
import assert from 'node:assert/strict';
import { rasterizeLines } from './lines.mjs';
import { rasterizePoints } from './points.mjs';
import { emptyResult } from '../../../contracts/raster/index.mjs';

const W = 64, H = 48;
const cam = (t = [0, 0, 0]) => ({ width: W, height: H, K: { fx: 50, fy: 50, cx: 32, cy: 24 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t });
const seg = (z) => ({ edgeLines: new Float32Array([-0.5, 0, z, 0.5, 0, z]) });

test('F-408: 겹친 선끼리는 편향 없이 가까운 선이 이긴다', () => {
  const out = emptyResult(W, H);
  rasterizeLines(cam(), [seg(10), seg(10.03)], [1, 2, 3], out);
  const p = 24 * W + 32;
  assert.equal(out.index[p], 0);
  assert.equal(out.depth[p], Math.fround(10));
});

test('F-409: float32 범위 밖 깊이는 그리지 않아 depth 가 유한하다', () => {
  const out = emptyResult(W, H);
  rasterizeLines(cam([0, 0, 1e39]), [seg(10)], [1, 2, 3], out);
  rasterizePoints(cam([0, 0, 1e39]), [{ points: new Float32Array([0, 0, 10]) }], [1, 2, 3], out);
  for (const d of out.depth) assert.ok(Number.isFinite(d));
  assert.ok(out.index.every((v) => v === -1));
});
