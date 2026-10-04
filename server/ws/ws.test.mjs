// T11.3 웹소켓 서버 골격 시험. 클라이언트는 node:net 으로 만든 최소 구현(핸드셰이크 + 마스킹 프레임).
// 주소는 코드에 적지 않는다: 시스템이 알려 주는 내부(loopback) 인터페이스 주소를 listen 에 쓰고, 이후는 server.address() 만 쓴다. 포트는 0(임시 포트).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWsServer, loadConfig, acceptKey, DEFAULT_MAX_WRITE_BUFFER, DEFAULT_MAX_PINGS_PER_SECOND } from './index.mjs';
import { FrameParser, encodeFrame, encodeClosePayload, OPCODES, MAX_MESSAGE_BYTES } from './frame/index.mjs';
import { MAX_PAYLOAD_BYTES } from '../../contracts/proto/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const KEY = Buffer.from([1, 2, 3, 4]);
const NEXT_TIMEOUT_MS = 3000;

function loopbackHost() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.internal && a.family === 'IPv4') return a.address;
  }
  throw new Error('loopback 인터페이스 없음');
}

// 시험이 중간에 실패해도 서버·소켓이 남아 프로세스가 끝나지 않는 일이 없도록 모두 모아 두었다가 정리한다.
const openServers = new Set();
const openSockets = new Set();
afterEach(async () => {
  for (const s of openSockets) s.destroy();
  openSockets.clear();
  await Promise.all([...openServers].map((w) => w.close()));
  openServers.clear();
});
const track = (ws) => { openServers.add(ws); return ws; };

async function start(onConnection, extra = {}) {
  const ws = track(await createWsServer({ host: loopbackHost(), port: 0, onConnection, ...extra }));
  return ws;
}

/** 최소 클라이언트: 핸드셰이크 후 서버 프레임 이벤트를 모은다. */
function connect(ws, { wsKey = Buffer.from('0123456789abcdef').toString('base64') } = {}) {
  const { address, port } = ws.address();
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: address, port });
    openSockets.add(sock);
    const parser = new FrameParser({ requireMask: false });
    const events = [];
    const waiters = [];
    let head = Buffer.alloc(0);
    let upgraded = false;
    let ended = false;
    const pump = () => {
      for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i]()) waiters.splice(i, 1);
    };
    sock.on('data', (d) => {
      if (!upgraded) {
        head = Buffer.concat([head, d]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) return;
        const text = head.subarray(0, end).toString();
        upgraded = true;
        const rest = head.subarray(end + 4);
        if (!/^HTTP\/1\.1 101/.test(text)) return reject(new Error(text));
        assert.ok(text.includes(`Sec-WebSocket-Accept: ${acceptKey(wsKey)}`));
        events.push(...parser.push(rest));
        resolve(api);
        return;
      }
      events.push(...parser.push(d));
      pump();
    });
    sock.on('close', () => { ended = true; pump(); });
    sock.on('error', () => {});
    sock.write(`GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${wsKey}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    const api = {
      sock, events,
      sendRaw: (b) => sock.write(b),
      send: (op, payload, opts = {}) => sock.write(encodeFrame(op, payload, { maskKey: KEY, ...opts })),
      // 시한이 있다: 서버가 멈추면 시험이 멈추지 않고 거절로 실패한다.
      next: (ms = NEXT_TIMEOUT_MS) => new Promise((res, rej) => {
        let timer;
        const check = () => {
          if (events.length) { clearTimeout(timer); res(events.shift()); return true; }
          if (ended) { clearTimeout(timer); res(null); return true; }
          return false;
        };
        if (check()) return;
        timer = setTimeout(() => { const i = waiters.indexOf(check); if (i >= 0) waiters.splice(i, 1); rej(new Error(`next() 시간 초과 ${ms} ms`)); }, ms);
        waiters.push(check);
      }),
      // next() 처럼 시한이 있다: close 가 오지 않으면 60 초 매달리지 않고 거절로 실패한다.
      closed: (ms = NEXT_TIMEOUT_MS) => new Promise((res, rej) => {
        if (ended) return res();
        const t = setTimeout(() => { sock.off('close', onClose); rej(new Error(`closed() 시간 초과 ${ms} ms`)); }, ms);
        const onClose = () => { clearTimeout(t); res(); };
        sock.once('close', onClose);
      }),
    };
  });
}

async function waitFor(cond, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor 시간 초과');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function serverSide() {
  const conns = [];
  let notify;
  const first = new Promise((r) => { notify = r; });
  return { conns, first, onConnection: (c) => { conns.push(c); notify(c); } };
}

test('이진 메시지 왕복(작은·16비트 길이·64비트 길이 프레임)', async () => {
  const s = serverSide();
  const ws = await start((c) => { c.onMessage((m) => c.send(m)); s.onConnection(c); });
  const cl = await connect(ws);
  for (const n of [0, 5, 125, 126, 65535, 65536, 70000]) {
    const payload = Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) & 0xff);
    cl.send(OPCODES.BINARY, payload);
    const ev = await cl.next();
    assert.equal(ev.type, 'message');
    assert.deepEqual(Buffer.from(ev.data), Buffer.from(payload));
  }
  cl.sock.destroy();
  await ws.close();
});

test('서버 프레임 바이트 배치: FIN+이진, 마스크 없음, 길이 그대로', () => {
  const f = encodeFrame(OPCODES.BINARY, Uint8Array.of(9, 8, 7));
  assert.deepEqual([...f], [0x82, 3, 9, 8, 7]);
  const m = encodeFrame(OPCODES.BINARY, Uint8Array.of(1, 2), { maskKey: Uint8Array.of(0xff, 0, 0xff, 0) });
  assert.deepEqual([...m], [0x82, 0x82, 0xff, 0, 0xff, 0, 1 ^ 0xff, 2]);
});

test('분할 프레임 조립(사이에 ping 끼움)', async () => {
  const s = serverSide();
  const received = [];
  const ws = await start((c) => { c.onMessage((m) => { received.push(Buffer.from(m)); c.send(m); }); s.onConnection(c); });
  const cl = await connect(ws);
  cl.send(OPCODES.BINARY, Uint8Array.of(1, 2, 3), { fin: false });
  cl.send(OPCODES.PING, Uint8Array.of(42));
  cl.send(OPCODES.CONT, Uint8Array.of(4, 5), { fin: false });
  cl.send(OPCODES.CONT, Uint8Array.of(6), { fin: true });
  const pong = await cl.next();
  assert.equal(pong.type, 'pong');
  assert.deepEqual([...pong.data], [42]);
  const msg = await cl.next();
  assert.deepEqual([...msg.data], [1, 2, 3, 4, 5, 6]);
  assert.equal(received.length, 1);
  // 바이트 단위로 쪼개 들어와도 같다.
  const raw = encodeFrame(OPCODES.BINARY, Uint8Array.of(7, 7), { maskKey: KEY });
  for (const b of raw) { cl.sendRaw(Buffer.of(b)); await new Promise((r) => setImmediate(r)); }
  assert.deepEqual([...(await cl.next()).data], [7, 7]);
  cl.sock.destroy();
  await ws.close();
});

test('ping 은 같은 본문의 pong 으로 답한다', async () => {
  const s = serverSide();
  const ws = await start(s.onConnection);
  const cl = await connect(ws);
  const body = Uint8Array.from({ length: 125 }, (_, i) => i);
  cl.send(OPCODES.PING, body);
  const ev = await cl.next();
  assert.equal(ev.type, 'pong');
  assert.deepEqual(Buffer.from(ev.data), Buffer.from(body));
  cl.sock.destroy();
  await ws.close();
});

test('정상 종료: 클라이언트 close 1000 → 서버가 close 로 답하고 onClose', async () => {
  const s = serverSide();
  const closes = [];
  const ws = await start((c) => { c.onClose((r) => closes.push(r)); s.onConnection(c); });
  const cl = await connect(ws);
  cl.send(OPCODES.CLOSE, encodeClosePayload(1000, 'bye'));
  const ev = await cl.next();
  assert.equal(ev.type, 'close');
  assert.equal(ev.code, 1000);
  await cl.closed();
  await waitFor(() => closes.length === 1);
  assert.deepEqual(closes, [{ code: 1000, reason: 'bye' }]);
  await ws.close();
});

test('서버가 close() 하면 close 프레임을 보내고 클라이언트 응답 뒤 끝낸다', async () => {
  const s = serverSide();
  const closes = [];
  const ws = await start((c) => { c.onClose((r) => closes.push(r)); s.onConnection(c); });
  const cl = await connect(ws);
  const conn = await s.first;
  conn.close(1000, 'done');
  const ev = await cl.next();
  assert.deepEqual([ev.type, ev.code, ev.reason], ['close', 1000, 'done']);
  cl.send(OPCODES.CLOSE, encodeClosePayload(1000));
  await cl.closed();
  await waitFor(() => closes.length === 1);
  assert.equal(closes[0].code, 1000);
  await ws.close();
});

test('상한 초과 프레임은 close 1009', async () => {
  const s = serverSide();
  const closes = [];
  const ws = await start((c) => { c.onClose((r) => closes.push(r)); s.onConnection(c); });
  const cl = await connect(ws);
  // 상한은 contracts 값 + 여유. 상한 + 1 바이트 길이를 헤더로만 선언해도 본문 도착 전에 거부한다.
  assert.equal(MAX_MESSAGE_BYTES, MAX_PAYLOAD_BYTES + 1024);
  const over = MAX_MESSAGE_BYTES + 1;
  const head = Buffer.alloc(14);
  head[0] = 0x82; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(over), 2); KEY.copy(head, 10);
  cl.sendRaw(head);
  const ev = await cl.next();
  assert.equal(ev.type, 'close');
  assert.equal(ev.code, 1009);
  await cl.closed();
  await waitFor(() => closes.length === 1);
  assert.equal(closes[0].code, 1009);
  await ws.close();
});

test('분할 메시지 누적이 상한을 넘으면 1009, 상한 정확히는 통과', async () => {
  const s = serverSide();
  const lens = [];
  const ws = await start((c) => { c.onMessage((m) => lens.push(m.length)); s.onConnection(c); });
  const cl = await connect(ws);
  cl.send(OPCODES.BINARY, new Uint8Array(MAX_MESSAGE_BYTES));
  await waitFor(() => lens.length === 1);
  assert.deepEqual(lens, [4194304 + 1024]);
  cl.send(OPCODES.BINARY, new Uint8Array(MAX_MESSAGE_BYTES), { fin: false });
  cl.send(OPCODES.CONT, new Uint8Array(1));
  const ev = await cl.next();
  assert.equal(ev.code, 1009);
  await cl.closed();
  await ws.close();
});

test('마스크 없는 클라이언트 프레임은 close 1002', async () => {
  const s = serverSide();
  const ws = await start(s.onConnection);
  const cl = await connect(ws);
  cl.sendRaw(encodeFrame(OPCODES.BINARY, Uint8Array.of(1, 2, 3))); // maskKey 없음
  const ev = await cl.next();
  assert.equal(ev.type, 'close');
  assert.equal(ev.code, 1002);
  await cl.closed();
  await ws.close();
});

test('규약 위반: RSV 비트·알 수 없는 opcode·분할된 제어 프레임·시작 없는 연속은 1002, 텍스트는 1003', () => {
  const run = (bytes) => new FrameParser().push(Buffer.from(bytes));
  const m = [0, 0, 0, 0];
  assert.equal(run([0xc2, 0x80, ...m])[0].code, 1002); // RSV1
  assert.equal(run([0x83, 0x80, ...m])[0].code, 1002); // opcode 3
  assert.equal(run([0x09, 0x80, ...m])[0].code, 1002); // FIN 없는 ping
  assert.equal(run([0x80, 0x80, ...m])[0].code, 1002); // 시작 없는 연속
  assert.equal(run([0x88, 0x81, ...m, 0x01])[0].code, 1002); // close 본문 1바이트
  assert.equal(run([0x88, 0x82, ...m, 0x03, 0xed])[0].code, 1002); // close 코드 1005 는 선로 금지
  assert.equal(run([0x81, 0x80, ...m])[0].code, 1003); // 텍스트
  const p = new FrameParser();
  assert.equal(p.push(Buffer.from([0x80, 0x80, ...m]))[0].type, 'error');
  assert.deepEqual(p.push(encodeFrame(OPCODES.BINARY, Uint8Array.of(1), { maskKey: KEY })), []); // 오류 뒤 입력 무시
});

test('핸드셰이크 오류는 400, 일반 요청은 426', async () => {
  const ws = await start(() => {});
  await assert.rejects(connect(ws, { wsKey: 'AAAA' }), /400/);
  // 일반 HTTP 요청은 상태 코드 426 과 Upgrade 머리말로 답한다(200 등으로 바뀌면 실패).
  const { address, port } = ws.address();
  const res = await new Promise((resolve, reject) => {
    http.get({ host: address, port, path: '/' }, (r) => { r.resume(); r.on('end', () => resolve(r)); }).on('error', reject);
  });
  assert.equal(res.statusCode, 426);
  assert.equal(res.headers.upgrade, 'websocket');
  await ws.close();
});

test('onMessage 가 던지면 그 연결만 1011 로 닫히고 uncaughtException 0, 다른 연결은 왕복 계속', async () => {
  const uncaught = [];
  const onUncaught = (e) => uncaught.push(e);
  process.on('uncaughtException', onUncaught);
  try {
    const errors = [];
    const closes = [];
    let n = 0;
    const ws = track(await createWsServer({
      host: loopbackHost(), port: 0,
      onError: (err, where) => errors.push([err.message, where]),
      onConnection: (c) => {
        const id = n++;
        c.onClose((r) => closes.push([id, r.code]));
        c.onMessage((m) => {
          if (m[0] === 0xee) throw new Error('boom');
          c.send(m);
        });
      },
    }));
    const bad = await connect(ws);
    const good = await connect(ws);
    bad.send(OPCODES.BINARY, Uint8Array.of(0xee));
    const ev = await bad.next();
    assert.equal(ev.type, 'close');
    assert.equal(ev.code, 1011);
    bad.send(OPCODES.CLOSE, encodeClosePayload(1011));
    await bad.closed();
    // 다른 연결은 계속 왕복한다.
    for (const b of [1, 2, 3]) {
      good.send(OPCODES.BINARY, Uint8Array.of(b));
      const echo = await good.next();
      assert.equal(echo.type, 'message');
      assert.deepEqual([...echo.data], [b]);
    }
    await waitFor(() => closes.length === 1);
    assert.deepEqual(errors, [['boom', 'onMessage']]);
    assert.equal(closes[0][0], 0);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(uncaught, []);
    good.sock.destroy();
    await ws.close();
  } finally {
    process.off('uncaughtException', onUncaught);
  }
});

test('onClose 가 던져도 uncaughtException 없이 onError 로 보고된다', async () => {
  const uncaught = [];
  const onUncaught = (e) => uncaught.push(e);
  process.on('uncaughtException', onUncaught);
  try {
    const errors = [];
    const ws = track(await createWsServer({
      host: loopbackHost(), port: 0,
      onError: (err, where) => errors.push([err.message, where]),
      onConnection: (c) => c.onClose(() => { throw new Error('closeboom'); }),
    }));
    const cl = await connect(ws);
    cl.send(OPCODES.CLOSE, encodeClosePayload(1000));
    await cl.closed();
    await waitFor(() => errors.length === 1);
    assert.deepEqual(errors, [['closeboom', 'onClose']]);
    assert.deepEqual(uncaught, []);
    await ws.close();
  } finally {
    process.off('uncaughtException', onUncaught);
  }
});

/** 동작 중 uncaughtException 을 모으는 틀. */
async function withUncaught(fn) {
  const uncaught = [];
  const onUncaught = (e) => uncaught.push(e);
  process.on('uncaughtException', onUncaught);
  try { await fn(uncaught); } finally { process.off('uncaughtException', onUncaught); }
}

test('async onMessage 가 거절되면 그 연결만 1011, onError where=onMessage, uncaught 0, 다른 연결 유지', () => withUncaught(async (uncaught) => {
  const errors = [];
  const closes = [];
  let n = 0;
  const ws = await start((c) => {
    const id = n++;
    c.onClose((r) => closes.push([id, r.code]));
    c.onMessage(async (m) => {
      await new Promise((r) => setImmediate(r));
      if (m[0] === 0xee) throw new Error('asyncboom');
      c.send(m);
    });
  }, { onError: (err, where) => errors.push([err.message, where]) });
  const bad = await connect(ws);
  const good = await connect(ws);
  bad.send(OPCODES.BINARY, Uint8Array.of(0xee));
  const ev = await bad.next();
  assert.deepEqual([ev.type, ev.code], ['close', 1011]);
  bad.send(OPCODES.CLOSE, encodeClosePayload(1011));
  await bad.closed();
  for (const b of [1, 2, 3]) {
    good.send(OPCODES.BINARY, Uint8Array.of(b));
    const echo = await good.next();
    assert.deepEqual([echo.type, [...echo.data]], ['message', [b]]);
  }
  await waitFor(() => closes.length === 1);
  assert.deepEqual(errors, [['asyncboom', 'onMessage']]);
  assert.deepEqual(closes, [[0, 1011]]);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(uncaught, []);
  good.sock.destroy();
  await ws.close();
}));

test('onConnection 이 던지면 그 소켓만 닫히고 onError where=onConnection, uncaught 0, 다른 연결 유지', () => withUncaught(async (uncaught) => {
  const errors = [];
  let n = 0;
  const ws = await start((c) => {
    if (n++ === 0) throw new Error('connboom');
    c.onMessage((m) => c.send(m));
  }, { onError: (err, where) => errors.push([err.message, where]) });
  const bad = await connect(ws);
  await bad.closed();
  assert.deepEqual(errors, [['connboom', 'onConnection']]);
  const good = await connect(ws);
  for (const b of [4, 5]) {
    good.send(OPCODES.BINARY, Uint8Array.of(b));
    const echo = await good.next();
    assert.deepEqual([...echo.data], [b]);
  }
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(uncaught, []);
  assert.equal(errors.length, 1);
  good.sock.destroy();
  await ws.close();
}));

test('읽지 않는 클라이언트에 ping 을 쏟아도 서버 writableLength 는 상한 이하이고 연결은 1008 로 닫힌다', async () => {
  const CAP = 64 * 1024;
  const PINGS = 1_000_000; // 125 B 본문 ping 100 만 건(약 131 MB 송신)
  const s = serverSide();
  const closes = [];
  const ws = await start((c) => { c.onClose((r) => closes.push(r)); s.onConnection(c); }, { maxWriteBuffer: CAP, maxPingsPerSecond: Number.MAX_SAFE_INTEGER });
  const cl = await connect(ws);
  cl.sock.pause(); // 읽지 않는다
  const conn = await s.first;
  let max = 0;
  const sample = setInterval(() => { max = Math.max(max, conn.bufferedAmount()); }, 1);
  const batch = Buffer.concat(Array.from({ length: 1000 }, () => encodeFrame(OPCODES.PING, new Uint8Array(125), { maskKey: KEY })));
  try {
    const deadline = Date.now() + 8000; // 서버가 닫지 않으면 시험이 멈추지 않고 아래 단언으로 실패한다
    for (let i = 0; i < PINGS / 1000 && !cl.sock.destroyed && Date.now() < deadline; i++) {
      if (!cl.sock.write(batch)) {
        await new Promise((r) => {
          const done = () => { clearTimeout(t); cl.sock.off('drain', done); cl.sock.off('close', done); r(); };
          const t = setTimeout(done, 1000);
          cl.sock.on('drain', done); cl.sock.on('close', done);
        });
      }
    }
    await waitFor(() => closes.length === 1, 3000);
  } finally {
    clearInterval(sample);
  }
  max = Math.max(max, conn.bufferedAmount());
  assert.equal(closes[0].code, 1008);
  assert.ok(max > 0, '실제로 쌓인 적이 있어야 시험이 의미 있다');
  assert.ok(max <= CAP, `writableLength ${max} > ${CAP}`);
  cl.sock.destroy();
  await ws.close();
});

test('ping 속도 제한: 한도까지는 모두 pong, 넘으면 1008', async () => {
  const closes = [];
  const ws = await start((c) => c.onClose((r) => closes.push(r)), { maxPingsPerSecond: 10 });
  const cl = await connect(ws);
  for (let i = 0; i < 10; i++) cl.send(OPCODES.PING, Uint8Array.of(i));
  for (let i = 0; i < 10; i++) {
    const ev = await cl.next();
    assert.deepEqual([ev.type, [...ev.data]], ['pong', [i]]);
  }
  cl.send(OPCODES.PING, Uint8Array.of(99)); // 11 번째
  const ev = await cl.next();
  assert.deepEqual([ev.type, ev.code], ['close', 1008]);
  cl.send(OPCODES.CLOSE, encodeClosePayload(1008));
  await cl.closed();
  await waitFor(() => closes.length === 1);
  assert.equal(closes[0].code, 1008);
  await ws.close();
});

test('클라이언트 close 에 대한 서버 close 에코가 클라이언트에 도달한다', async () => {
  const ws = await start(() => {});
  for (let i = 0; i < 20; i++) {
    const cl = await connect(ws);
    cl.send(OPCODES.CLOSE, encodeClosePayload(1000, 'x'));
    const ev = await cl.next();
    assert.deepEqual([ev?.type, ev?.code], ['close', 1000]);
    await cl.closed();
  }
  await ws.close();
});

test('RFC 6455 의 Accept 값 예시', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('bufferedAmount 는 쌓인 바이트를 돌려준다(읽지 않는 클라이언트)', async () => {
  const s = serverSide();
  const ws = await start(s.onConnection);
  const cl = await connect(ws);
  cl.sock.pause();
  const conn = await s.first;
  assert.equal(conn.bufferedAmount(), 0);
  const chunk = new Uint8Array(1 << 20);
  for (let i = 0; i < 64; i++) conn.send(chunk);
  assert.ok(conn.bufferedAmount() > 0);
  cl.sock.destroy();
  await ws.close();
});

test('loadConfig: 두 환경 변수가 없으면 오류, 있으면 값 그대로', () => {
  assert.throws(() => loadConfig({}), /SKYLENS_WS_HOST/);
  assert.throws(() => loadConfig({ SKYLENS_WS_HOST: 'h' }), /SKYLENS_WS_PORT/);
  assert.throws(() => loadConfig({ SKYLENS_WS_HOST: 'h', SKYLENS_WS_PORT: 'x' }), /정수/);
  assert.deepEqual(loadConfig({ SKYLENS_WS_HOST: 'h', SKYLENS_WS_PORT: '0' }), { host: 'h', port: 0 });
});

test('저장소 grep: server/·tools/ 아래 소스에 주소·포트 리터럴 0', () => {
  const root = path.resolve(here, '..', '..');
  // 제외(유일): 점으로 구분한 청크 키 문자열이 IPv4 패턴과 겹치는 오탐. 주소가 아니며 다른 담당 파일이라 여기서 고치지 않고 제외만 한다.
  const excluded = new Set([path.join(root, 'server', 'asset', 'ids', 'ids.test.mjs')]);
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (excluded.has(p)) continue;
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (e.name.endsWith('.mjs')) files.push(p);
    }
  };
  walk(path.join(root, 'server'));
  walk(path.join(root, 'tools'));
  assert.ok(files.length >= 20);
  assert.ok(files.some((f) => f.includes(`${path.sep}tools${path.sep}`)));
  const patterns = [
    /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, // IPv4 리터럴
    new RegExp(['local', 'host'].join(''), 'i'),
    new RegExp(['\\[', ':', ':|:', ':1\\b'].join('')), // IPv6 리터럴
    /\bport\s*[:=]\s*[1-9]\d*/i, // 숫자 포트 대입
    /:\d{2,5}\b(?!\w)(?=['"`/])/, // "주소:포트" 문자열
  ];
  const hits = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((ln, i) => { for (const re of patterns) if (re.test(ln)) hits.push(`${path.relative(root, f)}:${i + 1}: ${ln.trim()}`); });
  }
  assert.deepEqual(hits, []);
});

// ---- F-206 / F-200 / F-207 ----
const MIB = 1 << 20;

/** 주입 시계. set(t) 로 임의 값(되감기 포함)으로 옮긴다. */
function fakeClock(t = 1_000_000) {
  const f = () => t;
  f.set = (v) => { t = v; };
  f.advance = (d) => { t += d; };
  return f;
}
const pingN = (cl, n) => { for (let i = 0; i < n; i++) cl.send(OPCODES.PING, Uint8Array.of(i & 0xff)); };
const expectPongs = async (cl, n) => {
  for (let i = 0; i < n; i++) {
    const ev = await cl.next();
    assert.deepEqual([ev.type, [...ev.data]], ['pong', [i & 0xff]]);
  }
};

test('기본값: 쓰기 버퍼 1 MiB, ping 초당 50', () => {
  assert.equal(DEFAULT_MAX_WRITE_BUFFER, 1048576);
  assert.equal(DEFAULT_MAX_PINGS_PER_SECOND, 50);
});

test('옵션 없이 만든 서버: 50 번째 ping 까지 pong, 51 번째는 1008', async () => {
  const closes = [];
  const ws = await start((c) => c.onClose((r) => closes.push(r))); // 옵션 없음(기본 한도, 실제 시계)
  const cl = await connect(ws);
  pingN(cl, 50);
  await expectPongs(cl, 50);
  cl.send(OPCODES.PING, Uint8Array.of(51));
  const ev = await cl.next();
  assert.deepEqual([ev.type, ev.code], ['close', 1008]);
  cl.send(OPCODES.CLOSE, encodeClosePayload(1008));
  await cl.closed();
  await waitFor(() => closes.length === 1);
  assert.equal(closes[0].code, 1008);
  await ws.close();
});

test('2 MiB send 로 버퍼가 찬 상태에서 ping 1 건: 연결 유지, pong 도착', async () => {
  const CAP = 64 * 1024;
  const s = serverSide();
  const closes = [];
  const ws = await start((c) => { c.onClose((r) => closes.push(r)); s.onConnection(c); }, { maxWriteBuffer: CAP });
  const cl = await connect(ws);
  cl.sock.pause();
  const conn = await s.first;
  const payload = new Uint8Array(2 * MIB).fill(7);
  // 커널 소켓 버퍼가 일부를 흡수하므로, 2 MiB 묶음을 서버 쪽 대기 바이트가 상한을 넘을 때까지 보낸다.
  let sent = 0;
  while (conn.bufferedAmount() <= CAP && sent < 8) { conn.send(payload); sent++; }
  assert.ok(conn.bufferedAmount() > CAP, `send 데이터가 상한(${CAP})보다 쌓여 있어야 시험이 의미 있다: ${conn.bufferedAmount()}`);
  cl.send(OPCODES.PING, Uint8Array.of(1));
  await new Promise((r) => setTimeout(r, 100));
  cl.sock.resume();
  let msgs = 0;
  let ev;
  do {
    ev = await cl.next(5000);
    if (ev.type === 'message') { assert.equal(ev.data.length, 2 * MIB); msgs++; }
  } while (ev.type === 'message');
  assert.deepEqual([ev.type, [...ev.data]], ['pong', [1]]);
  assert.equal(msgs, sent);
  assert.deepEqual(closes, []);
  cl.sock.destroy();
  await ws.close();
});

test('옵션 검증: maxWriteBuffer·maxPingsPerSecond 의 NaN/0/200 등은 RangeError', async () => {
  const base = { host: loopbackHost(), port: 0, onConnection: () => {} };
  for (const v of [NaN, 0, 200, 256, -1, 1.5, Infinity, '1024']) {
    assert.throws(() => createWsServer({ ...base, maxWriteBuffer: v }), RangeError, `maxWriteBuffer ${String(v)}`);
  }
  for (const v of [NaN, 0, -3, 0.5, Infinity, '5', null]) {
    assert.throws(() => createWsServer({ ...base, maxPingsPerSecond: v }), RangeError, `maxPingsPerSecond ${String(v)}`);
  }
  for (const v of [NaN, 0, Infinity]) {
    assert.throws(() => createWsServer({ ...base, maxSendBuffer: v }), RangeError);
    assert.throws(() => createWsServer({ ...base, maxPendingMessages: v }), RangeError);
  }
  // 경계: 257 과 1 은 허용
  const ok = track(await createWsServer({ ...base, maxWriteBuffer: 257, maxPingsPerSecond: 1 }));
  await ok.close();
});

test('주입 시계: 창 안 N+1 번째 ping 은 1008, 창이 지난 뒤에는 N 건 모두 pong', async () => {
  const N = 5;
  const clock = fakeClock();
  const closes = [];
  const ws = await start((c) => c.onClose((r) => closes.push(r)), { maxPingsPerSecond: N, now: clock });
  const cl = await connect(ws);
  pingN(cl, N);
  await expectPongs(cl, N);
  clock.advance(999); // 아직 창 안
  cl.send(OPCODES.PING, Uint8Array.of(0));
  const ev = await cl.next();
  assert.deepEqual([ev.type, ev.code], ['close', 1008]);
  await cl.closed();
  assert.equal(closes[0].code, 1008);

  const cl2 = await connect(ws);
  pingN(cl2, N);
  await expectPongs(cl2, N);
  clock.advance(1000); // 창이 지남
  pingN(cl2, N);
  await expectPongs(cl2, N);
  clock.advance(1000);
  pingN(cl2, N);
  await expectPongs(cl2, N);
  cl2.sock.destroy();
  await ws.close();
});

test('시계가 되감겨도 오탐 1008 이 없다', async () => {
  const N = 3;
  const clock = fakeClock(5_000_000);
  const closes = [];
  const ws = await start((c) => c.onClose((r) => closes.push(r)), { maxPingsPerSecond: N, now: clock });
  const cl = await connect(ws);
  pingN(cl, N);
  await expectPongs(cl, N);
  clock.set(1_000); // 한참 되감김
  pingN(cl, N);
  await expectPongs(cl, N);
  clock.advance(-1);
  pingN(cl, N);
  await expectPongs(cl, N);
  assert.deepEqual(closes, []);
  cl.sock.destroy();
  await ws.close();
});

test('send 상한: 넘기는 프레임은 쓰지 않고 false, 연결은 1008 로 닫힌다', async () => {
  const s = serverSide();
  const closes = [];
  const ws = await start((c) => { c.onClose((r) => closes.push(r)); s.onConnection(c); }, { maxSendBuffer: MIB });
  const cl = await connect(ws);
  cl.sock.pause();
  const conn = await s.first;
  const chunk = new Uint8Array(256 * 1024);
  let refused = false;
  for (let i = 0; i < 400 && !refused; i++) {
    conn.send(chunk);
    refused = conn.send(new Uint8Array(MIB)) === false; // 1 MiB 프레임 + 쌓인 양이 상한을 넘는다
  }
  assert.ok(refused, 'send 가 상한에서 false 를 돌려줘야 한다');
  assert.ok(conn.bufferedAmount() <= MIB + 1024, `bufferedAmount ${conn.bufferedAmount()}`);
  assert.equal(conn.send(chunk), false); // 닫는 중
  cl.sock.resume();
  let ev;
  do { ev = await cl.next(5000); } while (ev && ev.type !== 'close');
  assert.equal(ev.code, 1008);
  cl.send(OPCODES.CLOSE, encodeClosePayload(1008));
  await cl.closed();
  await waitFor(() => closes.length === 1);
  assert.equal(closes[0].code, 1008);
  await ws.close();
});

test('async onMessage 처리 중 상한: 넘는 메시지는 읽기를 멈추고 끝나는 대로 순서대로 처리한다', async () => {
  const CAP = 2;
  const started = [];
  const gates = [];
  let inflight = 0;
  let maxInflight = 0;
  const ws = await start((c) => {
    c.onMessage((m) => {
      started.push(m[0]);
      inflight++; maxInflight = Math.max(maxInflight, inflight);
      return new Promise((r) => gates.push(() => { inflight--; r(); }));
    });
  }, { maxPendingMessages: CAP });
  const cl = await connect(ws);
  for (let i = 0; i < 6; i++) cl.send(OPCODES.BINARY, Uint8Array.of(i));
  await waitFor(() => started.length === CAP);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(started, [0, 1]); // 3 번째부터는 아직 호출되지 않는다
  for (let done = 0; done < 6; done++) {
    await waitFor(() => gates.length > done);
    gates[done]();
  }
  await waitFor(() => started.length === 6);
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
  assert.ok(maxInflight <= CAP, `동시 처리 ${maxInflight} > ${CAP}`);
  cl.sock.destroy();
  await ws.close();
});

test('onConnection catch 의 socket.destroy: 빠지면 hang 이 아니라 시한 안에 실패한다', async () => {
  const ws = await start(() => { throw new Error('connboom2'); }, { onError: () => {} });
  const cl = await connect(ws);
  await cl.closed(3000); // destroy 가 없으면 3 s 뒤 거절
  // closed() 가 시한을 지키는지 확인: 닫히지 않는 연결에서는 거절된다.
  const ws2 = await start(() => {});
  const cl2 = await connect(ws2);
  await assert.rejects(cl2.closed(200), /시간 초과/);
  cl2.sock.destroy();
  await ws.close();
  await ws2.close();
});

test('핸드셰이크 거절 직후 RST 20 회: uncaughtException 0, 이후 정상 접속', () => withUncaught(async (uncaught) => {
  const ws = await start(() => {}, { onError: () => {} });
  const { address, port } = ws.address();
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => {
      const sock = net.connect({ host: address, port });
      openSockets.add(sock);
      sock.on('error', () => {});
      sock.on('close', resolve);
      sock.on('connect', () => {
        sock.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: AAAA\r\nSec-WebSocket-Version: 12\r\n\r\n');
        sock.resetAndDestroy();
      });
    });
  }
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(uncaught, []);
  const cl = await connect(ws);
  cl.sock.destroy();
  await ws.close();
}));

test('close 프레임 없이 FIN: onClose 정확히 한 번, 코드 1006, 2 초 안', async () => {
  const closes = [];
  const ws = await start((c) => c.onClose((r) => closes.push(r)));
  const cl = await connect(ws);
  cl.sock.end();
  const end = Date.now() + 2000;
  while (closes.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(closes.length, 1);
  assert.equal(closes[0].code, 1006);
  await ws.close();
});
