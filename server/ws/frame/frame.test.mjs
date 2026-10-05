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

// push 중 복사된 바이트 수(copy, TypedArray.set, Buffer.concat, Buffer.from(typed array))와 새로 할당한 Buffer 바이트 수를 센다.
// 벽시계와 달리 CPU 부하에 영향받지 않는다. 할당 총량은 JS 바이트 루프로 복사하는 이차 구현(복사 계수에 안 잡힘)을 잡는다:
// 그런 구현도 조각마다 더 큰 버퍼를 새로 잡아야 하므로 할당 총량이 이차로 는다.
// 한계: 시험 시작 전에 모듈 범위에서 잡아 둔 원본 함수·생성자(예: const A = Uint8Array)와 slice/subarray 는 셀 수 없다.
// 그래서 계수 단언에 더해 process.cpuUsage() 상한(cpuMs)을 둔다. CPU 시간은 다른 프로세스 부하에 거의 영향받지 않는다.
function countCopiedBytes(fn) {
  const c = { copied: 0, allocated: 0 };
  const origCopy = Buffer.prototype.copy;
  const origSet = Uint8Array.prototype.set;
  const origConcat = Buffer.concat;
  const origFrom = Buffer.from;
  const OrigU8 = globalThis.Uint8Array;
  const origAlloc = { alloc: Buffer.alloc, allocUnsafe: Buffer.allocUnsafe, allocUnsafeSlow: Buffer.allocUnsafeSlow };
  Buffer.prototype.copy = function (target, ts, ss = 0, se = this.length) {
    const r = origCopy.call(this, target, ts, ss, se);
    c.copied += r;
    return r;
  };
  Uint8Array.prototype.set = function (src, off) {
    c.copied += src.length;
    return origSet.call(this, src, off);
  };
  Buffer.concat = function (list, total) {
    const r = origConcat.call(Buffer, list, total);
    c.copied += r.length;
    return r;
  };
  Buffer.from = function (v, ...rest) {
    const r = origFrom.call(Buffer, v, ...rest);
    if (ArrayBuffer.isView(v)) c.copied += r.length;
    return r;
  };
  for (const k of Object.keys(origAlloc)) {
    Buffer[k] = function (n, ...rest) {
      c.allocated += n;
      return origAlloc[k].call(Buffer, n, ...rest);
    };
  }
  // new Uint8Array(n) / new Uint8Array(배열) 도 할당으로 센다(JS 루프 이차 복사가 이 경로를 쓴다). Buffer 내부 할당은 전역을 거치지 않는다.
  globalThis.Uint8Array = new Proxy(OrigU8, {
    construct(target, args, newTarget) {
      const a = args[0];
      if (typeof a === 'number') c.allocated += a;
      else if (a != null && typeof a.length === 'number') c.allocated += a.length;
      return Reflect.construct(target, args, newTarget);
    },
  });
  try {
    fn(c);
  } finally {
    globalThis.Uint8Array = OrigU8;
    Buffer.prototype.copy = origCopy;
    Uint8Array.prototype.set = origSet;
    Buffer.concat = origConcat;
    Buffer.from = origFrom;
    Object.assign(Buffer, origAlloc);
  }
  return c;
}

// 현재 프로세스의 CPU 시간(user+system, ms). 벽시계와 달리 다른 프로세스 부하로 늘지 않는다.
const cpuNow = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };

test('1400 B 조각 push 복사량은 프레임 크기에 선형이고(4 배 크기 -> 복사량비 < 6) 내용이 보존된다', () => {
  // 시간 대신 복사된 바이트 수로 판정한다. 선형이면 비율 약 4, 조각마다 전체를 복사하는 이차 구현이면 약 16 이상.
  const small = maskedWire(1024 * 1024, (i) => (i * 31 + 7) & 0xff);
  const big = maskedWire(4 * 1024 * 1024, (i) => (i * 31 + 7) & 0xff);
  const measure = ({ wire, body }) => {
    const events = [];
    // 퇴행 구현이 시험 전체를 멈추지 않도록 시간 예산은 안전장치로만 둔다(판정에는 쓰지 않는다)
    // 벽시계 예산(5 s)은 안전장치일 뿐이다. 판정은 계수와 CPU 시간 상한(아래)이 한다.
    const cpu0 = cpuNow();
    const c = countCopiedBytes(() => {
      pushAll(new FrameParser({ maxPayload: body.length }), wire, 1400, 5000, events);
    });
    c.cpuMs = cpuNow() - cpu0;
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'message');
    assert.ok(Buffer.from(events[0].data).equals(body));
    return c;
  };
  const cSmall = measure(small);
  const cBig = measure(big);
  // 하한: 적어도 프레임 크기만큼은 복사돼야 한다. 계수가 0 이면 비율 단언이 항상 참이 되므로 계수기 고장을 여기서 잡는다.
  assert.ok(cSmall.copied >= small.body.length, `1 MiB 복사 ${cSmall.copied} B < 프레임 크기(계수기 고장?)`);
  assert.ok(cBig.copied >= big.body.length, `4 MiB 복사 ${cBig.copied} B < 프레임 크기(계수기 고장?)`);
  // CPU 상한: 정상 16-19 ms, 이차 변이 1.5 s 이상. 부하 아래서도 정상이 통과하도록 여유를 크게 둔다.
  assert.ok(cBig.cpuMs < 400, `4 MiB CPU ${cBig.cpuMs.toFixed(0)} ms (정상 약 20 ms)`);
  assert.ok(cSmall.cpuMs < 400, `1 MiB CPU ${cSmall.cpuMs.toFixed(0)} ms (정상 약 20 ms)`);
  const ratio = cBig.copied / Math.max(cSmall.copied, 1);
  const aRatio = cBig.allocated / Math.max(cSmall.allocated, 1);
  console.log(`# 1400 B chunks: 1 MiB copied ${cSmall.copied} B alloc ${cSmall.allocated} B, 4 MiB copied ${cBig.copied} B alloc ${cBig.allocated} B, ratio ${ratio.toFixed(2)}/${aRatio.toFixed(2)}, cpu ${cSmall.cpuMs.toFixed(0)}/${cBig.cpuMs.toFixed(0)} ms`);
  assert.ok(ratio < 6, `복사량비 ${ratio.toFixed(2)} (선형 ~4, 이차 ~16)`);
  assert.ok(aRatio < 6, `할당량비 ${aRatio.toFixed(2)} (선형 ~4, 이차 ~16)`);
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

test('F-208: 마스킹된 4 MiB 프레임을 1 B 조각으로 넣어도 복사량 <= 3 x 프레임 + 1 MiB, 메모리 증가 <= 프레임 + 8 MB', () => {
  // 시간 단정 대신 복사·할당 바이트 수로 판정한다(부하에 영향받지 않음). 선형이면 복사는 take 한 번(= SIZE) 안팎이다.
  const SIZE = 4 * 1024 * 1024;
  const payload = Buffer.alloc(SIZE);
  for (let i = 0; i < SIZE; i += 4093) payload[i] = (i >> 8) & 0xff;
  const frame = encodeFrame(OPCODES.BINARY, payload, { maskKey: KEY });
  const p = new FrameParser({ maxPayload: SIZE + 1024 });
  const before = usedBytes();
  let peak = before;
  const t0 = performance.now();
  const ev = [];
  const LIMIT = 3 * SIZE + 1048576;
  const c = countCopiedBytes((live) => {
    for (let o = 0; o < frame.length; o++) {
      ev.push(...p.push(frame.subarray(o, o + 1)));
      // 시간은 판정이 아니라 안전장치다. 이차 구현은 계수가 한도를 넘는 즉시 여기서 실패한다(30 s 를 기다리지 않는다).
      if ((o & 0xff) === 0 && (live.copied > LIMIT || live.allocated > LIMIT)) {
        throw new Error(`복사 ${live.copied} B / 할당 ${live.allocated} B 가 한도 ${LIMIT} B 초과(오프셋 ${o}/${frame.length})`);
      }
      if ((o & 0x3ff) === 0 && performance.now() - t0 > 30000) throw new Error(`30 s 초과(오프셋 ${o}/${frame.length})`);
      if ((o & 0xffff) === 0) peak = Math.max(peak, process.memoryUsage().heapUsed + process.memoryUsage().external);
    }
  });
  const ms = performance.now() - t0;
  const after = process.memoryUsage();
  peak = Math.max(peak, after.heapUsed + after.external);
  const growth = peak - before;
  console.log(`# 1 B chunks: ${ms.toFixed(0)} ms, copied ${c.copied} B, alloc ${c.allocated} B, growth ${(growth / 1048576).toFixed(1)} MiB`);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'message');
  assert.ok(Buffer.from(ev[0].data).equals(payload), '내용 보존');
  assert.ok(c.copied >= SIZE, `복사 ${c.copied} B < 프레임 크기(계수기 고장?)`);
  assert.ok(c.copied <= 3 * SIZE + 1048576, `복사 ${c.copied} B`);
  assert.ok(c.allocated <= 3 * SIZE + 1048576, `할당 ${c.allocated} B`);
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

test('F-208: 1400 B 조각도 복사량 <= 3 x 프레임 + 1 MiB 이고 내용이 보존된다', () => {
  const SIZE = 4 * 1024 * 1024;
  const payload = Buffer.alloc(SIZE, 0x5a);
  const frame = encodeFrame(OPCODES.BINARY, payload, { maskKey: KEY });
  const p = new FrameParser({ maxPayload: SIZE + 1024 });
  const ev = [];
  // 시간은 판정에 쓰지 않고 안전장치(5 s)로만 둔다
  const cpu0 = cpuNow();
  const c = countCopiedBytes(() => { pushAll(p, frame, 1400, 5000, ev); });
  const cpuMs = cpuNow() - cpu0;
  console.log(`# 1400 B chunks 4 MiB: cpu ${cpuMs.toFixed(0)} ms, copied ${c.copied} B, alloc ${c.allocated} B`);
  assert.equal(ev.length, 1);
  assert.ok(Buffer.from(ev[0].data).equals(payload));
  assert.ok(c.copied >= SIZE, `복사 ${c.copied} B < 프레임 크기(계수기 고장?)`);
  assert.ok(cpuMs < 400, `CPU ${cpuMs.toFixed(0)} ms (정상 약 20 ms, 이차 변이 1.5 s 이상)`);
  assert.ok(c.copied <= 3 * SIZE + 1048576, `복사 ${c.copied} B`);
  assert.ok(c.allocated <= 3 * SIZE + 1048576, `할당 ${c.allocated} B`);
});
