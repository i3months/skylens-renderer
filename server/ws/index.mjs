// 웹소켓 서버 골격(T11.3). node:http upgrade + RFC 6455 직접 구현(server/ws/frame).
// 주소·포트는 코드에 두지 않는다: loadConfig(env) 가 SKYLENS_WS_HOST, SKYLENS_WS_PORT 에서 읽고 없으면 오류.
// 접속 객체: { send(Uint8Array), onMessage(cb), onClose(cb), close(), bufferedAmount() }
//   onMessage(cb): cb(Uint8Array) 완성된 이진 메시지(분할 프레임은 조립 후 한 번).
//   onClose(cb): cb({ code, reason }) 연결이 끝날 때 한 번.
//   bufferedAmount(): 아직 소켓으로 나가지 못하고 쌓인 바이트(배압 판단용).
import http from 'node:http';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { FrameParser, encodeFrame, encodeClosePayload, isValidCloseCode, MAX_CLOSE_REASON_BYTES, OPCODES } from './frame/index.mjs';

export const ENV_HOST = 'SKYLENS_WS_HOST';
export const ENV_PORT = 'SKYLENS_WS_PORT';
const HANDSHAKE_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CLOSE_WAIT_MS = 2000;
// pong 용 쓰기 버퍼 상한: 읽지 않는 클라이언트에게 pong 이 무한히 쌓이는 것을 막는다. 아직 나가지 못한 pong 바이트만 센다
// (send() 로 쌓인 데이터는 세지 않는다: 큰 초기 번들을 받는 중인 정상 클라이언트의 ping 이 1008 을 받지 않도록). 넘기려는 pong 은 쓰지 않고 1008 로 닫는다.
export const DEFAULT_MAX_WRITE_BUFFER = 1 << 20;
// close 프레임을 상한 안에서 보낼 수 있게 pong 판단에서 남겨 두는 여유(close 본문은 최대 125 B + 머리 2 B).
const CLOSE_RESERVE = 256;
// pong 한 개의 최대 크기(머리 2 B + 본문 125 B). maxWriteBuffer 하한이 이 값을 감당해야 첫 ping 에 1008 이 나지 않는다.
const MAX_PONG_FRAME_BYTES = 127;
// ping 속도 제한: 1 초 창마다 허용하는 ping 수. 넘으면 1008.
export const DEFAULT_MAX_PINGS_PER_SECOND = 50;
const PING_WINDOW_MS = 1000;
// send() 상한: 소켓에 쌓인 바이트(writableLength) + 새 프레임이 이 값을 넘으면 그 프레임은 쓰지 않고 false 를 돌려주며
// 연결을 1008('send buffer')로 닫는다. 4 MiB 메시지 여럿을 감당하는 값.
export const DEFAULT_MAX_SEND_BUFFER = 32 << 20;
// 처리 중(약속이 아직 끝나지 않은) onMessage 상한. 가득 차면 소켓 읽기를 멈추고(pause) 끝나는 대로 이어서 처리한다.
export const DEFAULT_MAX_PENDING_MESSAGES = 64;

// close() 인자 정리: 선로에 실을 수 없는 코드는 1005 면 1000, 그 밖에는 1011 로 바꾸고 사유는 123 B 로 UTF-8 경계에서 자른다.
function sanitizeClose(code, reason) {
  const c = isValidCloseCode(code) ? code : (code === 1005 ? 1000 : 1011);
  let r = Buffer.from(typeof reason === 'string' ? reason : '', 'utf8');
  if (r.length > MAX_CLOSE_REASON_BYTES) {
    let n = MAX_CLOSE_REASON_BYTES;
    while (n > 0 && (r[n] & 0xc0) === 0x80) n--; // 문자 중간이면 앞으로 물린다
    r = r.subarray(0, n);
  }
  return { code: c, reason: r.toString('utf8') };
}

function checkInt(name, v, min) {
  if (!Number.isInteger(v) || v < min) throw new RangeError(`${name} 는 ${min} 이상의 정수여야 한다: ${String(v)}`);
}

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

function createConnection(socket, head, onError, limits) {
  const parser = new FrameParser();
  let msgCb = () => {};
  let closeCb = () => {};
  let closeSent = false;
  let finished = false;
  let timer = null;
  let result = { code: 1006, reason: '' };
  let failed = false;
  let pingWindowStart = -Infinity;
  let pingCount = 0;
  let pongBytes = 0; // 쓰기 콜백이 오지 않은 pong 바이트(send 데이터 제외)
  let pending = 0; // 끝나지 않은 async onMessage 수
  let paused = false;
  let draining = false;
  const backlog = [];

  // onError 자체가 던져도 서버는 멈추지 않는다.
  const report = (err, where) => {
    try { onError?.(err, where); } catch { /* 오류 보고 실패는 삼킨다 */ }
  };
  // 소비자 콜백 호출: 던지거나 거절된 약속은 이 연결만 1011 로 닫는다.
  const guarded = (fn, arg, where) => {
    try {
      const r = fn(arg);
      if (r && typeof r.then === 'function') {
        pending++;
        r.then(() => { pending--; drain(); }, (err) => { pending--; fail(err, where); drain(); });
      }
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

  // 규칙 위반(상한·속도): 이 연결만 code 로 닫는다. 이미 닫는 중이면 무시.
  const violate = (code, reason) => {
    if (failed || finished || closeSent) return;
    failed = true;
    result = { code, reason };
    startClose(code, reason);
  };
  const onPing = (data) => {
    if (closeSent) return;
    const now = limits.now();
    // 시계가 유한하지 않으면 창을 건드리지 않고 세기만 한다. 되감기면 창 시작만 지금으로 옮기고 횟수는 유지한다
    // (되감기를 번갈아 해도 한도를 우회하지 못한다). 앞으로 간 시간이 한 창 이상일 때만 횟수를 지운다.
    if (Number.isFinite(now)) {
      const elapsed = now - pingWindowStart;
      if (elapsed < 0) pingWindowStart = now;
      else if (elapsed >= PING_WINDOW_MS) { pingWindowStart = now; pingCount = 0; }
    }
    if (++pingCount > limits.maxPingsPerSecond) return violate(1008, 'ping rate');
    const frame = encodeFrame(OPCODES.PONG, data);
    if (pongBytes + frame.length > limits.maxWriteBuffer - CLOSE_RESERVE) return violate(1008, 'write buffer');
    pongBytes += frame.length;
    socket.write(frame, () => { pongBytes -= frame.length; });
  };

  const finish = () => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    socket.destroy();
    try { closeCb(result); } catch (err) { report(err, 'onClose'); }
  };
  const armTimer = () => {
    if (!timer) { timer = setTimeout(finish, CLOSE_WAIT_MS); timer.unref?.(); }
  };
  const sendClose = (code, reason = '') => {
    if (closeSent || socket.destroyed) return;
    closeSent = true;
    try {
      socket.write(encodeFrame(OPCODES.CLOSE, encodeClosePayload(code, reason)));
    } catch (err) { report(err, 'close'); }
  };
  const startClose = (code, reason) => {
    try { sendClose(code, reason); } finally { armTimer(); }
  };

  // 이벤트를 쌓아 두고 drain 이 차례로 처리한다. 처리 중 메시지가 상한에 닿으면 읽기를 멈추고 남은 이벤트는 backlog 에 둔다
  // (backlog 는 읽은 청크 하나 분량으로 한정된다).
  const drain = () => {
    if (draining) return;
    draining = true;
    try {
      while (backlog.length) {
        if (failed || finished) { backlog.length = 0; return; }
        const ev = backlog[0];
        if (ev.type === 'message' && pending >= limits.maxPendingMessages) {
          if (!paused) { paused = true; socket.pause(); }
          return;
        }
        backlog.shift();
        if (ev.type === 'message') guarded(msgCb, ev.data, 'onMessage');
        else if (ev.type === 'ping') onPing(ev.data);
        else if (ev.type === 'close') {
          backlog.length = 0;
          result = { code: ev.code, reason: ev.reason };
          if (!closeSent) sendClose(ev.code === 1005 ? 1000 : ev.code);
          // close 에코가 소켓으로 나간 뒤(end 의 완료 콜백)에 끝낸다. 바로 destroy 하면 에코가 유실될 수 있다.
          // 상대가 읽지 않아 end 가 끝나지 않을 때를 위해 시한도 건다.
          armTimer();
          socket.end(finish);
          return;
        } else if (ev.type === 'error') {
          backlog.length = 0;
          result = { code: ev.code, reason: ev.reason };
          startClose(ev.code, ev.reason);
          socket.end();
          return;
        }
      }
      if (paused && !finished) { paused = false; socket.resume(); }
    } finally {
      draining = false;
    }
  };
  const feed = (chunk) => {
    if (failed || finished) return; // 닫는 중에는 더 해석하지 않는다
    backlog.push(...parser.push(chunk));
    drain();
  };

  socket.on('data', feed);
  socket.on('error', () => {});
  // 상대가 close 프레임 없이 FIN 만 보내면 끝낸다(result 기본값 1006, 이미 정해진 코드는 유지).
  // 이미 닫는 중이면 아무것도 하지 않는다: 쌓인 데이터와 close 에코를 socket.end(finish) 가 내보낸 뒤 끝낸다.
  socket.on('end', () => {
    if (closeSent || failed || finished) return;
    closeSent = true; // 더 쓰지 않는다
    armTimer();
    socket.end(finish);
  });
  socket.on('close', finish);
  if (head && head.length) queueMicrotask(() => feed(head));

  return {
    send(bytes) {
      if (closeSent || finished) return false;
      const frame = encodeFrame(OPCODES.BINARY, bytes);
      // 상한 초과: 쓰지 않고 false, 연결은 1008 로 닫는다. (true/false 는 소켓 배압 신호이며 false 여도 데이터는 쌓인다.)
      if (socket.writableLength + frame.length > limits.maxSendBuffer) { violate(1008, 'send buffer'); return false; }
      return socket.write(frame);
    },
    onMessage(cb) { msgCb = cb; },
    onClose(cb) { closeCb = cb; },
    close(code = 1000, reason = '') {
      const c = sanitizeClose(code, reason);
      result = c;
      startClose(c.code, c.reason);
    },
    bufferedAmount() { return socket.writableLength; },
  };
}

/**
 * @param {{host: string, port: number, wire?: {onConnection: Function, stats: Function}, maxWriteBuffer?: number, maxPingsPerSecond?: number, maxSendBuffer?: number, maxPendingMessages?: number, now?: () => number, onConnection?: (conn: object) => void, onError?: (err: unknown, where: string) => void}} options
 * @returns {Promise<{server: http.Server, address(): object, close(): Promise<void>}>} listen 이 끝난 뒤 반환.
 */
export function createWsServer({ host, port, onConnection: onConnectionOpt, wire, onError, maxWriteBuffer = DEFAULT_MAX_WRITE_BUFFER, maxPingsPerSecond = DEFAULT_MAX_PINGS_PER_SECOND, maxSendBuffer = DEFAULT_MAX_SEND_BUFFER, maxPendingMessages = DEFAULT_MAX_PENDING_MESSAGES, now = () => performance.now() }) {
  // wire(server/ws/wire 의 createWire 결과)가 있으면 접속마다 wire.onConnection 으로 attachConnection 을 배선하고 stats() 를 노출한다.
  const onConnection = typeof onConnectionOpt === 'function' ? onConnectionOpt : wire?.onConnection?.bind(wire);
  if (typeof onConnection !== 'function') throw new TypeError('onConnection 필요');
  checkInt('maxWriteBuffer', maxWriteBuffer, CLOSE_RESERVE + MAX_PONG_FRAME_BYTES + 1);
  checkInt('maxPingsPerSecond', maxPingsPerSecond, 1);
  checkInt('maxSendBuffer', maxSendBuffer, 1);
  checkInt('maxPendingMessages', maxPendingMessages, 1);
  if (typeof now !== 'function') throw new TypeError('now 는 함수여야 한다');
  const limits = { maxWriteBuffer, maxPingsPerSecond, maxSendBuffer, maxPendingMessages, now };
  const server = http.createServer((req, res) => {
    res.writeHead(426, { Upgrade: 'websocket', 'Content-Length': 0 });
    res.end();
  });
  const sockets = new Set();
  server.on('upgrade', (req, socket, head) => {
    // 거절 경로(400)에서도 상대의 RST 가 uncaughtException 이 되지 않게 가장 먼저 단다.
    const onHandshakeError = (err) => { try { onError?.(err, 'handshake'); } catch { /* 보고 실패는 삼킨다 */ } };
    socket.on('error', onHandshakeError);
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
    // 핸드셰이크 오류 처리기는 101 뒤에 떼고, 이후 오류는 연결 쪽 처리기가 삼킨다('handshake' 로 오보하지 않는다).
    socket.removeListener('error', onHandshakeError);
    socket.on('error', () => {});
    socket.setNoDelay(true);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    try {
      onConnection(createConnection(socket, head, onError, limits));
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
        stats: () => (wire ? wire.stats() : null),
        close: () => new Promise((r) => {
          for (const s of sockets) s.destroy();
          server.close(() => r());
        }),
      });
    });
  });
}
