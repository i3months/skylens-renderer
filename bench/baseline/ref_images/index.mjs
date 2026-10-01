// Temporary CPU point-cloud reference renderer (T01.8, used until the real renderer T06 exists).
//
// Data: the level-4 (step 7000) segment PLYs of skylens demo assets, merged
//   (segments/seg<N>_step07000.ply, N ascending). Their coordinates are already in the demo
//   asset frame in metres, which segments.json / people.json define as the ENU frame
//   (x east, y up, z -north, 1 unit = 1 m), so NO frame mapping is applied.
//   (The top-level step*_light.ply files are normalised/other-scale and are not used.)
// Camera: X_c = R * X_w + t, [u,v,1] ~ K * X_c. Camera frame is OpenCV-style:
//   x right, y down, z forward. Rows of R are right = f x up, down = f x right, f = normalize(target - eye);
//   t = -R * eye. K: fy = (H/2)/tan(fov_y/2), fx = fy, cx = W/2, cy = H/2.
//   Pixel = (floor(u), floor(v)) with pixel (i,j) covering [i,i+1) x [j,j+1).
// Raster: every point is one 1-px square, z-buffered on z_c (nearest wins, first in file order on ties),
//   points with z_c <= 0 are dropped. Colour = clamp(0.5 + 0.28209479 * f_dc, 0, 1) * 255 rounded;
//   opacity/scale/rotation are ignored. No hole filling or interpolation: empty pixels stay BACKGROUND.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { assertRecords } from '../../../contracts/metrics/index.mjs';

export const BACKGROUND = [16, 16, 16];
const SH0 = 0.28209479177387814;

export function readPly(buf) {
  const m = buf.indexOf('end_header\n');
  if (m < 0) throw new Error('bad ply header');
  const head = buf.toString('latin1', 0, m).split('\n');
  if (!head.includes('format binary_little_endian 1.0')) throw new Error('not binary_little_endian');
  const n = +/^element vertex (\d+)$/m.exec(head.join('\n'))[1];
  const props = head.filter((l) => l.startsWith('property ')).map((l) => l.split(' '));
  if (props.some((p) => p[1] !== 'float')) throw new Error('only float properties supported');
  const idx = Object.fromEntries(props.map((p, i) => [p[2], i]));
  const stride = props.length * 4, off = m + 11;
  const pos = new Float32Array(n * 3), col = new Uint8Array(n * 3);
  const c8 = (v) => Math.round(Math.min(1, Math.max(0, 0.5 + SH0 * v)) * 255);
  for (let i = 0; i < n; i++) {
    const o = off + i * stride;
    for (let k = 0; k < 3; k++) {
      pos[i * 3 + k] = buf.readFloatLE(o + idx['xyz'[k]] * 4);
      col[i * 3 + k] = c8(buf.readFloatLE(o + idx['f_dc_' + k] * 4));
    }
  }
  return { n, pos, col };
}

export function loadCloud(skylensDir) {
  const dir = join(skylensDir, 'res/static/demo/segments');
  const files = readdirSync(dir).filter((f) => /^seg\d+_step07000\.ply$/.test(f))
    .sort((a, b) => parseInt(a.slice(3)) - parseInt(b.slice(3)));
  if (!files.length) throw new Error('no seg*_step07000.ply in ' + dir);
  const parts = files.map((f) => readPly(readFileSync(join(dir, f))));
  const n = parts.reduce((s, p) => s + p.n, 0);
  const pos = new Float32Array(n * 3), col = new Uint8Array(n * 3);
  let o = 0;
  for (const p of parts) { pos.set(p.pos, o * 3); col.set(p.col, o * 3); o += p.n; }
  return { n, pos, col, files };
}

export function cameraOf(vp) {
  const [ex, ey, ez] = vp.eye;
  let f = vp.target.map((v, i) => v - vp.eye[i]);
  const nz = (a) => { const l = Math.hypot(...a); return a.map((v) => v / l); };
  const cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  f = nz(f);
  const r = nz(cr(f, vp.up)), d = cr(f, r);
  const R = [r, d, f];
  const t = R.map((row) => -(row[0] * ex + row[1] * ey + row[2] * ez));
  const fy = (vp.height / 2) / Math.tan((vp.fov_y_deg * Math.PI) / 360);
  return { R, t, fx: fy, fy, cx: vp.width / 2, cy: vp.height / 2 };
}

export function render(cloud, vp) {
  const { width: W, height: H } = vp;
  const { R, t, fx, fy, cx, cy } = cameraOf(vp);
  const depth = new Float64Array(W * H).fill(Infinity);
  const rgb = Buffer.alloc(W * H * 3);
  for (let p = 0; p < W * H; p++) { rgb[p * 3] = BACKGROUND[0]; rgb[p * 3 + 1] = BACKGROUND[1]; rgb[p * 3 + 2] = BACKGROUND[2]; }
  const P = cloud.pos;
  for (let i = 0; i < cloud.n; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    const zc = R[2][0] * x + R[2][1] * y + R[2][2] * z + t[2];
    if (!(zc > 0)) continue;
    const xc = R[0][0] * x + R[0][1] * y + R[0][2] * z + t[0];
    const yc = R[1][0] * x + R[1][1] * y + R[1][2] * z + t[1];
    const px = Math.floor((fx * xc) / zc + cx), py = Math.floor((fy * yc) / zc + cy);
    if (px < 0 || py < 0 || px >= W || py >= H) continue;
    const q = py * W + px;
    if (zc < depth[q]) {
      depth[q] = zc;
      rgb[q * 3] = cloud.col[i * 3]; rgb[q * 3 + 1] = cloud.col[i * 3 + 1]; rgb[q * 3 + 2] = cloud.col[i * 3 + 2];
    }
  }
  let nonempty = 0;
  for (let q = 0; q < W * H; q++) if (depth[q] !== Infinity) nonempty++;
  return { rgb, nonempty };
}

const CRC = (() => { const T = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; } return T; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
export function encodePng(rgb, W, H) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) rgb.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3); // filter byte 0
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

export async function run({ skylensDir, outDir, commit }) {
  const vps = JSON.parse(readFileSync(new URL('../../../fixtures/viewpoints/viewpoints.json', import.meta.url))).viewpoints;
  const cloud = loadCloud(skylensDir);
  mkdirSync(outDir, { recursive: true });
  const recs = [];
  for (const vp of vps) {
    const { rgb, nonempty } = render(cloud, vp);
    writeFileSync(join(outDir, `view${vp.id}_${vp.name}.png`), encodePng(rgb, vp.width, vp.height));
    recs.push({ metric: `ref.view${vp.id}.nonempty_px`, value: nonempty, unit: 'px', device: 'cpu-node',
      method: 'point-1px-zbuffer;seg*_step07000;opencv-cam', commit });
  }
  return assertRecords(recs);
}
