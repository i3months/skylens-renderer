// 모의 클라이언트 시험(T11.9). 실제 client/proto 로 부호화하고 server/proto/codec 으로 복호한다(자체 codec 없음).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockClient, createLoopbackPair, replayPath, poseFromLookAt } from './index.mjs';
import * as clientCodec from '../../client/proto/index.mjs';
import * as serverCodec from '../../server/proto/codec/index.mjs';
import { dronePath, freePath } from '../../fixtures/paths/index.mjs';

const tick = () => Promise.resolve();

// 서버 쪽 끝: 도착한 바이트를 서버 복호기로 복호해 모은다.
function serverEnd(transport) {
  const got = [];
  transport.onMessage((bytes) => got.push(serverCodec.decodeMessage(bytes)));
  return got;
}

// quat(카메라→ENU)로 회전한 (0,0,1) = 앞 방향
function forwardOf([x, y, z, w]) {
  return [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const conj = ([x, y, z, w]) => [-x, -y, -z, w];
function assertVecClose(actual, expected, eps, msg) {
  assert.equal(actual.length, expected.length, msg);
  actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) <= eps, `${msg} [${i}] ${v} != ${expected[i]}`));
}
const f32 = (a) => a.map(Math.fround);

test('루프백 쌍은 바이트를 그대로 전달한다', async () => {
  const { a, b } = createLoopbackPair();
  const received = [];
  b.onMessage((bytes) => received.push(bytes));
  a.send(new Uint8Array([1, 2, 3, 4, 5]));
  await tick();
  assert.deepEqual(received, [new Uint8Array([1, 2, 3, 4, 5])]);
});

test('모의 클라이언트 메시지가 서버 복호기에서 필드까지 같다', async () => {
  const { a, b } = createLoopbackPair();
  const got = serverEnd(b);
  const client = createMockClient({ transport: a, codec: clientCodec, now: () => 0 });
  const items = [
    { segmentId: 1, level: 0, lod: 2, chunkIndex: 5, tileX: 10, tileY: 20 },
    { segmentId: 2, level: 1, lod: 3, chunkIndex: 7, tileX: -30, tileY: 40 },
  ];
  client.hello(123, 456);
  client.sendView({ viewSeq: 7, pos: [1.5, 2.5, 3.5], quat: [0, 0, 0, 1], fovY: 1.5, width: 800, height: 600 });
  client.requestPieces({ reqId: 999, items });
  client.ack(789);
  await tick();
  assert.deepEqual(got, [
    { type: 'HELLO', sessionId: 123, lastPieceSeq: 456 },
    { type: 'VIEW_UPDATE', viewSeq: 7, pos: [1.5, 2.5, 3.5], quat: [0, 0, 0, 1], fovY: 1.5, width: 800, height: 600 },
    { type: 'PIECE_REQUEST', reqId: 999, items },
    { type: 'ACK', upToPieceSeq: 789 },
  ]);
});

test('run 은 atMs 가 된 동작만 보내고 viewSeq·필드를 그대로 싣는다', async () => {
  const { a, b } = createLoopbackPair();
  const got = serverEnd(b);
  let timeMs = 0;
  const client = createMockClient({ transport: a, codec: clientCodec, now: () => timeMs });
  const item = { segmentId: 3, level: 2, lod: 1, chunkIndex: 4, tileX: 5, tileY: 6 };
  const script = [
    { atMs: 0, action: 'view', viewSeq: 11, pos: [1, 2, 3], quat: [0, 0, 0, 1], fovY: 1.25, width: 640, height: 480 },
    { atMs: 100, action: 'view', viewSeq: 12, pos: [4, 5, 6], quat: [1, 0, 0, 0], fovY: 1.25, width: 640, height: 480 },
    { atMs: 100, action: 'request', reqId: 8, items: [item] },
    { atMs: 250, action: 'ack', upToPieceSeq: 9 },
  ];

  await client.run(script); // 시각 0: 첫 동작만
  await tick();
  assert.equal(got.length, 1, '시각 0 에는 atMs 0 동작 1개뿐');
  assert.deepEqual(got[0], { type: 'VIEW_UPDATE', viewSeq: 11, pos: [1, 2, 3], quat: [0, 0, 0, 1], fovY: 1.25, width: 640, height: 480 });

  timeMs = 99; // 아직 100 에 못 미침
  await client.run(script);
  await tick();
  assert.equal(got.length, 1, '시각 99 에는 새 동작 없음');

  timeMs = 100;
  await client.run(script);
  await tick();
  assert.equal(got.length, 3);
  assert.deepEqual(got[1], { type: 'VIEW_UPDATE', viewSeq: 12, pos: [4, 5, 6], quat: [1, 0, 0, 0], fovY: 1.25, width: 640, height: 480 });
  assert.deepEqual(got[2], { type: 'PIECE_REQUEST', reqId: 8, items: [item] });

  timeMs = 10_000;
  await client.run(script);
  await tick();
  assert.deepEqual(got[3], { type: 'ACK', upToPieceSeq: 9 });
  assert.equal(got.length, 4);
  assert.equal(client.received.length, 0, '서버가 보낸 것이 없으니 클라이언트 수신 0');
});

test('run 이 스크립트에 viewSeq 가 없으면 0 이고, 있으면 값마다 구분된다', async () => {
  const { a, b } = createLoopbackPair();
  const got = serverEnd(b);
  const client = createMockClient({ transport: a, codec: clientCodec, now: () => 0 });
  await client.run([
    { atMs: 0, action: 'view', viewSeq: 5 },
    { atMs: 0, action: 'view', viewSeq: 6 },
    { atMs: 0, action: 'view' },
  ]);
  await tick();
  assert.deepEqual(got.map((m) => m.viewSeq), [5, 6, 0]);
  // 기본 자세: 항등 quat, 원점, 기본 시야·해상도
  assert.deepEqual(got[2], { type: 'VIEW_UPDATE', viewSeq: 0, pos: [0, 0, 0], quat: [0, 0, 0, 1], fovY: 1.5, width: 1024, height: 768 });
});

// 경로 1개 재생 시 서버 복호기가 받는 VIEW_UPDATE 수는 시점 수와 정확히 같다(수 고정).
for (const [name, codec] of [['client/proto', clientCodec], ['server/proto/codec', serverCodec]]) {
  test(`replayPath(dronePath 50 시점, ${name}) 는 VIEW_UPDATE 50 개를 viewSeq 증가로 보낸다`, async () => {
    const path = dronePath({ seed: 1, frames: 50, fps: 30 });
    const { a, b } = createLoopbackPair();
    const got = serverEnd(b);
    const sent = replayPath(path, codec, { transport: a, fovY: 1.0, width: 1280, height: 720, firstViewSeq: 1 });
    await tick();
    assert.equal(sent, 50);
    assert.equal(got.length, 50);
    assert.ok(got.every((m) => m.type === 'VIEW_UPDATE'));
    assert.deepEqual(got.map((m) => m.viewSeq), Array.from({ length: 50 }, (_, i) => i + 1));
    got.forEach((m, i) => {
      const { eye, target } = path.frames[i];
      // GL(x=동, y=위, z=-북) → ENU(e=x, n=-z, u=y)
      assert.deepEqual(m.pos, f32([eye[0], -eye[2], eye[1]]), `시점 ${i} pos`);
      assert.equal(m.fovY, Math.fround(1.0));
      assert.equal(m.width, 1280);
      assert.equal(m.height, 720);
      const want = [target[0] - eye[0], -(target[2] - eye[2]), target[1] - eye[1]];
      const n = Math.hypot(...want);
      assertVecClose(forwardOf(m.quat), want.map((v) => v / n), 1e-5, `시점 ${i} 앞 방향`);
    });
  });
}

test('replayPath(freePath 40 시점) 도 시점 수만큼 받고 시선이 target 을 향한다', async () => {
  const path = freePath({ seed: 7, frames: 40, fps: 30 });
  const { a, b } = createLoopbackPair();
  const got = serverEnd(b);
  assert.equal(replayPath(path, clientCodec, { transport: a }), 40);
  await tick();
  assert.equal(got.length, 40);
  assert.deepEqual(got.map((m) => m.viewSeq), Array.from({ length: 40 }, (_, i) => i + 1));
  got.forEach((m, i) => {
    const { eye, target } = path.frames[i];
    const want = [target[0] - eye[0], -(target[2] - eye[2]), target[1] - eye[1]];
    const n = Math.hypot(...want);
    assertVecClose(forwardOf(m.quat), want.map((v) => v / n), 1e-5, `시점 ${i} 앞 방향`);
  });
});

test('replayPath 는 시점 0 개면 0 을 돌려주고 잘못된 입력은 거절한다', () => {
  const { a } = createLoopbackPair();
  assert.equal(replayPath({ frames: [] }, clientCodec, { transport: a }), 0);
  assert.throws(() => replayPath({}, clientCodec, { transport: a }), /frames/);
  assert.throws(() => replayPath({ frames: [] }, {}, { transport: a }), /codec/);
  assert.throws(() => replayPath({ frames: [] }, clientCodec, {}), /transport/);
  // 같은 점을 보는 시점은 시선이 없어 거절, 부호화 실패면 하나도 보내지 않는다
  assert.throws(() => poseFromLookAt({ eye: [1, 2, 3], target: [1, 2, 3] }), /target/);
  const sentBytes = [];
  const spy = { send: (bytes) => sentBytes.push(bytes) };
  const good = { eye: [0, 0, 0], target: [0, 0, -10], up: [0, 1, 0] };
  const bad = { eye: [0, 0, 0], target: [0, 0, 0], up: [0, 1, 0] };
  assert.throws(() => replayPath({ frames: [good, bad] }, clientCodec, { transport: spy }));
  assert.equal(sentBytes.length, 0);
});

// quat 은 카메라→ENU, 카메라 축은 OpenCV(+z 앞, x 오른쪽, y 아래). 항등 quat 은 하늘(+u)을 본다.
test('기본 quat [0,0,0,1] 은 하늘(+u)을 보고, 수평 북쪽 시선은 항등이 아니다', () => {
  assertVecClose(forwardOf([0, 0, 0, 1]), [0, 0, 1], 0, '항등 = 앞이 ENU +u(하늘)');
  // GL z=-북 이므로 target z 가 음수이면 북쪽: 앞 = ENU (0,1,0)
  const north = poseFromLookAt({ eye: [0, 0, 0], target: [0, 0, -10], up: [0, 1, 0] });
  assertVecClose(north.pos, [0, 0, 0], 0, '북쪽 시선 pos');
  assertVecClose(forwardOf(north.quat), [0, 1, 0], 1e-12, '북쪽 수평 시선');
  assert.ok(Math.abs(north.quat[3] - 1) > 0.1, '수평 시선 quat 은 항등이 아니다');
  // 카메라 오른쪽(x축)은 동쪽, 아래(y축)는 -u: 앞(북)에서 오른쪽은 동
  const [x, y, z, w] = north.quat;
  const right = [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)];
  assertVecClose(right, [1, 0, 0], 1e-12, '북쪽을 볼 때 오른쪽 = 동');
});

test('역회전(켤레) quat 이면 같은 시점이어도 앞 방향이 달라진다', () => {
  // 동쪽 아래로 기울인 시선: 항등도 180° 회전도 아닌 일반 자세
  const pose = poseFromLookAt({ eye: [0, 10, 0], target: [10, 0, -10], up: [0, 1, 0] });
  const want = [10, 10, -10].map((v) => v / Math.hypot(10, 10, 10));
  const fwd = forwardOf(pose.quat);
  assertVecClose(fwd, want, 1e-12, '정방향 quat 앞');
  const inv = forwardOf(conj(pose.quat));
  assert.ok(dot(fwd, inv) < 0.9, `켤레 quat 은 다른 방향을 본다(내적 ${dot(fwd, inv)})`);
  // 손계산: 오른쪽=(1,-1,0)/√2, 아래=(-1,-1,-2)/√6, 켤레의 앞 = (오른쪽.u, 아래.u, 앞.u) = (0,-2/√6,-1/√3)
  assertVecClose(inv, [0, -2 / Math.sqrt(6), -1 / Math.sqrt(3)], 1e-12, '켤레 quat 앞 방향(손계산)');
  // 와이어를 거친 뒤에도 구분된다
  const { a, b } = createLoopbackPair();
  const got = serverEnd(b);
  replayPath({ frames: [{ eye: [0, 10, 0], target: [10, 0, -10], up: [0, 1, 0] }] }, clientCodec, { transport: a });
  return tick().then(() => {
    assert.equal(got.length, 1);
    assert.ok(dot(forwardOf(got[0].quat), want) > 0.999999);
    assert.ok(dot(forwardOf(conj(got[0].quat)), want) < 0.9);
  });
});
