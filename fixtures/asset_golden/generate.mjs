// 골든 자산 파일 생성기(결정적). 같은 코드 → 같은 바이트.
//   node fixtures/asset_golden/generate.mjs           point27.skla, gauss56.skla 를 이 폴더에 쓴다
//   node fixtures/asset_golden/generate.mjs --check   다시 만들어 저장된 파일과 바이트 비교(다르면 종료코드 1)
// 부호화는 format/ASSET_FORMAT.md §5 식을 그대로 옮긴 참조 구현이다(골든 전용, 제품 packer 아님).
// 입력 값은 손으로 계산할 수 있게 고른 것이고, 사이드카 JSON(point27.json, gauss56.json)의 기대값은 손계산 값이다.
import { readFileSync, writeFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  FORMAT_POINT27, FORMAT_GAUSS56, CODEC_RAW_PLANAR, VERSION_MAJOR, VERSION_MINOR, HEADER_SIZE, TILE_SIZE_M,
  POSITION_Q_MAX, SH_C0, SCALE_LOG_MIN, SCALE_LOG_STEPS_PER_UNIT, OCT_SNORM_MAX, ROT_COMPONENT_CENTER, ROT_COMPONENT_MAX,
  OFFSETS, bodyLayout, serializeHeader,
} from '../../contracts/asset/index.mjs';

/** 명세 §5.0 반올림: floor(x + 0.5) */
const round = (x) => Math.floor(x + 0.5);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** GeoAnchor 예시 값(실제 운영 앵커 아님). */
export const ANCHOR = Object.freeze({ lat: 37.5, lon: 127.0, alt: 30.0 });

function fold(u, v) {
  const su = u >= 0 ? 1 : -1;
  const sv = v >= 0 ? 1 : -1;
  return [(1 - Math.abs(v)) * su, (1 - Math.abs(u)) * sv];
}
function encodeOct(x, y, z) {
  const l1 = Math.abs(x) + Math.abs(y) + Math.abs(z);
  let u = x / l1;
  let v = y / l1;
  if (z < 0) [u, v] = fold(u, v);
  return [clamp(round(u * OCT_SNORM_MAX), -OCT_SNORM_MAX, OCT_SNORM_MAX), clamp(round(v * OCT_SNORM_MAX), -OCT_SNORM_MAX, OCT_SNORM_MAX)];
}
function encodeRot(w, x, y, z) {
  let q = [w, x, y, z];
  const len = Math.hypot(...q);
  q = q.map((c) => c / len);
  let m = 0;
  for (let k = 1; k < 4; k++) if (Math.abs(q[k]) > Math.abs(q[m])) m = k;
  if (q[m] < 0) q = q.map((c) => -c);
  const rest = [];
  for (let k = 0; k < 4; k++) if (k !== m) rest.push(clamp(round(q[k] * Math.SQRT2 * ROT_COMPONENT_CENTER) + ROT_COMPONENT_CENTER, 0, ROT_COMPONENT_MAX));
  return ((m << 30) | (rest[0] << 20) | (rest[1] << 10) | rest[2]) >>> 0;
}

function bounds(pos, n) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) {
    const v = pos[3 * i + a];
    if (v < min[a]) min[a] = v;
    if (v > max[a]) max[a] = v;
  }
  return { min, max };
}
function quantExp(min, max) {
  for (const k of [10, 9, 8]) if ([0, 1, 2].every((a) => (max[a] - min[a]) * 2 ** k <= POSITION_Q_MAX)) return k;
  throw new Error('extent too large');
}

/** 평면 값 배열들을 본문 배치대로 써서 파일을 완성한다(체크섬 포함). */
function assemble(format, meta, pos, n, planeValues) {
  const { min, max } = bounds(pos, n);
  const qexp = quantExp(min, max);
  const tileX = Math.floor(min[0] / TILE_SIZE_M);
  const tileY = Math.floor(min[1] / TILE_SIZE_M);
  if (Math.floor(max[0] / TILE_SIZE_M) !== tileX || Math.floor(max[1] / TILE_SIZE_M) !== tileY) throw new Error('points span tiles');
  const layout = bodyLayout(format, n);
  const header = serializeHeader({
    versionMajor: VERSION_MAJOR, versionMinor: VERSION_MINOR, headerSize: HEADER_SIZE, format, codec: CODEC_RAW_PLANAR,
    segmentId: meta.segmentId, level: meta.level, pointCount: n, tileX, tileY, tileSizeM: TILE_SIZE_M,
    lod: meta.lod, quantExp: qexp, chunkIndex: meta.chunkIndex, bodyBytes: layout.requiredBytes,
    bboxMin: min, bboxMax: max, anchor: ANCHOR, checksum: 0,
  });
  const file = new Uint8Array(HEADER_SIZE + layout.requiredBytes);
  file.set(header, 0);
  const dv = new DataView(file.buffer);
  const posQ = [0, 1, 2].map((a) => Array.from({ length: n }, (_, i) => clamp(round((pos[3 * i + a] - min[a]) * 2 ** qexp), 0, POSITION_Q_MAX)));
  const values = { pos_e: posQ[0], pos_n: posQ[1], pos_u: posQ[2], ...planeValues };
  for (const p of layout.planes) {
    const vals = values[p.name];
    const base = HEADER_SIZE + p.offset;
    for (let i = 0; i < n; i++) {
      if (p.type === 'u16') dv.setUint16(base + 2 * i, vals[i], true);
      else if (p.type === 'u8') dv.setUint8(base + i, vals[i]);
      else if (p.type === 'i8') dv.setInt8(base + i, vals[i]);
      else if (p.type === 'u32') dv.setUint32(base + 4 * i, vals[i], true);
    }
  }
  dv.setUint32(OFFSETS.checksum, crc32(file), true);
  return file;
}

/** 27 B 점 32개. 구간 7, 수준 2(3500 스텝), 타일 (1, −2), LOD 0, 조각 0. */
export function buildPoint27() {
  const n = 32;
  const NORMALS = [[0, 0, 1], [0.6, 0, 0.8], [0, -0.6, -0.8], [0.36, 0.48, 0.8]];
  const pos = new Float32Array(3 * n);
  const nrm = new Float32Array(3 * n);
  const r = [], g = [], b = [], ox = [], oy = [];
  for (let i = 0; i < n; i++) {
    pos[3 * i] = 64 + (i % 8) * 0.5;
    pos[3 * i + 1] = -128 + Math.floor(i / 8) * 0.75;
    pos[3 * i + 2] = 1 + i * 0.0625;
    nrm.set(NORMALS[i % 4], 3 * i);
    r.push(i * 8);
    g.push(255 - i * 8);
    b.push((i * 37) % 256);
    const [qx, qy] = encodeOct(nrm[3 * i], nrm[3 * i + 1], nrm[3 * i + 2]);
    ox.push(qx);
    oy.push(qy);
  }
  return assemble(FORMAT_POINT27, { segmentId: 7, level: 2, lod: 0, chunkIndex: 0 }, pos, n, {
    color_r: r, color_g: g, color_b: b, normal_oct_x: ox, normal_oct_y: oy,
  });
}

/** 56 B 가우시안 21개. 구간 7, 수준 3(7000 스텝), 타일 (0, 0), LOD 1, 조각 2. */
export function buildGauss56() {
  const n = 21;
  const pos = new Float32Array(3 * n);
  const fdc = new Float32Array(3 * n);
  const opa = new Float32Array(n);
  const scl = new Float32Array(3 * n);
  const rot = new Float32Array(4 * n);
  const planes = { color_r: [], color_g: [], color_b: [], opacity: [], scale_0: [], scale_1: [], scale_2: [], rotation: [] };
  for (let i = 0; i < n; i++) {
    pos[3 * i] = 10 + (i % 7);
    pos[3 * i + 1] = 20 + Math.floor(i / 7) * 2;
    pos[3 * i + 2] = -2 + i * 0.25;
    const target = [i * 12, 128, 255 - i * 12];
    for (let k = 0; k < 3; k++) fdc[3 * i + k] = (target[k] / 255 - 0.5) / SH_C0;
    opa[i] = (i - 10) * 0.5;
    scl[3 * i] = -6 + i * 0.25;
    scl[3 * i + 1] = -3.5;
    scl[3 * i + 2] = -2 - i * 0.125;
    const half = (i * 7.5 * Math.PI) / 180;
    rot.set([Math.cos(half), 0, 0, Math.sin(half)], 4 * i);
    const col = [0, 1, 2].map((k) => clamp(round((0.5 + SH_C0 * fdc[3 * i + k]) * 255), 0, 255));
    planes.color_r.push(col[0]);
    planes.color_g.push(col[1]);
    planes.color_b.push(col[2]);
    planes.opacity.push(clamp(round(255 / (1 + Math.exp(-opa[i]))), 0, 255));
    for (let k = 0; k < 3; k++) {
      planes[`scale_${k}`].push(clamp(round((scl[3 * i + k] - SCALE_LOG_MIN) * SCALE_LOG_STEPS_PER_UNIT), 0, 255));
    }
    planes.rotation.push(encodeRot(rot[4 * i], rot[4 * i + 1], rot[4 * i + 2], rot[4 * i + 3]));
  }
  return assemble(FORMAT_GAUSS56, { segmentId: 7, level: 3, lod: 1, chunkIndex: 2 }, pos, n, planes);
}

export const GOLDENS = Object.freeze({ 'point27.skla': buildPoint27, 'gauss56.skla': buildGauss56 });

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes('--check');
  let bad = 0;
  for (const [name, build] of Object.entries(GOLDENS)) {
    const path = fileURLToPath(new URL(name, import.meta.url));
    const bytes = build();
    if (check) {
      const same = Buffer.compare(Buffer.from(bytes), readFileSync(path)) === 0;
      console.log(`${name}: ${same ? 'identical' : 'DIFFERENT'} (${bytes.length} B)`);
      if (!same) bad++;
    } else {
      writeFileSync(path, bytes);
      console.log(`${name}: wrote ${bytes.length} B`);
    }
  }
  process.exitCode = bad ? 1 : 0;
}
