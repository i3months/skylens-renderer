import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createWsServer } from '../../../server/ws/index.mjs';
import { checkEventLog } from '../run_all/event_log.mjs';
import { countOpenConnections, connectionViolations } from '../clients/index.mjs';
import { LEVEL_PAYLOAD_BYTES, SOCKET_HOST } from './contract.mjs';
import { createHash } from 'node:crypto';
import { encodeFrame, OPCODES } from '../../../server/ws/frame/index.mjs';
import { runSocketClients } from './clients.mjs';

const CLIENTS = 30;

function startServer(onConnection) {
  return createWsServer({ host: SOCKET_HOST, port: 0, onConnection });
}

function sendLevels(conn) {
  for (const n of LEVEL_PAYLOAD_BYTES) conn.send(new Uint8Array(n));
}

test('30 clients connect at once, record a valid log, and stay open until durationS', async () => {
  const srv = await startServer(sendLevels);
  try {
    const durationS = 1;
    const events = await runSocketClients({ host: SOCKET_HOST, port: srv.address().port, clients: CLIENTS, durationS });
    assert.deepEqual(checkEventLog(events, CLIENTS), []);
    assert.deepEqual(connectionViolations(events, CLIENTS), []);
    assert.equal(countOpenConnections(events).min, CLIENTS);
    for (let i = 1; i < events.length; i++) {
      const a = events[i - 1];
      const b = events[i];
      assert.ok(a.tMs < b.tMs || (a.tMs === b.tMs && a.id <= b.id), `order at ${i}`);
    }
    for (let id = 0; id < CLIENTS; id++) {
      const mine = events.filter((e) => e.id === id);
      const kinds = (k) => mine.filter((e) => e.kind === k);
      assert.equal(kinds('connect').length, 1);
      assert.equal(kinds('close').length, 1);
      assert.equal(mine[0].kind, 'connect');
      assert.equal(mine.at(-1).kind, 'close');
      assert.ok(kinds('close')[0].tMs >= durationS * 1000);
      assert.deepEqual(kinds('bytes').map((e) => e.bytes), [...LEVEL_PAYLOAD_BYTES]);
      for (const b of kinds('bytes')) assert.ok(b.latencyMs >= 0 && b.latencyMs <= b.tMs);
      assert.deepEqual(kinds('level').map((e) => e.level), [0, 1, 2, 3]);
      const ff = kinds('first_frame');
      assert.equal(ff.length, 1);
      assert.equal(ff[0].tMs, kinds('level')[0].tMs);
      assert.ok(mine.indexOf(ff[0]) > mine.indexOf(kinds('level')[0]));
    }
  } finally {
    await srv.close();
  }
});

test('injected clock: tMs is measured from one start reading', async () => {
  const srv = await startServer(sendLevels);
  try {
    let calls = 0;
    const base = 1e6;
    const now = () => { calls++; return base + performance.now(); };
    const events = await runSocketClients({ host: SOCKET_HOST, port: srv.address().port, clients: 2, durationS: 0.3, now });
    assert.ok(calls > 0);
    assert.deepEqual(checkEventLog(events, 2), []);
    assert.ok(events.every((e) => e.tMs < 5000));
  } finally {
    await srv.close();
  }
});

test('connection failures resolve with no connect events', async () => {
  const tmp = net.createServer();
  await new Promise((r) => tmp.listen(0, SOCKET_HOST, r));
  const freePort = tmp.address().port;
  await new Promise((r) => tmp.close(r));
  const events = await runSocketClients({ host: SOCKET_HOST, port: freePort, clients: 3, durationS: 0.2 });
  assert.deepEqual(events, []);
});

test('a handshake that never completes is bounded and emits nothing', async () => {
  const held = new Set();
  const silent = net.createServer((s) => { held.add(s); s.on('error', () => {}); s.on('close', () => held.delete(s)); });
  await new Promise((r) => silent.listen(0, SOCKET_HOST, r));
  try {
    const t0 = performance.now();
    const events = await runSocketClients({ host: SOCKET_HOST, port: silent.address().port, clients: 2, durationS: 0.2 });
    assert.deepEqual(events, []);
    assert.ok(performance.now() - t0 < 3000);
  } finally {
    for (const s of held) s.destroy();
    await new Promise((r) => silent.close(r));
  }
});

test('server close before durationS emits an early close and the run still resolves', async () => {
  const srv = await startServer((conn) => {
    conn.send(new Uint8Array(LEVEL_PAYLOAD_BYTES[0]));
    setTimeout(() => conn.close(1000, 'done'), 20);
  });
  try {
    const events = await runSocketClients({ host: SOCKET_HOST, port: srv.address().port, clients: 4, durationS: 1 });
    assert.deepEqual(checkEventLog(events, 4), []);
    assert.deepEqual(connectionViolations(events, 4), []);
    const closes = events.filter((e) => e.kind === 'close');
    assert.equal(closes.length, 4);
    for (const c of closes) assert.ok(c.tMs < 900);
    assert.equal(events.filter((e) => e.kind === 'level').length, 4);
  } finally {
    await srv.close();
  }
});

test('programmer errors reject', async () => {
  const ok = { host: SOCKET_HOST, port: 1, clients: 1, durationS: 1 };
  await assert.rejects(runSocketClients({ ...ok, clients: 0 }), RangeError);
  await assert.rejects(runSocketClients({ ...ok, durationS: 0 }), RangeError);
  await assert.rejects(runSocketClients({ ...ok, host: '' }), TypeError);
  await assert.rejects(runSocketClients({ ...ok, port: 70000 }), RangeError);
  await assert.rejects(runSocketClients({ ...ok, now: 5 }), TypeError);
});

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Raw server: valid handshake (optionally after delayMs, a number or a function of the accept index), then onOpen(socket). */
function rawServer({ delayMs = 0, onOpen = () => {} } = {}) {
  const sockets = new Set();
  let accepted = 0;
  const server = net.createServer((socket) => {
    const delay = typeof delayMs === 'function' ? delayMs(accepted++) : delayMs;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buf = Buffer.alloc(0);
    let done = false;
    socket.on('data', (chunk) => {
      if (done) return;
      buf = Buffer.concat([buf, chunk]);
      if (buf.indexOf('\r\n\r\n') < 0) return;
      done = true;
      const key = /sec-websocket-key:\s*(\S+)/i.exec(buf.toString('latin1'))[1];
      const accept = createHash('sha1').update(key + GUID).digest('base64');
      setTimeout(() => {
        if (socket.destroyed) return;
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        onOpen(socket);
      }, delay);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, SOCKET_HOST, () => resolve({
      port: server.address().port,
      close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
    }));
  });
}

test('level is recovered from the payload size, not arrival order; one first_frame at the first level', async () => {
  const srv = await startServer((conn) => {
    conn.send(new Uint8Array(LEVEL_PAYLOAD_BYTES[3]));
    setTimeout(() => conn.send(new Uint8Array(LEVEL_PAYLOAD_BYTES[1])), 20);
  });
  try {
    const events = await runSocketClients({ host: SOCKET_HOST, port: srv.address().port, clients: 1, durationS: 0.4 });
    const levels = events.filter((e) => e.kind === 'level');
    assert.deepEqual(levels.map((e) => e.level), [3, 1]);
    const ff = events.filter((e) => e.kind === 'first_frame');
    assert.equal(ff.length, 1);
    assert.equal(ff[0].tMs, levels[0].tMs);
    assert.ok(levels[1].tMs > levels[0].tMs);
  } finally {
    await srv.close();
  }
});

test('5 messages: exactly 4 level events (non-level size is bytes only) and 5 bytes events', async () => {
  const srv = await startServer((conn) => {
    for (const n of LEVEL_PAYLOAD_BYTES) conn.send(new Uint8Array(n));
    conn.send(new Uint8Array(100));
  });
  try {
    const events = await runSocketClients({ host: SOCKET_HOST, port: srv.address().port, clients: 2, durationS: 0.4 });
    for (let id = 0; id < 2; id++) {
      const mine = events.filter((e) => e.id === id);
      assert.equal(mine.filter((e) => e.kind === 'level').length, 4);
      assert.deepEqual(mine.filter((e) => e.kind === 'level').map((e) => e.level), [0, 1, 2, 3]);
      assert.equal(mine.filter((e) => e.kind === 'bytes').length, 5);
      assert.deepEqual(mine.filter((e) => e.kind === 'bytes').map((e) => e.bytes).sort((a, b) => a - b), [100, ...LEVEL_PAYLOAD_BYTES]);
      assert.equal(mine.filter((e) => e.kind === 'first_frame').length, 1);
    }
  } finally {
    await srv.close();
  }
});

test('a non-level first message yields bytes only and no first_frame', async () => {
  const srv = await startServer((conn) => { conn.send(new Uint8Array(100)); });
  try {
    const events = await runSocketClients({ host: SOCKET_HOST, port: srv.address().port, clients: 1, durationS: 0.3 });
    assert.equal(events.filter((e) => e.kind === 'bytes').length, 1);
    assert.equal(events.filter((e) => e.kind === 'level' || e.kind === 'first_frame').length, 0);
  } finally {
    await srv.close();
  }
});

test('latencyMs is measured from the attempt time; a first payload delayed 50 ms arrives after the attempt', async () => {
  const srv = await rawServer({
    onOpen(socket) {
      setTimeout(() => socket.write(encodeFrame(OPCODES.BINARY, new Uint8Array(LEVEL_PAYLOAD_BYTES[0]))), 50);
    },
  });
  try {
    // Deterministic clock that advances 1 ms on every call, so start, attempt and every later reading are all distinct.
    const readings = [];
    let tick = 0;
    const now = () => { tick += 1; readings.push(tick); return tick; };
    const events = await runSocketClients({ host: SOCKET_HOST, port: srv.port, clients: 1, durationS: 0.3, now });
    const [start, attempt] = readings; // start reading first, then the single client's attempt reading
    const bytes = events.filter((e) => e.kind === 'bytes');
    assert.equal(bytes.length, 1);
    assert.ok(attempt - start > 0, `attempt-start ${attempt - start}`); // a non-zero base, so the equality below is not circular
    assert.equal(bytes[0].latencyMs, bytes[0].tMs - (attempt - start));
    assert.ok(bytes[0].latencyMs < bytes[0].tMs);
    const connect = events.find((e) => e.kind === 'connect');
    assert.ok(connect.tMs >= attempt - start && connect.tMs <= bytes[0].tMs);
  } finally {
    await srv.close();
  }
});

test('two time bases: latencyMs runs from the connect attempt, the connect event tMs is handshake completion', async () => {
  const HANDSHAKE_MS = 40;
  const srv = await rawServer({
    delayMs: HANDSHAKE_MS,
    onOpen(socket) { socket.write(encodeFrame(OPCODES.BINARY, new Uint8Array(LEVEL_PAYLOAD_BYTES[0]))); },
  });
  try {
    const readings = [];
    // Real clock in integer ms (exact arithmetic) plus a constant +7 offset on every reading after the first, so attempt - start > 0
    // whatever the real clock rounds to (otherwise latencyMs = tMs, attempt base lost, would still satisfy the equality below).
    // The offset is constant, not per-call, so it cancels out of handshakeMs and does not inflate it with the poll count.
    let calls = 0;
    const now = () => { calls += 1; const v = Math.round(performance.now()) + (calls > 1 ? 7 : 0); readings.push(v); return v; };
    const events = await runSocketClients({ host: SOCKET_HOST, port: srv.port, clients: 1, durationS: 0.3, now });
    const [start, attempt] = readings;
    assert.ok(attempt - start > 0, `attempt-start ${attempt - start}`);
    const connect = events.find((e) => e.kind === 'connect');
    const bytes = events.find((e) => e.kind === 'bytes');
    // latencyMs = recv - attempt; bytes.tMs - connect.tMs = recv - connectedMs; the difference is connectedMs - attempt.
    const handshakeMs = bytes.latencyMs - (bytes.tMs - connect.tMs);
    assert.equal(handshakeMs, connect.tMs - (attempt - start));
    // The server holds the 101 for 40 ms of real time; the constant offset cancels, so the measurement is tight: 40 +/- 5
    // (timers may fire ~1 ms early, each integer rounding costs up to 1 ms, and a few ms of loopback / scheduler lateness).
    assert.ok(Math.abs(handshakeMs - HANDSHAKE_MS) <= 5, `handshake ${handshakeMs}`);
    assert.ok(bytes.latencyMs >= handshakeMs); // latency spans the handshake (equal when the payload shares the data event with the 101)
  } finally {
    await srv.close();
  }
});

test('a handshake that finishes after durationS adds no events', async () => {
  const srv = await rawServer({ delayMs: 350, onOpen(socket) { socket.write(encodeFrame(OPCODES.BINARY, new Uint8Array(LEVEL_PAYLOAD_BYTES[0]))); } });
  try {
    const events = await runSocketClients({ host: SOCKET_HOST, port: srv.port, clients: 2, durationS: 0.2 });
    assert.deepEqual(events, []);
  } finally {
    await srv.close();
  }
});

test('ties on tMs are ordered by id even when arrival order is reversed; closes land exactly at durationS', async () => {
  const CLIENTS_TIE = 4;
  // The k-th accepted connection waits (CLIENTS_TIE - 1 - k) * 15 ms, so handshakes finish roughly in reverse id order.
  const srv = await rawServer({
    delayMs: (k) => (CLIENTS_TIE - 1 - k) * 15,
    onOpen(socket) { for (const n of LEVEL_PAYLOAD_BYTES) socket.write(encodeFrame(OPCODES.BINARY, new Uint8Array(n))); },
  });
  try {
    // The fake clock advances gradually and stays behind the real timers: every handshake and level event lands at 0, the clock
    // is still 999 when a single setTimeout(endMs) would fire (real 1000 ms), and reaches 1000 only at real 1100 ms. An early
    // close (before the clock reaches endMs) or a one-shot timer that skips the re-check would stamp a close below 1000.
    let clock = 0;
    const timers = [[400, 500], [700, 999], [1100, 1000]].map(([at, v]) => setTimeout(() => { clock = v; }, at));
    const events = await runSocketClients({ host: SOCKET_HOST, port: srv.port, clients: CLIENTS_TIE, durationS: 1, now: () => clock });
    for (const t of timers) clearTimeout(t);
    assert.ok(events.every((e) => e.tMs === 0 || e.tMs === 1000));
    assert.ok(events.filter((e) => e.tMs === 0).length > CLIENTS_TIE * 4);
    const closes = events.filter((e) => e.kind === 'close');
    assert.equal(closes.length, CLIENTS_TIE);
    for (const c of closes) assert.equal(c.tMs, 1000); // exactly durationS * 1000, never earlier
    for (let i = 1; i < events.length; i++) {
      assert.ok(events[i].tMs >= events[i - 1].tMs, `tMs non-decreasing at ${i}`);
      if (events[i].tMs === events[i - 1].tMs) assert.ok(events[i].id >= events[i - 1].id, `id ascending on tMs tie at ${i}`);
    }
    for (let id = 0; id < CLIENTS_TIE; id++) {
      const mine = events.filter((e) => e.id === id);
      assert.equal(mine[0].kind, 'connect');
      assert.equal(mine.at(-1).kind, 'close');
      assert.deepEqual(mine.filter((e) => e.kind === 'level').map((e) => e.level), [0, 1, 2, 3]);
    }
  } finally {
    await srv.close();
  }
});

test('path option reaches the server request line for every client', async () => {
  const lines = [];
  const srv = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.once('data', (d) => { lines.push(d.toString('latin1').split('\r\n')[0]); socket.destroy(); });
  });
  await new Promise((r) => srv.listen(0, SOCKET_HOST, r));
  try {
    const events = await runSocketClients({ host: SOCKET_HOST, port: srv.address().port, clients: 3, durationS: 0.2, path: '/x' });
    assert.deepEqual(events, []);
    assert.deepEqual(lines, ['GET /x HTTP/1.1', 'GET /x HTTP/1.1', 'GET /x HTTP/1.1']);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
