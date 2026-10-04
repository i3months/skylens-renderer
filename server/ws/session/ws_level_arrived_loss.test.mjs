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
// '더 오는 프레임 없음' 판정(F-273 ⑤): 벽시계 대기로 판정하지 않는다.
//   - 끝 표지: attachConnection 의 onSession 은 replay(WELCOME·재전송) 가 끝난 뒤 불린다. 그 시점 서버 send 기록 길이를 고정한다.
//   - 클라이언트는 고정한 수만큼 프레임을 받았는지만 확인한다(받을 때까지 기다리며, 시한은 안전용일 뿐 판정에 쓰지 않는다).
//   - 시나리오 동안 setTimeout·setInterval 은 node:test 모의 타이머로 바꿔 둔다. 시험 끝에서 걸려 있던 타이머를 모두
//     결정적으로 실행(runAll)한 뒤 서버 send 기록 길이가 끝 표지 때와 같음을 단언한다. 그래서 replay 뒤 지연 송신
//     (예: 400 ms 뒤 가짜 LEVEL_ARRIVED) 도 실제로 기다리지 않고 기록에 드러난다.
import { test, afterEach, mock } from 'node:test';
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
const NEXT_TIMEOUT_MS = 3000; // 안전 시한(판정에 쓰지 않음)
const MOCKED_TIMER_APIS = ['setTimeout', 'setInterval'];
// 모의 타이머를 켜기 전의 진짜 타이머. 시험 클라이언트의 안전 시한은 이것을 쓴다.
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
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
  mock.timers.reset();
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
    const deadline = realSetTimeout(() => { if (!upgraded) { sock.destroy(); reject(new Error('connect() 시간 초과')); } }, NEXT_TIMEOUT_MS);
    const pump = () => { for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i]()) waiters.splice(i, 1); };
    sock.on('data', (d) => {
      if (!upgraded) {
        head = Buffer.concat([head, d]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) return;
        const text = head.subarray(0, end).toString();
        upgraded = true;
        realClearTimeout(deadline);
        // 핸들러 안의 단언·복호 실패는 throw 로 새지 않게 promise 거절로 넘긴다(F-274 ⑤).
        try {
          if (!/^HTTP\/1\.1 101/.test(text)) throw new Error(text);
          assert.ok(text.includes(`Sec-WebSocket-Accept: ${acceptKey(wsKey)}`), 'Sec-WebSocket-Accept 불일치');
          events.push(...parser.push(head.subarray(end + 4)));
        } catch (err) {
          sock.destroy();
          reject(err);
          return;
        }
        resolve(api);
        pump();
        return;
      }
      try {
        events.push(...parser.push(d));
      } catch (err) {
        // 업그레이드 뒤 프레임 파싱 실패: 끊김으로 처리해 기다리는 쪽이 시한 대신 바로 실패하게 한다.
        sock.destroy(err);
      }
      pump();
    });
    sock.on('close', () => { ended = true; pump(); });
    sock.on('error', () => {});
    sock.write(`GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${wsKey}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    /** 다음 프레임 이벤트. ms 안에 없으면 null(끊김도 null). */
    const nextEvent = (ms) => new Promise((res) => {
      let timer;
      const check = () => {
        if (events.length) { realClearTimeout(timer); res(events.shift()); return true; }
        if (ended) { realClearTimeout(timer); res(null); return true; }
        return false;
      };
      if (check()) return;
      timer = realSetTimeout(() => { const i = waiters.indexOf(check); if (i >= 0) waiters.splice(i, 1); res(null); }, ms);
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
      /** 메시지 n 개(복호). 수만 센다 — '더 없음' 판정은 서버 쪽 send 기록으로 한다. */
      async takeMsgs(n) {
        const got = [];
        for (let i = 0; i < n; i++) got.push(await api.nextMsg());
        return got;
      },
      /** 이미 받아 두고 아직 꺼내지 않은 프레임 수(기다리지 않음). */
      pendingCount: () => events.length,
    };
  });
}

/**
 * 시나리오 하나를 돌리고 클라이언트가 본 세션 수신 이력과 판정 결과를 돌려준다.
 * @param {{ recordLevelArrived: boolean }} opt false 면 대조군(LEVEL_ARRIVED 를 저장소 기록 없이 보낸다)
 */
async function runScenario({ recordLevelArrived }) {
  // 서버·replay 가 거는 타이머는 모의 타이머로 잡아 두었다가 끝에서 결정적으로 모두 실행한다.
  mock.timers.enable({ apis: MOCKED_TIMER_APIS });
  try {
    return await runScenarioBody({ recordLevelArrived });
  } finally {
    mock.timers.reset();
  }
}

async function runScenarioBody({ recordLevelArrived }) {
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
      // 서버 send 기록: sent = 서버가 보내려 한 모든 프레임의 메시지 종류(버린 것 포함), onWire = 그중 소켓에 쓴 것.
      // 기록은 소켓 쓰기보다 먼저 한다(닫힌 뒤의 지연 송신도 기록에 남는다).
      const sent = [];
      const onWire = [];
      // 서버 쪽 send 래퍼: 프레임 머리 첫 바이트(메시지 종류)가 LEVEL_ARRIVED 면 소켓에 쓰지 않고 버린다.
      const wire = {
        send(bytes) {
          sent.push(bytes[0]);
          if (bytes[0] === MSG.LEVEL_ARRIVED && dropping) { droppedLevelArrived += 1; return true; }
          if (bytes[0] === MSG.PIECE) sentPieces += 1;
          onWire.push(bytes[0]);
          return raw.send(bytes);
        },
        onMessage: (cb) => raw.onMessage(cb),
        onClose: (cb) => { userClose = cb; },
        close: (code, reason) => raw.close(code, reason),
        bufferedAmount: () => raw.bufferedAmount(),
      };
      let markSession;
      const session = new Promise((r) => { markSession = r; });
      // 끝 표지: onSession 은 replay(WELCOME·재전송) 가 끝난 뒤 불리므로 그때의 기록 길이 = replay 가 보낸 프레임 수.
      const onSession = (sessionId, info) => markSession({ sessionId, ...info, sentAtEnd: sent.length, onWireAtEnd: onWire.length });
      const attached = attachConnection({ conn: wire, store, loadPiece, onSession });
      server.push({ wire, attached, session, closed, sent, onWire });
    },
  });
  openServers.add(ws);

  // 걸려 있던 (모의) 타이머를 모두 실행한 뒤 그 연결의 서버 send 기록이 기대 길이 그대로인지 단언한다.
  const assertNoMoreSends = (conn, expectedSent, label) => {
    mock.timers.runAll();
    assert.equal(conn.sent.length, expectedSent, `${label}: 끝 표지 뒤 서버가 프레임을 더 보냄(종류 ${conn.sent.slice(expectedSent).join(',')})`);
  };

  // ① 첫 연결: 새 세션.
  const c1 = await connect(ws);
  c1.sendMsg({ type: 'HELLO', sessionId: 0, lastPieceSeq: 0 });
  const welcome1 = await c1.nextMsg();
  assert.equal(welcome1.type, 'WELCOME');
  assert.equal(welcome1.resumed, false);
  const s1 = await server[0].session;
  assert.equal(s1.sessionId, welcome1.sessionId);
  // 새 세션의 replay 는 WELCOME 1건만 보낸다.
  assert.equal(s1.sentAtEnd, 1);
  assert.equal(s1.onWireAtEnd, 1);

  // ② 어댑터로 구간 9 수준 1 조각 3개를 송출한다. 대조군은 LEVEL_ARRIVED 만 기록 없이 접속 객체로 바로 보낸다.
  const { attached, wire } = server[0];
  const emit = recordLevelArrived
    ? (m) => attached.emit(m)
    : (m) => (m.type === 'LEVEL_ARRIVED' ? wire.send(serverEncode(m)) : attached.emit(m));
  const adapter = createCoreAdapter({ emit });
  const result = adapter.handle({ kind: 'level_arrived', segmentId: SEGMENT_ID, level: LEVEL, pieces: PIECES });
  assert.equal(result.action, 'first');
  // 송출 끝 표지: handle 은 동기로 emit 하므로 지금의 기록이 송출 전부다(PIECE 3 + LEVEL_ARRIVED 1, 그중 LEVEL_ARRIVED 는 버림).
  const sentAfterEmit = server[0].sent.length;
  const onWireAfterEmit = server[0].onWire.length;
  assert.equal(sentAfterEmit, 1 + PIECE_COUNT + 1);
  assert.equal(onWireAfterEmit, 1 + PIECE_COUNT);

  const pieces = await c1.takeMsgs(onWireAfterEmit - 1);
  assert.deepEqual(pieces.map((m) => m.type), Array(PIECE_COUNT).fill('PIECE'));
  assert.deepEqual(pieces.map((m) => m.pieceSeq), [1, 2, 3]);
  assert.deepEqual(pieces.map((m) => pieceKeyToString(m.key)), EXPECTED_KEYS);
  // LEVEL_ARRIVED 는 선에 나가지 않았다(서버에서 1건 버림). 서버가 소켓에 쓴 프레임은 클라이언트가 받은 것이 전부다.
  assert.equal(droppedLevelArrived, 1);
  assert.equal(c1.pendingCount(), 0);
  assertNoMoreSends(server[0], sentAfterEmit, '첫 연결');

  // ③ 연결 끊김. 세션은 저장소에 남는다.
  c1.sock.destroy();
  await server[0].closed;

  // ④ 새 연결에서 이어받기: HELLO(sessionId, lastPieceSeq=3).
  lossy = false;
  const c2 = await connect(ws);
  c2.sendMsg({ type: 'HELLO', sessionId: welcome1.sessionId, lastPieceSeq: PIECE_COUNT });
  const s2 = await server[1].session;
  assert.equal(s2.sentAtEnd, s2.onWireAtEnd); // 두 번째 연결은 버리지 않는다
  // 끝 표지까지 서버가 보낸 수만큼 받는다(WELCOME + 재전송).
  const [welcome2, ...after] = await c2.takeMsgs(s2.onWireAtEnd);
  assert.equal(welcome2.type, 'WELCOME');
  assert.equal(welcome2.resumed, true);
  assert.equal(welcome2.sessionId, welcome1.sessionId);
  assert.equal(c2.pendingCount(), 0);
  // 끝 표지 뒤 추가 송신 없음(지연 타이머까지 모두 실행한 뒤에도).
  assertNoMoreSends(server[1], s2.sentAtEnd, '이어받기 연결');
  // 시험 종료 직전 한 번 더: 그사이 첫 연결도 아무것도 더 보내지 않았다.
  assertNoMoreSends(server[0], sentAfterEmit, '첫 연결(종료 직전)');
  c2.sock.destroy();

  // ⑤ 클라이언트 판정: 세션 수신 이력 전체(첫 WELCOME 부터)로 완료 key 와 draw 를 만든다.
  const history = [welcome1, ...pieces, welcome2, ...after];
  const { keys, arrived } = collectArrivals(history);
  const completed = arrived.flatMap((a) => a.keys);
  const drawable = selectDrawable(keys, arrived);
  return { sentPieces, droppedLevelArrived, pieces, after, keys, arrived, completed, drawable };
}

/** 루프백 주소: IPv4 internal 우선, 없으면 IPv6 internal. 주소는 운영체제에서 읽는다(리터럴 없음). */
function loopbackHost() {
  const internal = Object.values(os.networkInterfaces()).flatMap((list) => list ?? []).filter((a) => a.internal);
  const pick = internal.find((a) => a.family === 'IPv4') ?? internal.find((a) => a.family === 'IPv6' && !a.scopeid);
  if (pick) return pick.address;
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
