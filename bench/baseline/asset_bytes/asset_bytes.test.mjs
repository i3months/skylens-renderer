import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './index.mjs';

const dir = process.env.SKYLENS_DIR;
const opts = { skip: dir ? false : 'SKYLENS_DIR not set' };

const LEVELS = [250, 1000, 3500, 7000];
// Measured from res/static/demo/segments/*.ply: [bytes, points, headerBytes] per level.
const EXPECTED = {
  0: [[64592, 1147, 360], [216128, 3853, 360], [3104161, 55425, 361], [6517698, 116381, 362]],
  1: [[107544, 1914, 360], [285848, 5098, 360], [3571761, 63775, 361], [6517698, 116381, 362]],
  2: [[127536, 2271, 360], [347672, 6202, 360], [3442569, 61468, 361], [6517642, 116380, 362]],
  3: [[174072, 3102, 360], [407312, 7267, 360], [4052241, 72355, 361], [6517698, 116381, 362]],
};
const TOTAL_BYTES = [473744, 1256960, 14170732, 26070736];
const TOTAL_POINTS = [8434, 22420, 253023, 465523];
const LIGHT = [[472664, 8434], [1255881, 22420], [14169650, 253023], [26069650, 465523]];

test('asset bytes per segment x level', opts, async () => {
  const recs = await run({ skylensDir: dir, outDir: mkdtempSync(join(tmpdir(), 'ab-')), commit: 'abcdef1' });
  const m = Object.fromEntries(recs.map((r) => [r.metric, r.value]));
  for (const [seg, lvls] of Object.entries(EXPECTED)) {
    lvls.forEach(([bytes, points, hdr], i) => {
      const p = `assets.seg${seg}.level${LEVELS[i]}`;
      assert.equal(m[`${p}.bytes`], bytes);
      assert.equal(m[`${p}.points`], points);
      assert.equal(m[`${p}.header_bytes`], hdr);
      assert.equal(m[`${p}.bytes_per_point`], 56); // 14 float32 per point, not 27 B
    });
  }
  LEVELS.forEach((l, i) => {
    assert.equal(m[`assets.total.level${l}.bytes`], TOTAL_BYTES[i]);
    assert.equal(m[`assets.total.level${l}.points`], TOTAL_POINTS[i]);
    assert.equal(m[`assets.light.level${l}.bytes`], LIGHT[i][0]);
    assert.equal(m[`assets.light.level${l}.points`], LIGHT[i][1]);
  });
  assert.equal(m['assets.total.all_levels.bytes'], 41972172);
  assert.equal(m['assets.format.stride_bytes'], 56);
  assert.equal(m['assets.format.assumed_stride_matches'], 0); // 27 B/point assumption is false
});
