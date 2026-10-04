// 서버·클라이언트 교차 시험. 서버 코덱은 정적 import 한다 — 모듈이 없으면 이 파일이 로드에서 실패한다(skip 으로 녹색 금지).
// 단언:
//  1) 9종 전부 무작위 유효 메시지(고정 시드)를 양쪽이 부호화한 바이트가 같다. 받는 쪽 방향 복호는 원 메시지를 되돌리고
//     반대 방향 복호는 ProtoError('direction') 이다.
//  2) 부호화 오류 입력 1,000개(유효 메시지를 무작위 변조): 양쪽의 (성공/실패, code) 가 같다.
//  3) 복호 오류 입력 1,000개(유효 프레임 바이트를 무작위 변조): 두 복호기가 같은 (성공/실패, code) 를 낸다 — 단 방향 검사는
//     서로 반대이므로, 프레임 검사(length 까지)에서 거절되면 두 쪽 code 가 같고, 통과하면 반대쪽은 'direction' 이다. 방향이 맞는 쪽이 성공하면 상대 부호화기로 다시 부호화한 바이트가 변조 입력과 같아야 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as client from './index.mjs';
import * as server from '../../server/proto/codec/index.mjs';
import { makeDecoder as makeRefDecoder } from '../../server/proto/fuzz/reference-codec.mjs';
import { ProtoError, MSG, DIRECTION, MAX_REQUEST_ITEMS, MAX_ERROR_TEXT, ERR_CODES } from '../../contracts/proto/index.mjs';

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
const outcome = (fn) => {
  try { return { ok: true, value: fn() }; } catch (e) {
    if (!(e instanceof ProtoError)) throw e;
    return { ok: false, code: e.code };
  }
};
const sig = (o) => (o.ok ? 'ok' : o.code);

function gen(r) {
  const u32 = () => Math.floor(r() * 2 ** 32);
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const key = () => ({ segmentId: int(0, 2 ** 30 - 1), level: int(0, 3), lod: int(0, 7), chunkIndex: int(0, 65535), tileX: int(-(2 ** 31), 2 ** 31 - 1), tileY: int(-(2 ** 31), 2 ** 31 - 1) });
  const f = (s) => Math.fround((r() - 0.5) * s);
  return {
    HELLO: () => ({ type: 'HELLO', sessionId: u32(), lastPieceSeq: u32() }),
    VIEW_UPDATE: () => {
      let q = [f(2), f(2), f(2), f(2)];
      const n = Math.hypot(...q) || 1;
      q = q.map((x) => Math.fround(x / n));
      return { type: 'VIEW_UPDATE', viewSeq: u32(), pos: [f(1000), f(1000), f(1000)], quat: q, fovY: Math.fround(0.1 + r() * 3), width: int(1, 65535), height: int(1, 65535) };
    },
    PIECE_REQUEST: () => {
      const items = []; const seen = new Set();
      for (let n = int(0, 12); items.length < n;) { const k = key(); const s = JSON.stringify(k); if (!seen.has(s)) { seen.add(s); items.push(k); } }
      return { type: 'PIECE_REQUEST', reqId: u32(), items };
    },
    ACK: () => ({ type: 'ACK', upToPieceSeq: u32() }),
    WELCOME: () => ({ type: 'WELCOME', sessionId: u32(), resumed: r() < 0.5, nextPieceSeq: Math.max(1, u32()) }),
    PIECE: () => ({ type: 'PIECE', pieceSeq: Math.max(1, u32()), key: key(), chunk: Uint8Array.from({ length: int(1, 200) }, () => int(0, 255)) }),
    LEVEL_ARRIVED: () => { const pieceCount = int(1, 2 ** 32 - 1); return { type: 'LEVEL_ARRIVED', segmentId: int(0, 2 ** 30 - 1), level: int(0, 3), pieceCount, firstPieceSeq: int(1, 2 ** 32 - pieceCount) }; },
    MISSING: () => ({ type: 'MISSING', segmentId: int(0, 2 ** 30 - 1) }),
    ERROR: () => ({ type: 'ERROR', code: int(1, 5), text: ['', 'a', '초과', 'x'.repeat(int(0, 80)), '😀 ok'][int(0, 4)] }),
  };
}
const TYPES = Object.keys(MSG);
const clone = (m) => structuredClone(m);

/** 메시지 한 군데를 범위 밖 값으로 바꾼다(없는 필드 추가·삭제 포함). */
function corruptMessage(m, r) {
  const c = clone(m);
  const bads = [-1, 2 ** 32, 2 ** 31, 2 ** 30, 1.5, NaN, Infinity, -Infinity, 0, 3, 4, 8, 65536, 256, 'x', null, undefined, 1e300, Math.PI, -0.5];
  const pick = (a) => a[Math.floor(r() * a.length)];
  const paths = [];
  const walk = (o, p) => {
    for (const k of Object.keys(o)) {
      if (k === 'type') continue;
      const v = o[k];
      if (v instanceof Uint8Array) paths.push([...p, k]);
      else if (v && typeof v === 'object') walk(v, [...p, k]);
      else paths.push([...p, k]);
    }
  };
  walk(c, []);
  const p = pick(paths);
  let o = c;
  for (const s of p.slice(0, -1)) o = o[s];
  const last = p[p.length - 1];
  const mode = r();
  if (mode < 0.1) delete o[last];
  else if (mode < 0.15 && o[last] instanceof Uint8Array) o[last] = new Uint8Array(0);
  else if (mode < 0.2 && c.type === 'ERROR' && last === 'text') o[last] = 'z'.repeat(MAX_ERROR_TEXT + 1);
  else if (mode < 0.25 && c.type === 'PIECE_REQUEST' && last === 'items') o[last] = Array.from({ length: MAX_REQUEST_ITEMS + 1 }, (_, i) => ({ segmentId: 0, level: 0, lod: 0, chunkIndex: i, tileX: 0, tileY: 0 }));
  else if (mode < 0.3 && c.type === 'PIECE_REQUEST' && c.items.length) c.items.push(clone(c.items[0]));
  else if (mode < 0.35 && c.type === 'VIEW_UPDATE') c.quat = [0, 0, 0, 1 + pick([0.0011, -0.0011, 0.5, 0.0009, -0.0009])];
  else o[last] = pick(bads);
  return c;
}

/** 프레임 바이트를 무작위 변조한다. */
function corruptBytes(b, r) {
  const x = Uint8Array.from(b);
  const int = (n) => Math.floor(r() * n);
  const mode = r();
  if (mode < 0.15) return x.slice(0, int(x.length));
  if (mode < 0.25) { const e = new Uint8Array(x.length + 1 + int(4)); e.set(x); return e; }
  if (mode < 0.55) { x[int(Math.min(8, x.length))] = int(256); return x; } // 머리 변조
  if (mode < 0.65) { new DataView(x.buffer).setUint32(4, int(2 ** 32), true); return x; }
  if (mode < 0.7) { new DataView(x.buffer).setUint32(4, 4 * 1024 * 1024 + int(3) - 1, true); return x; }
  const n = 1 + int(3);
  for (let i = 0; i < n; i++) x[8 + int(Math.max(1, x.length - 8)) % x.length] = int(256);
  return x;
}

test('교차: 전 종류 왕복·바이트 일치', () => {
  const r = rng(20260101);
  const g = gen(r);
  for (let i = 0; i < 50; i++) {
    for (const t of TYPES) {
      const m = g[t]();
      const cb = client.encodeMessage(m);
      const sb = server.encodeMessage(m);
      assert.deepEqual(cb, sb, `${t} 부호화 바이트`);
      const [rx, tx] = DIRECTION[MSG[t]] === 'c2s' ? [server, client] : [client, server];
      assert.deepEqual(rx.decodeMessage(cb), m, `${t} 복호`);
      assert.equal(sig(outcome(() => tx.decodeMessage(cb))), 'direction', `${t} 반대 방향`);
    }
  }
});

// PIECE.pieceSeq·WELCOME.nextPieceSeq 는 >= 1 이다. 생성기는 유효 메시지만 만들므로 seq 0 은 따로 못 박는다(양쪽 부호화·복호).
test('교차: seq 0 은 부호화·복호 모두 field (PIECE.pieceSeq, WELCOME.nextPieceSeq)', () => {
  const r = rng(20260104);
  const g = gen(r);
  for (let i = 0; i < 20; i++) {
    for (const [t, field, off] of [['PIECE', 'pieceSeq', 8], ['WELCOME', 'nextPieceSeq', 13]]) {
      const m = g[t]();
      const bytes = client.encodeMessage(m); // seq >= 1
      for (const seq of [0, 1]) {
        const z = { ...m, [field]: seq };
        const want = seq === 0 ? 'field' : 'ok';
        assert.equal(sig(outcome(() => client.encodeMessage(z))), want, `${t} 클라이언트 부호화 seq ${seq}`);
        assert.equal(sig(outcome(() => server.encodeMessage(z))), want, `${t} 서버 부호화 seq ${seq}`);
        const f = bytes.slice(); new DataView(f.buffer).setUint32(off, seq, true);
        assert.equal(sig(outcome(() => client.decodeMessage(f))), want, `${t} 클라이언트 복호 seq ${seq}`);
        assert.equal(sig(outcome(() => makeRefDecoder('s2c')(f))), want, `${t} 기준 복호 seq ${seq}`);
        assert.equal(sig(outcome(() => server.decodeMessage(f))), 'direction', `${t} 서버 복호는 방향 거부`);
      }
    }
  }
});

test('교차: 부호화 오류 입력 1,000개의 (성공/실패, code) 가 같다', () => {
  const r = rng(20260102);
  const g = gen(r);
  let fails = 0;
  for (let i = 0; i < 1000; i++) {
    const m = corruptMessage(g[TYPES[i % TYPES.length]](), r);
    const c = outcome(() => client.encodeMessage(m));
    const s = outcome(() => server.encodeMessage(m));
    assert.equal(sig(c), sig(s), `사례 ${i} ${JSON.stringify(m, (k, v) => (v instanceof Uint8Array ? `u8[${v.length}]` : Number.isNaN(v) ? 'NaN' : v === Infinity ? 'Inf' : v))}`);
    if (c.ok) assert.deepEqual(c.value, s.value);
    else fails++;
  }
  assert.ok(fails >= 500, `오류 입력이 너무 적다: ${fails}`);
});

test('교차: 복호 오류 입력 1,000개 — 방향이 맞는 쪽 기준 (성공/실패, code) 일치', () => {
  const r = rng(20260103);
  const g = gen(r);
  let fails = 0;
  const seenCodes = new Set();
  for (let i = 0; i < 1000; i++) {
    const t = TYPES[i % TYPES.length];
    const bytes = corruptBytes(client.encodeMessage(g[t]()), r);
    const c = outcome(() => client.decodeMessage(bytes));
    const s = outcome(() => server.decodeMessage(bytes));
    const label = `사례 ${i} ${t} [${Buffer.from(bytes.slice(0, 24)).toString('hex')}]`;
    // 서버 순서: short→type→version→reserved→limit→length(프레임)→direction→본문 length→field.
    // 프레임 검사(방향 앞)까지는 두 복호기의 (성공/실패, code) 가 정확히 같다.
    const dv = bytes.length >= 8 ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
    const frameOk = dv && DIRECTION[bytes[0]] !== undefined && bytes[1] === 1 && dv.getUint16(2, true) === 0
      && dv.getUint32(4, true) <= 4 * 1024 * 1024 && bytes.length === 8 + dv.getUint32(4, true);
    if (!frameOk) {
      assert.equal(sig(c), sig(s), label);
      assert.ok(!c.ok, label);
    } else {
      const dir = DIRECTION[bytes[0]];
      const [own, other, otherMod] = dir === 's2c' ? [c, s, server] : [s, c, client];
      assert.equal(sig(other), 'direction', label); // 프레임 검사를 통과했으므로 반대쪽은 방향 거부
      // 방향이 맞는 쪽은 기준 코덱(계약 순서: length 먼저)과 (성공/실패, code)가 정확히 같아야 한다.
      const ref = outcome(() => makeRefDecoder(dir)(bytes));
      assert.equal(sig(own), sig(ref), label + ' 기준 코덱과 code');
      if (own.ok) assert.deepEqual(otherMod.encodeMessage(own.value), bytes, label + ' 재부호화');
    }
    if (!(c.ok && s.ok)) { fails++; seenCodes.add(sig(c)); seenCodes.add(sig(s)); }
  }
  assert.ok(fails >= 800, `오류 입력이 너무 적다: ${fails}`);
  for (const k of ['short', 'type', 'direction', 'version', 'reserved', 'limit', 'length', 'field']) assert.ok(seenCodes.has(k), `code ${k} 가 변조 집합에 없다`);
});

// 계약 순서: 본문 length 가 field 보다 먼저다. 양쪽 복호기에 같은 code 를 못 박는다(순서 교환 변이 사망용).
test('교차: length 가 field 보다 먼저다(count=0xffff·본문 6 B, msgLen=300·본문 4 B)', () => {
  const frame = (type, payload) => {
    const f = new Uint8Array(8 + payload.length); f[0] = type; f[1] = 1;
    new DataView(f.buffer).setUint32(4, payload.length, true); f.set(payload, 8); return f;
  };
  const req = frame(MSG.PIECE_REQUEST, Uint8Array.from([0, 0, 0, 0, 0xff, 0xff]));
  const err = frame(MSG.ERROR, Uint8Array.from([1, 0, 300 & 255, 300 >> 8]));
  assert.equal(sig(outcome(() => server.decodeMessage(req))), 'length');
  assert.equal(sig(outcome(() => client.decodeMessage(req))), 'direction');
  assert.equal(sig(outcome(() => client.decodeMessage(err))), 'length');
  assert.equal(sig(outcome(() => server.decodeMessage(err))), 'direction');
  // 본문 길이가 맞으면 field.
  const big = frame(MSG.PIECE_REQUEST, new Uint8Array(6 + 16 * 257).map((_, i) => (i === 4 || i === 5 ? 1 : 0)));
  assert.equal(sig(outcome(() => server.decodeMessage(big))), 'field');
  const long = frame(MSG.ERROR, Uint8Array.from([1, 0, 300 & 255, 300 >> 8, ...new Array(300).fill(97)]));
  assert.equal(sig(outcome(() => client.decodeMessage(long))), 'field');
});
