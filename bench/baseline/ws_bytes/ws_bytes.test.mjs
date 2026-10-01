import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from './index.mjs';
import { assertRecords } from '../../../contracts/metrics/index.mjs';

const skylensDir = process.env.SKYLENS_DIR;
const EXPECTED = {
  'ws.camera_feed.bytes': 936,
  'ws.detection.bytes': 662,
  'ws.link_status.bytes': 651,
  'ws.mission_status.bytes': 315,
  'ws.server_status.bytes': 755,
  'ws.splat_chunk.bytes': 4994,
  'ws.telemetry.bytes': 11480,
  'ws.total.bytes': 19793,
  'ws.frames': 69,
};
const toMap = (recs) => Object.fromEntries(recs.map((r) => [r.metric, r.value]));

test('ws_bytes: replay twice gives identical, expected totals', { skip: !skylensDir && 'SKYLENS_DIR not set' }, async () => {
  const a = await run({ skylensDir, commit: 'abcdef1' });
  const b = await run({ skylensDir, commit: 'abcdef1' });
  assertRecords(a);
  assert.deepEqual(toMap(a), toMap(b));
  assert.deepEqual(toMap(a), EXPECTED);
  const sum = a.filter((r) => /^ws\.(?!total)[a-z_]+\.bytes$/.test(r.metric)).reduce((s, r) => s + r.value, 0);
  assert.equal(sum, EXPECTED['ws.total.bytes']);
});
