// 폴백 일관성 시험: 받지 않은 위치를 지어내지 않고, 검사에 실패하면 이전 상태가 그대로임을 확인한다.
// 기대값은 구현과 독립으로 손계산했다. 화면 변환(view 직접 지정): x = w/2 + (e − cE)/m, y = h/2 − (n − cN)/m.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTowerFallback } from './index.mjs';
import { TOWER_OVERLAY_LIMITS } from '../../../contracts/controlview/overlay.mjs';

// 화면 200x100, 중심 (0,0), 1 m/px → x = 100 + e, y = 50 − n.
const SIZE = { width: 200, height: 100 };
const VIEW = { centerE: 0, centerN: 0, metersPerPx: 1 };

function make() {
  const f = createTowerFallback();
  f.setAvailable(false);
  f.setView({ ...VIEW });
  return f;
}
const snap = (f) => ({ counts: f.counts(), frame: f.frame(SIZE) });
const ids = (list) => list.map((m) => m.id);

test('index: 받지 않은 위치를 지어내지 않는다(보간·외삽 없음)', () => {
  const f = make();

  // (a) 두 번 호출하면 두 번째만 보인다(교체). 누적·보간 없음.
  f.setDrones([{ id: 'a', enu: [10, 20, 5] }, { id: 'b', enu: [-30, 0, 0] }]);
  f.setDrones([{ id: 'c', enu: [40, -10, 0], yaw: 1.5 }]);
  let fr = f.frame(SIZE);
  assert.deepEqual(ids(fr.drones), ['c']);
  assert.equal(fr.drones.length, 1);
  // c: x = 100+40 = 140, y = 50−(−10) = 60.
  assert.equal(fr.drones[0].x, 140);
  assert.equal(fr.drones[0].y, 60);
  assert.equal(fr.drones[0].yaw, 1.5);
  assert.equal(f.counts().drones, 1);

  // 점 수 일치: 탐지 3, 경로 2개(점 4 + 2).
  f.setDetections([{ id: 'x', enu: [0, 0, 0] }, { id: 'y', enu: [1, 1, 0] }, { id: 'z', enu: [2, 2, 0], kind: 'alert', confidence: 0.5 }]);
  f.setPath({ id: 'p1', points: [[0, 0, 0], [10, 0, 0], [10, 10, 0], [20, 10, 0]] });
  f.setPath({ id: 'p2', points: [[-5, -5, 0], [5, 5, 0]] });
  fr = f.frame(SIZE);
  assert.equal(fr.drones.length, 1);
  assert.equal(fr.detections.length, 3);
  assert.equal(fr.paths.length, 2);
  assert.equal(fr.paths[0].polyline.length, 4);
  assert.equal(fr.paths[1].polyline.length, 2);
  const total = fr.drones.length + fr.detections.length + fr.paths.reduce((s, p) => s + p.polyline.length, 0);
  assert.equal(total, 1 + 3 + 6);
  // p1 의 점 순서·좌표: (0,0)→(100,50), (10,0)→(110,50), (10,10)→(110,40), (20,10)→(120,40).
  assert.deepEqual(fr.paths[0].polyline, [{ x: 100, y: 50 }, { x: 110, y: 50 }, { x: 110, y: 40 }, { x: 120, y: 40 }]);

  // 점 하나만 있는 목록도 점 하나만 나온다(둘 사이를 채우지 않는다).
  f.setDrones([{ id: 'only', enu: [0, 0, 0] }]);
  assert.equal(f.frame(SIZE).drones.length, 1);

  // (b) 입력 id 에 없는 항목은 결과에 없다.
  f.setDrones([{ id: 'd1', enu: [1, 1, 0] }, { id: 'd2', enu: [2, 2, 0] }]);
  f.setDetections([{ id: 't1', enu: [3, 3, 0] }]);
  fr = f.frame(SIZE);
  assert.deepEqual(ids(fr.drones).sort(), ['d1', 'd2']);
  assert.deepEqual(ids(fr.detections), ['t1']);
  assert.deepEqual(ids(fr.paths).sort(), ['p1', 'p2']);
  for (const gone of ['a', 'b', 'c', 'only', 'x', 'y', 'z']) {
    assert.ok(!ids(fr.drones).includes(gone) && !ids(fr.detections).includes(gone), gone);
  }

  // (d) removePath·clear 뒤 해당 항목은 사라진다.
  assert.equal(f.removePath('p1'), true);
  assert.equal(f.removePath('p1'), false);
  assert.deepEqual(ids(f.frame(SIZE).paths), ['p2']);
  assert.equal(f.counts().paths, 1);
  f.clear();
  fr = f.frame(SIZE);
  assert.deepEqual([fr.drones, fr.detections, fr.paths], [[], [], []]);
  assert.equal(fr.empty, true);
  assert.deepEqual(f.counts(), { drones: 0, detections: 0, paths: 0 });

  // (e) live → fallback → live 를 오가도 받아 둔 데이터가 그대로 나온다.
  const g = createTowerFallback();
  g.setView({ ...VIEW });
  g.setDrones([{ id: 'u', enu: [7, 3, 0] }]);
  g.setPath({ id: 'q', points: [[0, 0, 0], [1, 1, 0]] });
  const live1 = g.frame(SIZE);
  assert.equal(live1.mode, 'live');
  assert.deepEqual(live1.drones, []); // live 에서는 3D 층이 그린다
  assert.equal(live1.empty, false);
  g.setAvailable(false);
  const fb1 = g.frame(SIZE);
  // u: x = 107, y = 47.
  assert.deepEqual(fb1.drones.map((d) => [d.id, d.x, d.y]), [['u', 107, 47]]);
  g.setAvailable(true);
  assert.equal(g.frame(SIZE).mode, 'live');
  g.setAvailable(false);
  assert.deepEqual(g.frame(SIZE), fb1);
  assert.deepEqual(g.counts(), { drones: 1, detections: 0, paths: 1 });

  // 시간이 흘러도(여러 번 호출) 결과는 불변이다: 외삽 없음. 자동 맞춤도 마찬가지.
  g.setView(null);
  const auto = g.frame(SIZE);
  for (let i = 0; i < 50; i++) assert.deepEqual(g.frame(SIZE), auto);
  // frame 결과를 고쳐도 상태는 불변이다.
  auto.drones[0].x = 9999;
  auto.paths[0].polyline.length = 0;
  assert.notEqual(g.frame(SIZE).drones[0].x, 9999);
  assert.equal(g.frame(SIZE).paths[0].polyline.length, 2);

  // (f) 입력 객체를 호출 뒤 변조해도 상태는 불변이다.
  const h = make();
  const drones = [{ id: 'm', enu: [10, 10, 0], yaw: 0.5 }];
  const dets = [{ id: 'n', enu: [20, 20, 0], kind: 'alert', confidence: 0.9 }];
  const path = { id: 'r', points: [[0, 0, 0], [5, 5, 0]] };
  h.setDrones(drones);
  h.setDetections(dets);
  h.setPath(path);
  const before = snap(h);
  drones[0].enu[0] = 999; drones[0].id = 'zzz'; drones[0].yaw = 3; drones.push({ id: 'extra', enu: [0, 0, 0] });
  dets[0].enu[1] = -999; dets[0].confidence = 0.1; dets.length = 0;
  path.points[0][0] = 888; path.points.push([1, 1, 1]); path.id = 'other';
  assert.deepEqual(snap(h), before);
});

test('index: 검사에 실패하면 이전 상태가 그대로다', () => {
  const f = make();
  f.setDrones([{ id: 'a', enu: [10, 20, 0] }]);
  f.setDetections([{ id: 't', enu: [1, 2, 0], kind: 'alert', confidence: 0.25 }]);
  f.setPath({ id: 'p', points: [[0, 0, 0], [3, 4, 0]] });
  const before = snap(f);
  assert.deepEqual(before.counts, { drones: 1, detections: 1, paths: 1 });

  // (c) 잘못된 입력은 던지고, 앞뒤 counts()·frame() 이 같다. 일부만 유효한 목록도 부분 반영되지 않는다.
  const bad = [
    () => f.setDrones([{ id: 'ok', enu: [1, 1, 0] }, { id: 'nan', enu: [NaN, 0, 0] }]),
    () => f.setDrones([{ id: 'ok', enu: [1, 1, 0] }, { id: 'dup', enu: [0, 0, 0] }, { id: 'dup', enu: [2, 2, 0] }]),
    () => f.setDrones([{ id: 'ok', enu: [1, 1, 0] }, { id: 'far', enu: [1.0e6 + 1, 0, 0] }]),
    () => f.setDrones([{ id: 'ok', enu: [1, 1, 0] }, { id: 'far', enu: [0, -2e6, 0] }]),
    () => f.setDetections([{ id: 'ok', enu: [1, 1, 0] }, { id: 'inf', enu: [0, Infinity, 0] }]),
    () => f.setDetections([{ id: 'dup', enu: [0, 0, 0] }, { id: 'dup', enu: [1, 1, 0] }]),
    () => f.setDetections([{ id: 'far', enu: [5e6, 0, 0] }]),
    () => f.setPath({ id: 'p', points: [[9, 9, 0]] }), // 점 1개, 기존 id 도 보존
    () => f.setPath({ id: 'new', points: [[0, 0, 0]] }),
    () => f.setPath({ id: 'p', points: [[0, 0, 0], [NaN, 1, 0]] }),
    () => f.setPath({ id: 'p', points: [[0, 0, 0], [1e7, 1, 0]] }),
  ];
  for (const fn of bad) {
    assert.throws(fn);
    assert.deepEqual(snap(f), before);
  }

  // 형식 위반도 마찬가지다.
  assert.throws(() => f.setDrones('x'), TypeError);
  assert.throws(() => f.setPath(null), TypeError);
  assert.deepEqual(snap(f), before);

  // maxPaths 초과 새 id: 상한까지 채운 뒤 새 id 는 던지고 상태 그대로, 기존 id 교체는 허용.
  const max = TOWER_OVERLAY_LIMITS.maxPaths;
  for (let i = 1; i < max; i++) f.setPath({ id: `k${i}`, points: [[i, 0, 0], [i, 1, 0]] });
  assert.equal(f.counts().paths, max);
  const full = snap(f);
  assert.throws(() => f.setPath({ id: 'overflow', points: [[0, 0, 0], [1, 1, 0]] }), RangeError);
  assert.deepEqual(snap(f), full);
  assert.ok(!ids(f.frame(SIZE).paths).includes('overflow'));
  f.setPath({ id: 'k1', points: [[0, 0, 0], [2, 2, 0], [4, 4, 0]] });
  assert.equal(f.counts().paths, max);
  assert.equal(f.frame(SIZE).paths.find((p) => p.id === 'k1').polyline.length, 3);

  // 실패 뒤에도 정상 입력은 받는다.
  f.setDrones([{ id: 'after', enu: [0, 0, 0] }]);
  assert.deepEqual(ids(f.frame(SIZE).drones), ['after']);

  // 잘못된 setAvailable·setView 도 모드·보기를 바꾸지 않는다.
  const m = f.mode();
  const v = f.frame(SIZE).view;
  assert.throws(() => f.setAvailable('yes'), TypeError);
  assert.throws(() => f.setView({ centerE: 0, centerN: 0, metersPerPx: -1 }), RangeError);
  assert.equal(f.mode(), m);
  assert.deepEqual(f.frame(SIZE).view, v);
});
