// T03.7 역변환 시험. 명세 format/ASSET_FORMAT.md §6 복원식, §8 오차 상한.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FORMAT_POINT27, FORMAT_GAUSS56, CODEC_RAW_PLANAR, VERSION_MAJOR, VERSION_MINOR, HEADER_SIZE, TILE_SIZE_M,
  POSITION_Q_MAX, SH_C0, SCALE_LOG_MIN, SCALE_LOG_STEPS_PER_UNIT, OCT_SNORM_MAX, ROT_COMPONENT_CENTER, ROT_COMPONENT_MAX,
  OFFSETS, ERROR_BOUNDS, AssetFormatError, bodyLayout, serializeHeader, parseHeader,
} from '../../../contracts/asset/index.mjs';
import { ANCHOR, buildPoint27, buildGauss56 } from '../../../fixtures/asset_golden/generate.mjs';
import { unpackChunk, toSourceRecords, decodeOctNormal, decodeRotation } from './index.mjs';

const GOLDEN = new URL('../../../fixtures/asset_golden/', import.meta.url);

// ---------------------------------------------------------------------------
// 참조 부호화: generate.mjs 의 내부 함수(encodeOct·encodeRot·assemble)를 그대로 옮긴 것.
// generate.mjs 가 이 함수들을 내보내지 않아 복사했고, 아래 `reference_encoder_matches_generate` 가
// 골든 입력을 이 복사본으로 다시 부호화해 generate.mjs 결과와 체크섬 외 바이트가 같음을 확인한다.
// ---------------------------------------------------------------------------
const round = (x) => Math.floor(x + 0.5);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
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
/** generate.mjs assemble 과 같고 체크섬만 0 으로 둔다. */
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
  return { file, qexp, min, posQ };
}

/** 원본 필드 → 조각 바이트(§5 식). */
function packPoint27(pos, nrm, rgb, n) {
  const planes = { color_r: [], color_g: [], color_b: [], normal_oct_x: [], normal_oct_y: [] };
  for (let i = 0; i < n; i++) {
    planes.color_r.push(rgb[3 * i]); planes.color_g.push(rgb[3 * i + 1]); planes.color_b.push(rgb[3 * i + 2]);
    const [qx, qy] = encodeOct(nrm[3 * i], nrm[3 * i + 1], nrm[3 * i + 2]);
    planes.normal_oct_x.push(qx); planes.normal_oct_y.push(qy);
  }
  return assemble(FORMAT_POINT27, { segmentId: 7, level: 2, lod: 0, chunkIndex: 0 }, pos, n, planes);
}
function packGauss56(pos, fdc, opa, scl, rot, n) {
  const planes = { color_r: [], color_g: [], color_b: [], opacity: [], scale_0: [], scale_1: [], scale_2: [], rotation: [] };
  for (let i = 0; i < n; i++) {
    const col = [0, 1, 2].map((k) => clamp(round((0.5 + SH_C0 * fdc[3 * i + k]) * 255), 0, 255));
    planes.color_r.push(col[0]); planes.color_g.push(col[1]); planes.color_b.push(col[2]);
    planes.opacity.push(clamp(round(255 / (1 + Math.exp(-opa[i]))), 0, 255));
    for (let k = 0; k < 3; k++) {
      planes[`scale_${k}`].push(clamp(round((scl[3 * i + k] - SCALE_LOG_MIN) * SCALE_LOG_STEPS_PER_UNIT), 0, 255));
    }
    planes.rotation.push(encodeRot(rot[4 * i], rot[4 * i + 1], rot[4 * i + 2], rot[4 * i + 3]));
  }
  return assemble(FORMAT_GAUSS56, { segmentId: 7, level: 3, lod: 1, chunkIndex: 2 }, pos, n, planes);
}

// ---------------------------------------------------------------------------
// 무작위·측정 도구
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rnd) {
  const u = 1 - rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}
const DEG = 180 / Math.PI;
/** 두 벡터 사이 각(도), atan2 형이라 작은 각도 정확. */
function vecAngleDeg(a, b) {
  const cx = a[1] * b[2] - a[2] * b[1];
  const cy = a[2] * b[0] - a[0] * b[2];
  const cz = a[0] * b[1] - a[1] * b[0];
  return Math.atan2(Math.hypot(cx, cy, cz), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) * DEG;
}
/** 두 사원수가 나타내는 회전 사이 각(도). q 와 −q 는 같은 회전. */
function rotAngleDeg(p, q) {
  const lp = Math.hypot(...p), lq = Math.hypot(...q);
  const a = p.map((c) => c / lp);
  let b = q.map((c) => c / lq);
  if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0) b = b.map((c) => -c);
  const d = Math.hypot(...a.map((c, k) => c - b[k]));
  const s = Math.hypot(...a.map((c, k) => c + b[k]));
  return 4 * Math.atan2(d, s) * DEG;
}
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

// 법선 경계 사례: 극, 적도(z=0), z<0 접힘, sgn(0)=+1 갈래, 접힘 대각선 근처
const EDGE_NORMALS = [
  [0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0],
  [Math.SQRT1_2, Math.SQRT1_2, 0], [-Math.SQRT1_2, Math.SQRT1_2, 0], [Math.SQRT1_2, -Math.SQRT1_2, 0], [-Math.SQRT1_2, -Math.SQRT1_2, 0],
  [0.6, 0, -0.8], [-0.6, 0, -0.8], [0, 0.6, -0.8], [0, -0.6, -0.8], [0.5, -0.5, -Math.SQRT1_2], [-0.5, 0.5, -Math.SQRT1_2],
  [1e-3, 1e-3, -1], [-1e-3, -1e-3, -1], [1e-3, -1e-3, 1], [0.6, 0.8, -1e-4], [0.6, 0.8, 1e-4], [-0.8, -0.6, -1e-4],
  [1, 1, -1], [-1, 1, -1], [1, -1, 1], [0.999, 0, -0.0447], [0, -0.999, -0.0447],
];
// 회전 경계 사례: w·x·y·z 각각이 최대(양·음), 같은 크기(작은 k 우선), 나머지 성분 ±1/√2(a=0·1022)
const EDGE_ROTATIONS = [];
for (let m = 0; m < 4; m++) {
  const e = [0, 0, 0, 0]; e[m] = 1;
  EDGE_ROTATIONS.push(e, e.map((c) => -c));
  const big = [0.3, -0.2, 0.25, -0.15]; big[m] = 0.85;
  EDGE_ROTATIONS.push(big, big.map((c) => -c));
  const tie = [0.5, -0.5, 0.5, -0.5]; tie[m] = 0.5 + 1e-6;
  EDGE_ROTATIONS.push(tie, tie.map((c) => -c));
  const other = (m + 1) % 4;
  const half = [0, 0, 0, 0]; half[m] = Math.SQRT1_2 + 1e-7; half[other] = Math.SQRT1_2;
  EDGE_ROTATIONS.push(half);
  const halfNeg = [0, 0, 0, 0]; halfNeg[m] = Math.SQRT1_2 + 1e-7; halfNeg[other] = -Math.SQRT1_2;
  EDGE_ROTATIONS.push(halfNeg);
}
EDGE_ROTATIONS.push([0.5, 0.5, 0.5, 0.5], [-0.5, 0.5, -0.5, 0.5], [Math.SQRT1_2, Math.SQRT1_2, 0, 0], [0, 0, -Math.SQRT1_2, Math.SQRT1_2]);

// 조각 설정: quant_exp 10·9·8 과 |좌표| 4096 근처(f32 반올림이 가장 큰 구간)
const CHUNKS = [
  { name: 'q10', tile: [1, -2], u: [-30, 30], expect: 10 },
  { name: 'q9', tile: [-3, 5], u: [-60, 60], expect: 9 },
  { name: 'q8', tile: [0, 0], u: [-120, 125], expect: 8 },
  { name: 'far', tile: [63, -64], u: [3800, 4050], expect: 8 },
  // u 가 2048 을 지나 f32 지수가 바뀐다. 최솟값이 2^-13 의 홀수 배라 2048 위 복원값은 f32 로 정확하지 않다
  { name: 'binade', tile: [31, -33], u: [1990 + 2 ** -13, 2110.7], expect: 9 },
];
const N = 4000;

function randomPositions(rnd, cfg, n) {
  const pos = new Float32Array(3 * n);
  const [tx, ty] = cfg.tile;
  for (let i = 0; i < n; i++) {
    pos[3 * i] = 64 * tx + 0.005 + rnd() * 63.98;
    pos[3 * i + 1] = 64 * ty + 0.005 + rnd() * 63.98;
    pos[3 * i + 2] = cfg.u[0] + rnd() * (cfg.u[1] - cfg.u[0]);
  }
  // 축 범위 끝점이 실제로 나오게 둔다(양자화 지수 고정)
  pos[2] = cfg.u[0];
  pos[5] = cfg.u[1];
  return pos;
}

/** 위치 오차 검사: f64 복원(기준식) ≤ 반 단계, f32 출력 = fround(f64 복원), f32 오차 ≤ 반 단계 + f32 반올림. */
function checkPositions(enc, src, out, n, stats, cfg) {
  assert.equal(enc.qexp, cfg.expect, `${cfg.name} quant_exp`);
  const step = 2 ** -enc.qexp;
  const b64 = ERROR_BOUNDS.positionAxisM(enc.qexp);
  const b32 = b64 + ERROR_BOUNDS.positionF32ExtraM;
  let bad = 0;
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) {
    const x = src[3 * i + a];
    assert.ok(Math.abs(x) < 4096, 'f32 상한 전제 |좌표| < 4096');
    const r64 = enc.min[a] + enc.posQ[a][i] * step;
    const e64 = Math.abs(r64 - x);
    const e32 = Math.abs(out[3 * i + a] - x);
    if (out[3 * i + a] !== Math.fround(r64) || e64 > b64 || e32 > b32) bad++;
    const k = `${cfg.name}(q${enc.qexp})`;
    stats.pos64[k] = Math.max(stats.pos64[k] ?? 0, e64);
    stats.pos32[k] = Math.max(stats.pos32[k] ?? 0, e32);
    stats.f32Extra = Math.max(stats.f32Extra, Math.abs(out[3 * i + a] - r64));
  }
  return bad;
}

test('unpack_error_bound', () => {
  const rnd = mulberry32(0x5eed0307);
  const stats = { pos64: {}, pos32: {}, f32Extra: 0, normalDeg: 0, color: 0, fdc: 0, alpha: 0, scale: 0, rotDeg: 0 };
  const viol = { pos: 0, normal: 0, color: 0, fdc: 0, alpha: 0, scale: 0, rot: 0 };

  // 형식 1: 27 B 점
  for (const cfg of CHUNKS) {
    const pos = randomPositions(rnd, cfg, N);
    const nrm = new Float32Array(3 * N);
    const rgb = new Uint8Array(3 * N);
    for (let i = 0; i < N; i++) {
      let v;
      if (i < EDGE_NORMALS.length) v = EDGE_NORMALS[i];
      else { v = [gauss(rnd), gauss(rnd), gauss(rnd)]; }
      const l = Math.hypot(...v);
      nrm.set(v.map((c) => c / l), 3 * i);
      for (let k = 0; k < 3; k++) rgb[3 * i + k] = Math.floor(rnd() * 256);
    }
    const enc = packPoint27(pos, nrm, rgb, N);
    const { header, fields } = unpackChunk(enc.file);
    assert.equal(header.format, FORMAT_POINT27);
    assert.ok(fields.positions instanceof Float32Array && fields.normals instanceof Float32Array && fields.colors instanceof Uint8Array);
    viol.pos += checkPositions(enc, pos, fields.positions, N, stats, cfg);
    for (let i = 0; i < N; i++) {
      const src = [nrm[3 * i], nrm[3 * i + 1], nrm[3 * i + 2]];
      const dec = [fields.normals[3 * i], fields.normals[3 * i + 1], fields.normals[3 * i + 2]];
      const ang = vecAngleDeg(src, dec);
      stats.normalDeg = Math.max(stats.normalDeg, ang);
      if (!(ang <= ERROR_BOUNDS.normalDeg)) viol.normal++;
      for (let k = 0; k < 3; k++) {
        const d = Math.abs(fields.colors[3 * i + k] - rgb[3 * i + k]);
        stats.color = Math.max(stats.color, d);
        if (d > ERROR_BOUNDS.colorPoint27) viol.color++;
      }
    }
    // 원본 레코드: 길이와 필드 값
    const rec = toSourceRecords(enc.file);
    assert.equal(rec.length, N * 27);
    const dv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
    for (const i of [0, 1, N - 1]) {
      for (let a = 0; a < 3; a++) {
        assert.equal(dv.getFloat32(27 * i + 4 * a, true), fields.positions[3 * i + a]);
        assert.equal(dv.getFloat32(27 * i + 12 + 4 * a, true), fields.normals[3 * i + a]);
        assert.equal(rec[27 * i + 24 + a], rgb[3 * i + a]);
      }
    }
  }

  // 형식 2: 56 B 가우시안
  const EDGE_OPACITY = [-30, -20, -6.2324, 0, 6.2324, 20, 30];
  const EDGE_SCALE = [SCALE_LOG_MIN, 5.9375];
  const EDGE_FDC = [0, Math.fround(-0.5 / SH_C0 * 0.9999999), Math.fround(0.5 / SH_C0 * 0.9999999), (127.5 / 255 - 0.5) / SH_C0];
  for (const cfg of CHUNKS) {
    const pos = randomPositions(rnd, cfg, N);
    const fdc = new Float32Array(3 * N);
    const opa = new Float32Array(N);
    const scl = new Float32Array(3 * N);
    const rot = new Float32Array(4 * N);
    for (let i = 0; i < N; i++) {
      for (let k = 0; k < 3; k++) {
        // 앞 몇 점은 동점·끝 값: f_dc 0(c·255 = 127.5), ±0.5/C0 에 가까운 값
        fdc[3 * i + k] = i < EDGE_FDC.length ? EDGE_FDC[i] : (rnd() - 0.5) / SH_C0;
        scl[3 * i + k] = i < EDGE_SCALE.length ? EDGE_SCALE[i] : SCALE_LOG_MIN + rnd() * (5.9375 - SCALE_LOG_MIN);
      }
      opa[i] = i < EDGE_OPACITY.length ? EDGE_OPACITY[i] : (rnd() - 0.5) * 24;
      let q;
      if (i < EDGE_ROTATIONS.length) q = EDGE_ROTATIONS[i];
      else q = [gauss(rnd), gauss(rnd), gauss(rnd), gauss(rnd)];
      const l = Math.hypot(...q);
      rot.set(q.map((c) => c / l), 4 * i);
    }
    const enc = packGauss56(pos, fdc, opa, scl, rot, N);
    const { header, fields } = unpackChunk(enc.file);
    assert.equal(header.format, FORMAT_GAUSS56);
    viol.pos += checkPositions(enc, pos, fields.positions, N, stats, cfg);
    let mCount = [0, 0, 0, 0];
    for (let i = 0; i < N; i++) {
      for (let k = 0; k < 3; k++) {
        const c = 0.5 + SH_C0 * fdc[3 * i + k];
        assert.ok(c >= 0 && c <= 1, 'f_dc 상한 적용 범위');
        const ef = Math.abs(fields.fdc[3 * i + k] - fdc[3 * i + k]);
        stats.fdc = Math.max(stats.fdc, ef);
        if (!(ef <= ERROR_BOUNDS.gaussFdc)) viol.fdc++;
        const es = Math.abs(fields.scales[3 * i + k] - scl[3 * i + k]);
        stats.scale = Math.max(stats.scale, es);
        if (!(es <= ERROR_BOUNDS.scaleLog)) viol.scale++;
      }
      const ea = Math.abs(sigmoid(fields.opacity[i]) - sigmoid(opa[i]));
      stats.alpha = Math.max(stats.alpha, ea);
      if (!(ea <= ERROR_BOUNDS.opacityAlpha) || !Number.isFinite(fields.opacity[i])) viol.alpha++;
      const src = Array.from(rot.subarray(4 * i, 4 * i + 4));
      const dec = Array.from(fields.rotations.subarray(4 * i, 4 * i + 4));
      const er = rotAngleDeg(src, dec);
      stats.rotDeg = Math.max(stats.rotDeg, er);
      if (!(er <= ERROR_BOUNDS.rotationDeg)) viol.rot++;
      // 가장 큰 성분 ≥ 0
      let m = 0;
      for (let k = 1; k < 4; k++) if (Math.abs(dec[k]) > Math.abs(dec[m])) m = k;
      assert.ok(dec[m] >= 0);
      mCount[enc.file[HEADER_SIZE + bodyLayout(FORMAT_GAUSS56, N).planes[10].offset + 4 * i + 3] >>> 6]++;
    }
    // 네 성분이 모두 '가장 큰 성분'으로 나왔다
    assert.ok(mCount.every((c) => c > 0), `m 분포 ${mCount}`);
    const rec = toSourceRecords(enc.file);
    assert.equal(rec.length, N * 56);
    const dv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
    for (const i of [0, 1, N - 1]) {
      const o = 56 * i;
      for (let a = 0; a < 3; a++) {
        assert.equal(dv.getFloat32(o + 4 * a, true), fields.positions[3 * i + a]);
        assert.equal(dv.getFloat32(o + 12 + 4 * a, true), fields.fdc[3 * i + a]);
        assert.equal(dv.getFloat32(o + 28 + 4 * a, true), fields.scales[3 * i + a]);
      }
      assert.equal(dv.getFloat32(o + 24, true), fields.opacity[i]);
      for (let k = 0; k < 4; k++) assert.equal(dv.getFloat32(o + 40 + 4 * k, true), fields.rotations[4 * i + k]);
    }
  }

  // 조각과 별도로 법선·회전 무작위 20만 개를 직접 왕복(최대 오차 관측용)
  for (let i = 0; i < 200000; i++) {
    const v = [gauss(rnd), gauss(rnd), gauss(rnd)];
    const ang = vecAngleDeg(v, decodeOctNormal(...encodeOct(...v)));
    stats.normalDeg = Math.max(stats.normalDeg, ang);
    if (!(ang <= ERROR_BOUNDS.normalDeg)) viol.normal++;
    const q = [gauss(rnd), gauss(rnd), gauss(rnd), gauss(rnd)];
    const er = rotAngleDeg(q, decodeRotation(encodeRot(...q)));
    stats.rotDeg = Math.max(stats.rotDeg, er);
    if (!(er <= ERROR_BOUNDS.rotationDeg)) viol.rot++;
  }

  const mm = (m) => (m * 1000).toFixed(10);
  console.log(
    `unpack_error_bound max observed: ` +
    `pos f64 ${Object.entries(stats.pos64).map(([k, v]) => `${k}=${mm(v)}mm`).join(' ')}; ` +
    `pos f32 ${Object.entries(stats.pos32).map(([k, v]) => `${k}=${mm(v)}mm`).join(' ')}; ` +
    `f32 rounding ${mm(stats.f32Extra)}mm (bound ${mm(ERROR_BOUNDS.positionF32ExtraM)}mm); ` +
    `normal ${stats.normalDeg.toFixed(4)}deg; color27 ${stats.color}; f_dc ${stats.fdc.toPrecision(10)} (bound ${ERROR_BOUNDS.gaussFdc.toPrecision(10)}); ` +
    `alpha ${stats.alpha.toPrecision(10)} (bound ${ERROR_BOUNDS.opacityAlpha.toPrecision(10)}); lnScale ${stats.scale.toPrecision(10)}; rotation ${stats.rotDeg.toFixed(4)}deg`,
  );
  console.log(`unpack_error_bound violations: ${JSON.stringify(viol)}`);
  assert.deepEqual(viol, { pos: 0, normal: 0, color: 0, fdc: 0, alpha: 0, scale: 0, rot: 0 });
});

test('reference_encoder_matches_generate', () => {
  // 골든 입력 규칙(사이드카 inputRule)을 복사본 부호화로 다시 만들어 generate.mjs 결과와 비교(체크섬 4바이트 제외)
  const same = (a, b) => {
    assert.equal(a.length, b.length);
    for (let i = 0; i < a.length; i++) if (i < OFFSETS.checksum || i >= OFFSETS.checksum + 4) assert.equal(a[i], b[i], `byte ${i}`);
  };
  {
    const n = 32;
    const NORMALS = [[0, 0, 1], [0.6, 0, 0.8], [0, -0.6, -0.8], [0.36, 0.48, 0.8]];
    const pos = new Float32Array(3 * n), nrm = new Float32Array(3 * n), rgb = new Uint8Array(3 * n);
    for (let i = 0; i < n; i++) {
      pos.set([64 + (i % 8) * 0.5, -128 + Math.floor(i / 8) * 0.75, 1 + i * 0.0625], 3 * i);
      nrm.set(NORMALS[i % 4], 3 * i);
      rgb.set([i * 8, 255 - i * 8, (i * 37) % 256], 3 * i);
    }
    same(packPoint27(pos, nrm, rgb, n).file, buildPoint27());
  }
  {
    const n = 21;
    const pos = new Float32Array(3 * n), fdc = new Float32Array(3 * n), opa = new Float32Array(n);
    const scl = new Float32Array(3 * n), rot = new Float32Array(4 * n);
    for (let i = 0; i < n; i++) {
      pos.set([10 + (i % 7), 20 + Math.floor(i / 7) * 2, -2 + i * 0.25], 3 * i);
      const target = [i * 12, 128, 255 - i * 12];
      for (let k = 0; k < 3; k++) fdc[3 * i + k] = (target[k] / 255 - 0.5) / SH_C0;
      opa[i] = (i - 10) * 0.5;
      scl.set([-6 + i * 0.25, -3.5, -2 - i * 0.125], 3 * i);
      const half = (i * 7.5 * Math.PI) / 180;
      rot.set([Math.cos(half), 0, 0, Math.sin(half)], 4 * i);
    }
    same(packGauss56(pos, fdc, opa, scl, rot, n).file, buildGauss56());
  }
});

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const nearArr = (a, b, tol, msg) => b.forEach((v, k) => near(a[k], v, tol, `${msg}[${k}]`));

test('unpack_golden_sidecar', () => {
  const p27 = new Uint8Array(readFileSync(new URL('point27.skla', GOLDEN)));
  const s27 = JSON.parse(readFileSync(new URL('point27.json', GOLDEN), 'utf8'));
  {
    const { header, fields } = unpackChunk(p27);
    assert.equal(header.pointCount, 32);
    assert.equal(toSourceRecords(p27).length, 32 * 27);
    // 첫 점(0): 저장 0·0·0 → 원점 그대로, 법선 (0,0) → (0,0,1)
    const f = s27.firstPoint;
    assert.deepEqual(Array.from(fields.positions.subarray(0, 3)), [64, -128, 1]);
    assert.deepEqual(Array.from(fields.positions.subarray(0, 3)), f.source.position);
    assert.deepEqual(Array.from(fields.normals.subarray(0, 3)), [0, 0, 1]);
    assert.deepEqual(Array.from(fields.colors.subarray(0, 3)), [0, 255, 0]);
    // 끝 점(31): 저장 (3584, 2304, 1984) → 67.5, −125.75, 2.9375; 법선 (28, 37) → (28, 37, 62)/√5997
    const l = s27.lastPoint;
    assert.deepEqual(Array.from(fields.positions.subarray(93, 96)), [67.5, -125.75, 2.9375]);
    assert.deepEqual(Array.from(fields.positions.subarray(93, 96)), l.source.position);
    nearArr(fields.normals.subarray(93, 96), [0.36156884, 0.47778741, 0.80061674], 1e-7, 'p27 last normal');
    assert.ok(vecAngleDeg(Array.from(fields.normals.subarray(93, 96)), l.source.normal) <= ERROR_BOUNDS.normalDeg);
    assert.deepEqual(Array.from(fields.colors.subarray(93, 96)), [248, 7, 123]);
    assert.deepEqual(Array.from(fields.colors.subarray(93, 96)), l.source.rgb);
    assert.deepEqual(decodeOctNormal(l.stored.normal_oct_x, l.stored.normal_oct_y).map(Math.fround), Array.from(fields.normals.subarray(93, 96)));
  }

  const g56 = new Uint8Array(readFileSync(new URL('gauss56.skla', GOLDEN)));
  const s56 = JSON.parse(readFileSync(new URL('gauss56.json', GOLDEN), 'utf8'));
  {
    const { header, fields } = unpackChunk(g56);
    assert.equal(header.pointCount, 21);
    assert.equal(toSourceRecords(g56).length, 21 * 56);
    const f = s56.firstPoint;
    assert.deepEqual(Array.from(fields.positions.subarray(0, 3)), [10, 20, -2]);
    assert.deepEqual(Array.from(fields.positions.subarray(0, 3)), f.source.position);
    // f_dc = (c/255 − 0.5)/C0, c = (0, 128, 255)
    nearArr(fields.fdc.subarray(0, 3), [-1.7724538509, 0.0069507435, 1.7724538509], 1e-6, 'g56 first f_dc');
    // opacity q=2 → ln(2/253)
    near(fields.opacity[0], -4.8402423, 1e-6, 'g56 first opacity');
    near(Math.abs(sigmoid(fields.opacity[0]) - sigmoid(f.source.opacityLogit)), 0, ERROR_BOUNDS.opacityAlpha, 'g56 first alpha');
    assert.deepEqual(Array.from(fields.scales.subarray(0, 3)), [-6, -3.5, -2]);
    assert.deepEqual(Array.from(fields.scales.subarray(0, 3)), f.source.scaleLog);
    assert.deepEqual(Array.from(fields.rotations.subarray(0, 4)), [1, 0, 0, 0]);

    const l = s56.lastPoint;
    const i = l.index;
    assert.equal(i, 20);
    assert.deepEqual(Array.from(fields.positions.subarray(60, 63)), [16, 24, 3]);
    assert.deepEqual(Array.from(fields.positions.subarray(60, 63)), l.source.position);
    // c = (240, 128, 15)
    nearArr(fields.fdc.subarray(60, 63), [1.5639299, 0.0069507435, -1.5639299], 1e-6, 'g56 last f_dc');
    for (let k = 0; k < 3; k++) {
      near(fields.fdc[60 + k], (l.source.rgbTarget[k] / 255 - 0.5) / SH_C0, ERROR_BOUNDS.gaussFdc, 'g56 last f_dc bound');
    }
    // opacity q=253 → ln(253/2)
    near(fields.opacity[20], 4.8402424, 1e-6, 'g56 last opacity');
    assert.deepEqual(Array.from(fields.scales.subarray(60, 63)), [-1, -3.5, -4.5]);
    assert.deepEqual(Array.from(fields.scales.subarray(60, 63)), l.source.scaleLog);
    // 저장 z 성분 150 → z = −361/(511√2) = −0.4995412, w = √(1 − z²) = 0.8662902 (원본 (−0.866, 0, 0, 0.5) 의 부호 반전)
    nearArr(fields.rotations.subarray(80, 84), [0.8662902, 0, 0, -0.4995412], 1e-6, 'g56 last rotation');
    assert.ok(rotAngleDeg(Array.from(fields.rotations.subarray(80, 84)), l.source.rotation) <= ERROR_BOUNDS.rotationDeg);
    assert.deepEqual(decodeRotation(l.stored.rotation).map(Math.fround), Array.from(fields.rotations.subarray(80, 84)));
    assert.deepEqual(decodeRotation(f.stored.rotation), [1, 0, 0, 0]);
  }
});

test('unpack_rejects_bad_input', () => {
  const g = new Uint8Array(readFileSync(new URL('gauss56.skla', GOLDEN)));
  const expectCode = (bytes, code) => assert.throws(() => unpackChunk(bytes), (e) => e instanceof AssetFormatError && e.code === code);
  const codec = g.slice(); codec[OFFSETS.codec] = 1; expectCode(codec, 'codec');
  expectCode(g.slice(0, g.length - 4), 'body');
  const extra = new Uint8Array(g.length + 4); extra.set(g); expectCode(extra, 'body');
  const qe = g.slice(); qe[OFFSETS.quantExp] = 11; expectCode(qe, 'field');
  // 회전 성분 1023 은 쓰지 않는 값
  assert.throws(() => decodeRotation((0 << 30) | (1023 << 20) | (511 << 10) | 511), (e) => e instanceof AssetFormatError && e.code === 'range');
  assert.throws(() => decodeOctNormal(-128, 0), (e) => e instanceof AssetFormatError && e.code === 'range');
  // 부 버전이 높으면 확장 평면을 무시하고 읽는다
  const h = parseHeader(g);
  const ext = new Uint8Array(g.length + 8);
  ext.set(g);
  const dv = new DataView(ext.buffer);
  dv.setUint16(OFFSETS.versionMinor, 1, true);
  dv.setUint32(OFFSETS.bodyBytes, h.bodyBytes + 8, true);
  assert.deepEqual(toSourceRecords(ext), toSourceRecords(g));
});
