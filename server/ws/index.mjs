// 웹소켓 서버 골격(T11.3). node:http upgrade + RFC 6455 직접 구현(server/ws/frame).
// 주소·포트는 코드에 두지 않는다: loadConfig(env) 가 SKYLENS_WS_HOST, SKYLENS_WS_PORT 에서 읽고 없으면 오류.
// 접속 객체: { send(Uint8Array), onMessage(cb), onClose(cb), close(), bufferedAmount() }
//   onMessage(cb): cb(Uint8Array) 완성된 이진 메시지(분할 프레임은 조립 후 한 번).
//   onClose(cb): cb({ code, reason }) 연결이 끝날 때 한 번.
//   bufferedAmount(): 아직 소켓으로 나가지 못하고 쌓인 바이트(배압 판단용).
import http from 'node:http';
import { createHash } from 'node:crypto';
import { FrameParser, encodeFrame, encodeClosePayload, OPCODES } from './frame/index.mjs';

export const ENV_HOST = 'SKYLENS_WS_HOST';
export const ENV_PORT = 'SKYLENS_WS_PORT';
const HANDSHAKE_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CLOSE_WAIT_MS = 2000;

/** 환경 변수에서 { host, port } 를 읽는다. 없거나 잘못되면 오류. */
export function loadConfig(env) {
  const host = env?.[ENV_HOST];
  const rawPort = env?.[ENV_PORT];
  if (!host) throw new Error(`${ENV_HOST} 가 설정되지 않았다`);
  if (rawPort === undefined || rawPort === '') throw new Error(`${ENV_PORT} 가 설정되지 않았다`);
  if (!/^\d+$/.test(rawPort)) throw new Error(`${ENV_PORT} 는 정수여야 한다`);
  const port = Number(rawPort);
  if (port > 65535) throw new Error(`${ENV_PORT} 범위 오류`);
  return { host, port };
}

export function acceptKey(key) {
  return createHash('sha1').update(key + HANDSHAKE_GUID).digest('base64');
}

function createConnection(socket, head, onError) {
  const parser = new FrameParser();
  let msgCb = () => {};
  let closeCb = () => {};
  let closeSent = false;
  let finished = false;
  let timer = null;
  let result = { code: 1006, reason: '' };
  let failed = false;

  // onError 자체가 던져도 서버는 멈추지 않는다.
  const report = (err, where) => {
    try { onError?.(err, where); } catch { /* 오류 보고 실패는 삼킨다 */ }
  };
  // 소비자 콜백 호출: 던지거나 거절된 약속은 이 연결만 1011 로 닫는다.
  const guarded = (fn, arg, where) => {
    try {
      const r = fn(arg);
      if (r && typeof r.then === 'function') r.then(undefined, (err) => fail(err, where));
    } catch (err) {
      fail(err, where);
    }
  };
  const fail = (err, where) => {
    report(err, where);
    if (failed || finished) return;
    failed = true;
    result = { code: 1011, reason: '' };
    startClose(1011, 'internal error');
  };

  const finish = () => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    socket.destroy();
    try { closeCb(result); } catch (err) { report(err, 'onClose'); }
  };
  const sendClose = (code, reason = '') => {
    if (closeSent || socket.destroyed) return;
    closeSent = true;
    socket.write(encodeFrame(OPCODES.CLOSE, encodeClosePayload(code, reason)));
  };
  const startClose = (code, reason) => {
    sendClose(code, reason);
    if (!timer) { timer = setTimeout(finish, CLOSE_WAIT_MS); timer.unref?.(); }
  };

  const feed = (chunk) => {
    for (const ev of parser.push(chunk)) {
      if (finished || failed) return;
      if (ev.type === 'message') { guarded(msgCb, ev.data, 'onMessage'); if (failed) return; }
      else if (ev.type === 'ping') { if (!closeSent) socket.write(encodeFrame(OPCODES.PONG, ev.data)); }
      else if (ev.type === 'close') {
        result = { code: ev.code, reason: ev.reason };
        if (!closeSent) sendClose(ev.code === 1005 ? 1000 : ev.code);
        // close 에코가 소켓으로 나간 뒤(end 의 완료 콜백)에 끝낸다. 바로 destroy 하면 에코가 유실될 수 있다.
        socket.end(finish);
        return;
      } else if (ev.type === 'error') {
        result = { code: ev.code, reason: ev.reason };
        startClose(ev.code, ev.reason);
        socket.end();
        return;
      }
    }
  };

  socket.on('data', feed);
  socket.on('error', () => {});
  socket.on('close', finish);
  if (head && head.length) queueMicrotask(() => feed(head));

  return {
    send(bytes) {
      if (closeSent || finished) return false;
      return socket.write(encodeFrame(OPCODES.BINARY, bytes));
    },
    onMessage(cb) { msgCb = cb; },
    onClose(cb) { closeCb = cb; },
    close(code = 1000, reason = '') { result = { code, reason }; startClose(code, reason); },
    bufferedAmount() { return socket.writableLength; },
  };
}

/**
 * @param {{host: string, port: number, onConnection: (conn: object) => void, onError?: (err: unknown, where: string) => void}} options
 * @returns {Promise<{server: http.Server, address(): object, close(): Promise<void>}>} listen 이 끝난 뒤 반환.
 */
export function createWsServer({ host, port, onConnection, onError }) {
  if (typeof onConnection !== 'function') throw new TypeError('onConnection 필요');
  const server = http.createServer((req, res) => {
    res.writeHead(426, { Upgrade: 'websocket', 'Content-Length': 0 });
    res.end();
  });
  const sockets = new Set();
  server.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    const ok = req.method === 'GET'
      && String(req.headers.upgrade ?? '').toLowerCase() === 'websocket'
      && /(^|,)\s*upgrade\s*(,|$)/i.test(String(req.headers.connection ?? ''))
      && req.headers['sec-websocket-version'] === '13'
      && typeof key === 'string' && Buffer.from(key, 'base64').length === 16;
    if (!ok) {
      socket.end('HTTP/1.1 400 Bad Request\r\nSec-WebSocket-Version: 13\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
    socket.setNoDelay(true);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    try {
      onConnection(createConnection(socket, head, onError));
    } catch (err) {
      // onConnection 이 던지면 그 소켓만 닫는다.
      try { onError?.(err, 'onConnection'); } catch { /* 보고 실패는 삼킨다 */ }
      socket.destroy();
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve({
        server,
        address: () => server.address(),
        close: () => new Promise((r) => {
          for (const s of sockets) s.destroy();
          server.close(() => r());
        }),
      });
    });
  });
}
