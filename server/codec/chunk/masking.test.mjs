// 검사 가림 해소 시험(F-174 ③, F-175 ①): body_bytes 검사와 평면 범위 검사가 서로를 가려 한쪽만 지워도 통과하던 문제.
import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { encodeChunk, decodeChunk } from './index.mjs';
import { packChunk } from '../../asset/pack/index.mjs';
import { parseHeader, FORMAT_POINT27, OFFSETS } from '../../../contracts/asset/index.mjs';

const ANCHOR = { lat: 37.5, lon: 127.0, alt: 30.0 };

// 한 타일 안의 5 점(n=5: pad4 때문에 n=6 과 필수 본문 바이트가 같다)
function rawFile5() {
  const pos = new Float32Array([70, -100, 3, 71, -100, 3, 72, -101, 4, 73, -102, 5, 74, -103, 6]);
  const nor = new Float32Array([1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1]);
  const col = new Uint8Array(15).map((_, i) => 10 + i * 7);
  return packChunk({ format: FORMAT_POINT27, segmentId: 7, level: 2, lod: 0, chunkIndex: 0, anchor: ANCHOR, fields: { positions: pos, normals: nor, colors: col } });
}

const dvOf = (f) => new DataView(f.buffer, f.byteOffset, f.byteLength);
function refix(file) {
  dvOf(file).setUint32(OFFSETS.checksum, 0, true);
  dvOf(file).setUint32(OFFSETS.checksum, crc32(file) >>> 0, true);
  return file;
}
function fail(fn) {
  try { fn(); } catch (e) { return e; }
  return null;
}

test('F-174 ③ body_bytes 검사 단독 판별: 길이는 header_size+body_bytes 와 맞고 본문만 모자라면 body_bytes 메시지로 거부', () => {
  const full = rawFile5();
  const h = parseHeader(full);
  for (const cut of [1, 4, 8, 20]) {
    const f = full.slice(0, full.length - cut); // 길이 검사는 통과시킨다
    dvOf(f).setUint32(OFFSETS.bodyBytes, h.bodyBytes - cut, true);
    refix(f); // 체크섬 검사도 통과시킨다
    const e = fail(() => encodeChunk(f));
    assert.ok(e, `cut ${cut} 거부`);
    assert.equal(e.code, 'length', `cut ${cut}`);
    // 평면 범위 검사 메시지가 아니라 body_bytes 검사 메시지여야 한다(앞 검사를 지우면 뒤 검사로 넘어가 메시지가 달라진다)
    assert.match(e.message, /body_bytes \d+ < \d+$/, `cut ${cut}`);
  }
});

test('F-174 ③ 평면 범위 검사는 body_bytes 검사를 통과한 입력에서 걸릴 수 없다(중복이라 제거): pointCount 만 키운 입력도 body_bytes 로 거부', () => {
  // 길이 검사(file.length == header_size+body_bytes)와 body_bytes >= requiredBytes 를 모두 통과하면
  // 마지막 평면 끝 = header_size + requiredBytes <= file.length 라 범위 검사가 걸릴 수 없다.
  const f = rawFile5();
  dvOf(f).setUint32(OFFSETS.pointCount, 400, true);
  refix(f);
  const e = fail(() => encodeChunk(f));
  assert.equal(e.code, 'length');
  assert.match(e.message, /body_bytes \d+ < /);
});

test('F-175 ① n=5 파일의 pointCount 를 6 으로 바꾸고 CRC 를 맞추면 형식이 허용하므로 받아들인다(패딩 0 점)', () => {
  // ASSET_FORMAT §3.1: 필수 본문 = 3·pad4(2n)+5·pad4(n) 은 n=5·6 모두 76 B 이고, §3.2-10 은 body_bytes >= 필수 합만 요구한다.
  const f = rawFile5();
  dvOf(f).setUint32(OFFSETS.pointCount, 6, true);
  refix(f);
  const out = decodeChunk(encodeChunk(f));
  assert.equal(parseHeader(out).pointCount, 6);
});
