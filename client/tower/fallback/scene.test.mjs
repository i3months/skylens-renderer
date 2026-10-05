// 관제탑 폴백 조립 장면 시험. 기준 수치는 손계산 값을 박았고, 그 밖에는 성질(왕복·북쪽이 위·경계 점이 여백 선 위)만 검사한다.
// 구현 모듈(view·markers·paths)을 import 하지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTowerFallback } from './index.mjs';
import { TOWER_FALLBACK_TEST_NAMES } from '../../../contracts/controlview/fallback.mjs';

const NAME_MAIN = 'index: 서버 불가 모의 시 배너와 지도 목록을 낸다';
const EPS = 1e-9;
const MIN_SPAN = 100;
const MARGIN = 16;

function near(a, b, msg) { assert.ok(Math.abs(a - b) <= EPS, `${msg}: ${a} != ${b}`); }

const SIZE = { width: 800, height: 600 };
// 장면: 드론 d1(0,0)·d2(200,100), 탐지 t1(100,50) detection·t2(200,-100) alert, 경로 p1 (0,0)→(100,50)→(200,100).
const DRONES = [{ id: 'd1', enu: [0, 0, 30], yaw: 0.5 }, { id: 'd2', enu: [200, 100, 40] }];
const DETS = [{ id: 't1', enu: [100, 50, 0] }, { id: 't2', enu: [200, -100, 0], kind: 'alert', confidence: 0.9 }];
const PATH = { id: 'p1', points: [[0, 0, 0], [100, 50, 0], [200, 100, 0]] };

function scene() {
  const f = createTowerFallback();
  f.setDrones(DRONES);
  f.setDetections(DETS);
  f.setPath(PATH);
  return f;
}

test('시험 이름은 계약 목록에 있다', () => {
  assert.ok(TOWER_FALLBACK_TEST_NAMES.includes(NAME_MAIN));
});

test(NAME_MAIN, () => {
  const f = scene();
  f.setAvailable(false);
  assert.equal(f.mode(), 'fallback');
  const r = f.frame(SIZE);
  assert.equal(r.banner, '실시간 3D 불가');
  assert.equal(r.mode, 'fallback');
  assert.equal(r.empty, false);
  // 손계산: e 0..200, n -100..100 → span 200, avail 600-32=568, metersPerPx=200/568, 중심 (100,0). 1m = 2.84px.
  near(r.view.centerE, 100, 'centerE');
  near(r.view.centerN, 0, 'centerN');
  near(r.view.metersPerPx, 200 / 568, 'metersPerPx');
  assert.equal(r.drones.length, 2);
  assert.equal(r.detections.length, 2);
  assert.equal(r.paths.length, 1);
  // 드론: x = 400 + (e-100)·2.84, y = 300 - n·2.84
  assert.deepEqual(r.drones.map((d) => d.id), ['d1', 'd2']);
  near(r.drones[0].x, 116, 'd1.x'); near(r.drones[0].y, 300, 'd1.y');
  near(r.drones[1].x, 684, 'd2.x'); near(r.drones[1].y, 16, 'd2.y');
  assert.equal(r.drones[0].visible, true);
  assert.equal(r.drones[1].visible, true);
  assert.equal(r.drones[0].yaw, 0.5);
  // 탐지
  assert.deepEqual(r.detections.map((d) => d.id), ['t1', 't2']);
  near(r.detections[0].x, 400, 't1.x'); near(r.detections[0].y, 158, 't1.y');
  near(r.detections[1].x, 684, 't2.x'); near(r.detections[1].y, 584, 't2.y');
  assert.equal(r.detections[0].kind, 'detection');
  assert.equal(r.detections[1].kind, 'alert');
  assert.equal(r.detections[1].confidence, 0.9);
  // 경로: 점 3개 전부, 순서 유지
  assert.equal(r.paths[0].id, 'p1');
  const want = [[116, 300], [400, 158], [684, 16]];
  assert.equal(r.paths[0].polyline.length, 3);
  want.forEach(([x, y], i) => { near(r.paths[0].polyline[i].x, x, `p1[${i}].x`); near(r.paths[0].polyline[i].y, y, `p1[${i}].y`); });
  // 성질: 화면 좌표를 view 로 되돌리면 받은 ENU 가 나온다(왕복)
  const back = (p) => [r.view.centerE + (p.x - SIZE.width / 2) * r.view.metersPerPx, r.view.centerN - (p.y - SIZE.height / 2) * r.view.metersPerPx];
  for (const [list, src] of [[r.drones, DRONES], [r.detections, DETS]]) {
    list.forEach((m, i) => { const [e, n] = back(m); near(e, src[i].enu[0], `${m.id} 왕복 e`); near(n, src[i].enu[1], `${m.id} 왕복 n`); });
  }
  PATH.points.forEach((q, i) => { const [e, n] = back(r.paths[0].polyline[i]); near(e, q[0], `p1[${i}] 왕복 e`); near(n, q[1], `p1[${i}] 왕복 n`); });
  // 성질: 북쪽(n 큼)일수록 y 가 작다
  assert.ok(r.drones[1].y < r.drones[0].y, 'd2(n=100) 는 d1(n=0) 보다 위');
  assert.ok(r.detections[1].y > r.detections[0].y, 't2(n=-100) 는 t1(n=50) 보다 아래');
  // 성질: 남북 끝점(n=±100)이 위·아래 여백 선 위에 있다(높이 600 이 짧은 변)
  near(r.drones[1].y, MARGIN, 'd2 위 여백 선'); near(r.detections[1].y, SIZE.height - MARGIN, 't2 아래 여백 선');
});

test('index: live 에서는 배너·목록·view 가 비어 있다', () => {
  const f = scene();
  assert.equal(f.mode(), 'live');
  const r = f.frame(SIZE);
  assert.equal(r.mode, 'live');
  assert.equal(r.banner, null);
  assert.equal(r.view, null);
  assert.equal(r.empty, false);
  assert.deepEqual(r.drones, []);
  assert.deepEqual(r.detections, []);
  assert.deepEqual(r.paths, []);
  // live 여도 데이터는 받아 두었다가 모드를 바꾸면 곧바로 낸다
  f.setAvailable(false);
  assert.equal(f.frame(SIZE).drones.length, 2);
});

test('index: fallback 이지만 데이터가 없으면 배너만 나온다', () => {
  const f = createTowerFallback();
  f.setAvailable(false);
  const r = f.frame(SIZE);
  assert.equal(r.banner, '실시간 3D 불가');
  assert.equal(r.view, null);
  assert.equal(r.empty, true);
  assert.deepEqual(r.drones, []);
  assert.deepEqual(r.detections, []);
  assert.deepEqual(r.paths, []);
});

test('index: setView 수동 지정은 맞춤 대신 쓰이고 null 이면 다시 맞춘다', () => {
  const f = scene();
  f.setAvailable(false);
  f.setView({ centerE: 0, centerN: 0, metersPerPx: 0.5 });
  let r = f.frame(SIZE);
  assert.deepEqual(r.view, { centerE: 0, centerN: 0, metersPerPx: 0.5 });
  // x = 400 + e/0.5, y = 300 - n/0.5
  near(r.drones[0].x, 400, 'd1.x'); near(r.drones[0].y, 300, 'd1.y');
  near(r.drones[1].x, 800, 'd2.x'); near(r.drones[1].y, 100, 'd2.y');
  assert.equal(r.drones[0].visible, true);
  assert.equal(r.drones[1].visible, false); // x = width 는 화면 밖
  near(r.detections[0].x, 600, 't1.x'); near(r.detections[0].y, 200, 't1.y');
  near(r.detections[1].y, 500, 't2.y');
  assert.deepEqual(r.paths[0].polyline, [{ x: 400, y: 300 }, { x: 600, y: 200 }, { x: 800, y: 100 }]);
  // 받은 점이 없어도 view 는 그 값이다
  f.clear();
  r = f.frame(SIZE);
  assert.deepEqual(r.view, { centerE: 0, centerN: 0, metersPerPx: 0.5 });
  assert.equal(r.empty, true);
  assert.deepEqual(r.drones, []);
  // null 이면 다시 맞춤(데이터 없으면 view null)
  f.setView(null);
  assert.equal(f.frame(SIZE).view, null);
});

test('index: 같은 크기에서 두 번 부르면 결과가 같다(상태 불변)', () => {
  const f = scene();
  f.setAvailable(false);
  const a = f.frame(SIZE);
  const b = f.frame({ width: 800, height: 600 });
  assert.deepEqual(a, b);
  assert.notEqual(a, b);
  assert.deepEqual(f.counts(), { drones: 2, detections: 2, paths: 1 });
  // 결과를 고쳐도 상태는 그대로
  a.drones[0].x = -1; a.paths[0].polyline.pop(); a.view.metersPerPx = 99;
  assert.deepEqual(f.frame(SIZE), b);
});

test('index: 크기를 바꿔도 모든 점이 여백 안에 든다', () => {
  const f = scene();
  f.setAvailable(false);
  for (const size of [{ width: 800, height: 600 }, { width: 320, height: 240 }, { width: 1000, height: 300 }, { width: 300, height: 1000 }, { width: 64, height: 64 }]) {
    const r = f.frame(size);
    const all = [...r.drones, ...r.detections, ...r.paths.flatMap((p) => p.polyline)];
    assert.equal(all.length, 2 + 2 + 3);
    for (const p of all) {
      assert.ok(p.x >= MARGIN - EPS && p.x <= size.width - MARGIN + EPS, `x ${p.x} in ${size.width}`);
      assert.ok(p.y >= MARGIN - EPS && p.y <= size.height - MARGIN + EPS, `y ${p.y} in ${size.height}`);
    }
    for (const m of [...r.drones, ...r.detections]) assert.equal(m.visible, true);
    // 성질: 짧은 변 방향의 경계 점은 여백 선 위에 닿는다(span 200 ≥ minSpan 이므로 두 축 모두 avail 을 채운다)
    const side = Math.min(size.width, size.height);
    const key = size.width <= size.height ? 'x' : 'y';
    near(Math.min(...all.map((p) => p[key])), MARGIN, `${key} 최소가 여백 선 위`);
    near(Math.max(...all.map((p) => p[key])), side - MARGIN, `${key} 최대가 여백 선 위`);
  }
});

test('index: 경로 점만 멀리 있어도 자동 맞춤이 경로 점을 포함한다', () => {
  // 드론 (0,0) 하나, 경로 (0,0)→(5000,5000). 경로 점을 맞춤에서 빼면 스케일이 minSpan 으로 줄어 폴리라인이 화면을 벗어난다.
  const f = createTowerFallback();
  f.setDrones([{ id: 'd', enu: [0, 0, 0] }]);
  f.setPath({ id: 'p', points: [[0, 0, 0], [5000, 5000, 0]] });
  f.setAvailable(false);
  const r = f.frame(SIZE);
  // 손계산: span 5000, avail 568, metersPerPx 5000/568, 중심 (2500,2500)
  near(r.view.centerE, 2500, 'centerE'); near(r.view.centerN, 2500, 'centerN');
  near(r.view.metersPerPx, 5000 / 568, 'metersPerPx');
  assert.equal(r.paths[0].polyline.length, 2);
  for (const p of r.paths[0].polyline) {
    assert.ok(p.x >= MARGIN - EPS && p.x <= SIZE.width - MARGIN + EPS, `x ${p.x}`);
    assert.ok(p.y >= MARGIN - EPS && p.y <= SIZE.height - MARGIN + EPS, `y ${p.y}`);
  }
  near(r.paths[0].polyline[0].y, SIZE.height - MARGIN, '시작점 아래 여백 선');
  near(r.paths[0].polyline[1].y, MARGIN, '끝점 위 여백 선');
});

test('index: 수동 view 일 때도 banner 가 나온다(데이터 있음·clear 뒤 모두)', () => {
  const f = scene();
  f.setAvailable(false);
  f.setView({ centerE: 0, centerN: 0, metersPerPx: 0.5 });
  assert.equal(f.frame(SIZE).banner, '실시간 3D 불가');
  f.clear();
  const r = f.frame(SIZE);
  assert.equal(r.banner, '실시간 3D 불가');
  assert.equal(r.mode, 'fallback');
  assert.equal(r.empty, true);
});

test('index: opts 의 minSpanM·marginPx 가 맞춤에 쓰인다(기본값으로 바뀌지 않는다)', () => {
  // 점 하나·100×100: span = max(0, 1000) = 1000, avail = 100 - 0 = 100 → metersPerPx 10 (기본값이면 100/68)
  const f = createTowerFallback({ minSpanM: 1000, marginPx: 0 });
  f.setDrones([{ id: 'd', enu: [7, 9, 0] }]);
  f.setAvailable(false);
  const r = f.frame({ width: 100, height: 100 });
  near(r.view.metersPerPx, 10, 'metersPerPx');
  near(r.drones[0].x, 50, 'x'); near(r.drones[0].y, 50, 'y');
});

test('index: setView 로 넘긴 객체나 frame 결과를 고쳐도 다음 frame 의 view 는 원래 값이다', () => {
  const f = scene();
  f.setAvailable(false);
  const given = { centerE: 1, centerN: 2, metersPerPx: 0.5 };
  f.setView(given);
  given.centerE = 999; given.metersPerPx = 77;
  assert.deepEqual(f.frame(SIZE).view, { centerE: 1, centerN: 2, metersPerPx: 0.5 });
  const r = f.frame(SIZE);
  r.view.centerN = -5; r.view.metersPerPx = 3;
  assert.deepEqual(f.frame(SIZE).view, { centerE: 1, centerN: 2, metersPerPx: 0.5 });
});
