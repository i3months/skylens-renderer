import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { createWsServer } from '../../../server/ws/index.mjs';
import { FrameParser, encodeFrame, encodeClosePayload, OPCODES } from '../../../server/ws/frame/index.mjs';
import { LEVEL_PAYLOAD_BYTES, SOCKET_HOST } from './contract.mjs';
import { connectWs } from './ws_client.mjs';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Bounds a wait so a missing callback fails fast instead of hanging the file. */
async function within(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${ms} ms: ${label}`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function payload(n, seed) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
}

async function levelServer(extra = () => {}) {
  return createWsServer({
    host: SOCKET_HOST,
    port: 0,
    onConnection(conn) {
      LEVEL_PAYLOAD_BYTES.forEach((n, i) => conn.send(payload(n, i)));
      extra(conn);
    },
  });
}

/** Raw TCP server that completes the handshake then runs script(socket, parser) on the upgraded socket. */
function rawServer(script, { status = 101 } = {}) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buf = Buffer.alloc(0);
    const parser = new FrameParser();
    let upgraded = false;
    socket.on('data', (chunk) => {
      if (upgraded) { script.onFrames?.(socket, parser.push(chunk)); return; }
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const key = /sec-websocket-key:\s*(\S+)/i.exec(buf.subarray(0, end).toString('latin1'))[1];
      if (status !== 101) { socket.end(`HTTP/1.1 ${status} Nope\r\nContent-Length: 0\r\n\r\n`); return; }
      const accept = createHash('sha1').update(key + GUID).digest('base64');
      upgraded = true;
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      script.onOpen?.(socket);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, SOCKET_HOST, () => resolve({
      port: server.address().port,
      close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
    }));
  });
}

function collect(conn, count) {
  const got = [];
  return new Promise((resolve) => {
    conn.onMessage((data) => { got.push(data); if (got.length === count) resolve(got); });
  });
}

test('connectWs receives the level payloads as whole binary messages', async () => {
  const srv = await levelServer();
  try {
    const conn = await connectWs({ host: SOCKET_HOST, port: srv.address().port });
    const got = await collect(conn, LEVEL_PAYLOAD_BYTES.length);
    assert.deepEqual(got.map((m) => m.length), [...LEVEL_PAYLOAD_BYTES]);
    got.forEach((m, i) => assert.deepEqual(m, payload(LEVEL_PAYLOAD_BYTES[i], i)));
    const closed = new Promise((r) => conn.onClose(r));
    await conn.close();
    const info = await closed;
    assert.equal(info.code, 1000);
  } finally {
    await srv.close();
  }
});

test('connectWs reassembles fragmented messages, answers ping, survives byte-sized TCP chunks', async () => {
  const msg = payload(5000, 7);
  let pong = null;
  const srv = await rawServer({
    async onOpen(socket) {
      const frames = Buffer.concat([
        encodeFrame(OPCODES.BINARY, msg.subarray(0, 1000), { fin: false }),
        encodeFrame(OPCODES.PING, Uint8Array.of(1, 2, 3)),
        encodeFrame(OPCODES.CONT, msg.subarray(1000, 4000), { fin: false }),
        encodeFrame(OPCODES.CONT, msg.subarray(4000)),
        encodeFrame(OPCODES.BINARY, Uint8Array.of(9)),
      ]);
      // First 200 bytes one at a time, the rest in one write.
      for (let i = 0; i < 200; i++) {
        socket.write(frames.subarray(i, i + 1));
        await new Promise((r) => setImmediate(r));
      }
      socket.write(frames.subarray(200));
    },
    onFrames(socket, evs) {
      for (const ev of evs) {
        if (ev.type === 'pong') pong = ev.data;
        if (ev.type === 'close') { socket.end(encodeFrame(OPCODES.CLOSE, encodeClosePayload(ev.code))); }
      }
    },
  });
  try {
    const conn = await connectWs({ host: SOCKET_HOST, port: srv.port });
    const got = await collect(conn, 2);
    assert.deepEqual(got[0], msg);
    assert.deepEqual(got[1], Uint8Array.of(9));
    await conn.close();
    assert.deepEqual(pong, Uint8Array.of(1, 2, 3)); // masked pong parsed by a mask-requiring parser
  } finally {
    await srv.close();
  }
});

test('connectWs reports a server close with its code', async () => {
  const srv = await levelServer((conn) => conn.close(4001, 'bye'));
  try {
    const conn = await connectWs({ host: SOCKET_HOST, port: srv.address().port });
    const info = await new Promise((r) => conn.onClose(r));
    assert.equal(info.code, 4001);
    assert.equal(info.reason, 'bye');
    await conn.close(); // already gone: resolves
  } finally {
    await srv.close();
  }
});

test('connectWs rejects on refused connection, bad status, and handshake timeout', async () => {
  const tmp = net.createServer();
  await new Promise((r) => tmp.listen(0, SOCKET_HOST, r));
  const freePort = tmp.address().port;
  await new Promise((r) => tmp.close(r));
  await assert.rejects(connectWs({ host: SOCKET_HOST, port: freePort }));

  const bad = await rawServer({}, { status: 403 });
  try {
    await assert.rejects(connectWs({ host: SOCKET_HOST, port: bad.port }), /handshake failed/);
  } finally {
    await bad.close();
  }

  const silent = net.createServer((s) => s.on('error', () => {}));
  const held = new Set();
  silent.on('connection', (s) => { held.add(s); s.on('close', () => held.delete(s)); });
  await new Promise((r) => silent.listen(0, SOCKET_HOST, r));
  try {
    await assert.rejects(connectWs({ host: SOCKET_HOST, port: silent.address().port, timeoutMs: 100 }), /timeout/);
  } finally {
    for (const s of held) s.destroy();
    await new Promise((r) => silent.close(r));
  }
});

test('connectWs rejects bad arguments', async () => {
  await assert.rejects(connectWs({ host: '', port: 1 }), TypeError);
  await assert.rejects(connectWs({ host: SOCKET_HOST, port: 0 }), RangeError);
  await assert.rejects(connectWs({ host: SOCKET_HOST, port: 1, path: 'x' }), TypeError);
});

/** Raw server whose response to the upgrade request is built by respond(socket, key, requestHead). */
function headServer(respond) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
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
      const head = buf.toString('latin1');
      respond(socket, /sec-websocket-key:\s*(\S+)/i.exec(head)[1], head);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, SOCKET_HOST, () => resolve({
      port: server.address().port,
      close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
    }));
  });
}
const acceptOf = (key) => createHash('sha1').update(key + GUID).digest('base64');

async function rejectsWith(respond, message) {
  const srv = await headServer(respond);
  try {
    await assert.rejects(connectWs({ host: SOCKET_HOST, port: srv.port }), (err) => { assert.equal(err.message, message); return true; });
  } finally {
    await srv.close();
  }
}

test('handshake: forged Sec-WebSocket-Accept is rejected', () => rejectsWith((s, key) => {
  s.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptOf(`${key}x`)}\r\n\r\n`);
}, 'handshake failed: bad accept key'));

test('handshake: missing Upgrade header is rejected', () => rejectsWith((s, key) => {
  s.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptOf(key)}\r\n\r\n`);
}, 'handshake failed: missing upgrade header'));

test('handshake: a response head over 16 KB is rejected', () => rejectsWith((s) => {
  s.write(`HTTP/1.1 101 Switching Protocols\r\nX-Pad: ${'a'.repeat(17000)}`); // no terminator
}, 'handshake response too large'));

test('handshake: 403 status is rejected with the status line', () => rejectsWith((s) => {
  s.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
}, 'handshake failed: unexpected status: HTTP/1.1 403 Forbidden'));

const REJECTED_STATUSES = [[100, 'Continue'], [102, 'Processing'], [103, 'Early Hints'], [200, 'OK'], [1010, 'Nope']];

for (const [code, text] of REJECTED_STATUSES) {
  test(`handshake: status ${code} with otherwise valid upgrade headers is rejected`, () => rejectsWith((s, key) => {
    s.write(`HTTP/1.1 ${code} ${text}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptOf(key)}\r\n\r\n`);
  }, `handshake failed: unexpected status: HTTP/1.1 ${code} ${text}`));
}

test('handshake: bare status lines without a reason phrase are rejected as handshake failures', async () => {
  for (const [code] of REJECTED_STATUSES) {
    await rejectsWith((s, key) => {
      s.write(`HTTP/1.1 ${code}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptOf(key)}\r\n\r\n`);
    }, `handshake failed: unexpected status: HTTP/1.1 ${code}`);
  }
});

test('path reaches the server request line', async () => {
  let line = null;
  const srv = await headServer((s, key, head) => {
    line = head.split('\r\n')[0];
    s.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptOf(key)}\r\n\r\n`);
  });
  try {
    const conn = await connectWs({ host: SOCKET_HOST, port: srv.port, path: '/x' });
    assert.equal(line, 'GET /x HTTP/1.1');
    conn.socket.destroy();
  } finally {
    await srv.close();
  }
});

test('onMessage gets the receive time read at data-event entry, not at delivery', async () => {
  const srv = await levelServer();
  try {
    let tick = 1;
    const entry = []; // the clock value at the entry of each data event after the handshake
    const conn = await connectWs({ host: SOCKET_HOST, port: srv.address().port, now: () => tick });
    // Runs before the client's own data listener, so the client reads a distinct clock value per event.
    conn.socket.prependListener('data', () => { tick += 1000; entry.push(tick); });
    // Let the level payloads arrive with no callback set, then move the clock: queued messages keep their entry stamps.
    await new Promise((r) => setTimeout(r, 200));
    const afterArrival = tick;
    tick += 1_000_000;
    const times = [];
    await within(new Promise((resolve) => {
      conn.onMessage((d, t) => { times.push(t); if (times.length === LEVEL_PAYLOAD_BYTES.length) resolve(); });
    }), 5000, 'level messages');
    assert.ok(entry.length > 0);
    for (const t of times) assert.ok(t === 1 || entry.includes(t), `recvMs ${t} was not read at a data-event entry (${entry})`);
    assert.ok(times.every((t) => t <= afterArrival));
    assert.ok(times.every((t) => t >= conn.connectedMs));
    await conn.close();
  } finally {
    await srv.close();
  }
});

test('onMessage with a live callback: now() is read once per data event, at its entry', async () => {
  const srv = await levelServer();
  try {
    let reads = 0;
    const conn = await connectWs({ host: SOCKET_HOST, port: srv.address().port, now: () => ++reads });
    assert.equal(reads, 1); // the handshake data event
    let dataEvents = 0;
    conn.socket.on('data', () => { dataEvents++; });
    const times = [];
    await within(new Promise((resolve) => {
      conn.onMessage((d, t) => { times.push(t); if (times.length === LEVEL_PAYLOAD_BYTES.length) resolve(); });
    }), 5000, 'level messages');
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(dataEvents > 0);
    assert.equal(reads, 1 + dataEvents); // a read at delivery time would add calls
    for (const t of times) assert.ok(t >= 1 && t <= reads);
    await conn.close();
  } finally {
    await srv.close();
  }
});

test('abnormal end without a close frame reports 1006', async () => {
  const srv = await rawServer({ onOpen(socket) { setTimeout(() => socket.destroy(), 20); } });
  try {
    const conn = await connectWs({ host: SOCKET_HOST, port: srv.port });
    const info = await within(new Promise((r) => conn.onClose(r)), 5000, 'onClose');
    assert.deepEqual(info, { code: 1006, reason: '' });
  } finally {
    await srv.close();
  }
});

test('abnormal close: socket destroyed right after the handshake reports 1006 with an empty reason, once', async () => {
  const srv = await rawServer({ onOpen(socket) { socket.destroy(); } });
  try {
    const conn = await connectWs({ host: SOCKET_HOST, port: srv.port });
    const infos = [];
    await within(new Promise((r) => { conn.onClose((i) => { infos.push(i); r(); }); }), 5000, 'onClose');
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(infos, [{ code: 1006, reason: '' }]);
    await conn.close(); // already gone: resolves
  } finally {
    await srv.close();
  }
});

test('server close(1000) frame then socket end: onClose is called exactly once, with the close frame code', async () => {
  const srv = await rawServer({
    onOpen(socket) { socket.write(encodeFrame(OPCODES.CLOSE, encodeClosePayload(1000))); },
    onFrames(socket, evs) { if (evs.some((e) => e.type === 'close')) socket.end(); },
  });
  try {
    const conn = await connectWs({ host: SOCKET_HOST, port: srv.port });
    const infos = [];
    await within(new Promise((r) => { conn.onClose((i) => { infos.push(i); r(); }); }), 5000, 'onClose');
    await within(conn.close(), 5000, 'socket gone'); // resolves once the socket emitted close
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(infos, [{ code: 1000, reason: '' }]);
  } finally {
    await srv.close();
  }
});

test('a masked server frame closes the connection with 1002 and delivers nothing', async () => {
  let clientClose = null;
  const srv = await rawServer({
    onOpen(socket) {
      socket.write(encodeFrame(OPCODES.BINARY, Uint8Array.of(1, 2, 3), { maskKey: Uint8Array.of(1, 2, 3, 4) }));
    },
    onFrames(socket, evs) {
      for (const ev of evs) if (ev.type === 'close') { clientClose = ev.code; socket.end(); }
    },
  });
  try {
    const conn = await connectWs({ host: SOCKET_HOST, port: srv.port });
    const got = [];
    conn.onMessage((d) => got.push(d));
    const info = await Promise.race([new Promise((r) => conn.onClose(r)), new Promise((r) => setTimeout(() => r({ code: 'no close' }), 1500))]);
    assert.equal(info.code, 1002);
    await conn.close();
    assert.deepEqual(got, []);
    assert.equal(clientClose, 1002);
  } finally {
    await srv.close();
  }
});

test('a masked frame split across TCP chunks after a good frame is still caught', async () => {
  let clientClose = null;
  const srv = await rawServer({
    async onOpen(socket) {
      socket.write(encodeFrame(OPCODES.BINARY, Uint8Array.of(7)));
      await new Promise((r) => setTimeout(r, 20));
      const bad = encodeFrame(OPCODES.BINARY, new Uint8Array(300), { maskKey: Uint8Array.of(5, 6, 7, 8) });
      socket.write(bad.subarray(0, 1));
      await new Promise((r) => setTimeout(r, 20));
      socket.write(bad.subarray(1));
    },
    onFrames(socket, evs) {
      for (const ev of evs) if (ev.type === 'close') { clientClose = ev.code; socket.end(); }
    },
  });
  try {
    const conn = await connectWs({ host: SOCKET_HOST, port: srv.port });
    const got = [];
    conn.onMessage((d) => got.push(d));
    const info = await Promise.race([new Promise((r) => conn.onClose(r)), new Promise((r) => setTimeout(() => r({ code: 'no close' }), 1500))]);
    assert.equal(info.code, 1002);
    assert.deepEqual(got, [Uint8Array.of(7)]);
    await conn.close();
    assert.equal(clientClose, 1002);
  } finally {
    await srv.close();
  }
});
