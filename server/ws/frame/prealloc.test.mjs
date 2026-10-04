// 프레임 파서 꼬리 버퍼 선할당 상한 시험(F-214 ④). 큰 프레임 머리만 보내고 멈춘 연결이 프레임 크기만큼 메모리를 잡지 않아야 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameParser, encodeFrame, OPCODES } from './index.mjs';

const KEY = Uint8Array.of(9, 8, 7, 6);
const MIB = 1 << 20;
const FRAME = 4 * MIB;

test('F-218: 선언 길이 4,000,000 머리 14 B + 17,000 B 를 보낸 연결 50 개의 arrayBuffers 증가 <= 보낸 바이트의 4 배 + 1 MB', () => {
  const DECLARED = 4_000_000;
  const head = Buffer.alloc(14);
  head[0] = 0x82; head[1] = 0x80 | 127;
  head.writeBigUInt64BE(BigInt(DECLARED), 2);
  KEY.forEach((v, i) => { head[10 + i] = v; });
  const N = 50;
  const parsers = [];
  global.gc?.();
  const before = process.memoryUsage().arrayBuffers;
  let sent = 0;
  for (let i = 0; i < N; i++) {
    const p = new FrameParser({ maxPayload: FRAME });
    // 머리 + 16000 B 는 한 조각(16384 B 미만), 이어서 1000 B
    p.push(Buffer.concat([head, Buffer.alloc(16000, 3)]));
    p.push(Buffer.alloc(1000, 4));
    sent += 14 + 17000 - 1000 + 1000;
    parsers.push(p);
  }
  const grown = process.memoryUsage().arrayBuffers - before;
  assert.ok(grown <= 4 * sent + MIB, `증가 ${grown} B, 보낸 ${sent} B`);
  assert.equal(parsers.length, N);
});

test('F-218: 1 B 조각으로 4 MiB 프레임을 받는 동안 arrayBuffers 증가는 프레임 + 수 MB 이내', () => {
  const body = Buffer.alloc(FRAME, 1);
  const wire = encodeFrame(OPCODES.BINARY, body, { maskKey: KEY });
  global.gc?.();
  const before = process.memoryUsage().arrayBuffers;
  const p = new FrameParser({ maxPayload: FRAME });
  let n = 0;
  // 앞 200,000 B 는 1 B 조각, 나머지는 1400 B 조각
  for (let o = 0; o < 200_000; o++) n += p.push(wire.subarray(o, o + 1)).length;
  for (let o = 200_000; o < wire.length; o += 1400) n += p.push(wire.subarray(o, o + 1400)).length;
  assert.equal(n, 1);
  const grown = process.memoryUsage().arrayBuffers - before;
  assert.ok(grown <= 2 * FRAME + 4 * MIB, `증가 ${grown} B`); // 결과 4 MiB + 조립 중 조각 4 MiB 까지 허용
});

test('상한을 둬도 단계적으로 키워 4 MiB 프레임이 작은 조각 입력에서 온전히 조립된다', () => {
  const body = Buffer.alloc(FRAME);
  for (let i = 0; i < FRAME; i++) body[i] = (i * 13 + 5) & 0xff;
  const wire = encodeFrame(OPCODES.BINARY, body, { maskKey: KEY });
  const p = new FrameParser({ maxPayload: FRAME });
  const events = [];
  for (let o = 0; o < wire.length; o += 1000) events.push(...p.push(Buffer.from(wire.subarray(o, o + 1000))));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'message');
  assert.ok(Buffer.from(events[0].data).equals(body));
});
