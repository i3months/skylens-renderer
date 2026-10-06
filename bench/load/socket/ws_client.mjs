// Minimal RFC 6455 client for the real-socket load run (T16.12). node:net only; frames via server/ws/frame.
// connectWs({ host, port, path = '/', timeoutMs }) resolves once the 101 upgrade is verified and rejects on any
// connect / handshake failure (refused, bad status, bad accept key, timeout). The returned handle:
//   onMessage(cb(Uint8Array))  complete binary messages (fragments reassembled); messages that arrive before a
//                              callback is set are queued and delivered when it is set.
//   onClose(cb({ code, reason }))  called once when the connection ends (server close, error, or our close()).
//   close(code = 1000)         sends a masked close frame and resolves when the socket is gone (bounded wait).
//   socket                     the underlying net.Socket.
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { FrameParser, encodeFrame, encodeClosePayload, OPCODES } from '../../../server/ws/frame/index.mjs';

const HANDSHAKE_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_HANDSHAKE_BYTES = 16384;
export const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
export const CLOSE_WAIT_MS = 2000;

function expectedAccept(key) {
  return createHash('sha1').update(key + HANDSHAKE_GUID).digest('base64');
}

function maskedFrame(opcode, payload) {
  return encodeFrame(opcode, payload, { maskKey: randomBytes(4) });
}

/** Parses an HTTP response head; returns null when it is not a valid 101 for this key. */
function checkUpgrade(head, key) {
  const lines = head.split('\r\n');
  if (!/^HTTP\/1\.1 101(\s|$)/.test(lines[0])) return `unexpected status: ${lines[0]}`;
  const headers = new Map();
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  if (String(headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') return 'missing upgrade header';
  if (headers.get('sec-websocket-accept') !== expectedAccept(key)) return 'bad accept key';
  return null;
}

/**
 * @param {{ host: string, port: number, path?: string, timeoutMs?: number }} opts
 * @returns {Promise<{ onMessage(cb: (data: Uint8Array) => void): void, onClose(cb: (info: {code: number, reason: string}) => void): void, close(code?: number): Promise<void>, socket: net.Socket }>}
 */
export function connectWs({ host, port, path = '/', timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS } = {}) {
  if (typeof host !== 'string' || host === '') return Promise.reject(new TypeError('host must be a non-empty string'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.reject(new RangeError('port must be an integer in 1..65535'));
  if (typeof path !== 'string' || !path.startsWith('/')) return Promise.reject(new TypeError('path must start with /'));
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) return Promise.reject(new RangeError('timeoutMs must be > 0'));

  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const socket = net.connect({ host, port });
    let upgraded = false;
    let settled = false;
    let headBuf = Buffer.alloc(0);
    const parser = new FrameParser({ requireMask: false });
    const queue = [];
    let msgCb = null;
    let closeCb = null;
    let closeInfo = null; // set once the connection is finished
    let closeSent = false;
    let closeTimer = null;
    let closeWaiters = [];

    const connectTimer = setTimeout(() => fail(new Error('connect timeout')), timeoutMs);

    function fail(err) {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      socket.destroy();
      reject(err);
    }

    let gone = false; // the socket emitted 'close'

    // Records how the connection ended and tells the close callback, once. The socket itself goes away on its own
    // (the peer ends it after our close frame) or at the latest CLOSE_WAIT_MS later.
    function finish(code, reason) {
      if (closeInfo) return;
      closeInfo = { code, reason };
      if (closeCb) closeCb(closeInfo);
    }

    function sendClose(code) {
      if (closeSent || socket.destroyed) return;
      closeSent = true;
      try { socket.write(maskedFrame(OPCODES.CLOSE, encodeClosePayload(code))); } catch { /* socket already broken */ }
      socket.end();
      closeTimer = setTimeout(() => socket.destroy(), CLOSE_WAIT_MS);
    }

    function deliver(data) {
      if (msgCb) msgCb(data);
      else queue.push(data);
    }

    function feed(chunk) {
      for (const ev of parser.push(chunk)) {
        if (closeInfo) return;
        if (ev.type === 'message') deliver(ev.data);
        else if (ev.type === 'ping') {
          if (!closeSent) socket.write(maskedFrame(OPCODES.PONG, ev.data));
        } else if (ev.type === 'close') {
          const code = ev.code;
          sendClose(code === 1005 ? 1000 : code);
          finish(code, ev.reason);
        } else if (ev.type === 'error') {
          sendClose(ev.code);
          finish(ev.code, ev.reason);
        }
      }
    }

    socket.on('connect', () => {
      socket.setNoDelay(true);
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });

    socket.on('data', (chunk) => {
      if (upgraded) { feed(chunk); return; }
      headBuf = Buffer.concat([headBuf, chunk]);
      const end = headBuf.indexOf('\r\n\r\n');
      if (end < 0) {
        if (headBuf.length > MAX_HANDSHAKE_BYTES) fail(new Error('handshake response too large'));
        return;
      }
      const problem = checkUpgrade(headBuf.subarray(0, end).toString('latin1'), key);
      if (problem) { fail(new Error(`handshake failed: ${problem}`)); return; }
      const rest = headBuf.subarray(end + 4);
      headBuf = null;
      upgraded = true;
      settled = true;
      clearTimeout(connectTimer);
      resolve(handle);
      if (rest.length > 0) feed(rest);
    });

    socket.on('error', (err) => {
      if (!settled) fail(err);
    });

    socket.on('close', () => {
      clearTimeout(connectTimer);
      clearTimeout(closeTimer);
      closeTimer = null;
      gone = true;
      if (!settled) { fail(new Error('connection closed during handshake')); return; }
      finish(1006, '');
      const waiters = closeWaiters;
      closeWaiters = [];
      for (const w of waiters) w();
    });

    const handle = {
      socket,
      onMessage(cb) {
        msgCb = cb;
        while (msgCb && queue.length > 0) msgCb(queue.shift());
      },
      onClose(cb) {
        closeCb = cb;
        if (closeInfo && cb) cb(closeInfo);
      },
      close(code = 1000) {
        return new Promise((r) => {
          if (gone) { r(); return; }
          closeWaiters.push(r);
          sendClose(code);
        });
      },
    };
  });
}
