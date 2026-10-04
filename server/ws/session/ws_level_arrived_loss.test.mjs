// F-238 ④ 확인 기준: 실제 웹소켓 경로에서 LEVEL_ARRIVED 프레임만 유실 → HELLO 재개 → 그 LEVEL_ARRIVED 를 다시 받고
// 클라이언트 draw 에 조각 n 개의 key 가 모두 들어간다.
//
// 경로: 코어 어댑터(server/adapter/core) → attachConnection(server/ws/session 계약) → server/ws 접속 객체 → TCP →
//       시험용 최소 웹소켓 클라이언트(node:net, 핸드셰이크 + 마스킹 프레임. server/ws/ws.test.mjs 와 같은 방식) →
//       client/proto 복호 → contracts/client_raster(collectArrivals·selectDrawable).
// 유실 흉내: 첫 연결의 접속 객체를 서버 쪽에서 감싸 LEVEL_ARRIVED 프레임만 소켓에 쓰지 않고 버린다(PIECE 는 그대로 나간다).
// 대조군: 같은 시나리오에서 어댑터의 emit 을 시험이 만든 래퍼로 바꿔 LEVEL_ARRIVED 를 저장소 기록(recordLevelArrived) 없이
//       접속 객체로 바로 보낸다. 그러면 이어받기 재전송 목록에 완료 표시가 없어 완료 key 0 개(영구 pending, F-236 재현)다.
// 주소: 루프백 주소는 운영체제 인터페이스에서 읽고(리터럴 없음) 포트는 0(임시 포트), 이후에는 server.address() 만 본다.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import { attachConnection } from './index.mjs';
import { createWsServer, acceptKey } from '../index.mjs';
import { FrameParser, encodeFrame, OPCODES } from '../frame/index.mjs';
import { createSessionStore } from '../resume/index.mjs';
import { createCoreAdapter } from '../../adapter/core/index.mjs';
import { encodeMessage as serverEncode } from '../../proto/codec/index.mjs';
import { encodeMessage as clientEncode, decodeMessage as clientDecode } from '../../../client/proto/index.mjs';
import { MSG, pieceKeyString } from '../../../contracts/proto/index.mjs';
import { collectArrivals, pieceKeyToString } from '../../../contracts/client_raster/arrival.mjs';
import { selectDrawable } from '../../../contracts/client_raster/index.mjs';

// ── 기준값 ───────────────────────────────────────────────────────────
const SEGMENT_ID = 9;
const LEVEL = 1;
const PIECE_COUNT = 3; // 송출·수신 조각 수
const EXPECTED_COMPLETED = 3; // 이어받기 뒤 완료 key 수(= draw key 수)
const EXPECTED_CONTROL_COMPLETED = 0; // 대조군(recordLevelArrived 없음)의 완료 key 수
const NEXT_TIMEOUT_MS = 3000;
// 더 오는 프레임이 없음을 확인하는 대기. 서버는 WELCOME 과 재전송을 한 동기 처리 안에서 쓰므로 루프백에서는 넉넉하다.
const QUIET_MS = 150;
const MASK = Buffer.from([1, 2, 3, 4]);

// 같은 타일·같은 LOD 의 chunk 0..n−1(그 수준의 조각 전부). 바이트는 chunk 마다 다르게.
const PIECES = Array.from({ length: PIECE_COUNT }, (_, c) => ({
  key: { segmentId: SEGMENT_ID, level: LEVEL, lod: 0, chunkIndex: c, tileX: 0, tileY: 0 },
  bytes: Uint8Array.from({ length: 8 + c }, (_, i) => (SEGMENT_ID * 31 + c * 7 + i) & 0xff),
}));
// 클라이언트 key 는 ASSET_FORMAT §11 정규 문자열(contracts/proto 의 pieceKeyString 과 모양이 다르다).
const EXPECTED_KEYS = PIECES.map((p) => pieceKeyToString(p.key));

// 시험이 중간에 실패해도 서버·소켓이 남지 않게 모아 두었다가 정리한다.
const openServers = new Set();
const openSockets = new Set();
afterEach(async () => {
  for (const s of openSockets) s.destroy();
  openSockets.clear();
  await Promise.all([...openServers].map((w) => w.close()));
  openServers.clear();
});

/** 시험용 최소 웹소켓 클라이언트. 이진 메시지는 client/proto 로 복호해 돌려준다. */
function connect(ws) {
  const { address, port } = ws.address();
  const wsKey = Buffer.from('0123456789abcdef').toString('base64');
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: address, port });
    openSockets.add(sock);
    const parser = new FrameParser({ requireMask: false });
    const events = [];
    const waiters = [];
    let head = Buffer.alloc(0);
    let upgraded = false;
    let ended = false;
    const deadline = setTimeout(() => { if (!upgraded) { sock.destroy(); reject(new Error('connect() 시간 초과')); } }, NEXT_TIMEOUT_MS);
    const pump = () => { for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i]()) waiters.splice(i, 1); };
    sock.on('data', (d) => {
      if (!upgraded) {
        head = Buffer.concat([head, d]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) return;
        const text = head.subarray(0, end).toString();
        upgraded = true;
        clearTimeout(deadline);
        if (!/^HTTP\/1\.1 101/.test(text)) { reject(new Error(text)); return; }
        assert.ok(text.includes(`Sec-WebSocket-Accept: ${acceptKey(wsKey)}`));
        events.push(...parser.push(head.subarray(end + 4)));
        resolve(api);
        pump();
        return;
      }
      events.push(...parser.push(d));
      pump();
    });
    sock.on('close', () => { ended = true; pump(); });
    sock.on('error', () => {});
    sock.write(`GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${wsKey}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    /** 다음 프레임 이벤트. ms 안에 없으면 null(끊김도 null). */
    const nextEvent = (ms) => new Promise((res) => {
      let timer;
      const check = () => {
        if (events.length) { clearTimeout(timer); res(events.shift()); return true; }
        if (ended) { clearTimeout(timer); res(null); return true; }
        return false;
      };
      if (check()) return;
      timer = setTimeout(() => { const i = waiters.indexOf(check); if (i >= 0) waiters.splice(i, 1); res(null); }, ms);
      waiters.push(check);
    });
    const api = {
      sock,
      sendMsg: (m) => sock.write(encodeFrame(OPCODES.BINARY, clientEncode(m), { maskKey: MASK })),
      /** 다음 메시지(복호). 시한 안에 없으면 실패. */
      async nextMsg() {
        const ev = await nextEvent(NEXT_TIMEOUT_MS);
        assert.ok(ev, `메시지를 ${NEXT_TIMEOUT_MS} ms 안에 받지 못함`);
        assert.equal(ev.type, 'message', `이진 메시지가 아닌 프레임: ${ev.type}`);
        return clientDecode(new Uint8Array(ev.data));
      },
      /** QUIET_MS 동안 더 오는 메시지를 모은다(없어야 하는 곳에서 단언용). */
      async drain() {
        const got = [];
        for (let ev = await nextEvent(QUIET_MS); ev; ev = await nextEvent(QUIET_MS)) {
          if (ev.type === 'message') got.push(clientDecode(new Uint8Array(ev.data)));
        }
        return got;
      },
    };
  });
}

/**
 * 시나리오 하나를 돌리고 클라이언트가 본 세션 수신 이력과 판정 결과를 돌려준다.
 * @param {{ recordLevelArrived: boolean }} opt false 면 대조군(LEVEL_ARRIVED 를 저장소 기록 없이 보낸다)
 */
async function runScenario({ recordLevelArrived }) {
  const store = createSessionStore({ maxSessions: 4, ttlMs: 60_000, now: () => 0 });
  const stored = new Map(PIECES.map((p) => [pieceKeyString(p.key), p.bytes]));
  const loadPiece = (key) => stored.get(pieceKeyString(key)) ?? null;

  let lossy = true; // 첫 연결만 LEVEL_ARRIVED 를 잃는다
  let droppedLevelArrived = 0;
  let sentPieces = 0;
  const server = [];
  const ws = await createWsServer({
    host: loopbackHost(),
    port: 0,
    onConnection(raw) {
      const dropping = lossy;
      let userClose = () => {};
      let markClosed;
      const closed = new Promise((r) => { markClosed = r; });
      raw.onClose((info) => { try { userClose(info); } finally { markClosed(info); } });
      // 서버 쪽 send 래퍼: 프레임 머리 첫 바이트(메시지 종류)가 LEVEL_ARRIVED 면 소켓에 쓰지 않고 버린다.
      const wire = {
        send(bytes) {
          if (bytes[0] === MSG.LEVEL_ARRIVED && dropping) { droppedLevelArrived += 1; return true; }
          if (bytes[0] === MSG.PIECE) sentPieces += 1;
          return raw.send(bytes);
        },
        onMessage: (cb) => raw.onMessage(cb),
        onClose: (cb) => { userClose = cb; },
        close: (code, reason) => raw.close(code, reason),
        bufferedAmount: () => raw.bufferedAmount(),
      };
      let markSession;
      const session = new Promise((r) => { markSession = r; });
      const attached = attachConnection({ conn: wire, store, loadPiece, onSession: (sessionId, info) => markSession({ sessionId, ...info }) });
      server.push({ wire, attached, session, closed });
    },
  });
  openServers.add(ws);

  // ① 첫 연결: 새 세션.
  const c1 = await connect(ws);
  c1.sendMsg({ type: 'HELLO', sessionId: 0, lastPieceSeq: 0 });
  const welcome1 = await c1.nextMsg();
  assert.equal(welcome1.type, 'WELCOME');
  assert.equal(welcome1.resumed, false);
  const s1 = await server[0].session;
  assert.equal(s1.sessionId, welcome1.sessionId);

  // ② 어댑터로 구간 9 수준 1 조각 3개를 송출한다. 대조군은 LEVEL_ARRIVED 만 기록 없이 접속 객체로 바로 보낸다.
  const { attached, wire } = server[0];
  const emit = recordLevelArrived
    ? (m) => attached.emit(m)
    : (m) => (m.type === 'LEVEL_ARRIVED' ? wire.send(serverEncode(m)) : attached.emit(m));
  const adapter = createCoreAdapter({ emit });
  const result = adapter.handle({ kind: 'level_arrived', segmentId: SEGMENT_ID, level: LEVEL, pieces: PIECES });
  assert.equal(result.action, 'first');

  const pieces = [];
  for (let i = 0; i < PIECE_COUNT; i++) pieces.push(await c1.nextMsg());
  assert.deepEqual(pieces.map((m) => m.type), Array(PIECE_COUNT).fill('PIECE'));
  assert.deepEqual(pieces.map((m) => m.pieceSeq), [1, 2, 3]);
  assert.deepEqual(pieces.map((m) => pieceKeyToString(m.key)), EXPECTED_KEYS);
  // LEVEL_ARRIVED 는 선에 나가지 않았다(서버에서 1건 버림, 클라이언트는 아무것도 더 받지 않음).
  assert.equal(droppedLevelArrived, 1);
  assert.deepEqual(await c1.drain(), []);

  // ③ 연결 끊김. 세션은 저장소에 남는다.
  c1.sock.destroy();
  await server[0].closed;

  // ④ 새 연결에서 이어받기: HELLO(sessionId, lastPieceSeq=3).
  lossy = false;
  const c2 = await connect(ws);
  c2.sendMsg({ type: 'HELLO', sessionId: welcome1.sessionId, lastPieceSeq: PIECE_COUNT });
  const welcome2 = await c2.nextMsg();
  assert.equal(welcome2.type, 'WELCOME');
  assert.equal(welcome2.resumed, true);
  assert.equal(welcome2.sessionId, welcome1.sessionId);
  const after = await c2.drain();
  c2.sock.destroy();

  // ⑤ 클라이언트 판정: 세션 수신 이력 전체(첫 WELCOME 부터)로 완료 key 와 draw 를 만든다.
  const history = [welcome1, ...pieces, welcome2, ...after];
  const { keys, arrived } = collectArrivals(history);
  const completed = arrived.flatMap((a) => a.keys);
  const drawable = selectDrawable(keys, arrived);
  return { sentPieces, droppedLevelArrived, pieces, after, keys, arrived, completed, drawable };
}

function loopbackHost() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.internal && a.family === 'IPv4') return a.address;
  }
  throw new Error('loopback 인터페이스 없음');
}

test('F-238 ④: LEVEL_ARRIVED 프레임만 유실 → HELLO 재개 → LEVEL_ARRIVED 재수신, draw 에 조각 3개 key', async () => {
  const r = await runScenario({ recordLevelArrived: true });
  assert.equal(r.sentPieces, PIECE_COUNT);
  assert.equal(r.pieces.length, PIECE_COUNT);
  // 재개 뒤 정확히 LEVEL_ARRIVED 1건(조각은 lastPieceSeq 로 확인돼 다시 오지 않는다).
  assert.equal(r.after.length, 1);
  assert.deepEqual(r.after[0], { type: 'LEVEL_ARRIVED', segmentId: SEGMENT_ID, level: LEVEL, pieceCount: PIECE_COUNT, firstPieceSeq: 1 });
  assert.equal(r.arrived.length, 1);
  assert.equal(r.completed.length, EXPECTED_COMPLETED);
  assert.deepEqual(r.completed, EXPECTED_KEYS);
  assert.equal(r.drawable.draw.length, EXPECTED_COMPLETED);
  assert.deepEqual([...r.drawable.draw].sort(), [...EXPECTED_KEYS].sort());
  assert.deepEqual(r.drawable.pending, []);
});

test('대조군: 배선에서 recordLevelArrived 를 빼면 재개 뒤에도 완료 key 0 개(영구 pending, F-236 재현)', async () => {
  const r = await runScenario({ recordLevelArrived: false });
  assert.equal(r.sentPieces, PIECE_COUNT);
  assert.equal(r.droppedLevelArrived, 1);
  // 저장소에 완료 표시 기록이 없으니 이어받기가 되살릴 것이 없다.
  assert.deepEqual(r.after, []);
  assert.equal(r.arrived.length, 0);
  assert.equal(r.completed.length, EXPECTED_CONTROL_COMPLETED);
  assert.deepEqual(r.drawable.draw, []);
  assert.deepEqual([...r.drawable.pending].sort(), [...EXPECTED_KEYS].sort());
});
