// 서버·클라이언트 교차 시험. server/proto/codec/index.mjs 가 작업 트리에 있을 때만 돈다(동적 import, 없으면 건너뜀).
// 건너뛰면 시험 결과에 skipped 로 남고, 사유가 표준 출력에 한 줄 찍힌다.
// 단언:
//  1) 9종 전부 무작위 유효 메시지(고정 시드)를 양쪽이 부호화한 바이트가 같다. 받는 쪽 방향 복호는 원 메시지를 되돌리고
//     반대 방향 복호는 ProtoError('direction') 이다.
//  2) 부호화 오류 입력 1,000개(유효 메시지를 무작위 변조): 양쪽의 (성공/실패, code) 가 같다.
//  3) 복호 오류 입력 1,000개(유효 프레임 바이트를 무작위 변조): 두 복호기가 같은 (성공/실패, code) 를 낸다 — 단 방향 검사는
//     서로 반대이므로, 방향이 맞는 쪽의 결과를 기준으로 반대쪽은 'direction'(type 검사까지 통과한 경우) 이거나 같은 code
//     (short·type)여야 한다. 방향이 맞는 쪽이 성공하면 상대 부호화기로 다시 부호화한 바이트가 변조 입력과 같아야 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as client from './index.mjs';
import { ProtoError, MSG, DIRECTION, MAX_REQUEST_ITEMS, MAX_ERROR_TEXT, ERR_CODES } from '../../contracts/proto/index.mjs';

const serverPath = fileURLToPath(new URL('../../server/proto/codec/index.mjs', import.meta.url));
const server = existsSync(serverPath) ? await import(pathToFileURL(serverPath).href) : null;
const skip = server ? false : 'server/proto/codec/index.mjs 없음 — 교차 시험 건너뜀';
if (!server) console.log(`# 교차 시험 건너뜀: ${serverPath} 가 작업 트리에 없다`);

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
    WELCOME: () => ({ type: 'WELCOME', sessionId: u32(), resumed: r() < 0.5, nextPieceSeq: u32() }),
    PIECE: () => ({ type: 'PIECE', pieceSeq: u32(), key: key(), chunk: Uint8Array.from({ length: int(1, 200) }, () => int(0, 255)) }),
    LEVEL_ARRIVED: () => ({ type: 'LEVEL_ARRIVED', segmentId: int(0, 2 ** 30 - 1), level: int(0, 3), pieceCount: u32() }),
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

const DIR_OF = (bytes) => (bytes.length >= 1 ? DIRECTION[bytes[0]] : undefined);

test('교차: 전 종류 왕복·바이트 일치', { skip }, () => {
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

test('교차: 부호화 오류 입력 1,000개의 (성공/실패, code) 가 같다', { skip }, () => {
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

test('교차: 복호 오류 입력 1,000개 — 방향이 맞는 쪽 기준 (성공/실패, code) 일치', { skip }, () => {
  const r = rng(20260103);
  const g = gen(r);
  let fails = 0;
  const seenCodes = new Set();
  for (let i = 0; i < 1000; i++) {
    const t = TYPES[i % TYPES.length];
    const bytes = corruptBytes(client.encodeMessage(g[t]()), r);
    const c = outcome(() => client.decodeMessage(bytes));
    const s = outcome(() => server.decodeMessage(bytes));
    const dir = DIR_OF(bytes);
    const label = `사례 ${i} ${t} [${Buffer.from(bytes.slice(0, 24)).toString('hex')}]`;
    if (bytes.length < 8 || dir === undefined) {
      assert.equal(sig(c), sig(s), label); // short·type 은 방향과 무관하게 같다
    } else {
      const [own, other, ownMod, otherMod] = dir === 's2c' ? [c, s, client, server] : [s, c, server, client];
      assert.equal(sig(other), 'direction', label); // type 검사까지 통과했으므로 반대쪽은 방향 거부
      if (own.ok) assert.deepEqual(otherMod.encodeMessage(own.value), bytes, label + ' 재부호화');
      assert.ok(own.ok || own.code !== 'direction', label);
      void ownMod;
    }
    if (!(c.ok && s.ok)) { fails++; seenCodes.add(sig(c)); seenCodes.add(sig(s)); }
  }
  assert.ok(fails >= 800, `오류 입력이 너무 적다: ${fails}`);
  for (const k of ['short', 'type', 'direction', 'version', 'reserved', 'limit', 'length', 'field']) assert.ok(seenCodes.has(k), `code ${k} 가 변조 집합에 없다`);
});
