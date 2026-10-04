// 실제 모듈(client/status/<모듈>/index.mjs)을 loadDefaultModules() 로 읽어 3구간 × 4수준 시나리오를 돌린다.
// 일곱 모듈이 모두 합쳐진 트리에서만 통과한다(모듈 파일이 없으면 동적 import 가 실패한다).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStatusView, loadDefaultModules } from './index.mjs';
import { createMockRenderServer, SCENARIO_EVENTS, COUNTS, countOfTestChunk, pieceKeyOf, feed } from './mock_server.mjs';

test('실제 모듈 조립: 3구간 × 4수준 재생의 그림·노출·안내·해제·폴백·카메라', async () => {
  const modules = await loadDefaultModules();
  const view = createStatusView({ modules, countOf: countOfTestChunk });
  const server = createMockRenderServer();
  feed(view, server.welcome(false));
  for (const s of [0, 1, 2]) feed(view, server.missing(s));

  let f = view.frame();
  assert.deepEqual(f.drawKeys, []);
  assert.deepEqual(f.reveal, { visible: [], hidden: [0, 1, 2], renderPointCount: 0 });
  assert.deepEqual(f.notices.map((n) => [n.segmentId, n.text]), [[0, '없음'], [1, '없음'], [2, '없음']]);

  const points = [];
  const released = [];
  for (const [seg, level] of SCENARIO_EVENTS) {
    feed(view, server.levelArrival(seg, level));
    f = view.frame();
    points.push(f.reveal.renderPointCount);
    released.push(...f.releasedKeys);
  }
  assert.deepEqual(points, [30, 530, 553, 593, 593, 593, 633, 1210, 1210, 1250, 1250, 1250]);
  assert.deepEqual(released, [
    '0.0.0.0.0.0', '0.0.0.0.0.1', '0.1.0.0.0.0', '0.1.0.0.0.1',
    '2.1.0.0.0.0', '2.1.0.0.0.1', '0.2.0.0.0.0', '0.2.0.0.0.1',
  ]);

  f = view.frame();
  assert.deepEqual(f.drawKeys, ['0.3.0.0.0.0', '0.3.0.0.0.1', '1.3.0.0.0.0', '2.3.0.0.0.0', '2.3.0.0.0.1', '2.3.0.0.0.2']);
  assert.deepEqual(f.reveal, { visible: [0, 1, 2], hidden: [], renderPointCount: 1250 });
  assert.deepEqual(f.notices, []);
  assert.deepEqual(f.releasedKeys, []);
  assert.equal(f.fallback.mode, 'live');

  // 받은 조각은 다시 요청하지 않는다(자산 색인을 넘기지 않았으니 요청 0)
  assert.deepEqual(view.requests(), []);

  feed(view, server.error(5, 'busy'));
  assert.equal(view.frame().fallback.mode, 'fallback');
  feed(view, server.welcome(true));
  assert.equal(view.frame().fallback.mode, 'live');

  view.setMarkers([{ id: 'drone', enu: [1, 2, 10] }]);
  const out = view.setCamera({ pos: [0, 0, 0], quat: [0, 0, 0, 1], fovY: Math.PI / 2 }, { width: 800, height: 600, devicePixelRatio: 1 });
  f = view.frame();
  assert.equal(f.view, out.view);
  assert.ok(Math.abs(f.markers[0].u - 430) < 1e-6);
  assert.ok(Math.abs(f.markers[0].v - 360) < 1e-6);
  assert.ok(Math.abs(f.markers[0].depth - 10) < 1e-9);
  assert.equal(f.markers[0].visible, true);
});

/** 실제 모듈 조립에서 levels·arrival 인스턴스를 엿볼 수 있게 생성 함수만 감싼다(동작은 실제 모듈 그대로). */
async function spiedModules() {
  const modules = await loadDefaultModules();
  const made = { levels: [], planners: [] };
  const levels = { createStatusLevels: () => { const l = modules.levels.createStatusLevels(); made.levels.push(l); return l; } };
  const arrival = { createArrivalPlanner: (o) => { const p = modules.arrival.createArrivalPlanner(o); made.planners.push(p); return p; } };
  return { modules: { ...modules, levels, arrival }, made };
}

// 구간 5 만 쓰는 점 수 표: 수준 1 은 조각 2 개(9, 8 점), 수준 3 은 조각 3 개(100, 200, 300 점)
const SEG5 = [];
SEG5[5] = [[1], [9, 8], [2], [100, 200, 300]];

test('실제 모듈 조립: 새 세션(resumed=false)은 앞 세션 칸을 비우고 앞 세션 key 를 모두 해제한다', async () => {
  const modules = await loadDefaultModules();
  const view = createStatusView({ modules, countOf: countOfTestChunk });
  const a = createMockRenderServer({ sessionId: 11, counts: SEG5 });
  feed(view, a.welcome(false));
  feed(view, a.levelArrival(5, 3));
  let f = view.frame();
  assert.deepEqual(f.drawKeys, ['5.3.0.0.0.0', '5.3.0.0.0.1', '5.3.0.0.0.2']);
  assert.equal(f.reveal.renderPointCount, 600);

  const b = createMockRenderServer({ sessionId: 12, counts: SEG5 });
  feed(view, b.welcome(false));
  f = view.frame();
  assert.equal(f.drawKeys.filter((k) => k.startsWith('5.')).length, 0);
  assert.deepEqual(f.reveal, { visible: [], hidden: [5], renderPointCount: 0 });
  assert.deepEqual(f.notices.map((n) => [n.segmentId, n.text]), [[5, '없음']]);
  assert.deepEqual(f.releasedKeys, ['5.3.0.0.0.0', '5.3.0.0.0.1', '5.3.0.0.0.2']);
  assert.deepEqual(view.frame().releasedKeys, []);

  // 새 세션의 수준 1 은 앞 세션 수준 3 에 추월당한 것이 아니라 받아들여진다
  feed(view, b.levelArrival(5, 1));
  f = view.frame();
  assert.deepEqual(f.drawKeys, ['5.1.0.0.0.0', '5.1.0.0.0.1']);
  assert.deepEqual(f.reveal, { visible: [5], hidden: [], renderPointCount: 17 });
  assert.deepEqual(f.notices, []);
  assert.deepEqual(f.releasedKeys, []);
});

test('실제 모듈 조립: 같은 세션 이어받기(resumed=true)는 수준 상태를 그대로 잇는다', async () => {
  const modules = await loadDefaultModules();
  const view = createStatusView({ modules, countOf: countOfTestChunk });
  const a = createMockRenderServer({ sessionId: 11, counts: SEG5 });
  feed(view, a.welcome(false));
  feed(view, a.levelArrival(5, 3));
  view.frame();
  feed(view, a.welcome(true));
  let f = view.frame();
  assert.deepEqual(f.drawKeys, ['5.3.0.0.0.0', '5.3.0.0.0.1', '5.3.0.0.0.2']);
  assert.deepEqual(f.reveal, { visible: [5], hidden: [], renderPointCount: 600 });
  assert.deepEqual(f.releasedKeys, []);
  // 같은 세션에서 늦게 온 수준 1 은 추월당해 건너뛴다
  feed(view, a.levelArrival(5, 1));
  f = view.frame();
  assert.deepEqual(f.drawKeys, ['5.3.0.0.0.0', '5.3.0.0.0.1', '5.3.0.0.0.2']);
  assert.equal(f.reveal.renderPointCount, 600);
});

test('실제 모듈 조립: 받은 조각은 요청에 0 건, 요청은 MISSING 구간의 받지 않은 key 만', async () => {
  const index = (seg) => [0, 1].flatMap((lv) => [pieceKeyOf(seg, lv, 0), pieceKeyOf(seg, lv, 1)]);
  const { modules, made } = await spiedModules();
  const view = createStatusView({ modules, countOf: countOfTestChunk, pieceIndex: index });
  const server = createMockRenderServer();
  feed(view, server.welcome(false));
  // 도착 전 구간 2 의 MISSING → 색인 4 key 를 모두 요청
  feed(view, server.missing(2));
  const asked2 = [pieceKeyOf(2, 0, 0), pieceKeyOf(2, 0, 1), pieceKeyOf(2, 1, 0), pieceKeyOf(2, 1, 1)];
  assert.deepEqual(view.requests().flatMap((r) => r.items), asked2);
  for (const [seg, level] of SCENARIO_EVENTS) feed(view, server.levelArrival(seg, level));
  // 받은 조각 22 개 중 요청에 나온 key 0 개(색인은 넘겼지만 MISSING 이 없었다)
  assert.deepEqual(view.requests(), []);
  // 도착한 구간 0 의 MISSING 은 요청하지 않는다
  feed(view, server.missing(0));
  assert.deepEqual(view.requests(), []);
  // 생성 때 하나, 첫 WELCOME(resumed=false) 때 하나
  assert.equal(made.planners.length, 2);
  assert.equal(made.planners[1].pendingCount(), 0);

  // 새 세션: 구간 0 수준 0 조각 0 만 받은 상태에서 MISSING(0) → 나머지 3 key 만 요청
  const b = createMockRenderServer({ sessionId: 8 });
  feed(view, b.welcome(false));
  const frames = b.levelArrival(0, 0);
  feed(view, [frames[0]]);
  feed(view, b.missing(0));
  const req = view.requests();
  assert.equal(req.length, 1);
  assert.deepEqual(req[0].items, [pieceKeyOf(0, 0, 1), pieceKeyOf(0, 1, 0), pieceKeyOf(0, 1, 1)]);
  // 새 세션은 새 요청 계획이라 reqId 가 0 부터이고, 앞 세션에서 요청했던 key 도 다시 요청한다(구간 2 는 새 세션에서 도착 전)
  assert.equal(req[0].reqId, 0);
  feed(view, b.missing(2));
  const again = view.requests();
  assert.equal(again[0].reqId, 1);
  assert.deepEqual(again.flatMap((r) => r.items), asked2);
  assert.equal(made.planners.length, 3);
});

test('실제 모듈 조립: 교체 N 번 + frame() 뒤 levels 의 해제 누적이 비어 있고 해제된 수준의 pieceSeq 색인이 없다', async () => {
  const { modules, made } = await spiedModules();
  const view = createStatusView({ modules, countOf: countOfTestChunk });
  const server = createMockRenderServer();
  feed(view, server.welcome(false));
  const released = [];
  for (const [seg, level] of SCENARIO_EVENTS) {
    feed(view, server.levelArrival(seg, level));
    released.push(...view.frame().releasedKeys);
  }
  // 교체 4 번(0:0→1, 0:1→2, 2:1→3, 0:2→3), 해제 key 8 개
  assert.equal(released.length, 8);
  // 생성 때 하나, 첫 WELCOME(resumed=false) 때 하나
  assert.equal(made.levels.length, 2);
  assert.equal(made.levels[1].released().length, 0);
  // 해제된 창(구간 0 수준 0 = pieceSeq 1..2)의 LEVEL_ARRIVED 를 다시 보내면 색인이 없어 모자란 창(TypeError)
  assert.throws(() => view.handle({ type: 'LEVEL_ARRIVED', segmentId: 0, level: 0, pieceCount: 2, firstPieceSeq: 1 }), TypeError);
  // 그리는 수준(구간 0 수준 3)의 창은 남아 있다. 손 계산: 앞선 이벤트 조각 수 2+1+2+2+1+3+2+3+1 = 17 → 첫 pieceSeq 18
  let first03 = 1;
  for (const [seg, level] of SCENARIO_EVENTS) {
    if (seg === 0 && level === 3) break;
    first03 += COUNTS[seg][level].length;
  }
  assert.equal(first03, 18);
  view.handle({ type: 'LEVEL_ARRIVED', segmentId: 0, level: 3, pieceCount: 2, firstPieceSeq: 18 });
  assert.equal(view.frame().reveal.renderPointCount, 1250);
  // 새 세션으로 넘어가면 앞 levels 인스턴스는 버려지고 새 인스턴스도 누적이 비어 있다
  feed(view, createMockRenderServer({ sessionId: 9 }).welcome(false));
  view.frame();
  assert.equal(made.levels.length, 3);
  assert.equal(made.levels[2].released().length, 0);
});
