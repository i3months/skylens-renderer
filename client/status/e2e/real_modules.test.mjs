// 실제 모듈(client/status/<모듈>/index.mjs)을 loadDefaultModules() 로 읽어 3구간 × 4수준 시나리오를 돌린다.
// 일곱 모듈이 모두 합쳐진 트리에서만 통과한다(모듈 파일이 없으면 동적 import 가 실패한다).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStatusView, loadDefaultModules } from './index.mjs';
import { createMockRenderServer, SCENARIO_EVENTS, countOfTestChunk, feed } from './mock_server.mjs';

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

  const req = view.requests();
  assert.equal(req.reduce((a, r) => a + r.items.length, 0), 14);
  assert.equal(req[0].reqId, 0);

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
