// F-577 9/10: one test through the whole report path (delayed-handshake server -> runSocketClients -> runScenario -> loadReport),
// and the S5 threshold being a reference note, not a verdict, for a cloud-approximation (loopback-socket) run.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { encodeFrame, OPCODES } from '../../../server/ws/frame/index.mjs';
import { runSocketClients } from '../socket/clients.mjs';
import { LEVEL_PAYLOAD_BYTES, SOCKET_HOST } from '../socket/contract.mjs';
import { runScenario } from './run.mjs';
import { loadReport } from '../../../tools/load_report/index.mjs';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const HANDSHAKE_DELAY_MS = 40;
const METHOD = 'loopback-socket';
const NOTE = '(handshake-complete basis, not an S5 value)';
const COMMIT = 'abc1234';

// Raw server: the 101 reply is held for delayMs, then every level payload follows at once.
function delayedServer(delayMs) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buf = Buffer.alloc(0);
    let answered = false;
    socket.on('data', (chunk) => {
      if (answered) return;
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      answered = true;
      const key = /sec-websocket-key:\s*(\S+)/i.exec(buf.subarray(0, end).toString('latin1'))[1];
      const accept = createHash('sha1').update(key + GUID).digest('base64');
      setTimeout(() => {
        const head = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`;
        socket.write(Buffer.concat([Buffer.from(head, 'latin1'), ...LEVEL_PAYLOAD_BYTES.map((n) => encodeFrame(OPCODES.BINARY, new Uint8Array(n)))]));
      }, delayMs);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, SOCKET_HOST, () => resolve({
      port: server.address().port,
      close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
    }));
  });
}

const nearestRank95 = (xs) => [...xs].sort((a, b) => a - b)[Math.ceil(0.95 * xs.length) - 1];
const scenario = (clients, durationS) => ({
  name: 'socket30', kind: 'steady', clients, durationS,
  path: [{ t: 0, e: 0, n: 0, u: 100 }, { t: Math.min(30, durationS), e: 150, n: 0, u: 100 }],
});
const withoutSamples = (violations) => violations.filter((v) => !v.includes('server samples'));

test('report path: first_frame_p95 is (first_frame - connect) p95 on the handshake-complete basis, apart from latency, with the row note', async () => {
  const clients = 10;
  const srv = await delayedServer(HANDSHAKE_DELAY_MS);
  let events;
  try {
    events = await runSocketClients({ host: SOCKET_HOST, port: srv.port, clients, durationS: 1 });
  } finally {
    await srv.close();
  }
  const { result, violations } = runScenario(scenario(clients, 1), { events, commit: COMMIT, method: METHOD });
  assert.deepEqual(withoutSamples(violations), []);

  // Expected values come from the raw log: (first_frame - connect) and the latencyMs of the bytes event that carried the first level.
  const fromConnect = [];
  const latency = [];
  for (let id = 0; id < clients; id++) {
    const mine = events.filter((e) => e.id === id);
    const connect = mine.find((e) => e.kind === 'connect');
    const ff = mine.find((e) => e.kind === 'first_frame');
    assert.ok(connect && ff, `client ${id} has connect and first_frame`);
    fromConnect.push(ff.tMs - connect.tMs);
    const arrival = mine.find((e) => e.kind === 'bytes' && e.tMs === ff.tMs);
    assert.ok(arrival, `client ${id} has the bytes event of its first frame`);
    latency.push(arrival.latencyMs);
  }
  const record = result.records.find((r) => r.metric === 'load.first_frame_p95');
  assert.equal(record.value, nearestRank95(fromConnect));
  assert.ok(nearestRank95(latency) - record.value >= 35, `latency p95 ${nearestRank95(latency)} vs first_frame_p95 ${record.value}`);
  assert.ok(record.value < HANDSHAKE_DELAY_MS - 5, `first_frame_p95 ${record.value} must not include the handshake`);

  const report = loadReport(result);
  const row = report.split('\n').find((l) => l.includes('load.first_frame_p95'));
  assert.ok(row.startsWith(`| load.first_frame_p95 ${NOTE} | ${record.value} |`), row);
  assert.equal(report.split(NOTE).length - 1, 1, 'the note appears on that row only');
  assert.ok(report.includes('(cloud approximation)'), report);
});

// A log whose first_frame p95 is 3500 ms after connect (over the 3 s limit).
function slowFirstFrameLog(clients, durationS) {
  const ev = [];
  for (let id = 0; id < clients; id++) {
    ev.push({ id, tMs: 0, kind: 'connect' });
    ev.push({ id, tMs: 3500, kind: 'bytes', bytes: LEVEL_PAYLOAD_BYTES[0], latencyMs: 3500 });
    ev.push({ id, tMs: 3500, kind: 'level', level: 0 });
    ev.push({ id, tMs: 3500, kind: 'first_frame' });
    ev.push({ id, tMs: durationS * 1000, kind: 'close' });
  }
  return ev.sort((a, b) => a.tMs - b.tMs || a.id - b.id);
}

test('S5 3 s limit on a loopback-socket run is a reference note matching the report row note, not a violation', () => {
  const events = slowFirstFrameLog(3, 4);
  const sock = runScenario(scenario(3, 4), { events, commit: COMMIT, method: METHOD });
  assert.deepEqual(withoutSamples(sock.violations), []);
  assert.equal(sock.notes.length, 2);
  const [fromStats, fromThreshold] = sock.notes;
  assert.equal(fromStats, `socket30: reference only (not an S5 verdict), ${NOTE}: first-frame p95 3500 ms exceeds limit 3000 ms`);
  assert.equal(fromThreshold, `socket30: reference only (not an S5 verdict), ${NOTE}: load.first_frame_p95: 3500 > max 3000`);
  const row = loadReport(sock.result).split('\n').find((l) => l.includes('load.first_frame_p95'));
  assert.ok(row.includes(NOTE), row);
  for (const n of sock.notes) assert.ok(n.includes(NOTE), n);

  // Same log under the simulated label keeps both as violations and has no notes.
  const sim = runScenario(scenario(3, 4), { events, commit: COMMIT });
  assert.deepEqual(sim.notes, []);
  assert.ok(sim.violations.includes('socket30: first-frame p95 3500 ms exceeds limit 3000 ms'), sim.violations.join('\n'));
  assert.ok(sim.violations.includes('socket30: load.first_frame_p95: 3500 > max 3000'), sim.violations.join('\n'));
});

test('runScenario rejects an empty or non-string method', () => {
  for (const method of ['', 7, null]) assert.throws(() => runScenario(scenario(1, 1), { commit: COMMIT, method }), /method must be a non-empty string/);
});
