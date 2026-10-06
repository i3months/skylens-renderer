// Minimal RFC 6455 client for the real-socket load run (T16.12). node:net only; frames via server/ws/frame.
// connectWs({ host, port, path = '/', timeoutMs }) resolves once the 101 upgrade is verified and rejects on any
// connect / handshake failure (refused, bad status, bad accept key, timeout). The returned handle:
//   onMessage(cb(Uint8Array, recvMs))  complete binary messages (fragments reassembled); messages that arrive before a
//                              callback is set are queued and delivered when it is set. recvMs is now() read at the entry of
//                              the socket 'data' event that completed the message (not when the callback runs).
//                              connectWs also takes now = () => performance.now() for that reading.
//   A server frame with the MASK bit set is a protocol error (RFC 6455 5.1): the client closes with 1002.
//   onClose(cb({ code, reason }))  called once when the connection ends (server close, error, or our close()).
//   close(code = 1000)         sends a masked close frame and resolves when the socket is gone (bounded wait).
//   connectedMs                now() at the entry of the data event that completed the 101 head.
//   socket                     the underlying net.Socket.
import net from 'node:net';
import { performance } from 'node:perf_hooks';
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
export function connectWs({ host, port, path = '/', timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS, now = () => performance.now() } = {}) {
  if (typeof host !== 'string' || host === '') return Promise.reject(new TypeError('host must be a non-empty string'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.reject(new RangeError('port must be an integer in 1..65535'));
  if (typeof path !== 'string' || !path.startsWith('/')) return Promise.reject(new TypeError('path must start with /'));
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) return Promise.reject(new RangeError('timeoutMs must be > 0'));
  if (typeof now !== 'function') return Promise.reject(new TypeError('now must be a function'));

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

    function deliver(data, recvMs) {
      if (msgCb) msgCb(data, recvMs);
      else queue.push([data, recvMs]);
    }

    // Stream-level scan of server frame headers; FrameParser(requireMask:false) would silently accept a masked frame.
    // Returns the offset in chunk of the first byte of the offending frame (-1: its start was in an earlier chunk), or null.
    const scan = { phase: 0, extLeft: 0, ext: [], payloadLeft: 0 };
    function findMasked(chunk) {
      let i = 0;
      let frameAt = scan.phase === 0 ? 0 : -1;
      while (i < chunk.length) {
        if (scan.phase === 0) { scan.phase = 1; frameAt = i; i++; } else if (scan.phase === 1) {
          const b = chunk[i++];
          if (b & 0x80) return frameAt;
          const len = b & 0x7f;
          scan.ext = [];
          if (len === 126) { scan.extLeft = 2; scan.phase = 2; } else if (len === 127) { scan.extLeft = 8; scan.phase = 2; } else if (len > 0) { scan.payloadLeft = len; scan.phase = 3; } else scan.phase = 0;
        } else if (scan.phase === 2) {
          scan.ext.push(chunk[i++]);
          if (--scan.extLeft === 0) {
            scan.payloadLeft = scan.ext.reduce((a, v) => a * 256 + v, 0);
            scan.phase = scan.payloadLeft > 0 ? 3 : 0;
          }
        } else {
          const n = Math.min(scan.payloadLeft, chunk.length - i);
          i += n;
          scan.payloadLeft -= n;
          if (scan.payloadLeft === 0) scan.phase = 0;
        }
      }
      return null;
    }

    function feed(chunk, recvMs) {
      if (closeInfo) return;
      const maskedAt = findMasked(chunk);
      if (maskedAt !== null) {
        feedParsed(chunk.subarray(0, Math.max(0, maskedAt)), recvMs);
        if (closeInfo) return;
        sendClose(1002);
        finish(1002, 'masked server frame');
        return;
      }
      feedParsed(chunk, recvMs);
    }

    function feedParsed(chunk, recvMs) {
      for (const ev of parser.push(chunk)) {
        if (closeInfo) return;
        if (ev.type === 'message') deliver(ev.data, recvMs);
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
      const recvMs = now();
      if (upgraded) { feed(chunk, recvMs); return; }
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
      handle.connectedMs = recvMs; // handshake-complete time: now() at the entry of the data event that finished the head
      settled = true;
      clearTimeout(connectTimer);
      resolve(handle);
      if (rest.length > 0) feed(rest, recvMs);
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
        while (msgCb && queue.length > 0) { const [d, t] = queue.shift(); msgCb(d, t); }
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
