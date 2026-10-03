// T03.7 역변환 시험. 명세 format/ASSET_FORMAT.md §6 복원식, §8 오차 상한.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FORMAT_POINT27, FORMAT_GAUSS56, HEADER_SIZE, SH_C0, SCALE_LOG_MIN,
  OFFSETS, ERROR_BOUNDS, AssetFormatError, bodyLayout, parseHeader,
} from '../../../contracts/asset/index.mjs';
import {
  ANCHOR, encodeOct, encodeRot, encodeFdc, encodeOpacity, encodeScale,
} from '../../../fixtures/asset_golden/generate.mjs';
import { packChunk, encodeOctNormal, encodeRotation } from '../pack/index.mjs';
import { unpackChunk, toSourceRecords, decodeOctNormal, decodeRotation } from './index.mjs';

const GOLDEN = new URL('../../../fixtures/asset_golden/', import.meta.url);

// ---------------------------------------------------------------------------
// 부호화는 제품 packChunk 로 한다. generate.mjs 의 참조 부호기는 사이드카 손계산 대조에만 쓴다.
// ---------------------------------------------------------------------------
const META27 = { segmentId: 7, level: 2, lod: 0, chunkIndex: 0 };
const META56 = { segmentId: 7, level: 3, lod: 1, chunkIndex: 2 };

/** 조각 본문에서 평면 하나의 값을 읽는다(복원기와 무관하게 바이트에서 직접). */
function readPlane(file, format, n, name) {
  const p = bodyLayout(format, n).planes.find((x) => x.name === name);
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const o = HEADER_SIZE + p.offset;
  return Array.from({ length: n }, (_, i) => (p.type === 'u16' ? dv.getUint16(o + 2 * i, true)
    : p.type === 'u8' ? dv.getUint8(o + i) : p.type === 'i8' ? dv.getInt8(o + i) : dv.getUint32(o + 4 * i, true)));
}

/** 제품 packChunk 로 부호화하고 위치 검사에 쓸 저장 값을 바이트에서 꺼낸다. */
function packProduct(format, meta, fields) {
  const file = packChunk({ format, ...meta, anchor: ANCHOR, fields });
  const n = fields.positions.length / 3;
  const h = parseHeader(file);
  // bbox_min 은 원본 최솟값과 같아야 한다(§5.1)
  const min = [0, 1, 2].map((a) => { let m = Infinity; for (let i = 0; i < n; i++) m = Math.min(m, fields.positions[3 * i + a]); return m; });
  assert.deepEqual(h.bboxMin, min);
  const posQ = ['pos_e', 'pos_n', 'pos_u'].map((name) => readPlane(file, format, n, name));
  return { file, qexp: h.quantExp, min, posQ };
}

// f32 순서 키: 정수 비교가 f32 값 순서와 같다
const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);
const f32Key = (x) => { F32[0] = x; const b = U32[0]; return b & 0x80000000 ? -(b & 0x7fffffff) : b; };
const keyF32 = (k) => { U32[0] = k < 0 ? (0x80000000 | -k) >>> 0 : k; return F32[0]; };
const nextUp = (x) => keyF32(f32Key(x) + 1);
/** 단조 증가 enc 에서 enc(x) ≥ t 인 가장 작은 f32 키(lo..hi 안). */
function firstKey(enc, t, lo, hi) {
  while (lo < hi) { const m = Math.floor((lo + hi) / 2); if (enc(keyF32(m)) >= t) hi = m; else lo = m + 1; }
  return lo;
}
/**
 * 저장 값 v=0..255 각각을 만드는 가장 작은·가장 큰 f32 원본(§5 식, f64 계산). [lo, hi] 키 범위 안에서 찾는다.
 * @returns {{v: number, lo: number, hi: number}[]}
 */
function codeEnds(enc, loKey, hiKey) {
  const out = [];
  for (let v = 0; v <= 255; v++) {
    const a = firstKey(enc, v, loKey, hiKey);
    const b = v === 255 ? hiKey : firstKey(enc, v + 1, loKey, hiKey + 1) - 1;
    out.push({ v, lo: keyF32(a), hi: keyF32(b) });
  }
  return out;
}
const round5 = (x) => Math.floor(x + 0.5);
const clamp8 = (x) => Math.min(255, Math.max(0, x));
const encFdcSpec = (f) => clamp8(round5((0.5 + SH_C0 * f) * 255));
const encOpaSpec = (l) => clamp8(round5(255 / (1 + Math.exp(-l))));
// f_dc 상한 적용 범위 0.5 + C0·f ∈ [0, 1] 의 f32 끝
let FDC_LO_KEY = f32Key(Math.fround(-0.5 / SH_C0));
while (0.5 + SH_C0 * keyF32(FDC_LO_KEY) < 0) FDC_LO_KEY++;
let FDC_HI_KEY = f32Key(Math.fround(0.5 / SH_C0));
while (0.5 + SH_C0 * keyF32(FDC_HI_KEY) > 1) FDC_HI_KEY--;
const F32_MAX_KEY = f32Key(3.4028234663852886e38);
/** 색 코드 c 마다 끝점 f32 원본(§5.2). */
const FDC_ENDS = codeEnds(encFdcSpec, FDC_LO_KEY, FDC_HI_KEY);
/** 불투명도 q 마다 끝점 f32 로짓 원본(§5.5). q=0·255 는 ±f32 최댓값까지. */
const OPA_ENDS = codeEnds(encOpaSpec, -F32_MAX_KEY, F32_MAX_KEY);

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
    const enc = packProduct(FORMAT_POINT27, META27, { positions: pos, normals: nrm, colors: rgb });
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
  // 끝점 원본: 저장 구간 아래 끝(닫힘)은 f32 복원 후에도 상한 안이어야 한다(§8, 반올림 방향).
  // 위 끝(열림)은 §8 의 f64 상한 + f32 반올림(|f32 복원 − f64 복원|)까지 허용한다.
  const EDGE_FDC = [];
  const EDGE_FDC_OPEN = [];
  for (const v of [0, Math.fround(-0.5 / SH_C0 * 0.9999999), Math.fround(0.5 / SH_C0 * 0.9999999), (127.5 / 255 - 0.5) / SH_C0]) {
    for (let k = 0; k < 3; k++) { EDGE_FDC.push(v); EDGE_FDC_OPEN.push(false); }
  }
  for (const e of FDC_ENDS) {
    EDGE_FDC.push(e.lo, e.hi);
    EDGE_FDC_OPEN.push(false, e.v < 255);
  }
  const EDGE_OPACITY = [-30, -20, -6.2324, 0, 6.2324, 20, 30];
  const EDGE_OPACITY_OPEN = EDGE_OPACITY.map(() => false);
  for (const e of OPA_ENDS) {
    EDGE_OPACITY.push(e.lo, e.hi);
    EDGE_OPACITY_OPEN.push(false, e.v > 0 && e.v < 255);
  }
  assert.ok(EDGE_FDC.length <= 3 * N && EDGE_OPACITY.length <= N);
  // 끝점이 빈틈없이 이어진다: c 의 위 끝 바로 다음 f32 = c+1 의 아래 끝(가장 작은·가장 큰 원본)
  for (const ends of [FDC_ENDS, OPA_ENDS]) {
    for (let v = 0; v < 255; v++) assert.equal(nextUp(ends[v].hi), ends[v + 1].lo, `ends ${v}→${v + 1}`);
  }
  // f64 기준식 비교의 f64 연산 반올림 여유(예: c=128 아래 끝 −9.8e-17 에서 7e-17 초과)
  const EPS64 = 1e-15;
  const EDGE_SCALE = [SCALE_LOG_MIN, 5.9375];
  for (const cfg of CHUNKS) {
    const pos = randomPositions(rnd, cfg, N);
    const fdc = new Float32Array(3 * N);
    const opa = new Float32Array(N);
    const scl = new Float32Array(3 * N);
    const rot = new Float32Array(4 * N);
    for (let i = 0; i < N; i++) {
      for (let k = 0; k < 3; k++) {
        const j = 3 * i + k;
        fdc[j] = j < EDGE_FDC.length ? EDGE_FDC[j] : (rnd() - 0.5) / SH_C0;
        scl[j] = i < EDGE_SCALE.length ? EDGE_SCALE[i] : SCALE_LOG_MIN + rnd() * (5.9375 - SCALE_LOG_MIN);
      }
      opa[i] = i < EDGE_OPACITY.length ? EDGE_OPACITY[i] : (rnd() - 0.5) * 24;
      let q;
      if (i < EDGE_ROTATIONS.length) q = EDGE_ROTATIONS[i];
      else q = [gauss(rnd), gauss(rnd), gauss(rnd), gauss(rnd)];
      const l = Math.hypot(...q);
      rot.set(q.map((c) => c / l), 4 * i);
    }
    const enc = packProduct(FORMAT_GAUSS56, META56, { positions: pos, fdc, opacity: opa, scales: scl, rotations: rot });
    const { header, fields } = unpackChunk(enc.file);
    assert.equal(header.format, FORMAT_GAUSS56);
    viol.pos += checkPositions(enc, pos, fields.positions, N, stats, cfg);
    const storedC = [readPlane(enc.file, FORMAT_GAUSS56, N, 'color_r'), readPlane(enc.file, FORMAT_GAUSS56, N, 'color_g'), readPlane(enc.file, FORMAT_GAUSS56, N, 'color_b')];
    const storedQ = readPlane(enc.file, FORMAT_GAUSS56, N, 'opacity');
    // 끝점 원본이 제품 부호화에서도 의도한 저장 값이 되는지
    for (let e = 0; e < FDC_ENDS.length; e++) {
      for (const [side, off] of [['lo', 0], ['hi', 1]]) {
        const j = 12 + 2 * e + off;
        assert.equal(storedC[j % 3][Math.floor(j / 3)], e, `f_dc ${side} end c=${e}`);
      }
      assert.equal(storedQ[7 + 2 * e], e, `opacity lo end q=${e}`);
      assert.equal(storedQ[8 + 2 * e], e, `opacity hi end q=${e}`);
    }
    let mCount = [0, 0, 0, 0];
    for (let i = 0; i < N; i++) {
      for (let k = 0; k < 3; k++) {
        const c = 0.5 + SH_C0 * fdc[3 * i + k];
        assert.ok(c >= 0 && c <= 1, 'f_dc 상한 적용 범위');
        const j = 3 * i + k;
        const ef = Math.abs(fields.fdc[j] - fdc[j]);
        stats.fdc = Math.max(stats.fdc, ef);
        // f64 복원(§6)은 상한 안, f32 복원은 열린 끝에서만 f32 반올림만큼 더 허용
        const r64 = (storedC[k][i] / 255 - 0.5) / SH_C0;
        const open = j < EDGE_FDC.length && EDGE_FDC_OPEN[j];
        const slack = open ? Math.abs(fields.fdc[j] - r64) : 0;
        if (!(Math.abs(r64 - fdc[j]) <= ERROR_BOUNDS.gaussFdc + EPS64) || !(ef <= ERROR_BOUNDS.gaussFdc + slack)) viol.fdc++;
        const es = Math.abs(fields.scales[3 * i + k] - scl[3 * i + k]);
        stats.scale = Math.max(stats.scale, es);
        if (!(es <= ERROR_BOUNDS.scaleLog)) viol.scale++;
      }
      const ea = Math.abs(sigmoid(fields.opacity[i]) - sigmoid(opa[i]));
      stats.alpha = Math.max(stats.alpha, ea);
      const a64 = Math.min(509 / 510, Math.max(1 / 510, storedQ[i] / 255));
      const openA = i < EDGE_OPACITY.length && EDGE_OPACITY_OPEN[i];
      const slackA = openA ? Math.abs(sigmoid(fields.opacity[i]) - a64) : 0;
      if (!(Math.abs(a64 - sigmoid(opa[i])) <= ERROR_BOUNDS.opacityAlpha + EPS64) || !(ea <= ERROR_BOUNDS.opacityAlpha + slackA)
        || !Number.isFinite(fields.opacity[i])) viol.alpha++;
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
    const ang = vecAngleDeg(v, decodeOctNormal(...encodeOctNormal(...v)));
    stats.normalDeg = Math.max(stats.normalDeg, ang);
    if (!(ang <= ERROR_BOUNDS.normalDeg)) viol.normal++;
    const q = [gauss(rnd), gauss(rnd), gauss(rnd), gauss(rnd)];
    const er = rotAngleDeg(q, decodeRotation(encodeRotation(...q)));
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

test('sidecar_stored_matches_golden_and_reference_encoder', () => {
  // 사이드카의 손계산 stored 값 = 골든 바이트 = generate.mjs 참조 부호기(원본 → 저장 값)
  const cases = [
    { file: 'point27.skla', json: 'point27.json', format: FORMAT_POINT27, keys: ['firstPoint', 'lastPoint', 'foldedNormalPoint'] },
    { file: 'gauss56.skla', json: 'gauss56.json', format: FORMAT_GAUSS56, keys: ['firstPoint', 'lastPoint', 'rotationM3Point'] },
  ];
  for (const c of cases) {
    const bytes = new Uint8Array(readFileSync(new URL(c.file, GOLDEN)));
    const side = JSON.parse(readFileSync(new URL(c.json, GOLDEN), 'utf8'));
    const n = side.header.pointCount;
    for (const key of c.keys) {
      const pt = side[key];
      assert.ok(pt, `${c.json} ${key}`);
      for (const [name, v] of Object.entries(pt.stored)) {
        assert.equal(readPlane(bytes, c.format, n, name)[pt.index], v, `${c.json} ${key}.${name}`);
      }
      const src = pt.source;
      if (c.format === FORMAT_POINT27) {
        // 원본은 Float32Array 에 담긴 값으로 부호화된다
        const nv = Array.from(new Float32Array(src.normal));
        assert.deepEqual(encodeOct(...nv), [pt.stored.normal_oct_x, pt.stored.normal_oct_y]);
        assert.deepEqual(encodeOctNormal(...nv), [pt.stored.normal_oct_x, pt.stored.normal_oct_y]);
      } else {
        const fdc = new Float32Array(src.rgbTarget.map((t) => (t / 255 - 0.5) / SH_C0));
        assert.deepEqual(Array.from(fdc, encodeFdc), [pt.stored.color_r, pt.stored.color_g, pt.stored.color_b]);
        assert.equal(encodeOpacity(Math.fround(src.opacityLogit)), pt.stored.opacity);
        assert.deepEqual(src.scaleLog.map((v) => encodeScale(Math.fround(v))), [pt.stored.scale_0, pt.stored.scale_1, pt.stored.scale_2]);
        const rv = Array.from(new Float32Array(src.rotation));
        assert.equal(encodeRot(...rv), pt.stored.rotation);
        assert.equal(encodeRotation(...rv), pt.stored.rotation);
      }
    }
  }
  // 참조 부호기와 제품 부호기가 무작위 입력에서도 같다(복사 드리프트 감시)
  const rnd = mulberry32(0x0610);
  for (let i = 0; i < 20000; i++) {
    const v = [gauss(rnd), gauss(rnd), gauss(rnd)];
    assert.deepEqual(encodeOctNormal(...v), encodeOct(...v));
    const q = [gauss(rnd), gauss(rnd), gauss(rnd), gauss(rnd)];
    assert.equal(encodeRotation(...q), encodeRot(...q));
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

    // m=3 점(8): 저장 w 성분 872 → w = 361/(511√2), z = √(1 − w²)
    const r = s56.rotationM3Point;
    assert.equal(r.stored.rotation >>> 30, 3);
    nearArr(fields.rotations.subarray(4 * r.index, 4 * r.index + 4), r.decodedRotation, 1e-7, 'g56 m=3 rotation');
    assert.ok(rotAngleDeg(Array.from(fields.rotations.subarray(4 * r.index, 4 * r.index + 4)), r.source.rotation) <= ERROR_BOUNDS.rotationDeg);
    assert.deepEqual(Array.from(fields.positions.subarray(3 * r.index, 3 * r.index + 3)), r.source.position);
  }
  {
    // 접힘 법선 점(2): 저장 (73, −127) → z<0 접힘 복원 (0, −54, −73)/√8245
    const { fields } = unpackChunk(p27);
    const p = s27.foldedNormalPoint;
    assert.ok(p.source.normal[2] < 0);
    nearArr(fields.normals.subarray(3 * p.index, 3 * p.index + 3), p.decodedNormal, 1e-7, 'p27 folded normal');
    assert.ok(vecAngleDeg(Array.from(fields.normals.subarray(3 * p.index, 3 * p.index + 3)), p.source.normal) <= ERROR_BOUNDS.normalDeg);
    assert.deepEqual(Array.from(fields.positions.subarray(3 * p.index, 3 * p.index + 3)), p.source.position);
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
