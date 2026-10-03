// 조각 부호화·복호화 입력 검증 시험(F-168 encodeChunk 의 codec 0 엄격 검사, F-169 스트림 rawLen 범위, F-172 colorMode 노출).
import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { encodeChunk, decodeChunk, decodeChunkInfo } from './index.mjs';
import { packChunk } from '../../asset/pack/index.mjs';
import { decodeChunkClient } from '../../../client/codec/index.mjs';
import { parseHeader, FORMAT_POINT27, OFFSETS } from '../../../contracts/asset/index.mjs';
import { CodecError, COLOR_MODE, BODY_FIXED_BYTES } from '../../../contracts/codec/index.mjs';

const ANCHOR = { lat: 37.5, lon: 127.0, alt: 30.0 };

// 법선 (1,0,0)×2·(0,1,0)×2, 한 타일 안의 4 점인 codec 0 파일
function rawFile() {
  const pos = new Float32Array([70, -100, 3, 71, -100, 3, 72, -101, 4, 73, -102, 5]);
  const nor = new Float32Array([1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0]);
  const col = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]);
  return packChunk({ format: FORMAT_POINT27, segmentId: 7, level: 2, lod: 0, chunkIndex: 0, anchor: ANCHOR, fields: { positions: pos, normals: nor, colors: col } });
}

/** 체크섬 필드를 0 으로 보고 CRC-32 를 다시 채운다(손상이 체크섬이 아닌 다른 검사에서 걸리는지 보려는 용도). */
function refix(file) {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  dv.setUint32(OFFSETS.checksum, 0, true);
  dv.setUint32(OFFSETS.checksum, crc32(file) >>> 0, true);
  return file;
}

function code(fn) {
  try { fn(); } catch (e) { return `${e.constructor.name}:${e.code}`; }
  return 'no-throw';
}

const dvOf = (f) => new DataView(f.buffer, f.byteOffset, f.byteLength);

test('기준: 손상 없는 원본은 encodeChunk 를 통과한다', () => {
  assert.doesNotThrow(() => encodeChunk(rawFile()));
});

test('F-168 (a) 끝 1·3·4 B 를 자른 입력은 length 로 거부(체크섬을 맞춰도)', () => {
  for (const cut of [1, 3, 4]) {
    const f = rawFile().slice(0, -cut);
    assert.equal(code(() => encodeChunk(f)), 'CodecError:length', `cut ${cut}`);
    // body_bytes 도 같이 줄이고 체크섬을 맞춘 경우: 필요한 본문보다 짧으므로 여전히 length
    const g = rawFile().slice(0, -cut);
    dvOf(g).setUint32(OFFSETS.bodyBytes, g.length - 128, true);
    refix(g);
    assert.equal(code(() => encodeChunk(g)), 'CodecError:length', `cut+bodyBytes ${cut}`);
  }
});

test('F-168 (b) 체크섬이 틀린 입력은 checksum 으로 거부', () => {
  const f = rawFile();
  f[f.length - 20] ^= 0x10; // 색 바이트 하나 반전
  assert.equal(code(() => encodeChunk(f)), 'CodecError:checksum');
});

test('F-168 (c) body_bytes 를 줄인 입력은 length 로 거부', () => {
  const f = rawFile();
  const h = parseHeader(f);
  dvOf(f).setUint32(OFFSETS.bodyBytes, h.bodyBytes - 8, true);
  refix(f);
  assert.equal(code(() => encodeChunk(f)), 'CodecError:length'); // 파일 길이 ≠ header_size + body_bytes
  const g = rawFile(); const g2 = g.slice(0, g.length - 8);
  dvOf(g2).setUint32(OFFSETS.bodyBytes, h.bodyBytes - 8, true);
  refix(g2); // 길이는 맞고 본문만 모자람
  assert.equal(code(() => encodeChunk(g2)), 'CodecError:length');
});

test('F-168 (d) pointCount 를 늘린 입력은 length 로 거부', () => {
  const f = rawFile();
  dvOf(f).setUint32(OFFSETS.pointCount, 5, true);
  refix(f);
  assert.equal(code(() => encodeChunk(f)), 'CodecError:length');
});

test('F-168 (e) lod=9·quantExp 범위 밖·tileSizeM 변경 입력은 AssetFormatError field', () => {
  const lod = rawFile(); lod[OFFSETS.lod] = 9; refix(lod);
  assert.equal(code(() => encodeChunk(lod)), 'AssetFormatError:field');
  for (const q of [0, 17, 255]) {
    const f = rawFile(); f[OFFSETS.quantExp] = q; refix(f);
    assert.equal(code(() => encodeChunk(f)), 'AssetFormatError:field', `quantExp ${q}`);
  }
  const t = rawFile(); dvOf(t).setUint16(OFFSETS.tileSizeM, 128, true); refix(t);
  assert.equal(code(() => encodeChunk(t)), 'AssetFormatError:field');
});

test('F-168 헤더만 남긴 입력·빈 입력도 throw', () => {
  const f = rawFile();
  assert.notEqual(code(() => encodeChunk(f.slice(0, 128))), 'no-throw');
  assert.notEqual(code(() => encodeChunk(new Uint8Array(0))), 'no-throw');
});

test('F-168 감독 재현 ①: 끝 3 B 를 자른 법선 4 점 파일은 지어낸 법선 대신 throw', () => {
  const f = rawFile().slice(0, -3);
  assert.throws(() => encodeChunk(f), CodecError);
});

test('F-168 Buffer 입력(byteOffset 이 0 이 아닌 뷰)도 같은 결과', () => {
  const f = rawFile();
  const pool = Buffer.alloc(f.length + 10);
  const view = pool.subarray(6, 6 + f.length);
  view.set(f);
  assert.deepEqual(encodeChunk(view), encodeChunk(f));
});

// ---- F-169 ----
const LEB = (v) => { const o = []; do { let b = v % 128; v = Math.floor(v / 128); if (v) b |= 0x80; o.push(b); } while (v); return o; };

/** codec 1 파일의 pos 스트림을 바꿔 길이·체크섬을 맞춘 새 파일 */
function withPosStream(enc, posBytes) {
  const h = parseHeader(enc);
  const b = h.headerSize, dv = dvOf(enc);
  const pl = dv.getUint32(b + 4, true), nl = dv.getUint32(b + 8, true), cl = dv.getUint32(b + 12, true);
  const rest = enc.subarray(b + BODY_FIXED_BYTES + pl);
  const out = new Uint8Array(b + BODY_FIXED_BYTES + posBytes.length + nl + cl);
  out.set(enc.subarray(0, b + BODY_FIXED_BYTES), 0);
  out.set(posBytes, b + BODY_FIXED_BYTES);
  out.set(rest, b + BODY_FIXED_BYTES + posBytes.length);
  const d = dvOf(out);
  d.setUint32(b + 4, posBytes.length, true);
  d.setUint32(OFFSETS.bodyBytes, out.length - b, true);
  return refix(out);
}

function onePoint() {
  const f = packChunk({ format: FORMAT_POINT27, segmentId: 1, level: 0, lod: 0, chunkIndex: 0, anchor: ANCHOR,
    fields: { positions: new Float32Array([70.25, -100.5, 3.125]), normals: new Float32Array([0, 0, 1]), colors: new Uint8Array([10, 20, 30]) } });
  return encodeChunk(f);
}

test('F-169 n=1 에서 pos 스트림 rawLen 2^26 은 50 ms 안에 limit 으로 거부, 클라이언트와 같은 코드', () => {
  const enc = onePoint();
  const big = new Uint8Array(1 + 4 + (1 << 20)); // [01][LEB(2^26)][00 × 1 MiB]
  big[0] = 1; big.set(LEB(1 << 26), 1);
  const bad = withPosStream(enc, big);
  const t0 = performance.now();
  const sv = code(() => decodeChunk(bad));
  const ms = performance.now() - t0;
  assert.equal(sv, 'CodecError:limit');
  assert.ok(ms < 50, `${ms.toFixed(1)} ms`);
  assert.equal(code(() => decodeChunkClient(bad)), 'CodecError:limit');
});

test('F-169 pos rawLen 경계: n=1 에서 [1,7] 안은 통과(다른 검사로 거부), 0·8 은 limit', () => {
  const enc = onePoint();
  for (const rawLen of [0, 8, 100]) {
    const s = new Uint8Array([0, ...LEB(rawLen), ...new Uint8Array(rawLen)]); // 저장 모드
    const r = code(() => decodeChunk(withPosStream(enc, s)));
    assert.equal(r, 'CodecError:limit', `rawLen ${rawLen}`);
    // 클라이언트의 min 미달 코드는 다른 하위 작업이 맞춘다(현재 'stream'). 상한 초과만 클라이언트와 비교한다.
    if (rawLen > 7) assert.equal(code(() => decodeChunkClient(withPosStream(enc, s))), 'CodecError:limit');
  }
  const ok = new Uint8Array([0, ...LEB(7), ...new Uint8Array(7)]); // 범위 안: limit 이 아닌 코드(위치 스트림 형식 오류 가능)
  assert.notEqual(code(() => decodeChunk(withPosStream(enc, ok))), 'CodecError:limit');
});

// ---- F-172 ⑧ ----
test('F-172 decodeChunkInfo 는 색 모드를 돌려주고 decodeChunk 는 같은 file 을 돌려준다', () => {
  const raw = rawFile();
  const lossless = encodeChunk(raw);
  const lossy = encodeChunk(raw, { lossyColor: true });
  const a = decodeChunkInfo(lossless), b = decodeChunkInfo(lossy);
  assert.ok(a.colorMode !== COLOR_MODE.QUANT2);
  assert.equal(b.colorMode, COLOR_MODE.QUANT2);
  assert.deepEqual(decodeChunk(lossy), b.file);
  assert.deepEqual(decodeChunk(lossless), a.file);
});
