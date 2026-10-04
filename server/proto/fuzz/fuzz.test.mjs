// 프로토콜 퍼저 시험(T11.10). 고정 시드. 제품 코덱(server/proto/codec, client/proto)은 정적 import 한다 —
// 모듈이 없으면 이 파일이 로드에서 실패하므로 skip 으로 녹색이 되지 않는다. 퍼저 자체는 기준 코덱(reference-codec.mjs)과
// 일부러 깨뜨린 복호기로 검증하고, 제품 복호는 기준 코덱과 차등 비교한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runFuzz, checkOne } from './index.mjs';
import * as serverCodec from '../codec/index.mjs';
import * as clientCodec from '../../../client/proto/index.mjs';
import { encodeMessage as refEncode, makeDecoder } from './reference-codec.mjs';
import { ProtoError } from '../../../contracts/proto/index.mjs';

const SEED = 0x5eed11a;
const ITER = 100_000; // 서버 복호 10만 + 클라이언트 복호 10만
const SELF_ITER = 20_000;

const refCodec = (dir) => ({ decode: makeDecoder(dir), encode: refEncode, seedEncode: refEncode });

// ---- 퍼저 자기 검증 ----
test('기준 코덱은 퍼저를 위반 0 으로 통과한다(두 방향)', () => {
  for (const dir of ['c2s', 's2c']) {
    const r = runFuzz(refCodec(dir), { iterations: SELF_ITER, seed: SEED });
    assert.equal(r.violations.length, 0, JSON.stringify(r.violations.slice(0, 3)));
    assert.equal(r.runs, SELF_ITER);
    assert.ok(r.random > 4000 && r.mutated > 12000, 'random/mutated 배분');
    assert.ok(r.accepted > 500, `성공 경로가 충분히 밟혀야 한다: ${r.accepted}`);
    assert.ok(r.rejected > 5000);
  }
});

test('같은 시드는 같은 결과(결정성)', () => {
  const a = runFuzz(refCodec('c2s'), { iterations: 3000, seed: SEED });
  const b = runFuzz(refCodec('c2s'), { iterations: 3000, seed: SEED });
  assert.deepEqual(a, b);
});

test('깨진 복호기 1: 짧은 입력에 TypeError(패닉) -> panic 검출', () => {
  const ok = makeDecoder('c2s');
  const bad = (b) => { if (b.length < 8) return b.nothing.x; return ok(b); };
  const r = runFuzz({ ...refCodec('c2s'), decode: bad }, { iterations: 2000, seed: SEED });
  assert.ok(r.violations.some((v) => v.kind === 'panic'), JSON.stringify(r.violations.slice(0, 2)));
});

test('깨진 복호기 2: 성공 결과가 틀려 재부호화가 다름 -> roundtrip 검출', () => {
  const ok = makeDecoder('c2s');
  const bad = (b) => { const m = ok(b); return m.type === 'ACK' ? { ...m, upToPieceSeq: (m.upToPieceSeq + 1) % 4294967296 } : m; };
  const r = runFuzz({ ...refCodec('c2s'), decode: bad }, { iterations: 3000, seed: SEED });
  assert.ok(r.violations.some((v) => v.kind === 'roundtrip'), JSON.stringify(r.violations.slice(0, 2)));
});

test('깨진 복호기 3: count 를 믿고 힙 배열을 먼저 할당 -> alloc 검출', () => {
  const ok = makeDecoder('c2s');
  const bad = (b) => {
    if (b.length >= 14 && b[0] === 3) { const c = b[12] | (b[13] << 8); globalThis.__sink = new Array(c * 128).fill(1); }
    return ok(b);
  };
  const r = runFuzz({ ...refCodec('c2s'), decode: bad }, { iterations: 6000, seed: SEED });
  assert.ok(r.violations.some((v) => v.kind === 'alloc' || v.kind === 'time'), JSON.stringify(r.violations.slice(0, 2)));
  globalThis.__sink = null;
});

// typed array·Buffer 선할당은 힙(used_heap_size) 밖이라 arrayBuffers 증가분으로만 보인다.
const preallocDecoders = {
  'new Uint8Array(count*4096)': (b) => { if (b.length >= 14 && b[0] === 3) globalThis.__sink = new Uint8Array((b[12] | (b[13] << 8)) * 4096); },
  'Buffer.alloc(count*1024)': (b) => { if (b.length >= 14 && b[0] === 3) globalThis.__sink = Buffer.alloc((b[12] | (b[13] << 8)) * 1024); },
  'new Float64Array(msgLen*512)': (b) => { if (b.length >= 12 && b[0] === 9) globalThis.__sink = new Float64Array((b[10] | (b[11] << 8)) * 512); },
};
for (const [name, pre] of Object.entries(preallocDecoders)) {
  test(`깨진 복호기 3-타입배열: ${name} 선할당 -> 위반 >= 1, 원 코덱 0`, () => {
    for (const dir of ['c2s', 's2c']) {
      const ok = makeDecoder(dir);
      const bad = (b) => { pre(b); return ok(b); };
      const r = runFuzz({ ...refCodec(dir), decode: bad }, { iterations: 20000, seed: SEED });
      globalThis.__sink = null;
      assert.ok(r.violations.length >= 1, `${dir} 위반 0`);
      assert.ok(r.violations.some((v) => v.kind === 'alloc'), JSON.stringify(r.violations.slice(0, 2)));
      const base = runFuzz(refCodec(dir), { iterations: 20000, seed: SEED });
      assert.equal(base.violations.length, 0);
    }
  });
}

test('깨진 복호기 4: 느린 복호 -> time 검출(checkOne)', () => {
  const ok = makeDecoder('c2s');
  const slow = (b) => { const t = performance.now(); while (performance.now() - t < 30) { /* spin */ } return ok(b); };
  const frame = refEncode({ type: 'ACK', upToPieceSeq: 5 });
  const v = checkOne({ decode: slow, encode: refEncode }, frame, { timeLimitMs: 10 });
  assert.equal(v?.kind, 'time');
  assert.equal(checkOne({ decode: ok, encode: refEncode }, frame), null);
});

test('깨진 복호기 5: 입력 바이트를 바꿈 -> mutated-input 검출', () => {
  const ok = makeDecoder('c2s');
  const bad = (b) => { const m = ok(b); b[8] ^= 1; return m; };
  const v = checkOne({ decode: bad, encode: refEncode }, refEncode({ type: 'ACK', upToPieceSeq: 5 }));
  assert.equal(v?.kind, 'mutated-input');
});

test('거대 count 는 본문 길이로 먼저 거부된다(기준 코덱, 퍼저 판정 함수)', () => {
  const f = refEncode({ type: 'PIECE_REQUEST', reqId: 1, items: [] });
  new DataView(f.buffer).setUint16(12, 0xffff, true);
  assert.equal(checkOne(refCodec('c2s'), f), null);
  assert.throws(() => makeDecoder('c2s')(f), (e) => e instanceof ProtoError);
});

// ---- 계약 순서·HELLO 검사 사례(복호기 단위) ----
const hdr = (type, payload, { reserved = 0 } = {}) => {
  const f = new Uint8Array(8 + payload.length), dv = new DataView(f.buffer);
  f[0] = type; f[1] = 1; dv.setUint16(2, reserved, true); dv.setUint32(4, payload.length, true); f.set(payload, 8);
  return f;
};
const u16le = (v) => [v & 255, v >> 8];
const hello = (flags) => hdr(1, Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, flags]));
/** 방향별 (프레임, 기대 code) 표. length 가 field 보다 먼저임을 못 박는다. */
const DIRECTED = {
  c2s: [
    ['count=0xffff·본문 6 B -> length', hdr(3, Uint8Array.from([0, 0, 0, 0, ...u16le(0xffff)])), 'length'],
    ['count=257·본문 일치 -> field', hdr(3, new Uint8Array(6 + 16 * 257).fill(0).map((_, i) => (i === 4 ? 1 : i === 5 ? 1 : 0))), 'field'],
    ['count=257·본문 6 B -> length', hdr(3, Uint8Array.from([0, 0, 0, 0, ...u16le(257)])), 'length'],
    ['HELLO flags=1 -> field', hello(1), 'field'],
    ['HELLO flags=0xff -> field', hello(255), 'field'],
    ['HELLO flags=0 -> 성공', hello(0), 'ok'],
    ['HELLO reserved=1 -> reserved', hdr(1, new Uint8Array(9), { reserved: 1 }), 'reserved'],
    ['ACK reserved=0x100 -> reserved', hdr(4, new Uint8Array(4), { reserved: 0x100 }), 'reserved'],
  ],
  s2c: [
    ['msgLen=300·본문 4 B -> length', hdr(9, Uint8Array.from([1, 0, ...u16le(300)])), 'length'],
    ['msgLen=300·본문 일치 -> field', hdr(9, Uint8Array.from([1, 0, ...u16le(300), ...new Array(300).fill(97)])), 'field'],
    ['msgLen=257·본문 4 B -> length', hdr(9, Uint8Array.from([1, 0, ...u16le(257)])), 'length'],
    ['ERROR 알 수 없는 code -> field', hdr(9, Uint8Array.from([0, 0, 0, 0])), 'field'],
    ['WELCOME reserved=1 -> reserved', hdr(5, new Uint8Array(9), { reserved: 1 }), 'reserved'],
    ['WELCOME nextPieceSeq=0 -> field', hdr(5, new Uint8Array(9)), 'field'],
    ['WELCOME nextPieceSeq=1 -> 성공', hdr(5, Uint8Array.from([0, 0, 0, 0, 0, 1, 0, 0, 0])), 'ok'],
    ['PIECE pieceSeq=0 -> field', hdr(6, new Uint8Array(21)), 'field'],
    ['PIECE pieceSeq=1 -> 성공', hdr(6, Uint8Array.from([1, 0, 0, 0, ...new Array(17).fill(0)])), 'ok'],
  ],
};
function directedFailures(decode, dir) {
  const bad = [];
  for (const [label, frame, want] of DIRECTED[dir]) {
    let got = 'ok';
    try { decode(frame.slice()); } catch (e) { got = e instanceof ProtoError ? e.code : `panic:${e?.name}`; }
    if (got !== want) bad.push(`${label}: ${got}`);
  }
  return bad;
}

test('기준 코덱은 계약 순서 사례를 모두 만족한다', () => {
  for (const dir of ['c2s', 's2c']) assert.deepEqual(directedFailures(makeDecoder(dir), dir), []);
});

// 변이 복호기: 기준 코덱에서 검사 하나를 빼거나 순서를 바꾼 것. 사례표와 차등 퍼저가 둘 다 잡아야 한다.
const mutants = {
  'HELLO flags 검사 제거': ['c2s', (ok) => (b) => { if (b[0] === 1 && b.length === 17) { b = b.slice(); b[16] = 0; } return ok(b); }],
  'reserved 검사 제거': ['c2s', (ok) => (b) => { if (b.length >= 8) { b = b.slice(); b[2] = 0; b[3] = 0; } return ok(b); }],
  'PIECE_REQUEST length↔field 교환': ['c2s', (ok) => (b) => {
    try { return ok(b); } catch (e) {
      if (e.code === 'length' && b[0] === 3 && b.length >= 14 && (b[12] | (b[13] << 8)) > 256) throw new ProtoError('field', 'count');
      throw e;
    }
  }],
  'ERROR length↔field 교환': ['s2c', (ok) => (b) => {
    try { return ok(b); } catch (e) {
      if (e.code === 'length' && b[0] === 9 && b.length >= 12 && (b[10] | (b[11] << 8)) > 256) throw new ProtoError('field', 'msgLen');
      throw e;
    }
  }],
};
for (const [name, [dir, wrap]] of Object.entries(mutants)) {
  test(`변이 복호기: ${name} -> 사례표 실패`, () => {
    assert.ok(directedFailures(wrap(makeDecoder(dir)), dir).length >= 1);
  });
  test(`변이 복호기: ${name} -> 차등 퍼저 위반 >= 1`, () => {
    const r = runFuzz({ ...refCodec(dir), decode: wrap(makeDecoder(dir)), reference: { decode: makeDecoder(dir) } }, { iterations: 50_000, seed: SEED });
    assert.ok(r.violations.some((v) => v.kind === 'diff'), `${r.violations.length}`);
  });
}

// ---- 제품 코덱 ----
for (const [name, mod, dir, seedBase] of [
  ['서버 복호(server/proto/codec)', serverCodec, 'c2s', SEED],
  ['클라이언트 복호(client/proto)', clientCodec, 's2c', SEED ^ 0xc11e47],
]) {
  test(`제품 사례표: ${name}`, () => {
    assert.deepEqual(directedFailures(mod.decodeMessage, dir), []);
  });
  test(`퍼저: ${name} ${ITER} 회`, () => {
    assert.equal(typeof mod.decodeMessage, 'function');
    assert.equal(typeof mod.encodeMessage, 'function');
    // 시드 프레임은 독립 구현(기준 코덱)으로 만든다. 방향 검사까지 치도록 두 방향 종류가 모두 섞인다.
    const r = runFuzz({ decode: mod.decodeMessage, encode: mod.encodeMessage, seedEncode: refEncode, reference: { decode: makeDecoder(dir) } }, { iterations: ITER, seed: seedBase, stopAfter: 20 });
    console.log(`# T11.10 ${name}: runs=${r.runs} random=${r.random} mutated=${r.mutated} accepted=${r.accepted} rejected=${r.rejected} violations=${r.violations.length}`);
    assert.equal(r.violations.length, 0, JSON.stringify(r.violations.slice(0, 5)));
    assert.equal(r.runs, ITER);
    assert.ok(r.accepted > 1000, `성공 경로가 밟혀야 한다: ${r.accepted}`);
  });
}

test('기준 코덱: LEVEL_ARRIVED pieceCount 0 은 부호화·복호 모두 field, 1 은 왕복', () => {
  const m = (pieceCount) => ({ type: 'LEVEL_ARRIVED', segmentId: 5, level: 2, pieceCount });
  const kind = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof ProtoError); return e.code; } return null; };
  const dec = makeDecoder('s2c');
  assert.equal(kind(() => refEncode(m(0))), 'field');
  const f = refEncode(m(1));
  assert.deepEqual(dec(f), m(1));
  const z = Uint8Array.from(f); z.set([0, 0, 0, 0], z.length - 4);
  assert.equal(kind(() => dec(z)), 'field');
});
