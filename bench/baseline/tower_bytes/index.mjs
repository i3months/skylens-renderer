// T01.5: control-tower terrain/building request + byte tally, from local data only (no network).
//
// FINDING: the skylens repo ships NO building dataset and NO recorded terrain/WFS responses.
// Real buildings come live from VWorld WFS (lt_c_bldginfo, needs a key), terrain from the AWS
// terrarium tile service, imagery from VWorld WMTS. The "~6,191 buildings" figure appears only
// in README/SPEC prose. What IS reproducible offline is (a) the request plan derived from the
// tower's bbox and tile-budget rules and (b) the deterministic stand-in footprint generator
// (buildingSource.ts synthesizeBuildings), which the tower uses when VWorld returns nothing.
// Those are what this module tallies; the method strings say so.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertRecords } from '../../../contracts/metrics/index.mjs';

const MAX_ZOOM = 12, MAX_TILES = 12; // terrainSource.ts
const SAT_MIN_ZOOM = 6, SAT_MAX_ZOOM = 17, SAT_MAX_TILES = 160, RING_SAT_TILES = 40, RING_SPAN = 3;
const SYN_CELL_LAT = 0.0009; // buildingSource.ts
const DEVICE = 'offline-model';

const tx = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const ty = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};
const tiles = (b, z) =>
  (Math.floor(tx(b[2], z)) - Math.floor(tx(b[0], z)) + 1) * (Math.floor(ty(b[1], z)) - Math.floor(ty(b[3], z)) + 1);
const demZoom = (b) => { for (let z = MAX_ZOOM; z > 0; z--) if (tiles(b, z) <= MAX_TILES) return z; return 1; };
const satZoom = (b, max) => { for (let z = SAT_MAX_ZOOM; z > SAT_MIN_ZOOM; z--) if (tiles(b, z) <= max) return z; return SAT_MIN_ZOOM; };
const expand = (b, f) => {
  const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, hw = ((b[2] - b[0]) / 2) * f, hh = ((b[3] - b[1]) / 2) * f;
  return [cx - hw, cy - hh, cx + hw, cy + hh];
};

function hash01(i, j, salt) {
  let h = Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1) ^ Math.imul(salt, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Port of synthesizeBuildings(); returns the stand-in footprints for a bbox. */
export function synthesize(bbox) {
  const lat0 = (bbox[1] + bbox[3]) / 2;
  const mPerDegLat = 111320, mPerDegLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const cellLat = SYN_CELL_LAT, cellLon = (cellLat * mPerDegLat) / mPerDegLon;
  const j0 = Math.floor(bbox[1] / cellLat), j1 = Math.ceil(bbox[3] / cellLat);
  const i0 = Math.floor(bbox[0] / cellLon), i1 = Math.ceil(bbox[2] / cellLon);
  const out = [];
  if ((i1 - i0) * (j1 - j0) > 20000) return out;
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    if (hash01(i, j, 1) > 0.42) continue;
    const cLon = (i + 0.5) * cellLon + (hash01(i, j, 2) - 0.5) * cellLon * 0.3;
    const cLat = (j + 0.5) * cellLat + (hash01(i, j, 3) - 0.5) * cellLat * 0.3;
    if (cLon < bbox[0] || cLon > bbox[2] || cLat < bbox[1] || cLat > bbox[3]) continue;
    const wLon = cellLon * (0.28 + hash01(i, j, 4) * 0.34), wLat = cellLat * (0.28 + hash01(i, j, 5) * 0.34);
    const r = hash01(i, j, 6);
    out.push({ id: `syn-${i}-${j}`, ring: [[cLon - wLon / 2, cLat - wLat / 2], [cLon + wLon / 2, cLat - wLat / 2],
      [cLon + wLon / 2, cLat + wLat / 2], [cLon - wLon / 2, cLat + wLat / 2]], heightM: 8 + r * r * r * 120 });
  }
  return out;
}

/** Read the tower's default bbox (CONFIG.control.defaultMap -> PRESETS) from the skylens source. */
export function towerBbox(skylensDir) {
  const base = join(skylensDir, 'src/shared/viewer');
  const name = /defaultMap:\s*'(\w+)'/.exec(readFileSync(join(base, 'config.ts'), 'utf8'))[1];
  const m = new RegExp(`\\b${name}:\\s*\\[([^\\]]+)\\]`).exec(readFileSync(join(base, 'sources/terrainSource.ts'), 'utf8'));
  return { name, bbox: m[1].split(',').map(Number) };
}

/** Request plan of loadTerrainScene + loadBuildings for the core scene (cold load, VWorld unreachable). */
export function requestPlan(bbox) {
  const ring = expand(bbox, RING_SPAN);
  const plan = {
    demCore: tiles(bbox, demZoom(bbox)),
    demRing: tiles(ring, demZoom(ring)),
    satProbe: 1, // imageryReachable(): one tile; keyless -> imagery tiles are skipped
    satCore: tiles(bbox, satZoom(bbox, SAT_MAX_TILES)), // only if imagery is reachable
    satRing: tiles(ring, satZoom(ring, RING_SAT_TILES)),
    wfsRoot: 1, // fetchCell() root; quad-splits only on >=1000 rows
  };
  plan.keyless = plan.demCore + plan.demRing + plan.satProbe + plan.wfsRoot;
  plan.withImagery = plan.keyless + plan.satCore + plan.satRing;
  return plan;
}

export async function run({ skylensDir, outDir, commit }) {
  const { name, bbox } = towerBbox(skylensDir);
  const plan = requestPlan(bbox);
  const fp = synthesize(bbox);
  const payload = JSON.stringify({ type: 'FeatureCollection', features: fp.map((b) => ({ type: 'Feature',
    id: b.id, properties: { height: b.heightM }, geometry: { type: 'Polygon', coordinates: [[...b.ring, b.ring[0]]] } })) });
  const bytes = Buffer.byteLength(payload);
  void outDir;
  return assertRecords([
    { metric: 'tower.buildings.count', value: fp.length, unit: 'count', device: DEVICE, commit,
      method: `local stand-in generator (synthesizeBuildings port) over '${name}' bbox; no real building dataset in repo, 6191 is README prose only` },
    { metric: 'tower.requests.count', value: plan.keyless, unit: 'count', device: DEVICE, commit,
      method: `static request plan, keyless cold load: ${plan.demCore} core DEM + ${plan.demRing} ring DEM + ${plan.satProbe} imagery probe + ${plan.wfsRoot} WFS cell; with VWorld imagery +${plan.satCore + plan.satRing}` },
    { metric: 'tower.bytes', value: bytes, unit: 'B', device: DEVICE, commit,
      method: 'serialized GeoJSON of the stand-in footprints only; no recorded terrain/WFS responses exist locally' },
  ]);
}
