// 모의 클라이언트 시험(T11.9)

import assert from 'assert';
import { createMockClient, createLoopbackPair } from './index.mjs';
import { MSG, PROTO_VERSION, FRAME_HEADER_BYTES } from '../../contracts/proto/index.mjs';

/**
 * 시험용 최소 codec 구현(서버/클라이언트 계약 구현 전 임시).
 * 실제로는 server/proto/codec 과 client/proto 가 이를 내보낸다.
 */
class MinimalCodec {
  encodeMessage(message) {
    const type = message.type;
    let typeNum = MSG[type];
    if (typeNum === undefined) throw new Error(`unknown message type: ${type}`);

    let payload;
    switch (type) {
      case 'HELLO':
        payload = new Uint8Array(9);
        const dv1 = new DataView(payload.buffer);
        dv1.setUint32(0, message.sessionId, true);
        dv1.setUint32(4, message.lastPieceSeq, true);
        payload[8] = 0; // flags
        break;
      case 'VIEW_UPDATE': {
        payload = new Uint8Array(40);
        const dv2 = new DataView(payload.buffer);
        dv2.setUint32(0, message.viewSeq, true);
        dv2.setFloat32(4, message.pos[0], true);
        dv2.setFloat32(8, message.pos[1], true);
        dv2.setFloat32(12, message.pos[2], true);
        dv2.setFloat32(16, message.quat[0], true);
        dv2.setFloat32(20, message.quat[1], true);
        dv2.setFloat32(24, message.quat[2], true);
        dv2.setFloat32(28, message.quat[3], true);
        dv2.setFloat32(32, message.fovY, true);
        dv2.setUint16(36, message.width, true);
        dv2.setUint16(38, message.height, true);
        break;
      }
      case 'PIECE_REQUEST': {
        const itemCount = message.items.length;
        payload = new Uint8Array(6 + 16 * itemCount);
        const dv3 = new DataView(payload.buffer);
        dv3.setUint32(0, message.reqId, true);
        dv3.setUint16(4, itemCount, true);
        let offset = 6;
        for (const item of message.items) {
          dv3.setUint32(offset, item.segmentId, true);
          payload[offset + 4] = item.level;
          payload[offset + 5] = item.lod;
          dv3.setUint16(offset + 6, item.chunkIndex, true);
          dv3.setInt32(offset + 8, item.tileX, true);
          dv3.setInt32(offset + 12, item.tileY, true);
          offset += 16;
        }
        break;
      }
      case 'ACK': {
        payload = new Uint8Array(4);
        const dv4 = new DataView(payload.buffer);
        dv4.setUint32(0, message.upToPieceSeq, true);
        break;
      }
      default:
        throw new Error(`cannot encode message type: ${type}`);
    }

    // 프레임 헤더 + 본문
    const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
    const dvh = new DataView(frame.buffer);
    frame[0] = typeNum;
    frame[1] = PROTO_VERSION;
    // frame[2:4] reserved = 0
    dvh.setUint32(4, payload.length, true);
    frame.set(payload, FRAME_HEADER_BYTES);
    return frame;
  }

  decodeMessage(bytes) {
    if (bytes.length < FRAME_HEADER_BYTES) throw new Error('frame too short');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const type = bytes[0];
    const version = bytes[1];
    if (version !== PROTO_VERSION) throw new Error(`version mismatch: ${version}`);

    const payloadLength = dv.getUint32(4, true);
    if (FRAME_HEADER_BYTES + payloadLength !== bytes.length) {
      throw new Error(`length mismatch: header says ${payloadLength}, got ${bytes.length - FRAME_HEADER_BYTES}`);
    }

    const payload = bytes.slice(FRAME_HEADER_BYTES);
    const pdv = new DataView(payload.buffer, payload.byteOffset, payload.length);

    switch (type) {
      case MSG.HELLO: {
        return {
          type: 'HELLO',
          sessionId: pdv.getUint32(0, true),
          lastPieceSeq: pdv.getUint32(4, true),
        };
      }
      case MSG.VIEW_UPDATE: {
        return {
          type: 'VIEW_UPDATE',
          viewSeq: pdv.getUint32(0, true),
          pos: [pdv.getFloat32(4, true), pdv.getFloat32(8, true), pdv.getFloat32(12, true)],
          quat: [pdv.getFloat32(16, true), pdv.getFloat32(20, true), pdv.getFloat32(24, true), pdv.getFloat32(28, true)],
          fovY: pdv.getFloat32(32, true),
          width: pdv.getUint16(36, true),
          height: pdv.getUint16(38, true),
        };
      }
      case MSG.PIECE_REQUEST: {
        const reqId = pdv.getUint32(0, true);
        const itemCount = pdv.getUint16(4, true);
        const items = [];
        let offset = 6;
        for (let i = 0; i < itemCount; i++) {
          items.push({
            segmentId: pdv.getUint32(offset, true),
            level: payload[offset + 4],
            lod: payload[offset + 5],
            chunkIndex: pdv.getUint16(offset + 6, true),
            tileX: pdv.getInt32(offset + 8, true),
            tileY: pdv.getInt32(offset + 12, true),
          });
          offset += 16;
        }
        return { type: 'PIECE_REQUEST', reqId, items };
      }
      case MSG.ACK: {
        return {
          type: 'ACK',
          upToPieceSeq: pdv.getUint32(0, true),
        };
      }
      default:
        throw new Error(`unknown message type: ${type}`);
    }
  }
}

// 시험 1: 루프백 쌍 기본 기능
await (async () => {
  const { a, b } = createLoopbackPair();
  const received = [];

  b.onMessage((bytes) => {
    received.push(bytes);
  });

  const testBytes = new Uint8Array([1, 2, 3, 4, 5]);
  a.send(testBytes);

  // 비동기이지만 시험 안에서 즉시 확인할 수 있어야 함(microtask 대기)
  await Promise.resolve();

  assert.strictEqual(received.length, 1, '루프백 수신 메시지 1개');
  assert.deepStrictEqual(received[0], testBytes, '루프백 메시지 내용 일치');
})();

// 시험 2: 모의 클라이언트와 서버 핸들러
await (async () => {
  const { a: clientTransport, b: serverTransport } = createLoopbackPair();
  const codec = new MinimalCodec();

  // 서버 측: 메시지 수신 대기
  const serverReceived = [];
  serverTransport.onMessage((bytes) => {
    const msg = codec.decodeMessage(bytes);
    serverReceived.push(msg);
  });

  // 클라이언트 측
  let timeMs = 0;
  const client = createMockClient({
    transport: clientTransport,
    codec,
    now: () => timeMs,
  });

  // 단순 메시지 전송
  client.hello(123, 456);
  await Promise.resolve();
  assert.strictEqual(serverReceived.length, 1, '서버가 HELLO 수신');
  assert.strictEqual(serverReceived[0].type, 'HELLO', 'HELLO 타입 확인');
  assert.strictEqual(serverReceived[0].sessionId, 123, 'sessionId 일치');
  assert.strictEqual(serverReceived[0].lastPieceSeq, 456, 'lastPieceSeq 일치');

  client.sendView({
    viewSeq: 1,
    pos: [1.5, 2.5, 3.5],
    quat: [0, 0, 0, 1],
    fovY: 1.57,
    width: 800,
    height: 600,
  });
  await Promise.resolve();
  assert.strictEqual(serverReceived.length, 2, '서버가 VIEW_UPDATE 수신');
  assert.strictEqual(serverReceived[1].type, 'VIEW_UPDATE', 'VIEW_UPDATE 타입 확인');

  client.requestPieces({
    reqId: 999,
    items: [
      { segmentId: 1, level: 0, lod: 2, chunkIndex: 5, tileX: 10, tileY: 20 },
      { segmentId: 2, level: 1, lod: 3, chunkIndex: 7, tileX: 30, tileY: 40 },
    ],
  });
  await Promise.resolve();
  assert.strictEqual(serverReceived.length, 3, '서버가 PIECE_REQUEST 수신');
  assert.strictEqual(serverReceived[2].type, 'PIECE_REQUEST', 'PIECE_REQUEST 타입 확인');
  assert.strictEqual(serverReceived[2].items.length, 2, '요청 항목 2개');

  client.ack(789);
  await Promise.resolve();
  assert.strictEqual(serverReceived.length, 4, '서버가 ACK 수신');
  assert.strictEqual(serverReceived[3].type, 'ACK', 'ACK 타입 확인');
  assert.strictEqual(serverReceived[3].upToPieceSeq, 789, 'upToPieceSeq 일치');
})();

// 시험 3: 20단계 경로 스크립트 재생
await (async () => {
  const { a: clientTransport, b: serverTransport } = createLoopbackPair();
  const codec = new MinimalCodec();

  const serverReceived = [];
  serverTransport.onMessage((bytes) => {
    const msg = codec.decodeMessage(bytes);
    serverReceived.push(msg);
  });

  let timeMs = 0;
  const client = createMockClient({
    transport: clientTransport,
    codec,
    now: () => timeMs,
  });

  // 20단계 스크립트: 시간과 동작을 함께
  const script = [
    { atMs: 0, action: 'view', viewSeq: 0, pos: [0, 0, 0], quat: [0, 0, 0, 1], fovY: 1.5, width: 1024, height: 768 },
    { atMs: 0, action: 'ack', upToPieceSeq: 0 },
    { atMs: 100, action: 'request', reqId: 1, items: [{ segmentId: 1, level: 0, lod: 0, chunkIndex: 0, tileX: 0, tileY: 0 }] },
    { atMs: 100, action: 'view', viewSeq: 1, pos: [1, 0, 0], quat: [0, 0, 0, 1], fovY: 1.5, width: 1024, height: 768 },
    { atMs: 200, action: 'ack', upToPieceSeq: 1 },
    { atMs: 200, action: 'request', reqId: 2, items: [{ segmentId: 2, level: 1, lod: 1, chunkIndex: 1, tileX: 1, tileY: 1 }] },
    { atMs: 300, action: 'view', viewSeq: 2, pos: [2, 0, 0], quat: [0, 0, 0, 1], fovY: 1.5, width: 1024, height: 768 },
    { atMs: 300, action: 'ack', upToPieceSeq: 2 },
    { atMs: 400, action: 'request', reqId: 3, items: [{ segmentId: 3, level: 2, lod: 2, chunkIndex: 2, tileX: 2, tileY: 2 }] },
    { atMs: 400, action: 'view', viewSeq: 3, pos: [3, 0, 0], quat: [0, 0, 0, 1], fovY: 1.5, width: 1024, height: 768 },
    { atMs: 500, action: 'ack', upToPieceSeq: 3 },
    { atMs: 500, action: 'request', reqId: 4, items: [{ segmentId: 4, level: 3, lod: 3, chunkIndex: 3, tileX: 3, tileY: 3 }] },
    { atMs: 600, action: 'view', viewSeq: 4, pos: [4, 0, 0], quat: [0, 0, 0, 1], fovY: 1.5, width: 1024, height: 768 },
    { atMs: 600, action: 'ack', upToPieceSeq: 4 },
    { atMs: 700, action: 'request', reqId: 5, items: [{ segmentId: 5, level: 0, lod: 0, chunkIndex: 4, tileX: 4, tileY: 4 }] },
    { atMs: 700, action: 'view', viewSeq: 5, pos: [5, 0, 0], quat: [0, 0, 0, 1], fovY: 1.5, width: 1024, height: 768 },
    { atMs: 800, action: 'ack', upToPieceSeq: 5 },
    { atMs: 800, action: 'request', reqId: 6, items: [{ segmentId: 6, level: 1, lod: 1, chunkIndex: 5, tileX: 5, tileY: 5 }] },
    { atMs: 900, action: 'view', viewSeq: 6, pos: [6, 0, 0], quat: [0, 0, 0, 1], fovY: 1.5, width: 1024, height: 768 },
    { atMs: 900, action: 'ack', upToPieceSeq: 6 },
  ];

  // 스크립트를 시간 진행과 함께 실행
  const times = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900];
  for (const time of times) {
    timeMs = time;
    await client.run(script);
    await Promise.resolve();
  }

  // 20단계 모두 확인
  assert.strictEqual(serverReceived.length, 20, '서버가 20개 메시지 수신');

  // 메시지 종류와 순서 확인
  const expectedTypes = [
    'VIEW_UPDATE', 'ACK', 'PIECE_REQUEST', 'VIEW_UPDATE', 'ACK',
    'PIECE_REQUEST', 'VIEW_UPDATE', 'ACK', 'PIECE_REQUEST', 'VIEW_UPDATE',
    'ACK', 'PIECE_REQUEST', 'VIEW_UPDATE', 'ACK', 'PIECE_REQUEST',
    'VIEW_UPDATE', 'ACK', 'PIECE_REQUEST', 'VIEW_UPDATE', 'ACK',
  ];

  for (let i = 0; i < 20; i++) {
    assert.strictEqual(
      serverReceived[i].type,
      expectedTypes[i],
      `메시지 ${i}의 타입 일치 (받음: ${serverReceived[i].type}, 기대: ${expectedTypes[i]})`
    );
  }

  // received 배열에도 누적 확인(클라이언트 쪽이 아니라 서버가 받은 것이므로 생략 가능하지만 로직 확인)
  assert.strictEqual(client.received.length, 0, '클라이언트가 받은 메시지 없음(s→c 메시지 없음)');
})();

console.log('모든 시험 통과 (총 3개)');
