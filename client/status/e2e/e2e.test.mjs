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

test('새 세션 WELCOME(resumed=false)은 pieceSeq 색인을 비우고 도착 상태는 남긴다', () => {
  const view = newView();
  const a = createMockRenderServer({ sessionId: 3 });
  feed(view, a.welcome(false));
  feed(view, a.levelArrival(0, 1));
  const b = createMockRenderServer({ sessionId: 4 }); // 순번 1 부터 다시
  feed(view, b.welcome(false));
  feed(view, b.levelArrival(1, 0));
  const f = view.frame();
  assert.deepEqual(f.drawKeys, ['0.1.0.0.0.0', '0.1.0.0.0.1', '1.0.0.0.0.0']);
  assert.equal(f.reveal.renderPointCount, 75);
  // 다른 sessionId 로 resumed=true 는 거부
  assert.throws(() => view.handle({ type: 'WELCOME', sessionId: 9, resumed: true, nextPieceSeq: 1 }), TypeError);
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
  // 요청은 같은 PieceKey 를 한 번만
  const req = view.requests();
  assert.equal(req.length, 1);
  assert.equal(req[0].type, 'PIECE_REQUEST');
  assert.equal(req[0].reqId, 0);
  assert.deepEqual(req[0].items, [pieceKeyOf(0, 1, 0), pieceKeyOf(0, 1, 1)]);
  assert.deepEqual(view.requests(), []);
});

test('재생 전체의 요청: 받아들인 도착 7 번의 조각 14 개를 한 요청으로', () => {
  const view = newView();
  playScenario(view, createMockRenderServer());
  const req = view.requests();
  assert.equal(req.length, 1);
  // (0,0) 2 + (1,3) 1 + (2,1) 2 + (0,1) 2 + (0,2) 2 + (2,3) 3 + (0,3) 2 = 14
  assert.equal(req[0].items.length, 14);
  assert.deepEqual(req[0].items[2], pieceKeyOf(1, 3, 0));
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
