// 조각 부호화·복호화(T09.11) 시험: codec 0 ↔ codec 1 왕복, 오차 상한, 결정성, 서버·클라이언트 통합, 오류 경로, 압축률.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeChunk, decodeChunk } from './index.mjs';
import { packChunk } from '../../asset/pack/index.mjs';
import { unpackChunk } from '../../asset/unpack/index.mjs';
import { decodeChunkClient } from '../../../client/codec/index.mjs';
import { readHeaderClient, readPlanesClient } from '../../../client/asset/index.mjs';
import { parseHeader, FORMAT_POINT27, FORMAT_GAUSS56, ERROR_BOUNDS, OFFSETS } from '../../../contracts/asset/index.mjs';
import { CodecError, CODEC_SKLC1, pointMultiset } from '../../../contracts/codec/index.mjs';

const ANCHOR = { lat: 37.5, lon: 127.0, alt: 30.0 };
const PLANE_NAMES = ['pos_e', 'pos_n', 'pos_u', 'color_r', 'color_g', 'color_b', 'normal_oct_x', 'normal_oct_y'];

// 결정적 난수(mulberry32)
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function input(positions, normals, colors, extra = {}) {
  return { format: FORMAT_POINT27, segmentId: 7, level: 2, lod: 0, chunkIndex: 0, anchor: ANCHOR, fields: { positions, normals, colors }, ...extra };
}

function unitNormal(r) {
  const z = r() * 2 - 1, p = r() * 2 * Math.PI, s = Math.sqrt(1 - z * z);
  return [s * Math.cos(p), s * Math.sin(p), z];
}

// 한 타일(e 64..128, n -128..-64) 안의 무작위 점. 높이는 0..60 m.
function randomInput(n, seed) {
  const r = rng(seed);
  const pos = new Float32Array(3 * n), nor = new Float32Array(3 * n), col = new Uint8Array(3 * n);
  for (let i = 0; i < n; i++) {
    pos.set([64 + r() * 63, -128 + r() * 63, r() * 60], 3 * i);
    nor.set(unitNormal(r), 3 * i);
    col.set([r() * 256, r() * 256, r() * 256], 3 * i);
  }
  return input(pos, nor, col);
}

// 합성 지면: 완만한 기복 + 1 cm 잡음, 법선은 기울기에서, 색은 높이·무늬에 따른 완만한 변화 + 잡음.
function groundInput(n, seed) {
  const r = rng(seed);
  const pos = new Float32Array(3 * n), nor = new Float32Array(3 * n), col = new Uint8Array(3 * n);
  for (let i = 0; i < n; i++) {
    const x = r() * 63, y = r() * 63;
    const z = 20 + 3 * Math.sin(x / 9) * Math.cos(y / 11) + 0.02 * (r() - 0.5);
    const gx = (3 / 9) * Math.cos(x / 9) * Math.cos(y / 11), gy = -(3 / 11) * Math.sin(x / 9) * Math.sin(y / 11);
    const l = Math.hypot(gx, gy, 1);
    pos.set([64 + x, -128 + y, z], 3 * i);
    nor.set([-gx / l, -gy / l, 1 / l], 3 * i);
    const g = 90 + 40 * Math.sin(x / 5) + 30 * Math.cos(y / 7) + (r() - 0.5) * 6;
    col.set([g * 0.8, g, g * 0.6], 3 * i);
  }
  return input(pos, nor, col);
}

function planesOf(file) {
  const h = readHeaderClient(file);
  return { header: h, planes: readPlanesClient(file, h) };
}

// 각 점의 양자화 위치 → 원본 인덱스(위치가 모두 다를 때만 정확)
function indexByQuantPos(planes) {
  const m = new Map();
  for (let i = 0; i < planes.pos_e.length; i++) m.set(`${planes.pos_e[i]},${planes.pos_n[i]},${planes.pos_u[i]}`, i);
  return m;
}

function angleDeg(a, b) {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const la = Math.hypot(...a), lb = Math.hypot(...b);
  return (Math.acos(Math.min(1, Math.max(-1, d / (la * lb)))) * 180) / Math.PI;
}

// 모서리 65535: 두 점이 정확히 양자화 0 과 65535 가 되도록 범위를 65535/1024 m 로 잡는다.
function cornerInput() {
  const ext = 65535 / 1024;
  const pos = new Float32Array([64, -128, 1, 64 + ext, -128 + ext, 1 + ext]);
  const nor = new Float32Array([0, 0, 1, 1, 0, 0]);
  return input(pos, nor, new Uint8Array([1, 2, 3, 250, 251, 252]));
}

const CASES = [
  ['점 1 개', () => input(new Float32Array([70.25, -100.5, 3.125]), new Float32Array([0, 0, 1]), new Uint8Array([10, 20, 30]))],
  ['점 2 개(모서리 0 과 65535)', cornerInput],
  ['점 5 개 같은 점', () => input(new Float32Array(15).fill(0).map((_, i) => [70.5, -100.25, 3][i % 3]), new Float32Array(15).map((_, i) => [0, 0.6, 0.8][i % 3]), new Uint8Array(15).fill(77))],
  ['점 5 개 무작위', () => randomInput(5, 5)],
  ['점 1000 개 무작위', () => randomInput(1000, 1000)],
  ['점 5 만 개 합성 지면', () => groundInput(50000, 50000)],
];

for (const [name, make] of CASES) {
  test(`왕복(${name}): 헤더·점 다중집합 동일, unpackChunk 로 열리고 §8 오차 이내`, () => {
    const inp = make();
    const raw = packChunk(inp);
    const enc = encodeChunk(raw);
    const dec = decodeChunk(enc);
    const hr = parseHeader(raw), he = parseHeader(enc), hd = parseHeader(dec);
    assert.equal(hr.codec, 0);
    assert.equal(he.codec, CODEC_SKLC1);
    assert.equal(hd.codec, 0);
    // codec·bodyBytes·checksum 을 뺀 헤더 필드 전부 같다(복호 파일은 원본 헤더와 bodyBytes 도 같다)
    for (const k of Object.keys(hr)) {
      if (k === 'codec' || k === 'bodyBytes' || k === 'checksum') continue;
      assert.deepEqual(hd[k], hr[k], `헤더 ${k}`);
      assert.deepEqual(he[k], hr[k], `부호화 헤더 ${k}`);
    }
    assert.equal(hd.bodyBytes, hr.bodyBytes);
    assert.equal(dec.length, raw.length);
    const pr = planesOf(raw).planes, pd = planesOf(dec).planes;
    assert.deepEqual(pointMultiset(pd), pointMultiset(pr));

    // 복호 파일을 기존 unpack 으로 열고 원본 f32 와 비교
    const { header, fields } = unpackChunk(dec);
    const n = header.pointCount;
    assert.equal(n, inp.fields.positions.length / 3);
    const bound = ERROR_BOUNDS.positionAxisM(header.quantExp) + 2 ** -18; // 복원 f32 반올림(좌표 < 128 m 이므로 반 ulp = 2^-18)
    const byPos = indexByQuantPos(pr);
    let maxPos = 0, maxAng = 0;
    for (let i = 0; i < n; i++) {
      const key = `${pd.pos_e[i]},${pd.pos_n[i]},${pd.pos_u[i]}`;
      const j = byPos.get(key);
      assert.notEqual(j, undefined);
      // 같은 점 여러 개인 경우 byPos 가 마지막 인덱스를 주지만 값이 모두 같다
      for (let a = 0; a < 3; a++) maxPos = Math.max(maxPos, Math.abs(fields.positions[3 * i + a] - inp.fields.positions[3 * j + a]));
      const nv = [fields.normals[3 * i], fields.normals[3 * i + 1], fields.normals[3 * i + 2]];
      const ov = [inp.fields.normals[3 * j], inp.fields.normals[3 * j + 1], inp.fields.normals[3 * j + 2]];
      maxAng = Math.max(maxAng, angleDeg(nv, ov));
      for (let k = 0; k < 3; k++) assert.equal(fields.colors[3 * i + k], inp.fields.colors[3 * j + k]);
    }
    assert.ok(maxPos <= bound, `위치 오차 ${maxPos} > ${bound}`);
    assert.ok(maxAng <= 1.0, `법선 오차 ${maxAng}° > 1.0°`);
    if (n === 2) assert.deepEqual([Math.max(...pd.pos_e), Math.max(...pd.pos_n), Math.max(...pd.pos_u)], [65535, 65535, 65535]);
  });
}

test('encodeChunk 결정성: 같은 입력 두 번 → 바이트 동일', () => {
  const raw = packChunk(randomInput(3000, 11));
  assert.deepEqual(encodeChunk(raw), encodeChunk(raw));
  assert.deepEqual(encodeChunk(raw, { lossyColor: true }), encodeChunk(raw, { lossyColor: true }));
  assert.deepEqual(decodeChunk(encodeChunk(raw)), decodeChunk(encodeChunk(raw)));
});

test('encodeChunk 는 입력 점 순서와 무관하다(동률 없는 두 순열 → 같은 바이트)', () => {
  const n = 4000;
  const a = randomInput(n, 21);
  // 양자화 위치가 모두 달라 모턴 키 동률이 없는지 먼저 확인한다
  const rawA = packChunk(a);
  assert.equal(indexByQuantPos(planesOf(rawA).planes).size, n);
  const r = rng(99);
  const perm = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  const pos = new Float32Array(3 * n), nor = new Float32Array(3 * n), col = new Uint8Array(3 * n);
  perm.forEach((s, d) => {
    for (let k = 0; k < 3; k++) { pos[3 * d + k] = a.fields.positions[3 * s + k]; nor[3 * d + k] = a.fields.normals[3 * s + k]; col[3 * d + k] = a.fields.colors[3 * s + k]; }
  });
  const rawB = packChunk(input(pos, nor, col));
  assert.notDeepEqual(rawA, rawB); // 입력은 정말 다른 순서
  assert.deepEqual(encodeChunk(rawA), encodeChunk(rawB));
  assert.deepEqual(encodeChunk(rawA, { lossyColor: true }), encodeChunk(rawB, { lossyColor: true }));
});

test('통합 왕복: 서버 encodeChunk → client decodeChunkClient 평면이 decodeChunk 평면과 위치별 일치', () => {
  for (const [seed, n] of [[31, 1], [32, 777], [33, 20000]]) {
    const raw = packChunk(n === 20000 ? groundInput(n, seed) : randomInput(n, seed));
    for (const lossy of [false, true]) {
      const enc = encodeChunk(raw, { lossyColor: lossy });
      const cl = decodeChunkClient(enc);
      const sv = planesOf(decodeChunk(enc)).planes;
      assert.equal(cl.header.codec, CODEC_SKLC1);
      assert.equal(cl.header.pointCount, n);
      for (const name of PLANE_NAMES) {
        assert.equal(cl.planes[name].length, n, name);
        assert.deepEqual(Array.from(cl.planes[name]), Array.from(sv[name]), `${name} (n=${n}, lossy=${lossy})`);
      }
    }
  }
});

test('lossyColor: 채널 평균 절대 오차 ≤ 2, 위치·법선은 그대로', () => {
  const inp = randomInput(8000, 41); // 무작위 색: 팔레트 불가, 최악에 가까운 오차
  const raw = packChunk(inp);
  const pr = planesOf(raw).planes;
  const enc = encodeChunk(raw, { lossyColor: true });
  assert.ok(enc.length < encodeChunk(raw).length, '손실 색이 더 작아야 한다');
  const pd = planesOf(decodeChunk(enc)).planes;
  const byPos = indexByQuantPos(pr);
  const n = pd.pos_e.length;
  assert.equal(byPos.size, n);
  const sum = [0, 0, 0];
  let maxErr = 0;
  for (let i = 0; i < n; i++) {
    const j = byPos.get(`${pd.pos_e[i]},${pd.pos_n[i]},${pd.pos_u[i]}`);
    assert.equal(pd.normal_oct_x[i], pr.normal_oct_x[j]);
    assert.equal(pd.normal_oct_y[i], pr.normal_oct_y[j]);
    ['color_r', 'color_g', 'color_b'].forEach((c, k) => {
      const e = Math.abs(pd[c][i] - pr[c][j]);
      sum[k] += e;
      maxErr = Math.max(maxErr, e);
    });
  }
  const means = sum.map((s) => s / n);
  console.log(`lossyColor 채널 평균 오차 r,g,b = ${means.map((m) => m.toFixed(3)).join(', ')}, 최대 ${maxErr}`);
  for (const m of means) assert.ok(m <= 2, `평균 오차 ${m} > 2`);
  assert.ok(maxErr <= 2, `최대 오차 ${maxErr}`); // 복원 = (v>>2<<2)+2 이므로 최대 2(255 는 255 로 1 이내)
});

function expectCodecError(fn, code) {
  assert.throws(fn, (e) => e instanceof CodecError && (code === undefined || e.code === code), `CodecError ${code ?? ''} 기대`);
}

test('오류: 형식 2 입력·codec 1 입력은 encodeChunk 가 CodecError', () => {
  const n = 4;
  const g = {
    format: FORMAT_GAUSS56, segmentId: 7, level: 3, lod: 1, chunkIndex: 2, anchor: ANCHOR,
    fields: {
      positions: new Float32Array(3 * n).map((_, i) => 70 + i * 0.1), fdc: new Float32Array(3 * n), opacity: new Float32Array(n),
      scales: new Float32Array(3 * n).fill(-5), rotations: new Float32Array(4 * n).map((_, i) => (i % 4 === 0 ? 1 : 0)),
    },
  };
  g.fields.positions.set([70, -100, 1, 70.5, -100, 1, 71, -100, 1, 71.5, -100, 1]);
  const rawG = packChunk(g);
  assert.equal(parseHeader(rawG).format, FORMAT_GAUSS56);
  expectCodecError(() => encodeChunk(rawG), 'format');
  const enc = encodeChunk(packChunk(randomInput(50, 51)));
  expectCodecError(() => encodeChunk(enc), 'format');
});

test('오류: decodeChunk 의 codec 0 입력·형식 2·체크섬·길이 불일치는 CodecError', () => {
  const raw = packChunk(randomInput(500, 61));
  const enc = encodeChunk(raw);
  assert.doesNotThrow(() => decodeChunk(enc));
  expectCodecError(() => decodeChunk(raw), 'mode');
  // 체크섬: 본문 한 바이트 뒤집기(스트림 끝 쪽), 헤더 체크섬 필드 뒤집기
  const bad = enc.slice(); bad[bad.length - 1] ^= 0x01;
  expectCodecError(() => decodeChunk(bad), 'checksum');
  const bad2 = enc.slice(); bad2[OFFSETS.checksum] ^= 0xff;
  expectCodecError(() => decodeChunk(bad2), 'checksum');
  // 길이: 끝에 바이트 추가·끝 바이트 제거
  const longer = new Uint8Array(enc.length + 1); longer.set(enc);
  expectCodecError(() => decodeChunk(longer), 'length');
  expectCodecError(() => decodeChunk(enc.subarray(0, enc.length - 1)), 'length');
  // 본문 스트림 길이 합 불일치(posLen 을 1 늘리고 체크섬은 맞게 다시 계산하지 않아도 길이 검사가 먼저는 아님 → 어떤 경우든 CodecError)
  const base = parseHeader(enc).headerSize;
  const bad3 = enc.slice(); bad3[base + 4] ^= 0x01;
  expectCodecError(() => decodeChunk(bad3));
  // 형식 2 로 표시된 codec 1 파일
  const h = parseHeader(enc);
  const asG = enc.slice(); asG[OFFSETS.format] = FORMAT_GAUSS56;
  expectCodecError(() => decodeChunk(asG));
  assert.equal(h.format, FORMAT_POINT27);
});

test('압축률: 합성 지면 5 만 점 codec 1 본문 바이트/점 < 11 (실측값 고정)', () => {
  const raw = packChunk(groundInput(50000, 50000));
  const enc = encodeChunk(raw);
  const body = parseHeader(enc).bodyBytes;
  const bpp = body / 50000;
  console.log(`합성 지면 5만 점: codec 1 본문 ${body} B, ${bpp.toFixed(4)} B/점 (codec 0 본문 ${parseHeader(raw).bodyBytes} B = 11 B/점), 무손실`);
  const encL = encodeChunk(raw, { lossyColor: true });
  console.log(`  lossyColor: 본문 ${parseHeader(encL).bodyBytes} B, ${(parseHeader(encL).bodyBytes / 50000).toFixed(4)} B/점`);
  assert.equal(parseHeader(raw).bodyBytes, 550000); // 점당 11 B(위치 6 + 색 3 + 법선 2)
  assert.ok(bpp < 11, `${bpp} B/점`); // 계약 상한
  // 실측 5.594 B/점(위치 모턴 차분·법선 차분·색 DELTA + 범위 부호). 회귀 감지용으로 실측 근방을 좁게 건다.
  assert.ok(bpp < 6.0 && bpp > 5.0, `${bpp} B/점`);
  const l = parseHeader(encL).bodyBytes / 50000;
  assert.ok(l < bpp, `손실 색 ${l} B/점 은 무손실 ${bpp} 보다 작아야 한다`);
});
