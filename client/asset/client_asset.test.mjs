import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHeader, AssetFormatError, OFFSETS } from '../../contracts/asset/index.mjs';
import { readHeaderClient, readPlanesClient } from './index.mjs';

const dir = new URL('../../fixtures/asset_golden/', import.meta.url);
const load = (n) => ({
  bytes: new Uint8Array(readFileSync(new URL(`${n}.skla`, dir))),
  side: JSON.parse(readFileSync(new URL(`${n}.json`, dir), 'utf8')),
});
// 기준값(숫자): 파일 길이, 점 수, 본문 바이트, 평면 수, 첫/마지막 점 pos_e·pos_u.
const GOLD = {
  point27: { len: 480, n: 32, body: 352, planes: 8, first: { pos_e: 0, pos_u: 0 }, last: { pos_e: 3584, pos_u: 1984 } },
  gauss56: { len: 512, n: 21, body: 384, planes: 11, first: { pos_e: 0, pos_u: 0 }, last: { pos_e: 6144, pos_u: 5120 } },
};

for (const name of ['point27', 'gauss56']) {
  test(`client_header_parity ${name}`, () => {
    const { bytes, side } = load(name);
    const g = GOLD[name];
    assert.equal(bytes.length, g.len);
    const want = parseHeader(bytes);
    assert.equal(want.pointCount, g.n);
    assert.equal(want.bodyBytes, g.body);
    assert.equal(want.pointCount, side.header.pointCount);

    // ArrayBuffer 입력
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    assert.deepEqual(readHeaderClient(ab), want);
    // 오프셋 있는 뷰 입력(앞 5바이트 여백)
    const padded = new Uint8Array(bytes.length + 8);
    padded.set(bytes, 5);
    const sub = padded.subarray(5, 5 + bytes.length);
    const got = readHeaderClient(sub);
    assert.deepEqual(got, want);
    assert.equal(got.reserved.length, 12);
    assert.equal(got.extension.length, 0);
    assert.notEqual(got.reserved.buffer, padded.buffer);

    // 평면 길이·첫/마지막 값
    const planes = readPlanesClient(bytes, got);
    assert.equal(Object.keys(planes).length, g.planes);
    const n = want.pointCount;
    for (const [k, arr] of Object.entries(planes)) {
      assert.equal(arr.length, n, k);
      assert.equal(arr[0], side.firstPoint.stored[k], `${k} first`);
      assert.equal(arr[n - 1], side.lastPoint.stored[k], `${k} last`);
    }
    assert.equal(planes.pos_e[0], g.first.pos_e);
    assert.equal(planes.pos_u[0], g.first.pos_u);
    assert.equal(planes.pos_e[n - 1], g.last.pos_e);
    assert.equal(planes.pos_u[n - 1], g.last.pos_u);

    // 복사 없음: 원본 버퍼 공유
    assert.equal(planes.pos_e.buffer, bytes.buffer);
    assert.equal(planes.pos_e.byteOffset, bytes.byteOffset + 128);
    assert.equal(readPlanesClient(ab, got).pos_e.buffer, ab);
  });
}

test('client_header_parity rejects bad magic and short input', () => {
  const { bytes } = load('point27');
  const bad = bytes.slice();
  bad[0] = 0x58;
  assert.throws(() => readHeaderClient(bad), (e) => e instanceof AssetFormatError && e.code === 'magic');
  assert.throws(() => readHeaderClient(bytes.subarray(0, 100)), (e) => e.code === 'short');
});

test('client_header_parity unaligned view falls back to copy', () => {
  const { bytes } = load('point27');
  const padded = new Uint8Array(bytes.length + 8);
  padded.set(bytes, 1);
  const sub = padded.subarray(1, 1 + bytes.length);
  const h = readHeaderClient(sub);
  assert.equal(readPlanesClient(sub, h).pos_e[31], 3584);
});

test('client index.mjs has no node: imports or Buffer', () => {
  const src = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
  assert.ok(!src.includes('node:'));
  assert.ok(!/\bBuffer\b/.test(src));
});

// 음성: 각 변형은 AssetFormatError 와 code 를 단언한다.
const mutate = (name, fn) => {
  const b = load(name).bytes.slice();
  fn(b, new DataView(b.buffer));
  return b;
};
const rejects = (b, code) =>
  assert.throws(() => readHeaderClient(b), (e) => e instanceof AssetFormatError && e.code === code);

for (const name of ['point27', 'gauss56']) {
  test(`client rejects malformed headers ${name}`, () => {
    rejects(mutate(name, (b, dv) => dv.setUint16(OFFSETS.versionMajor, 2, true)), 'version');
    rejects(mutate(name, (b, dv) => dv.setUint16(OFFSETS.headerSize, 130, true)), 'header_size');
    rejects(mutate(name, (b) => { b[OFFSETS.format] = 3; }), 'format');
    rejects(mutate(name, (b) => { b[OFFSETS.codec] = 1; }), 'codec');
    rejects(mutate(name, (b) => { b[OFFSETS.quantExp] = 7; }), 'field');
    rejects(mutate(name, (b) => { b[OFFSETS.quantExp] = 11; }), 'field');
    rejects(mutate(name, (b, dv) => dv.setUint32(OFFSETS.pointCount, 0, true)), 'field');
    rejects(mutate(name, (b, dv) => dv.setUint16(OFFSETS.tileSizeM, 63, true)), 'field');
    // 길이 불일치: 잘린 본문, 뒤 바이트, body_bytes 변조
    const { bytes } = load(name);
    rejects(bytes.subarray(0, bytes.length - 1), 'body');
    const longer = new Uint8Array(bytes.length + 1);
    longer.set(bytes);
    rejects(longer, 'body');
    rejects(mutate(name, (b, dv) => dv.setUint32(OFFSETS.bodyBytes, dv.getUint32(OFFSETS.bodyBytes, true) + 4, true)), 'body');
  });

  test(`client readPlanesClient rejects codec and length ${name}`, () => {
    const { bytes } = load(name);
    const h = readHeaderClient(bytes);
    const longer = new Uint8Array(bytes.length + 4);
    longer.set(bytes);
    assert.throws(() => readPlanesClient(longer, h), (e) => e instanceof AssetFormatError && e.code === 'body');
    assert.throws(() => readPlanesClient(bytes.subarray(0, bytes.length - 1), h), (e) => e.code === 'body');
    assert.throws(() => readPlanesClient(bytes, { ...h, codec: 1 }), (e) => e instanceof AssetFormatError && e.code === 'codec');
  });
}
