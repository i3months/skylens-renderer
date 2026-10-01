import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { run, towerBbox, requestPlan } from './index.mjs';

const dir = process.env.SKYLENS_DIR;
const t = dir && existsSync(dir) ? test : test.skip;
const COMMIT = '59edcf9';
// Hard-coded offline values. 6191 (README prose) is NOT reproducible: no real dataset in repo.
const EXPECTED = { buildings: 415, requests: 8, bytes: 136409, requestsWithImagery: 100 };

t('tower_bytes_records', async () => {
  const recs = await run({ skylensDir: dir, outDir: '/tmp', commit: COMMIT });
  const m = Object.fromEntries(recs.map((r) => [r.metric, r.value]));
  assert.deepEqual(Object.keys(m).sort(), ['tower.buildings.count', 'tower.bytes', 'tower.requests.count']);
  assert.equal(towerBbox(dir).name, 'daejeon');
  assert.equal(m['tower.buildings.count'], EXPECTED.buildings);
  assert.equal(m['tower.requests.count'], EXPECTED.requests);
  assert.equal(m['tower.bytes'], EXPECTED.bytes);
  assert.equal(requestPlan(towerBbox(dir).bbox).withImagery, EXPECTED.requestsWithImagery);
});

t('tower_bytes_no_local_real_dataset', () => {
  // The ~6,191 real buildings (VWorld WFS) are not in the repo: no geojson/shp under res/.
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  assert.equal(walk(join(dir, 'res')).filter((f) => /\.(geojson|shp|pbf|gpkg)$/i.test(f)).length, 0);
  assert.ok(requestPlan(towerBbox(dir).bbox).keyless > 0);
});
