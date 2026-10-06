// Real-socket load clients (T16.12): opens `clients` WebSocket connections at once and records the contracts/load
// ClientEvent log on the real clock. See bench/load/socket/contract.mjs.
//   connect     when the 101 upgrade is verified (a client that fails to connect emits nothing at all)
//   bytes       per received message: bytes = payload length, latencyMs = ms since that client's connect
//   level       per LEVEL_PAYLOADS message, level = its arrival index (messages beyond the level count only add bytes)
//   first_frame once per client, at the arrival of its first level payload
//   close       at durationS (one shared instant for every open client), or earlier when the server ends the connection
// tMs is ms since the single start reading of now(); the log is sorted by tMs, then id (stable within one id).
import { performance } from 'node:perf_hooks';
import { LEVEL_COUNT } from '../../../contracts/asset/index.mjs';
import { LEVEL_PAYLOAD_BYTES } from './contract.mjs';
import { connectWs, DEFAULT_CONNECT_TIMEOUT_MS } from './ws_client.mjs';

const LEVEL_MESSAGES = Math.min(LEVEL_COUNT, LEVEL_PAYLOAD_BYTES.length);

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
  const timeoutMs = Math.min(connectTimeoutMs, endMs);
  let ended = false;
  const states = [];

  const attempts = [];
  for (let id = 0; id < clients; id++) {
    const st = { id, conn: null, open: false, connectMs: 0, messages: 0, firstFrame: false };
    states.push(st);
    attempts.push(connectWs({ host, port, path, timeoutMs }).then((conn) => {
      if (ended) return conn.close(); // upgrade finished after the run ended: not part of the log
      st.conn = conn;
      st.open = true;
      st.connectMs = elapsed();
      events.push({ id, tMs: st.connectMs, kind: 'connect' });
      conn.onMessage((data) => {
        if (!st.open) return;
        const tMs = elapsed();
        const index = st.messages++;
        events.push({ id, tMs, kind: 'bytes', bytes: data.length, latencyMs: Math.max(0, tMs - st.connectMs) });
        if (index < LEVEL_MESSAGES) {
          events.push({ id, tMs, kind: 'level', level: index });
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

  await new Promise((r) => { setTimeout(r, Math.max(0, endMs - elapsed())); });
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
