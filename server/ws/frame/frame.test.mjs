// 프레임 파서·인코더 시험(F-191, F-194 프레임 부분). 기대값은 RFC 6455 와 손계산으로 정한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameParser, encodeFrame, encodeClosePayload, OPCODES, DEFAULT_MAX_FRAGMENTS } from './index.mjs';

const KEY = Uint8Array.of(1, 2, 3, 4);
const mask = (bytes) => bytes.map((v, i) => v ^ KEY[i & 3]);
const run = (bytes, opts) => new FrameParser(opts).push(Buffer.from(bytes));

test('4 MiB 프레임을 1400 B 조각으로 밀어 넣어도 100 ms 이내이고 내용이 보존된다', () => {
  // 문턱 근거: 선형 구현은 복사 약 3 번(조각 복사·추출·언마스크)이라 4 MiB 에서 수 ms 수준이고,
  // 기존 O(n^2) 구현은 같은 입력에 약 1 s 이상 걸렸다(F-191). 100 ms 는 느린 CI 에서도 넘지 않으면서 이차 구현은 확실히 잡는 값.
  const size = 4 * 1024 * 1024;
  const body = Buffer.alloc(size);
  for (let i = 0; i < size; i++) body[i] = (i * 31 + 7) & 0xff;
  const wire = encodeFrame(OPCODES.BINARY, body, { maskKey: KEY });
  const p = new FrameParser({ maxPayload: size });
  const events = [];
  const t0 = process.hrtime.bigint();
  for (let o = 0; o < wire.length; o += 1400) events.push(...p.push(wire.subarray(o, o + 1400)));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'message');
  assert.ok(Buffer.from(events[0].data).equals(body));
  assert.ok(ms < 100, `4 MiB 조각 push ${ms.toFixed(1)} ms`);
});

test('조각 크기에 선형: 1 B 단위 push 가 64 KiB 에서도 끝난다', () => {
  const body = Buffer.alloc(64 * 1024, 5);
  const wire = encodeFrame(OPCODES.BINARY, body, { maskKey: KEY });
  const p = new FrameParser();
  let ev = [];
  for (let i = 0; i < wire.length; i++) ev = ev.concat(p.push(wire.subarray(i, i + 1)));
  assert.equal(ev.length, 1);
  assert.equal(ev[0].data.length, body.length);
});

test('빈 fin=0 연속 프레임 100,000 개는 1009 이고 조각을 쌓지 않는다', () => {
  const first = encodeFrame(OPCODES.BINARY, new Uint8Array(0), { fin: false, maskKey: KEY });
  const cont = encodeFrame(OPCODES.CONT, new Uint8Array(0), { fin: false, maskKey: KEY });
  const wire = Buffer.concat([first, ...Array.from({ length: 99999 }, () => cont)]);
  const p = new FrameParser();
  const ev = p.push(wire);
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].type, ev[0].code], ['error', 1009]);
  assert.equal(p.frags.length, 0);
  assert.equal(p.fragCount, DEFAULT_MAX_FRAGMENTS + 1);
});

test('조각 개수 상한 경계: 상한 개는 통과, 하나 더면 1009', () => {
  const mk = (n) => {
    const parts = [encodeFrame(OPCODES.BINARY, Uint8Array.of(1), { fin: false, maskKey: KEY })];
    for (let i = 2; i < n; i++) parts.push(encodeFrame(OPCODES.CONT, Uint8Array.of(1), { fin: false, maskKey: KEY }));
    parts.push(encodeFrame(OPCODES.CONT, Uint8Array.of(1), { maskKey: KEY }));
    return Buffer.concat(parts);
  };
  const ok = run(mk(10), { maxFragments: 10 });
  assert.equal(ok[0].type, 'message');
  assert.equal(ok[0].data.length, 10);
  const bad = run(mk(11), { maxFragments: 10 });
  assert.deepEqual([bad[0].type, bad[0].code], ['error', 1009]);
});

test('길이 0 연속 프레임이 섞여도 메시지 내용은 그대로', () => {
  const w = Buffer.concat([
    encodeFrame(OPCODES.BINARY, Uint8Array.of(1, 2), { fin: false, maskKey: KEY }),
    encodeFrame(OPCODES.CONT, new Uint8Array(0), { fin: false, maskKey: KEY }),
    encodeFrame(OPCODES.CONT, Uint8Array.of(3), { maskKey: KEY }),
  ]);
  const ev = run(w);
  assert.deepEqual([...ev[0].data], [1, 2, 3]);
});

test('확장 길이 비최소 부호화는 1002', () => {
  const m = [...KEY];
  // 82 FE 00 05: 길이 5 를 2바이트 필드로(마스크 비트 포함 FE)
  const e1 = run([0x82, 0xfe, 0x00, 0x05, ...m, ...mask([1, 2, 3, 4, 5])]);
  assert.deepEqual([e1[0].type, e1[0].code], ['error', 1002]);
  // 8바이트 필드로 길이 5, 그리고 65535
  const e2 = run([0x82, 0xff, 0, 0, 0, 0, 0, 0, 0, 5, ...m]);
  assert.equal(e2[0].code, 1002);
  const e3 = run([0x82, 0xff, 0, 0, 0, 0, 0, 0, 0xff, 0xff, ...m]);
  assert.equal(e3[0].code, 1002);
  // 경계: 126 은 2바이트 필드가 최소, 65536 은 8바이트 필드가 최소 -> 오류 아님(본문 대기)
  assert.deepEqual(run([0x82, 0xfe, 0x00, 126, ...m]), []);
  assert.deepEqual(run([0x82, 0xff, 0, 0, 0, 0, 0, 1, 0, 0, ...m], { maxPayload: 1 << 20 }), []);
  // 125 는 1바이트 필드가 최소이며 정상 수신
  const ok = run([0x82, 0x80 | 125, ...m, ...mask(new Array(125).fill(9))]);
  assert.equal(ok[0].type, 'message');
});

test('64비트 길이 최상위 비트 1 은 1002, 0 인 거대한 값은 1009', () => {
  const m = [...KEY];
  const top = run([0x82, 0xff, 0x80, 0, 0, 0, 0, 0, 0, 0, ...m]);
  assert.equal(top[0].code, 1002);
  const allOnes = run([0x82, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...m]);
  assert.equal(allOnes[0].code, 1002);
  const huge = run([0x82, 0xff, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...m]);
  assert.equal(huge[0].code, 1009);
  const over = run([0x82, 0xff, 0, 0, 0, 0, 0x10, 0, 0, 0, ...m], { maxPayload: 1024 });
  assert.equal(over[0].code, 1009);
});

test('encodeFrame 은 보낼 수 없는 opcode 를 거부한다', () => {
  for (const op of [3, 4, 5, 6, 7, 0xb, 0xf, 16, -1, 1.5, 0x82, NaN, undefined]) {
    assert.throws(() => encodeFrame(op, Uint8Array.of(1)), RangeError, `opcode ${op}`);
  }
  for (const op of [0, 1, 2]) assert.equal(encodeFrame(op, Uint8Array.of(1))[0] & 0x0f, op);
  for (const op of [8, 9, 10]) assert.equal(encodeFrame(op)[0] & 0x0f, op);
});

test('close 사유는 123 바이트까지(UTF-8 바이트 기준)', () => {
  assert.equal(encodeClosePayload(1000, 'a'.repeat(123)).length, 125);
  assert.throws(() => encodeClosePayload(1000, 'a'.repeat(124)), RangeError);
  // 한글 3 B x 41 = 123 B 통과, 42 자 = 126 B 거부(글자 수로는 123 이하)
  assert.equal(encodeClosePayload(1000, '가'.repeat(41)).length, 125);
  assert.throws(() => encodeClosePayload(1000, '가'.repeat(42)), RangeError);
});

test('여러 프레임이 한 조각에, 헤더가 조각 경계에 걸쳐도 모두 나온다', () => {
  const a = encodeFrame(OPCODES.BINARY, Buffer.alloc(300, 1), { maskKey: KEY });
  const b = encodeFrame(OPCODES.PING, Uint8Array.of(7), { maskKey: KEY });
  const all = Buffer.concat([a, b, a]);
  for (const step of [1, 2, 3, 5, 13, 1000]) {
    const p = new FrameParser();
    const ev = [];
    for (let o = 0; o < all.length; o += step) ev.push(...p.push(all.subarray(o, o + step)));
    assert.deepEqual(ev.map((e) => e.type), ['message', 'ping', 'message'], `step ${step}`);
    assert.equal(ev[0].data.length, 300);
  }
});

test('push 한 버퍼를 나중에 바꿔도 결과가 변하지 않는다', () => {
  const w = Buffer.from(encodeFrame(OPCODES.BINARY, Uint8Array.of(1, 2, 3, 4, 5, 6), { maskKey: KEY }));
  const p = new FrameParser();
  assert.deepEqual(p.push(w.subarray(0, 5)), []);
  w.fill(0, 0, 5);
  const ev = p.push(w.subarray(5));
  assert.deepEqual([...ev[0].data], [1, 2, 3, 4, 5, 6]);
});
