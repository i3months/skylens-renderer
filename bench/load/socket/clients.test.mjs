import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createWsServer } from '../../../server/ws/index.mjs';
import { checkEventLog } from '../run_all/event_log.mjs';
import { countOpenConnections, connectionViolations } from '../clients/index.mjs';
import { LEVEL_PAYLOAD_BYTES, SOCKET_HOST } from './contract.mjs';
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
      assert.ok(kinds('close')[0].tMs >= durationS * 1000 - 5);
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
