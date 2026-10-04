// 프로토콜 퍼저 시험(T11.10). 고정 시드. 제품 코덱(server/proto/codec, client/proto)은 동적 import 하며, 없으면 그 시험은
// 건너뛰고 건너뜀을 출력에 명시한다. 퍼저 자체는 기준 코덱(reference-codec.mjs)과 일부러 깨뜨린 복호기로 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runFuzz, checkOne } from './index.mjs';
import { encodeMessage as refEncode, makeDecoder } from './reference-codec.mjs';
import { ProtoError } from '../../../contracts/proto/index.mjs';

const SEED = 0x5eed11a;
const ITER = 100_000; // 서버 복호 10만 + 클라이언트 복호 10만
const SELF_ITER = 20_000;

async function load(rel) {
  try { return await import(new URL(rel, import.meta.url).href); } catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND' || e?.code === 'ERR_UNSUPPORTED_DIR_IMPORT') return null;
    throw e;
  }
}

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

test('깨진 복호기 3: count 를 믿고 먼저 할당 -> alloc 검출', () => {
  const ok = makeDecoder('c2s');
  const bad = (b) => {
    if (b.length >= 14 && b[0] === 3) { const c = b[12] | (b[13] << 8); globalThis.__sink = new Array(c * 128).fill(1); }
    return ok(b);
  };
  const r = runFuzz({ ...refCodec('c2s'), decode: bad }, { iterations: 6000, seed: SEED });
  assert.ok(r.violations.some((v) => v.kind === 'alloc' || v.kind === 'time'), JSON.stringify(r.violations.slice(0, 2)));
  globalThis.__sink = null;
});

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

// ---- 제품 코덱 ----
for (const [name, rel, dir, seedBase] of [
  ['서버 복호(server/proto/codec)', '../codec/index.mjs', 'c2s', SEED],
  ['클라이언트 복호(client/proto)', '../../../client/proto/index.mjs', 's2c', SEED ^ 0xc11e47],
]) {
  test(`퍼저: ${name} ${ITER} 회`, async (t) => {
    const mod = await load(rel);
    if (!mod) { const msg = `건너뜀: ${rel} 가 작업 트리에 없다(코덱 미병합)`; console.log(`# T11.10 ${msg}`); t.skip(msg); return; }
    assert.equal(typeof mod.decodeMessage, 'function');
    assert.equal(typeof mod.encodeMessage, 'function');
    // 시드 프레임은 독립 구현(기준 코덱)으로 만든다. 방향 검사까지 치도록 두 방향 종류가 모두 섞인다.
    const r = runFuzz({ decode: mod.decodeMessage, encode: mod.encodeMessage, seedEncode: refEncode }, { iterations: ITER, seed: seedBase, stopAfter: 20 });
    console.log(`# T11.10 ${name}: runs=${r.runs} random=${r.random} mutated=${r.mutated} accepted=${r.accepted} rejected=${r.rejected} violations=${r.violations.length}`);
    assert.equal(r.violations.length, 0, JSON.stringify(r.violations.slice(0, 5)));
    assert.equal(r.runs, ITER);
    assert.ok(r.accepted > 1000, `성공 경로가 밟혀야 한다: ${r.accepted}`);
  });
}
