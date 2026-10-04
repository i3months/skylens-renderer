// 어댑터 본체 통합 시험(가짜 모듈 주입, 모의 코어 + 모의 렌더 서버). 기준값은 COUNTS 표에서 손으로 셈한 숫자다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStatusView, STATUS_MODULE_FUNCTIONS } from './index.mjs';
import { FAKE_MODULES } from './fakes.mjs';
import { createMockRenderServer, SCENARIO_EVENTS, countOfTestChunk, testChunk, pieceKeyOf, feed } from './mock_server.mjs';

function newView() {
  return createStatusView({ modules: FAKE_MODULES, countOf: countOfTestChunk });
}

/** 접속 → 세 구간 MISSING → 이벤트 열 재생. 이벤트마다 frame() 을 읽어 releasedKeys 를 모은다. */
function playScenario(view, server, { onEvent } = {}) {
  feed(view, server.welcome(false));
  for (const s of [0, 1, 2]) feed(view, server.missing(s));
  const released = [];
  SCENARIO_EVENTS.forEach(([seg, level], i) => {
    feed(view, server.levelArrival(seg, level));
    const f = view.frame();
    released.push(...f.releasedKeys);
    if (onEvent) onEvent(i, f);
  });
  return released;
}

test('3구간 × 4수준 재생: 최종 그림은 구간별 가장 높은 도착 수준(수준 3)뿐이다', () => {
  const view = newView();
  const server = createMockRenderServer();
  playScenario(view, server);
  const f = view.frame();
  assert.deepEqual(f.drawKeys, [
    '0.3.0.0.0.0', '0.3.0.0.0.1',
    '1.3.0.0.0.0',
    '2.3.0.0.0.0', '2.3.0.0.0.1', '2.3.0.0.0.2',
  ]);
  // 점 수: 구간 0 = 70+80 = 150, 구간 1 = 500, 구간 2 = 100+200+300 = 600 → 1250
  assert.deepEqual(f.reveal, { visible: [0, 1, 2], hidden: [], renderPointCount: 1250 });
  assert.deepEqual(f.notices, []);
  assert.deepEqual(f.releasedKeys, []);
  assert.equal(f.fallback.mode, 'live');
  // pieceSeq 는 조각 수 합만큼 쓰였다: 구간 0 = 8, 구간 1 = 4, 구간 2 = 10 → 다음 순번 23
  assert.equal(server.nextPieceSeq(), 23);
});

test('재생 중간: 추월된 구간 1 은 수준 3 에 머물고 늦게 온 수준 0·2·1 은 건너뛴다', () => {
  const view = newView();
  const server = createMockRenderServer();
  const seen = [];
  playScenario(view, server, { onEvent: (i, f) => seen.push({ i, draw: f.drawKeys.filter((k) => k.startsWith('1.')), points: f.reveal.renderPointCount }) });
  // 구간 1 의 그림은 두 번째 이벤트(수준 3) 이후 끝까지 '1.3.0.0.0.0' 하나
  for (const s of seen.slice(1)) assert.deepEqual(s.draw, ['1.3.0.0.0.0'], `이벤트 ${s.i}`);
  assert.deepEqual(seen[0].draw, []);
  // 이벤트별 전체 점 수(손 계산, 교체라 낮은 수준 점은 더하지 않는다):
  //   (0,0) 30 | (1,3) +500 | (2,1) +23 | (0,1) 30→70 | skip | skip | (0,2) 70→110 | (2,3) 23→600 | skip | (0,3) 110→150 | skip | skip
  assert.deepEqual(seen.map((s) => s.points), [30, 530, 553, 593, 593, 593, 633, 1210, 1210, 1250, 1250, 1250]);
});

test('교체로 해제된 key 는 frame().releasedKeys 에 한 번씩만 나온다', () => {
  const view = newView();
  const server = createMockRenderServer();
  const released = playScenario(view, server);
  assert.deepEqual(released, [
    '0.0.0.0.0.0', '0.0.0.0.0.1', // (0,1) 이 (0,0) 교체
    '0.1.0.0.0.0', '0.1.0.0.0.1', // (0,2) 이 (0,1) 교체
    '2.1.0.0.0.0', '2.1.0.0.0.1', // (2,3) 이 (2,1) 교체
    '0.2.0.0.0.0', '0.2.0.0.0.1', // (0,3) 이 (0,2) 교체
  ]);
  assert.equal(new Set(released).size, 8);
  // 한 번 읽으면 비운다
  assert.deepEqual(view.frame().releasedKeys, []);
  // 같은 LEVEL_ARRIVED 를 다시 받아도(skip) 다시 나오지 않는다
  feed(view, server.levelArrival(0, 3));
  assert.deepEqual(view.frame().releasedKeys, []);
});

test('도착 전 구간은 reveal.hidden·notices 에 있고 drawKeys 에 없다', () => {
  const view = newView();
  const server = createMockRenderServer();
  feed(view, server.welcome(false));
  for (const s of [0, 1, 2]) feed(view, server.missing(s));
  let f = view.frame();
  assert.deepEqual(f.drawKeys, []);
  assert.deepEqual(f.reveal, { visible: [], hidden: [0, 1, 2], renderPointCount: 0 });
  assert.deepEqual(f.notices, [{ segmentId: 0, text: '없음' }, { segmentId: 1, text: '없음' }, { segmentId: 2, text: '없음' }]);
  feed(view, server.levelArrival(0, 0));
  feed(view, server.levelArrival(1, 3));
  f = view.frame();
  assert.deepEqual(f.drawKeys, ['0.0.0.0.0.0', '0.0.0.0.0.1', '1.3.0.0.0.0']);
  assert.deepEqual(f.reveal, { visible: [0, 1], hidden: [2], renderPointCount: 530 });
  assert.deepEqual(f.notices, [{ segmentId: 2, text: '없음' }]);
  assert.ok(!f.drawKeys.some((k) => k.startsWith('2.')));
  // 도착한 구간에 늦게 온 MISSING 은 도착 상태를 바꾸지 않는다
  feed(view, server.missing(0));
  assert.deepEqual(view.frame().reveal, { visible: [0, 1], hidden: [2], renderPointCount: 530 });
});

test('ERROR code 5 → fallback, 이어받기 WELCOME → live. 폴백 중에도 그림은 도착한 것 그대로', () => {
  const view = newView();
  const server = createMockRenderServer();
  feed(view, server.welcome(false));
  feed(view, server.levelArrival(0, 1));
  assert.equal(view.frame().fallback.mode, 'live');
  feed(view, server.error(5, 'busy'));
  let f = view.frame();
  assert.equal(f.fallback.mode, 'fallback');
  assert.equal(f.fallback.reason, 'unavailable');
  assert.deepEqual(f.drawKeys, ['0.1.0.0.0.0', '0.1.0.0.0.1']);
  assert.equal(f.reveal.renderPointCount, 70);
  // 다른 코드(1 BAD_MESSAGE)는 폴백으로 바꾸지 않는다(가짜 fallback 규칙)
  const v2 = newView();
  feed(v2, server.error(1, 'bad'));
  assert.equal(v2.frame().fallback.mode, 'live');
  // 같은 세션 이어받기: 색인이 이어져 다음 조각 순번을 그대로 받는다
  feed(view, server.welcome(true));
  f = view.frame();
  assert.equal(f.fallback.mode, 'live');
  assert.equal(f.fallback.reason, null);
  feed(view, server.levelArrival(0, 2));
  assert.deepEqual(view.frame().drawKeys, ['0.2.0.0.0.0', '0.2.0.0.0.1']);
});

test('새 세션 WELCOME(resumed=false)은 앞 세션 그림을 해제하고 새 세션이 도착시키지 않은 칸은 비운다', () => {
  const view = newView();
  const a = createMockRenderServer({ sessionId: 3 });
  feed(view, a.welcome(false));
  feed(view, a.levelArrival(0, 1));
  const b = createMockRenderServer({ sessionId: 4 }); // 순번 1 부터 다시
  feed(view, b.welcome(false));
  feed(view, b.levelArrival(1, 0));
  const f = view.frame();
  // 구간 0 은 앞 세션 수준 1 이 남지 않고 도착 전 칸, 구간 1 은 새 세션 수준 0 조각(점 5)만
  assert.deepEqual(f.drawKeys, ['1.0.0.0.0.0']);
  assert.deepEqual(f.reveal, { visible: [1], hidden: [0], renderPointCount: 5 });
  assert.deepEqual(f.notices, [{ segmentId: 0, text: '없음' }]);
  assert.deepEqual(f.releasedKeys, ['0.1.0.0.0.0', '0.1.0.0.0.1']);
  // 새 세션의 구간 0 수준 0 은 앞 세션 수준 1 에 추월당한 것으로 보지 않고 받아들인다
  feed(view, b.levelArrival(0, 0));
  assert.deepEqual(view.frame().drawKeys, ['0.0.0.0.0.0', '0.0.0.0.0.1', '1.0.0.0.0.0']);
  // 다른 sessionId 로 resumed=true 는 거부
  assert.throws(() => view.handle({ type: 'WELCOME', sessionId: 9, resumed: true, nextPieceSeq: 1 }), TypeError);
});

test('새 세션이 앞 세션과 같은 key 를 다시 도착시키면 그 key 는 releasedKeys 에 나오지 않는다(drawKeys 와 겹치지 않음)', () => {
  const view = newView();
  const a = createMockRenderServer({ sessionId: 3 });
  feed(view, a.welcome(false));
  feed(view, a.levelArrival(0, 0));
  feed(view, a.levelArrival(1, 0));
  view.frame();
  const b = createMockRenderServer({ sessionId: 4 });
  feed(view, b.welcome(false));
  feed(view, b.levelArrival(0, 0)); // frame 전에 같은 key 0.0.0.0.0.0·0.0.0.0.0.1 이 다시 도착
  const f = view.frame();
  assert.deepEqual(f.drawKeys, ['0.0.0.0.0.0', '0.0.0.0.0.1']);
  assert.deepEqual(f.releasedKeys, ['1.0.0.0.0.0']);
  assert.deepEqual(f.reveal, { visible: [0], hidden: [1], renderPointCount: 30 });
});

test('setCamera 뒤 frame().view·markers 가 반영된다', () => {
  const view = newView();
  view.setMarkers([{ id: 'drone', enu: [1, 2, 10] }, { id: 'behind', enu: [0, 0, -5] }]);
  let f = view.frame();
  assert.equal(f.view, null);
  assert.deepEqual(f.markers, []);
  // 단위 쿼터니언: 카메라 축 = ENU 축(카메라 z 앞 = 위). fovY = π/2, 800×600 → fy = fx = 300, cx = 400, cy = 300
  const out = view.setCamera({ pos: [0, 0, 0], quat: [0, 0, 0, 1], fovY: Math.PI / 2 }, { width: 800, height: 600, devicePixelRatio: 2 });
  assert.equal(out.viewUpdate.viewSeq, 0);
  f = view.frame();
  assert.equal(f.view, out.view);
  assert.ok(Math.abs(f.view.K.fx - 300) < 1e-9);
  assert.equal(f.markers.length, 2);
  // drone: X_c = [1, 2, 10] → u = 300·0.1 + 400 = 430, v = 300·0.2 + 300 = 360
  assert.equal(f.markers[0].id, 'drone');
  assert.ok(Math.abs(f.markers[0].u - 430) < 1e-9);
  assert.ok(Math.abs(f.markers[0].v - 360) < 1e-9);
  assert.equal(f.markers[0].depth, 10);
  assert.equal(f.markers[0].visible, true);
  assert.equal(f.markers[1].id, 'behind');
  assert.equal(f.markers[1].visible, false);
  // 카메라를 동쪽 10 m 로 옮기면 drone 의 u 는 300·(1−10)/10 + 400 = 130
  const out2 = view.setCamera({ pos: [10, 0, 0], quat: [0, 0, 0, 1], fovY: Math.PI / 2 }, { width: 800, height: 600, devicePixelRatio: 1 });
  assert.equal(out2.viewUpdate.viewSeq, 1);
  assert.ok(Math.abs(view.frame().markers[0].u - 130) < 1e-9);
  // 마커 교체도 다음 frame 에 반영
  view.setMarkers([{ id: 'p', enu: [10, 0, 5] }]);
  const m = view.frame().markers;
  assert.equal(m.length, 1);
  assert.ok(Math.abs(m[0].u - 400) < 1e-9 && Math.abs(m[0].v - 300) < 1e-9);
});

test('재전송 PIECE(같은 pieceSeq·같은 key)는 한 조각으로 센다', () => {
  const view = newView();
  const server = createMockRenderServer();
  feed(view, server.welcome(false));
  const frames = server.levelArrival(0, 1); // PIECE 1, PIECE 2, LEVEL_ARRIVED
  feed(view, [frames[0], ...server.resend(1), frames[1], ...server.resend(1), ...server.resend(2), frames[2]]);
  const f = view.frame();
  assert.deepEqual(f.drawKeys, ['0.1.0.0.0.0', '0.1.0.0.0.1']);
  assert.equal(f.reveal.renderPointCount, 70);
  // LEVEL_ARRIVED 재전송도 같은 창이라 아무것도 늘지 않는다
  feed(view, [frames[2]]);
  assert.equal(view.frame().reveal.renderPointCount, 70);
  // 받은 조각은 다시 요청하지 않는다
  assert.deepEqual(view.requests(), []);
});

test('재생 전체에서 받은 조각은 요청에 하나도 나오지 않는다(자산 색인 없음 → 요청 0)', () => {
  const view = newView();
  playScenario(view, createMockRenderServer());
  assert.deepEqual(view.requests(), []);
});

test('요청은 MISSING 구간의 자산 색인 중 아직 받지 않은 PieceKey 만, 같은 key 는 한 번만', () => {
  // 색인: 구간마다 수준 0..3 × 조각 2 개 = 8 key
  const index = (seg) => [0, 1, 2, 3].flatMap((lv) => [pieceKeyOf(seg, lv, 0), pieceKeyOf(seg, lv, 1)]);
  const view = createStatusView({ modules: FAKE_MODULES, countOf: countOfTestChunk, pieceIndex: index });
  const server = createMockRenderServer();
  feed(view, server.welcome(false));
  // 구간 0 수준 1 의 조각 두 개를 받았지만 LEVEL_ARRIVED 는 아직(구간 0 도착 전)
  const frames = server.levelArrival(0, 1);
  feed(view, frames.slice(0, 2));
  feed(view, server.missing(0));
  let req = view.requests();
  assert.equal(req.length, 1);
  assert.equal(req[0].reqId, 0);
  // 8 key 중 받은 0.1.* 두 개를 뺀 6 개
  assert.deepEqual(req[0].items, [pieceKeyOf(0, 0, 0), pieceKeyOf(0, 0, 1), pieceKeyOf(0, 2, 0), pieceKeyOf(0, 2, 1), pieceKeyOf(0, 3, 0), pieceKeyOf(0, 3, 1)]);
  // 같은 MISSING 이 다시 와도 이미 요청한 key 는 다시 내지 않는다
  feed(view, server.missing(0));
  assert.deepEqual(view.requests(), []);
  // 구간 0 이 도착한 뒤의 MISSING 은 요청하지 않는다
  feed(view, [frames[2]]);
  feed(view, server.missing(0));
  assert.deepEqual(view.requests(), []);
  // 다른 구간 key 를 돌려주는 색인은 TypeError, 상태 불변
  const bad = createStatusView({ modules: FAKE_MODULES, countOf: countOfTestChunk, pieceIndex: () => [pieceKeyOf(9, 0, 0)] });
  assert.throws(() => bad.handle({ type: 'MISSING', segmentId: 1 }), TypeError);
  assert.deepEqual(bad.frame().reveal.hidden, []);
  assert.throws(() => createStatusView({ modules: FAKE_MODULES, pieceIndex: 1 }), TypeError);
});

test('해제된 창의 재전송(PIECE·LEVEL_ARRIVED)은 조용히 무시하고, 다른 key·모자란 창은 여전히 거부한다', () => {
  const view = newView();
  const server = createMockRenderServer();
  feed(view, server.welcome(false));
  feed(view, server.levelArrival(0, 0)); // pieceSeq 1, 2
  feed(view, server.levelArrival(0, 1)); // pieceSeq 3, 4 → 0.0.* 해제
  assert.deepEqual(view.frame().releasedKeys, ['0.0.0.0.0.0', '0.0.0.0.0.1']);
  // 1..2 는 해제로 끝난 조각: 재전송 PIECE·LEVEL_ARRIVED 는 상태 불변
  const before = stateOf(view);
  feed(view, [...server.resend(1), ...server.resend(2)]);
  view.handle({ type: 'LEVEL_ARRIVED', segmentId: 0, level: 0, pieceCount: 2, firstPieceSeq: 1 });
  assert.deepEqual(stateOf(view), before);
  // 끝난 pieceSeq 에 다른 key 는 TypeError, 끝난 조각이 든 창이라도 다른 수준·모자란 창은 TypeError
  assert.throws(() => view.handle({ type: 'PIECE', pieceSeq: 1, key: pieceKeyOf(0, 0, 7), chunk: testChunk(1) }), TypeError);
  assert.throws(() => view.handle({ type: 'LEVEL_ARRIVED', segmentId: 0, level: 1, pieceCount: 2, firstPieceSeq: 1 }), TypeError);
  assert.throws(() => view.handle({ type: 'LEVEL_ARRIVED', segmentId: 0, level: 0, pieceCount: 3, firstPieceSeq: 0 }), RangeError);
  assert.throws(() => view.handle({ type: 'LEVEL_ARRIVED', segmentId: 0, level: 0, pieceCount: 6, firstPieceSeq: 1 }), TypeError);
  // 3..4(그리는 수준)의 재전송 창은 같은 수준이라 건너뛰고 그림은 그대로
  view.handle({ type: 'LEVEL_ARRIVED', segmentId: 0, level: 1, pieceCount: 2, firstPieceSeq: 3 });
  assert.deepEqual(view.frame().drawKeys, ['0.1.0.0.0.0', '0.1.0.0.0.1']);
  // 창 안에 같은 key 가 두 번이면 TypeError(받은 조각만 든 창 5..6, 끝난 조각이 섞인 창 4..5 모두)
  view.handle({ type: 'PIECE', pieceSeq: 5, key: pieceKeyOf(0, 1, 1), chunk: testChunk(1) });
  view.handle({ type: 'PIECE', pieceSeq: 6, key: pieceKeyOf(0, 1, 1), chunk: testChunk(1) });
  const before2 = stateOf(view);
  assert.throws(() => view.handle({ type: 'LEVEL_ARRIVED', segmentId: 0, level: 1, pieceCount: 2, firstPieceSeq: 5 }), TypeError);
  assert.throws(() => view.handle({ type: 'LEVEL_ARRIVED', segmentId: 0, level: 1, pieceCount: 2, firstPieceSeq: 4 }), TypeError);
  assert.deepEqual(stateOf(view), before2);
});

function stateOf(view) {
  const f = view.frame();
  return { drawKeys: f.drawKeys, reveal: f.reveal, notices: f.notices, fallback: f.fallback, releasedKeys: f.releasedKeys };
}

test('잘못된 메시지·모자란 창은 TypeError 이고 상태가 바뀌지 않는다', () => {
  const view = newView();
  const server = createMockRenderServer();
  feed(view, server.welcome(false));
  feed(view, server.missing(2));
  feed(view, server.levelArrival(0, 0)); // pieceSeq 1, 2
  view.frame(); // 해제 목록 비우기
  const before = stateOf(view);
  const bad = [
    null,
    42,
    {},
    { type: 'HELLO', sessionId: 0, lastPieceSeq: 0 },
    { type: 'PIECE_REQUEST', reqId: 0, items: [] },
    { type: 'NOPE' },
    // 같은 pieceSeq 다른 key
    { type: 'PIECE', pieceSeq: 1, key: pieceKeyOf(0, 0, 5), chunk: testChunk(9) },
    // key 범위 밖
    { type: 'PIECE', pieceSeq: 3, key: { ...pieceKeyOf(0, 0, 0), level: 9 }, chunk: testChunk(9) },
    // chunk 가 바이트가 아님
    { type: 'PIECE', pieceSeq: 3, key: pieceKeyOf(1, 0, 0), chunk: [1, 2, 3, 4] },
    // 모자란 창: 받은 조각은 1..2 뿐
    { type: 'LEVEL_ARRIVED', segmentId: 0, level: 0, pieceCount: 3, firstPieceSeq: 1 },
    { type: 'LEVEL_ARRIVED', segmentId: 2, level: 1, pieceCount: 1, firstPieceSeq: 5 },
    // 창 조각이 다른 수준
    { type: 'LEVEL_ARRIVED', segmentId: 0, level: 1, pieceCount: 2, firstPieceSeq: 1 },
    { type: 'LEVEL_ARRIVED', segmentId: 0, level: 'x', pieceCount: 2, firstPieceSeq: 1 },
    { type: 'MISSING', segmentId: -1 },
    { type: 'ERROR', code: 'x', text: '' },
    { type: 'WELCOME', sessionId: 0, resumed: false, nextPieceSeq: 1 },
  ];
  for (const m of bad) {
    assert.throws(() => view.handle(m), (e) => e instanceof TypeError || e instanceof RangeError, JSON.stringify(m));
  }
  // 창 부족·다른 key 는 반드시 TypeError
  assert.throws(() => view.handle(bad[9]), TypeError);
  assert.throws(() => view.handle(bad[6]), TypeError);
  assert.deepEqual(stateOf(view), before);
  // 거부 뒤에도 정상 진행: 다음 순번 3 부터 받는다
  feed(view, server.levelArrival(2, 1));
  const f = view.frame();
  assert.deepEqual(f.drawKeys, ['0.0.0.0.0.0', '0.0.0.0.0.1', '2.1.0.0.0.0', '2.1.0.0.0.1']);
  assert.deepEqual(f.notices, []);
  // 순번 역행(재전송이 아닌 작은 pieceSeq)은 거부, 상태 불변. 받은 조각은 1..4, 이어서 6 을 받고 5 를 보낸다
  view.handle({ type: 'PIECE', pieceSeq: 6, key: pieceKeyOf(1, 0, 0), chunk: testChunk(1) });
  const before2 = stateOf(view);
  assert.throws(() => view.handle({ type: 'PIECE', pieceSeq: 5, key: pieceKeyOf(1, 0, 1), chunk: testChunk(1) }), RangeError);
  assert.deepEqual(stateOf(view), before2);
  // 5 가 거부됐으니 창 5..6 은 모자라다
  assert.throws(() => view.handle({ type: 'LEVEL_ARRIVED', segmentId: 1, level: 0, pieceCount: 2, firstPieceSeq: 5 }), TypeError);
  view.handle({ type: 'LEVEL_ARRIVED', segmentId: 1, level: 0, pieceCount: 1, firstPieceSeq: 6 });
  assert.equal(view.frame().reveal.renderPointCount, 10 + 20 + 11 + 12 + 1);
});

test('countOf 가 없으면 PIECE 에서 TypeError(상태 불변), 잘못된 countOf 결과도 TypeError', () => {
  const view = createStatusView({ modules: FAKE_MODULES });
  const server = createMockRenderServer();
  feed(view, server.welcome(false));
  const frames = server.levelArrival(0, 0);
  assert.throws(() => feed(view, frames), TypeError);
  assert.deepEqual(view.frame().drawKeys, []);
  // PIECE 가 거부됐으니 LEVEL_ARRIVED 의 창도 모자라다
  assert.throws(() => view.handle({ type: 'LEVEL_ARRIVED', segmentId: 0, level: 0, pieceCount: 2, firstPieceSeq: 1 }), TypeError);
  const v2 = createStatusView({ modules: FAKE_MODULES, countOf: () => -1 });
  assert.throws(() => v2.handle({ type: 'PIECE', pieceSeq: 1, key: pieceKeyOf(0, 0, 0), chunk: testChunk(1) }), TypeError);
  const v3 = createStatusView({ modules: FAKE_MODULES, countOf: () => 1.5 });
  assert.throws(() => v3.handle({ type: 'PIECE', pieceSeq: 1, key: pieceKeyOf(0, 0, 0), chunk: testChunk(1) }), TypeError);
  assert.throws(() => createStatusView({ modules: FAKE_MODULES, countOf: 3 }), TypeError);
});

test('모듈 없이 createStatusView 를 부르면 TypeError', () => {
  assert.throws(() => createStatusView(), TypeError);
  assert.throws(() => createStatusView({}), TypeError);
  assert.throws(() => createStatusView({ countOf: countOfTestChunk }), TypeError);
  for (const name of Object.keys(STATUS_MODULE_FUNCTIONS)) {
    const partial = { ...FAKE_MODULES };
    delete partial[name];
    assert.throws(() => createStatusView({ modules: partial, countOf: countOfTestChunk }), TypeError, name);
    const broken = { ...FAKE_MODULES, [name]: {} };
    assert.throws(() => createStatusView({ modules: broken, countOf: countOfTestChunk }), TypeError, name);
  }
  assert.deepEqual(Object.keys(STATUS_MODULE_FUNCTIONS), ['arrival', 'levels', 'reveal', 'camera', 'overlay', 'missing_ui', 'fallback']);
});

// ---- F-300 ③④, F-301 ③④⑦ ----

/** 실제 도착 계획기를 감싸 호출을 세고, 원할 때 던지게 하는 arrival 모듈. */
function spyArrival({ throwOnCalls = [] } = {}) {
  const stat = { calls: 0 };
  const arrivalModule = {
    createArrivalPlanner(options) {
      const inner = FAKE_MODULES.arrival.createArrivalPlanner(options);
      return {
        ...inner,
        onSegmentArrived(segmentId, keys) {
          stat.calls += 1;
          if (throwOnCalls.includes(stat.calls)) throw new Error('planner 가 던졌다');
          return inner.onSegmentArrived(segmentId, keys);
        },
      };
    },
  };
  return { stat, modules: { ...FAKE_MODULES, arrival: arrivalModule } };
}

const twoKeyIndex = (seg) => [pieceKeyOf(seg, 0, 0), pieceKeyOf(seg, 0, 1)];

test('F-300 ③ 같은 구간 MISSING 10만 번과 구간 3개: requests() 없이도 후보는 구간당 하나만 남는다', () => {
  const { stat, modules } = spyArrival();
  const view = createStatusView({ modules, countOf: countOfTestChunk, pieceIndex: twoKeyIndex });
  for (let i = 0; i < 100000; i += 1) view.handle({ type: 'MISSING', segmentId: i % 3 });
  const req = view.requests();
  assert.equal(stat.calls, 3); // 후보 하나가 구간 하나(덮어쓰기). 예전에는 100000 번
  assert.equal(req.length, 1);
  assert.equal(req[0].items.length, 6);
  assert.deepEqual(view.requests(), []);
});

test('F-300 ④ planner 가 던지면 후보를 잃지 않는다: 두 번째 requests() 가 구간 1·2 를 모두 돌려준다', () => {
  const { modules } = spyArrival({ throwOnCalls: [1] });
  const view = createStatusView({ modules, countOf: countOfTestChunk, pieceIndex: twoKeyIndex });
  feed(view, createMockRenderServer().welcome(false));
  view.handle({ type: 'MISSING', segmentId: 1 });
  view.handle({ type: 'MISSING', segmentId: 2 });
  assert.throws(() => view.requests(), /planner 가 던졌다/);
  const req = view.requests();
  assert.deepEqual(req.flatMap((r) => r.items), [...twoKeyIndex(1), ...twoKeyIndex(2)]);
  assert.deepEqual(view.requests(), []);
});

test('F-300 ④ 두 번째 구간에서 던져도 이미 넣은 첫 구간은 다시 넣지 않고 둘 다 한 번씩만 나온다', () => {
  const { modules } = spyArrival({ throwOnCalls: [2] });
  const view = createStatusView({ modules, countOf: countOfTestChunk, pieceIndex: twoKeyIndex });
  view.handle({ type: 'MISSING', segmentId: 1 });
  view.handle({ type: 'MISSING', segmentId: 2 });
  assert.throws(() => view.requests(), /planner 가 던졌다/);
  const items = view.requests().flatMap((r) => r.items);
  assert.deepEqual(items, [...twoKeyIndex(1), ...twoKeyIndex(2)]);
});

test('F-301 ③ 원래와 다른 창(같은 구간·수준, 다른 first/n)은 거부하고 상태를 바꾸지 않는다', () => {
  const view = newView();
  const server = createMockRenderServer();
  feed(view, server.welcome(false));
  feed(view, server.levelArrival(0, 0)); // 1..2
  feed(view, server.levelArrival(0, 1)); // 3..4, 0.0.* 해제(끝난 조각)
  view.frame(); // 해제 목록 비우기
  const before = stateOf(view);
  // 끝난 조각만 든 창의 일부(1..1)는 같은 (구간, 수준) 이지만 원래 창(1..2)과 다르다
  assert.throws(() => view.handle({ type: 'LEVEL_ARRIVED', segmentId: 0, level: 0, pieceCount: 1, firstPieceSeq: 1 }), TypeError);
  assert.throws(() => view.handle({ type: 'LEVEL_ARRIVED', segmentId: 0, level: 0, pieceCount: 1, firstPieceSeq: 2 }), TypeError);
  assert.deepEqual(stateOf(view), before);
  // 같은 창의 재전송은 그대로 조용히 무시한다
  view.handle({ type: 'LEVEL_ARRIVED', segmentId: 0, level: 0, pieceCount: 2, firstPieceSeq: 1 });
  view.handle({ type: 'LEVEL_ARRIVED', segmentId: 0, level: 1, pieceCount: 2, firstPieceSeq: 3 });
  assert.deepEqual(stateOf(view), before);
  // 새 세션은 창 기록도 비운다: 같은 (구간, 수준) 을 다른 창으로 새로 받을 수 있다
  const s2 = createMockRenderServer({ sessionId: 8, counts: [[[7]]] });
  feed(view, s2.welcome(false));
  feed(view, s2.levelArrival(0, 0)); // 같은 (0, 0) 을 1..1 창으로
  assert.deepEqual(view.frame().drawKeys, ['0.0.0.0.0.0']);
});

test('F-301 ④ 같은 key 에 pieceSeq 가 8만 개여도 해제는 key 단위로 한 번에 옮긴다(indexOf·splice 호출 0)', () => {
  const view = newView();
  const N = 80000;
  const key = pieceKeyOf(0, 0, 0);
  view.handle({ type: 'WELCOME', sessionId: 7, resumed: false, nextPieceSeq: 1 });
  for (let s = 1; s <= N; s += 1) view.handle({ type: 'PIECE', pieceSeq: s, key, chunk: testChunk(1) });
  view.handle({ type: 'LEVEL_ARRIVED', segmentId: 0, level: 0, pieceCount: 1, firstPieceSeq: 1 });
  view.handle({ type: 'PIECE', pieceSeq: N + 1, key: pieceKeyOf(0, 1, 0), chunk: testChunk(1) });
  const idx = Array.prototype.indexOf;
  const spl = Array.prototype.splice;
  let heavy = 0;
  Array.prototype.indexOf = function patched(...a) { if (this.length >= 1000) heavy += 1; return idx.apply(this, a); };
  Array.prototype.splice = function patched(...a) { if (this.length >= 1000) heavy += 1; return spl.apply(this, a); };
  try {
    view.handle({ type: 'LEVEL_ARRIVED', segmentId: 0, level: 1, pieceCount: 1, firstPieceSeq: N + 1 }); // 수준 0 교체 → key 해제
  } finally {
    Array.prototype.indexOf = idx;
    Array.prototype.splice = spl;
  }
  assert.equal(heavy, 0);
  assert.deepEqual(view.frame().releasedKeys, ['0.0.0.0.0.0']);
  // 끝난 조각의 재전송은 여전히 조용히 무시된다
  view.handle({ type: 'PIECE', pieceSeq: 5, key, chunk: testChunk(1) });
  assert.throws(() => view.handle({ type: 'PIECE', pieceSeq: 5, key: pieceKeyOf(0, 0, 1), chunk: testChunk(1) }), TypeError);
});

test('F-301 ⑦ WELCOME(resumed=false) 중 주입 모듈이 던져도 상태가 바뀌지 않는다', () => {
  const modes = ['snapshots', 'released', 'create', 'expect', 'planner', 'fallback'];
  for (const mode of modes) {
    const flag = { mode: null };
    const hit = (name) => { if (flag.mode === name) throw new Error(`주입 오류 ${name}`); };
    const wrapped = {
      ...FAKE_MODULES,
      levels: {
        createStatusLevels() {
          hit('create');
          const l = FAKE_MODULES.levels.createStatusLevels();
          return {
            ...l,
            snapshots() { hit('snapshots'); return l.snapshots(); },
            released() { hit('released'); return l.released(); },
            expect(s) { hit('expect'); return l.expect(s); },
          };
        },
      },
      arrival: { createArrivalPlanner(o) { hit('planner'); return FAKE_MODULES.arrival.createArrivalPlanner(o); } },
      fallback: {
        createFallbackController() {
          const f = FAKE_MODULES.fallback.createFallbackController();
          return { ...f, handle(e) { hit('fallback'); return f.handle(e); } };
        },
      },
    };
    const make = (modules) => {
      const v = createStatusView({ modules, countOf: countOfTestChunk, pieceIndex: twoKeyIndex });
      const server = createMockRenderServer();
      feed(v, server.welcome(false));
      feed(v, server.missing(5));
      feed(v, server.levelArrival(0, 0));
      feed(v, server.levelArrival(0, 1)); // 0.0.* 해제가 frame() 에 아직 나가지 않은 상태
      return { v, server };
    };
    const a = make(wrapped);
    const b = make(FAKE_MODULES);
    flag.mode = mode;
    assert.throws(() => a.v.handle({ type: 'WELCOME', sessionId: 9, resumed: false, nextPieceSeq: 1 }), /주입 오류/, mode);
    flag.mode = null;
    assert.deepEqual(stateOf(a.v), stateOf(b.v), mode);
    // 이어서 같은 입력을 넣으면 같은 결과(요청 후보·pieceSeq 장부·수준 상태 모두 그대로)
    feed(a.v, a.server.levelArrival(0, 2));
    feed(b.v, b.server.levelArrival(0, 2));
    assert.deepEqual(stateOf(a.v), stateOf(b.v), mode);
    assert.deepEqual(a.v.requests(), b.v.requests(), mode);
    // 던지지 않으면 새 세션으로 바뀐다
    a.v.handle({ type: 'WELCOME', sessionId: 9, resumed: false, nextPieceSeq: 1 });
    assert.deepEqual(a.v.frame().drawKeys, [], mode);
  }
});
