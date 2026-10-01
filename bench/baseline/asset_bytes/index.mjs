// Asset bytes per segment x level (T01.3). Parses binary little-endian PLY headers only.
import { readFileSync, openSync, readSync, closeSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertRecords, serialize } from '../../../contracts/metrics/index.mjs';

export const LEVELS = [250, 1000, 3500, 7000];
export const SEGMENTS = [0, 1, 2, 3];
export const ASSUMED_STRIDE = 27; // bytes/point assumed by the task; measured stride differs (see run())
const DEMO = 'res/static/demo';
const pad = (n) => String(n).padStart(5, '0');

export function parseHeader(path) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const marker = 'end_header\n';
    const end = buf.subarray(0, n).indexOf(marker);
    if (end < 0) throw new Error(`no end_header in ${path}`);
    const headerBytes = end + marker.length;
    const text = buf.subarray(0, headerBytes).toString('latin1');
    if (!/^format binary_little_endian 1\.0$/m.test(text)) throw new Error(`not binary_little_endian: ${path}`);
    const m = /^element vertex (\d+)$/m.exec(text);
    if (!m) throw new Error(`no vertex element in ${path}`);
    const props = [...text.matchAll(/^property (\w+) (\w+)$/gm)].map((p) => ({ type: p[1], name: p[2] }));
    const SIZE = { float: 4, float32: 4, double: 8, uchar: 1, uint8: 1, char: 1, short: 2, ushort: 2, int: 4, uint: 4 };
    const stride = props.reduce((a, p) => a + (SIZE[p.type] ?? NaN), 0);
    return { points: Number(m[1]), headerBytes, props, stride, size: statSync(path).size };
  } finally {
    closeSync(fd);
  }
}

export async function run({ skylensDir, outDir, commit }) {
  const base = join(skylensDir, DEMO);
  const device = 'n/a';
  const method = 'fs.stat file size + PLY header vertex count (binary_little_endian)';
  const recs = [];
  const add = (metric, value, unit, m = method) => recs.push({ metric, value, unit, device, method: m, commit });
  const manifest = JSON.parse(readFileSync(join(base, 'segments.json'), 'utf8'));
  const totals = Object.fromEntries(LEVELS.map((l) => [l, { bytes: 0, points: 0 }]));
  let maxExcess = 0;
  const strides = new Set();
  for (const seg of SEGMENTS) {
    const mseg = manifest.segments.find((s) => s.index === seg);
    for (const lv of LEVELS) {
      const h = parseHeader(join(base, 'segments', `seg${seg}_step${pad(lv)}.ply`));
      const ml = mseg.levels.find((x) => x.steps === lv);
      if (ml.bytes !== h.size || ml.splats !== h.points) throw new Error(`segments.json disagrees with file for seg${seg} level${lv}`);
      const p = `assets.seg${seg}.level${lv}`;
      add(`${p}.bytes`, h.size, 'B');
      add(`${p}.points`, h.points, 'count');
      add(`${p}.header_bytes`, h.headerBytes, 'B');
      add(`${p}.bytes_per_point`, (h.size - h.headerBytes) / h.points, 'B', 'measured (size - header) / points');
      totals[lv].bytes += h.size;
      totals[lv].points += h.points;
      strides.add(h.stride);
      maxExcess = Math.max(maxExcess, h.size - ASSUMED_STRIDE * h.points - h.headerBytes);
    }
  }
  let all = 0;
  for (const lv of LEVELS) {
    add(`assets.total.level${lv}.bytes`, totals[lv].bytes, 'B', 'sum over segments 0-3');
    add(`assets.total.level${lv}.points`, totals[lv].points, 'count', 'sum over segments 0-3');
    all += totals[lv].bytes;
  }
  add('assets.total.all_levels.bytes', all, 'B', 'sum over segments 0-3 and 4 levels');
  for (const lv of LEVELS) {
    const h = parseHeader(join(base, `step${pad(lv)}_light.ply`));
    add(`assets.light.level${lv}.bytes`, h.size, 'B');
    add(`assets.light.level${lv}.points`, h.points, 'count');
  }
  // Format check: the 27 B/point assumption does not hold; record the real stride.
  if (strides.size !== 1) throw new Error(`mixed strides: ${[...strides]}`);
  const stride = [...strides][0];
  add('assets.format.stride_bytes', stride, 'B', 'sum of PLY property sizes (x,y,z,f_dc_0-2,opacity,scale_0-2,rot_0-3 = 14 float32, gaussian splat)');
  add('assets.format.assumed_stride_matches', maxExcess <= 0 ? 1 : 0, 'count', `1 if file size - 27*points <= header size for all segment files; else 0 (max excess over header: ${maxExcess} B)`);
  assertRecords(recs);
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'asset_bytes.json'), serialize(recs));
  }
  return recs;
}
