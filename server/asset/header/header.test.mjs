import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AssetFormatError } from '../../../contracts/asset/index.mjs';
import { readHeaderStrict, writeHeader } from './index.mjs';

const dir = new URL('../../../fixtures/asset_golden/', import.meta.url);
const golden = (n) => new Uint8Array(readFileSync(new URL(n, dir)));
const CHECKSUM_AT = 112;

// 읽은 헤더에서 쓰기 입력 필드만 뽑는다.
const fieldsOf = (h) => ({
  format: h.format, codec: h.codec, segmentId: h.segmentId, level: h.level, pointCount: h.pointCount,
  tileX: h.tileX, tileY: h.tileY, tileSizeM: h.tileSizeM, lod: h.lod, quantExp: h.quantExp,
  chunkIndex: h.chunkIndex, bodyBytes: h.bodyBytes, bboxMin: [...h.bboxMin], bboxMax: [...h.bboxMax],
  anchor: { ...h.anchor },
});

// 기준값(숫자 고정): point27 골든 = 32점, 본문 352 B, 파일 480 B, 타일 (1,-2), 구간 7 수준 2.
const BASE = () => ({
  format: 1, codec: 0, segmentId: 7, level: 2, pointCount: 32, tileX: 1, tileY: -2, tileSizeM: 64,
  lod: 0, quantExp: 10, chunkIndex: 0, bodyBytes: 352, bboxMin: [64, -128, 1], bboxMax: [67.5, -125.75, 2.9375],
  anchor: { lat: 37.5, lon: 127, alt: 30 },
});
const isErr = (code) => (e) => e instanceof AssetFormatError && e.code === code;
const writeRejects = (mut, code) => {
  const f = BASE();
  mut(f);
  assert.throws(() => writeHeader(f), isErr(code), `write ${code}`);
};
// 읽기 음성: 올바른 헤더 바이트를 고쳐 던지는지 본다.
const readRejects = (mut, code, opts) => {
  const b = writeHeader(BASE());
  mut(b, new DataView(b.buffer));
  assert.throws(() => readHeaderStrict(b, opts), isErr(code), `read ${code}`);
};

test('header_roundtrip: 골든 두 개를 읽고 다시 쓰면 checksum 외 128 B 가 같다', () => {
  for (const [name, fmt, points, body] of [['point27.skla', 1, 32, 352], ['gauss56.skla', 2, 21, 384]]) {
    const g = golden(name);
    const h = readHeaderStrict(g, { fileBytes: g.length });
    assert.equal(h.format, fmt);
    assert.equal(h.pointCount, points);
    assert.equal(h.bodyBytes, body);
    assert.equal(128 + body, g.length);
    const out = writeHeader(fieldsOf(h));
    assert.equal(out.length, 128);
    for (let i = 0; i < 128; i++) {
      if (i >= CHECKSUM_AT && i < CHECKSUM_AT + 4) continue;
      assert.equal(out[i], g[i], `byte ${i} of ${name}`);
    }
    assert.deepEqual([...out.subarray(CHECKSUM_AT, CHECKSUM_AT + 4)], [0, 0, 0, 0]);
  }
});

test('header_roundtrip: 골든 point27 필드 값', () => {
  const h = readHeaderStrict(golden('point27.skla'));
  assert.equal(h.segmentId, 7);
  assert.equal(h.level, 2);
  assert.equal(h.tileX, 1);
  assert.equal(h.tileY, -2);
  assert.equal(h.quantExp, 10);
  assert.equal(h.checksum, 3589071242);
  assert.deepEqual(h.bboxMax, [67.5, -125.75, 2.9375]);
});

test('header_roundtrip: 무작위 1,000개 쓰기→읽기 왕복', () => {
  let s = 12345;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const ri = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  for (let i = 0; i < 1000; i++) {
    const quantExp = ri(8, 10);
    const span = 65535 / 2 ** quantExp;
    const tileX = ri(-100000, 100000);
    const tileY = ri(-100000, 100000);
    const lo = (t) => 64 * t + Math.floor(rnd() * 32 * 1024) / 1024;
    const bboxMin = [lo(tileX), lo(tileY), (rnd() - 0.5) * 2000];
    const w = (m) => Math.floor(rnd() * Math.min(span, m) * 1024) / 1024;
    const bboxMax = [bboxMin[0] + w(31), bboxMin[1] + w(31), bboxMin[2] + w(span)];
    const format = ri(1, 2);
    const pointCount = ri(1, 100000);
    const sizes = format === 1 ? [2, 2, 2, 1, 1, 1, 1, 1] : [2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 4];
    const need = sizes.reduce((a, sz) => a + Math.ceil((pointCount * sz) / 4) * 4, 0);
    const f = {
      format, codec: 0, segmentId: ri(0, 2 ** 30 - 1), level: ri(0, 3), pointCount, tileX, tileY, tileSizeM: 64,
      lod: ri(0, 7), quantExp, chunkIndex: ri(0, 65535), bodyBytes: need + ri(0, 64), bboxMin, bboxMax,
      anchor: { lat: (rnd() - 0.5) * 180, lon: (rnd() - 0.5) * 360, alt: rnd() * 1000 },
    };
    const b = writeHeader(f);
    assert.equal(b.length, 128);
    const h = readHeaderStrict(b, { fileBytes: 128 + f.bodyBytes });
    assert.equal(h.versionMajor, 1);
    assert.equal(h.versionMinor, 0);
    assert.equal(h.headerSize, 128);
    assert.equal(h.checksum, 0);
    assert.deepEqual(fieldsOf(h), f);
  }
});

test('기준 헤더는 통과한다', () => {
  const h = readHeaderStrict(writeHeader(BASE()), { fileBytes: 480 });
  assert.equal(h.pointCount, 32);
});

test('거부(읽기): 잘못된 매직', () => readRejects((b) => { b[0] = 0x58; }, 'magic'));
test('거부(읽기): 주 버전 2', () => readRejects((b, d) => d.setUint16(4, 2, true), 'version'));
test('거부(읽기): 주 버전 0', () => readRejects((b, d) => d.setUint16(4, 0, true), 'version'));
test('거부(읽기): header_size 127', () => readRejects((b, d) => d.setUint16(8, 127, true), 'header_size'));
test('거부(읽기): header_size 130(4의 배수 아님)', () => readRejects((b, d) => d.setUint16(8, 130, true), 'header_size'));
test('거부(읽기): header_size 132 인데 입력이 128 B', () => readRejects((b, d) => d.setUint16(8, 132, true), 'short'));
test('거부(읽기): 128 B 미만', () => {
  assert.throws(() => readHeaderStrict(writeHeader(BASE()).subarray(0, 127)), isErr('short'));
});
test('거부(읽기): format 0 과 3', () => {
  readRejects((b) => { b[10] = 0; }, 'format');
  readRejects((b) => { b[10] = 3; }, 'format');
});
test('거부(읽기): codec 1', () => readRejects((b) => { b[11] = 1; }, 'codec'));
test('거부(읽기): point_count 0', () => readRejects((b, d) => d.setUint32(16, 0, true), 'field'));
test('거부(읽기): tile_size 63 과 128', () => {
  readRejects((b, d) => d.setUint16(28, 63, true), 'field');
  readRejects((b, d) => d.setUint16(28, 128, true), 'field');
});
test('거부(읽기): lod 8', () => readRejects((b) => { b[30] = 8; }, 'field'));
test('거부(읽기): quant_exp 7 과 11', () => {
  readRejects((b) => { b[31] = 7; }, 'field');
  readRejects((b) => { b[31] = 11; }, 'field');
});
test('거부(읽기): body_bytes 351(필수 평면 352 미만)', () => readRejects((b, d) => d.setUint32(36, 351, true), 'body'));
test('거부(읽기): 파일 길이 불일치', () => {
  readRejects(() => {}, 'body', { fileBytes: 481 });
  readRejects(() => {}, 'body', { fileBytes: 479 });
});
test('거부(읽기): bbox NaN·Infinity', () => {
  readRejects((b, d) => d.setFloat64(40, NaN, true), 'bbox');
  readRejects((b, d) => d.setFloat64(64, Infinity, true), 'bbox');
});
test('거부(읽기): bbox min > max', () => readRejects((b, d) => d.setFloat64(48, 0, true), 'bbox')); // min.n = 0 > max.n
test('거부(읽기): u 폭이 65535/1024 m 초과', () => readRejects((b, d) => d.setFloat64(80, 65.0001, true), 'range'));
test('거부(읽기): tile 범위 밖', () => {
  readRejects((b, d) => d.setInt32(20, 2, true), 'tile'); // tileX 2
  readRejects((b, d) => { b[31] = 8; d.setFloat64(64, 128, true); }, 'tile'); // max.e = 타일 끝(배타)
});
test('거부(읽기): anchor 비유한', () => readRejects((b, d) => d.setFloat64(88, NaN, true), 'field'));
test('거부(읽기): 부 버전 0 에서 reserved 비0', () => readRejects((b) => { b[120] = 1; }, 'reserved'));
test('수용(읽기): 부 버전 1 이면 reserved 비0 를 보존', () => {
  const b = writeHeader(BASE());
  new DataView(b.buffer).setUint16(6, 1, true);
  b[120] = 9;
  const h = readHeaderStrict(b);
  assert.equal(h.versionMinor, 1);
  assert.equal(h.reserved[4], 9);
});

test('거부(쓰기): format', () => writeRejects((f) => { f.format = 3; }, 'format'));
test('거부(쓰기): codec', () => writeRejects((f) => { f.codec = 2; }, 'codec'));
test('거부(쓰기): pointCount 0', () => writeRejects((f) => { f.pointCount = 0; }, 'field'));
test('거부(쓰기): tileSizeM 32', () => writeRejects((f) => { f.tileSizeM = 32; }, 'field'));
test('거부(쓰기): lod 8', () => writeRejects((f) => { f.lod = 8; }, 'field'));
test('거부(쓰기): quantExp 7·11', () => {
  writeRejects((f) => { f.quantExp = 7; }, 'field');
  writeRejects((f) => { f.quantExp = 11; }, 'field');
});
test('거부(쓰기): level 4, segmentId 2^30', () => {
  writeRejects((f) => { f.level = 4; }, 'field');
  writeRejects((f) => { f.segmentId = 2 ** 30; }, 'field');
});
test('거부(쓰기): bodyBytes 351', () => writeRejects((f) => { f.bodyBytes = 351; }, 'body'));
test('거부(쓰기): bbox 비유한·역전', () => {
  writeRejects((f) => { f.bboxMin[0] = NaN; }, 'field');
  writeRejects((f) => { f.bboxMin[1] = -125; }, 'bbox');
});
test('거부(쓰기): 폭 초과', () => writeRejects((f) => { f.bboxMax[2] = 65.0001; }, 'range'));
test('거부(쓰기): 타일 밖', () => {
  writeRejects((f) => { f.tileX = 0; }, 'tile');
  writeRejects((f) => { f.quantExp = 8; f.bboxMax[1] = -64; }, 'tile'); // n = 타일 끝(배타)
});
test('거부(쓰기): anchor 비유한', () => writeRejects((f) => { f.anchor.lon = Infinity; }, 'field'));
