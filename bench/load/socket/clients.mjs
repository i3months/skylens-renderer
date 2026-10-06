// Real-socket load clients (T16.12): opens `clients` WebSocket connections at once and records the contracts/load
// ClientEvent log on the real clock. See bench/load/socket/contract.mjs.
//   connect     when the 101 upgrade is verified (a client that fails to connect emits nothing at all)
//   bytes       per received message: bytes = payload length, latencyMs = receive time - that client's attempt time
//   level       per message whose length is a LEVEL_PAYLOAD_BYTES entry, level = that entry's index (recovered from the payload,
//               not from arrival order); any other length only produces a bytes event
//   first_frame once per client, at the tMs of its first level event
// Time base: attemptMs = now() read just before the client's connectWs call (which runs net.connect synchronously). The receive
// time recvMs is now() read at the entry of the socket 'data' event (ws_client passes it as onMessage's 2nd arg). For every bytes
// event latencyMs === tMs - (attemptMs - start) (tMs = recvMs - start, clamped at 0). The connect event's tMs is the time the
// handshake completed (conn.connectedMs, read at the data event that finished the 101 head), so it is NOT the latency base; it is only >= the attempt time.
//   close       at durationS (one shared instant for every open client), or earlier when the server ends the connection
// tMs is ms since the single start reading of now(); the log is sorted by tMs, then id (stable within one id).
import { performance } from 'node:perf_hooks';
import { LEVEL_PAYLOAD_BYTES } from './contract.mjs';
import { connectWs, DEFAULT_CONNECT_TIMEOUT_MS } from './ws_client.mjs';

// A handshake may finish up to this long after durationS before it is abandoned (the late connect is dropped from the log).
export const LATE_CONNECT_GRACE_MS = 500;

/**
 * @param {{ host: string, port: number, clients: number, durationS: number, now?: () => number, path?: string, connectTimeoutMs?: number }} opts
 * @returns {Promise<object[]>} ClientEvent[] sorted by tMs, then id
 */
export async function runSocketClients({ host, port, clients, durationS, now = () => performance.now(), path = '/', connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS } = {}) {
  if (typeof host !== 'string' || host === '') throw new TypeError('host must be a non-empty string');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError('port must be an integer in 1..65535');
  if (!Number.isInteger(clients) || clients < 1) throw new RangeError('clients must be a positive integer');
  if (!(Number.isFinite(durationS) && durationS > 0)) throw new RangeError('durationS must be a finite number > 0');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (!(Number.isFinite(connectTimeoutMs) && connectTimeoutMs > 0)) throw new RangeError('connectTimeoutMs must be > 0');

  const events = [];
  const start = now();
  const elapsed = () => Math.max(0, now() - start);
  const endMs = durationS * 1000;
  // Bound the handshake by the run length too, so a stuck connect never outlives the run by much.
  const timeoutMs = Math.min(connectTimeoutMs, endMs + LATE_CONNECT_GRACE_MS);
  let ended = false;
  const states = [];

  const attempts = [];
  for (let id = 0; id < clients; id++) {
    const st = { id, conn: null, open: false, firstFrame: false };
    states.push(st);
    const attemptMs = now();
    attempts.push(connectWs({ host, port, path, timeoutMs, now }).then((conn) => {
      if (ended) return conn.close(); // upgrade finished after the run ended: not part of the log
      st.conn = conn;
      st.open = true;
      events.push({ id, tMs: Math.max(0, conn.connectedMs - start), kind: 'connect' });
      conn.onMessage((data, recvMs = now()) => {
        if (!st.open) return;
        const tMs = Math.max(0, recvMs - start);
        events.push({ id, tMs, kind: 'bytes', bytes: data.length, latencyMs: Math.max(0, recvMs - attemptMs) });
        const level = LEVEL_PAYLOAD_BYTES.indexOf(data.length);
        if (level >= 0) {
          events.push({ id, tMs, kind: 'level', level });
          if (!st.firstFrame) {
            st.firstFrame = true;
            events.push({ id, tMs, kind: 'first_frame' });
          }
        }
      });
      conn.onClose(() => {
        if (!st.open) return;
        st.open = false; // server ended the connection before durationS
        events.push({ id, tMs: elapsed(), kind: 'close' });
      });
      return undefined;
    }, () => undefined)); // connection failure: no events for this client
  }

  // Never close early: a timer may fire a hair before now() reaches endMs, so re-check against the clock.
  while (elapsed() < endMs) await new Promise((r) => { setTimeout(r, Math.min(50, Math.max(1, endMs - elapsed()))); });
  ended = true;
  const closeMs = elapsed();
  const closing = [];
  for (const st of states) {
    if (!st.open) continue;
    st.open = false;
    events.push({ id: st.id, tMs: closeMs, kind: 'close' });
    closing.push(st.conn.close());
  }
  await Promise.all(closing);
  await Promise.all(attempts); // every pending handshake is bounded by timeoutMs

  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.tMs - b.e.tMs || a.e.id - b.e.id || a.i - b.i)
    .map(({ e }) => e);
}
