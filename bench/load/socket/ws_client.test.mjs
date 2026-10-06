import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { createWsServer } from '../../../server/ws/index.mjs';
import { FrameParser, encodeFrame, encodeClosePayload, OPCODES } from '../../../server/ws/frame/index.mjs';
import { LEVEL_PAYLOAD_BYTES, SOCKET_HOST } from './contract.mjs';
import { connectWs } from './ws_client.mjs';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

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
