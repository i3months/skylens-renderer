// 프레임 파서·인코더 시험(F-191, F-194 프레임 부분). 기대값은 RFC 6455 와 손계산으로 정한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameParser, encodeFrame, encodeClosePayload, OPCODES, DEFAULT_MAX_FRAGMENTS } from './index.mjs';

const KEY = Uint8Array.of(1, 2, 3, 4);
const mask = (bytes) => bytes.map((v, i) => v ^ KEY[i & 3]);
const run = (bytes, opts) => new FrameParser(opts).push(Buffer.from(bytes));

// 입력을 step 바이트씩 밀어 넣되 경과가 budgetMs 를 넘으면 루프 안에서 바로 throw 한다(퇴행 구현이 시험 전체를 멈추지 않게).
function pushAll(p, wire, step, budgetMs, events = []) {
  const t0 = performance.now();
  for (let o = 0; o < wire.length; o += step) {
    for (const e of p.push(wire.subarray(o, o + step))) events.push(e);
    if ((o & 0x3ff) === 0 && performance.now() - t0 > budgetMs) {
      throw new Error(`push ${budgetMs} ms 초과(오프셋 ${o}/${wire.length}, step ${step})`);
    }
  }
  return performance.now() - t0;
}

function maskedWire(size, fill) {
  const body = Buffer.alloc(size);
  for (let i = 0; i < size; i++) body[i] = fill(i);
  return { body, wire: encodeFrame(OPCODES.BINARY, body, { maskKey: KEY }) };
}

test('1400 B 조각 push 시간은 프레임 크기에 선형이고(4 배 크기 -> 시간비 < 10) 내용이 보존된다', () => {
  // 벽시계 절대값 대신 같은 프로세스에서 1 MiB 와 4 MiB 를 각각 최솟값(5 회)으로 재 비율을 본다.
  // 선형이면 비율 약 4, 이차이면 약 16. 부하는 두 측정에 같이 얹히고 최솟값이 이상치를 버린다.
  const small = maskedWire(1024 * 1024, (i) => (i * 31 + 7) & 0xff);
  const big = maskedWire(4 * 1024 * 1024, (i) => (i * 31 + 7) & 0xff);
  const time = ({ wire, body }) => {
    let best = Infinity;
    let total = 0;
    for (let r = 0; r < 5 && total < 1500; r++) { // 느린 구현은 반복하지 않고 일찍 끝낸다
      const events = [];
      const ms = pushAll(new FrameParser({ maxPayload: body.length }), wire, 1400, 1500, events);
      total += ms;
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'message');
      assert.ok(Buffer.from(events[0].data).equals(body));
      best = Math.min(best, ms);
    }
    return best;
  };
  time(small); // 예열
  const tSmall = time(small);
  const tBig = time(big);
  const ratio = tBig / Math.max(tSmall, 0.05);
  console.log(`# 1400 B chunks: 1 MiB ${tSmall.toFixed(1)} ms, 4 MiB ${tBig.toFixed(1)} ms, ratio ${ratio.toFixed(1)}`);
  assert.ok(ratio < 10, `시간비 ${ratio.toFixed(1)} (선형 ~4, 이차 ~16)`);
});

test('조각 크기에 선형: 1 B 단위 push 가 64 KiB 에서도 끝난다', () => {
  const body = Buffer.alloc(64 * 1024, 5);
  const wire = encodeFrame(OPCODES.BINARY, body, { maskKey: KEY });
  const p = new FrameParser();
  const ev = [];
  pushAll(p, wire, 1, 3000, ev);
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

// F-208: 1 B 조각으로 마스킹된 4 MiB 프레임을 밀어 넣어도 시간·메모리가 프레임 크기에 비례해야 한다.
// 이전 구현은 조각마다 Buffer 를 만들어 약 1.3 s·550 MB 였다. 측정은 입력 프레임을 만든 뒤의 증가분(heapUsed + external)이다.
function usedBytes() {
  if (global.gc) global.gc();
  const m = process.memoryUsage();
  return m.heapUsed + m.external;
}

test('F-208: 마스킹된 4 MiB 프레임을 1 B 조각으로 넣어도 2 s 미만, 메모리 증가 <= 프레임 + 8 MB', () => {
  const SIZE = 4 * 1024 * 1024;
  const payload = Buffer.alloc(SIZE);
  for (let i = 0; i < SIZE; i += 4093) payload[i] = (i >> 8) & 0xff;
  const frame = encodeFrame(OPCODES.BINARY, payload, { maskKey: KEY });
  const p = new FrameParser({ maxPayload: SIZE + 1024 });
  const before = usedBytes();
  let peak = before;
  const t0 = performance.now();
  const ev = [];
  for (let o = 0; o < frame.length; o++) {
    ev.push(...p.push(frame.subarray(o, o + 1)));
    if ((o & 0x3ff) === 0 && performance.now() - t0 > 2000) throw new Error(`2 s 초과(오프셋 ${o}/${frame.length})`);
    if ((o & 0xffff) === 0) peak = Math.max(peak, process.memoryUsage().heapUsed + process.memoryUsage().external);
  }
  const ms = performance.now() - t0;
  const after = process.memoryUsage();
  peak = Math.max(peak, after.heapUsed + after.external);
  const growth = peak - before;
  console.log(`# 1 B chunks: ${ms.toFixed(0)} ms, growth ${(growth / 1048576).toFixed(1)} MiB`);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'message');
  assert.ok(Buffer.from(ev[0].data).equals(payload), '내용 보존');
  assert.ok(ms < 2000, `${ms} ms`);
  assert.ok(growth <= SIZE + 8 * 1048576, `growth ${growth}`);
});

test('큰 조각(>= 16384 B)도 복사되어 호출자 버퍼를 나중에 바꿔도 결과가 변하지 않는다', () => {
  for (const size of [16384, 20000, 70000]) {
    const body = Buffer.alloc(size);
    for (let i = 0; i < size; i++) body[i] = (i * 7 + 3) & 0xff;
    const w = Buffer.from(encodeFrame(OPCODES.BINARY, body, { maskKey: KEY }));
    const cut = Math.max(16384, w.length - 100); // 첫 조각이 문턱 이상, 나머지는 작은 조각
    const p = new FrameParser({ maxPayload: size });
    assert.deepEqual(p.push(w.subarray(0, cut)), [], `size ${size}`);
    w.fill(0xee, 0, cut); // 첫 조각의 원 버퍼를 덮어쓴다
    const ev = p.push(w.subarray(cut));
    assert.equal(ev[0].type, 'message', `size ${size}`);
    assert.ok(Buffer.from(ev[0].data).equals(body), `size ${size}: 원 버퍼 별칭`);
  }
  // 한 번에 통째로 넣고 이벤트를 받은 뒤 입력을 바꿔도 data 는 그대로여야 한다
  const body = Buffer.alloc(30000, 9);
  const w = Buffer.from(encodeFrame(OPCODES.BINARY, body, { maskKey: KEY }));
  const ev = new FrameParser({ maxPayload: 30000 }).push(w);
  w.fill(0);
  assert.ok(Buffer.from(ev[0].data).equals(body));
});

test('F-208: 1400 B 조각도 빠르고 내용이 보존된다', () => {
  const SIZE = 4 * 1024 * 1024;
  const payload = Buffer.alloc(SIZE, 0x5a);
  const frame = encodeFrame(OPCODES.BINARY, payload, { maskKey: KEY });
  const p = new FrameParser({ maxPayload: SIZE + 1024 });
  const ev = [];
  const ms = pushAll(p, frame, 1400, 500, ev);
  assert.equal(ev.length, 1);
  assert.ok(Buffer.from(ev[0].data).equals(payload));
  assert.ok(ms < 500, `${ms} ms`);
});
