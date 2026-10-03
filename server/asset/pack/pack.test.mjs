import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import { packChunk, encodeOctNormal, encodeRotation } from './index.mjs';
import { buildPoint27, buildGauss56, ANCHOR } from '../../../fixtures/asset_golden/generate.mjs';
import { parseHeader, AssetFormatError, FORMAT_POINT27, FORMAT_GAUSS56, SH_C0, OFFSETS } from '../../../contracts/asset/index.mjs';

const golden = (name) => new Uint8Array(readFileSync(new URL(`../../../fixtures/asset_golden/${name}`, import.meta.url)));

// 골든 입력: generate.mjs 의 입력 규칙(사이드카 inputRule)을 그대로 옮긴 원본 필드
function point27Input() {
  const n = 32;
  const NORMALS = [[0, 0, 1], [0.6, 0, 0.8], [0, -0.6, -0.8], [0.36, 0.48, 0.8]];
  const positions = new Float32Array(3 * n);
  const normals = new Float32Array(3 * n);
  const colors = new Uint8Array(3 * n);
  for (let i = 0; i < n; i++) {
    positions.set([64 + (i % 8) * 0.5, -128 + Math.floor(i / 8) * 0.75, 1 + i * 0.0625], 3 * i);
    normals.set(NORMALS[i % 4], 3 * i);
    colors.set([i * 8, 255 - i * 8, (i * 37) % 256], 3 * i);
  }
  return { format: FORMAT_POINT27, segmentId: 7, level: 2, lod: 0, chunkIndex: 0, anchor: ANCHOR, fields: { positions, normals, colors } };
}
function gauss56Input() {
  const n = 21;
  const positions = new Float32Array(3 * n);
  const fdc = new Float32Array(3 * n);
  const opacity = new Float32Array(n);
  const scales = new Float32Array(3 * n);
  const rotations = new Float32Array(4 * n);
  for (let i = 0; i < n; i++) {
    positions.set([10 + (i % 7), 20 + Math.floor(i / 7) * 2, -2 + i * 0.25], 3 * i);
    const target = [i * 12, 128, 255 - i * 12];
    for (let k = 0; k < 3; k++) fdc[3 * i + k] = (target[k] / 255 - 0.5) / SH_C0;
    opacity[i] = (i - 10) * 0.5;
    scales.set([-6 + i * 0.25, -3.5, -2 - i * 0.125], 3 * i);
    const half = (i * 7.5 * Math.PI) / 180;
    rotations.set([Math.cos(half), 0, 0, Math.sin(half)], 4 * i);
  }
  return { format: FORMAT_GAUSS56, segmentId: 7, level: 3, lod: 1, chunkIndex: 2, anchor: ANCHOR, fields: { positions, fdc, opacity, scales, rotations } };
}

test('point27 골든과 바이트 동일', () => {
  const out = packChunk(point27Input());
  assert.equal(out.length, 480);
  assert.deepEqual(out, golden('point27.skla'));
  assert.deepEqual(out, buildPoint27());
  assert.equal(parseHeader(out).checksum, 0xd5ece18a);
});

test('gauss56 골든과 바이트 동일', () => {
  const out = packChunk(gauss56Input());
  assert.equal(out.length, 512);
  assert.deepEqual(out, golden('gauss56.skla'));
  assert.deepEqual(out, buildGauss56());
});

test('같은 입력 두 번 → 바이트 동일, 체크섬은 필드 0 으로 본 CRC-32', () => {
  for (const make of [point27Input, gauss56Input]) {
    const a = packChunk(make());
    const b = packChunk(make());
    assert.deepEqual(a, b);
    const z = a.slice();
    z.fill(0, OFFSETS.checksum, OFFSETS.checksum + 4);
    assert.equal(parseHeader(a).checksum, crc32(z));
  }
});

test('헤더 값: 타일·quantExp·bbox 는 점에서 계산', () => {
  const h = parseHeader(packChunk(point27Input()));
  assert.deepEqual([h.tileX, h.tileY, h.quantExp, h.pointCount, h.bodyBytes], [1, -2, 10, 32, 352]);
  assert.deepEqual(h.bboxMin, [64, -128, 1]);
  assert.deepEqual(h.bboxMax, [67.5, -125.75, 2.9375]);
});

test('quantExp 는 범위에 따라 10 → 9 → 8', () => {
  const mk = (extent) => {
    const i = point27Input();
    i.fields = { positions: new Float32Array([0, 0, 0, 1, 1, extent]), normals: new Float32Array([0, 0, 1, 0, 0, 1]), colors: new Uint8Array(6) };
    return parseHeader(packChunk(i)).quantExp;
  };
  assert.equal(mk(63.99), 10);
  assert.equal(mk(64), 9);
  assert.equal(mk(127.99), 9);
  assert.equal(mk(128), 8);
  assert.equal(mk(255.99), 8);
  // 등호 경계(§5.1 `≤ 65535`): extent = 65535·2^-k 는 k 그대로, 바로 위 f32 는 한 단계 아래
  const up = (x) => { const b = new Float32Array([x]); new Uint32Array(b.buffer)[0]++; return b[0]; };
  for (const [k, next] of [[10, 9], [9, 8]]) {
    const e = 65535 / 2 ** k;
    assert.equal(Math.fround(e), e);
    assert.equal(mk(e), k, `extent 65535/2^${k}`);
    assert.equal(mk(up(e)), next, `extent nextUp(65535/2^${k})`);
  }
  assert.equal(mk(65535 / 256), 8);
  assert.throws(() => mk(up(65535 / 256)), (e) => e instanceof AssetFormatError && e.code === 'range');
});

test('범위 초과 → range, 두 타일 → tile', () => {
  const base = point27Input();
  const wide = { ...base, fields: { positions: new Float32Array([0, 0, 0, 1, 1, 256]), normals: new Float32Array([0, 0, 1, 0, 0, 1]), colors: new Uint8Array(6) } };
  assert.throws(() => packChunk(wide), (e) => e instanceof AssetFormatError && e.code === 'range');
  const mk = (p) => ({ ...base, fields: { positions: new Float32Array(p), normals: new Float32Array([0, 0, 1, 0, 0, 1]), colors: new Uint8Array(6) } });
  assert.throws(() => packChunk(mk([63.5, 0, 0, 64, 0, 0])), (e) => e.code === 'tile');
  assert.throws(() => packChunk(mk([0, -0.5, 0, 0, 0.5, 0])), (e) => e.code === 'tile');
  assert.doesNotThrow(() => packChunk(mk([0, 0, 0, 63.99, 63.99, 0])));
});

test('점 0개·비유한 입력은 던진다', () => {
  const base = point27Input();
  const empty = { ...base, fields: { positions: new Float32Array(0), normals: new Float32Array(0), colors: new Uint8Array(0) } };
  assert.throws(() => packChunk(empty), AssetFormatError);
  const bad = point27Input();
  bad.fields.positions[4] = NaN;
  assert.throws(() => packChunk(bad), AssetFormatError);
  const zeroN = point27Input();
  zeroN.fields.normals.set([0, 0, 0], 3);
  assert.throws(() => packChunk(zeroN), AssetFormatError);
  const g = gauss56Input();
  g.fields.opacity[0] = Infinity;
  assert.throws(() => packChunk(g), AssetFormatError);
  const mismatch = point27Input();
  mismatch.fields.colors = new Uint8Array(3);
  assert.throws(() => packChunk(mismatch), AssetFormatError);
});

test('encodeOctNormal: 축·극·z<0 접힘·정규화 전 입력', () => {
  assert.deepEqual(encodeOctNormal(0, 0, 1), [0, 0]);
  assert.deepEqual(encodeOctNormal(1, 0, 0), [127, 0]);
  assert.deepEqual(encodeOctNormal(-1, 0, 0), [-127, 0]);
  assert.deepEqual(encodeOctNormal(0, 1, 0), [0, 127]);
  assert.deepEqual(encodeOctNormal(0, -1, 0), [0, -127]);
  // 남극: sgn(0) = +1 이라 (127, 127)
  assert.deepEqual(encodeOctNormal(0, 0, -1), [127, 127]);
  assert.deepEqual(encodeOctNormal(1, 1, -2), [95, 95]);
  assert.deepEqual(encodeOctNormal(-1, 2, -3), [-85, 106]);
  assert.deepEqual(encodeOctNormal(1, 1, 1), [42, 42]);
  // 정규화 전 입력은 길이에 무관
  assert.deepEqual(encodeOctNormal(3, 0, 0), [127, 0]);
  assert.deepEqual(encodeOctNormal(0, 0, 5), [0, 0]);
  assert.throws(() => encodeOctNormal(0, 0, 0), AssetFormatError);
  assert.throws(() => encodeOctNormal(NaN, 0, 1), AssetFormatError);
  assert.throws(() => encodeOctNormal(Infinity, 0, 1), AssetFormatError);
});

test('encodeRotation: 항등·축·부호 접힘·정규화 전 입력', () => {
  assert.equal(encodeRotation(1, 0, 0, 0), 536346111); // m=0, 나머지 511 셋
  assert.equal(encodeRotation(-1, 0, 0, 0), 536346111); // q 와 -q 는 같음
  assert.equal(encodeRotation(2, 0, 0, 0), 536346111); // 정규화 전
  assert.equal(encodeRotation(0, 1, 0, 0), 1610087935);
  assert.equal(encodeRotation(0, 0, 1, 0), 2683829759);
  assert.equal(encodeRotation(0, 0, 0, 1), 3757571583);
  assert.equal(encodeRotation(0, 0, 0, -1), 3757571583);
  assert.equal(encodeRotation(0.5, 0.5, 0.5, 0.5), 915252072); // 동률은 작은 색인
  assert.equal(encodeRotation(0.5, 0.5, 0.5, -0.5), 915251350);
  assert.equal(encodeRotation(1, 2, 3, 4), 3896254347);
  assert.throws(() => encodeRotation(0, 0, 0, 0), AssetFormatError);
  assert.throws(() => encodeRotation(NaN, 0, 0, 1), AssetFormatError);
});
