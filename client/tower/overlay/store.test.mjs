// 관제탑 저장소 시험(T15.6). 계약: contracts/controlview/overlay.mjs. 공개 API 만 쓴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOverlayStore } from './store.mjs';

test('store: setDrones는 교체이고 누적하지 않는다', () => {
  const store = createOverlayStore();

  // 첫 번째 호출
  const drones1 = [{ id: 'd1', enu: [1, 2, 3] }, { id: 'd2', enu: [4, 5, 6] }];
  store.setDrones(drones1);
  assert.equal(store.counts().drones, 2);

  // 두 번째 호출: 전체 교체 (누적 아님)
  const drones2 = [{ id: 'd3', enu: [7, 8, 9] }];
  store.setDrones(drones2);
  assert.equal(store.counts().drones, 1);
  const result = store.drones();
  assert.equal(result[0].id, 'd3');
  assert.deepEqual(result[0].enu, [7, 8, 9]);

  // 세 번째 호출: 빈 배열로 모두 지운다
  store.setDrones([]);
  assert.equal(store.counts().drones, 0);
});

test('store: setDetections는 교체이고 누적하지 않는다', () => {
  const store = createOverlayStore();

  // 첫 번째 호출
  const detections1 = [
    { id: 'det1', enu: [1, 2, 3], kind: 'detection', confidence: 0.9 },
    { id: 'det2', enu: [4, 5, 6], kind: 'alert', confidence: 0.5 },
  ];
  store.setDetections(detections1);
  assert.equal(store.counts().detections, 2);

  // 두 번째 호출: 전체 교체 (누적 아님)
  const detections2 = [{ id: 'det3', enu: [10, 11, 12], kind: 'detection' }];
  store.setDetections(detections2);
  assert.equal(store.counts().detections, 1);
  const result = store.detections();
  assert.equal(result[0].id, 'det3');
  assert.deepEqual(result[0].enu, [10, 11, 12]);
});

test('store: setPath는 같은 id를 교체하고 순서를 지킨다', () => {
  const store = createOverlayStore();

  // 첫 세 경로 추가
  const p1 = { id: 'p1', points: [[1, 2, 3], [4, 5, 6]] };
  const p2 = { id: 'p2', points: [[10, 11, 12], [13, 14, 15]] };
  const p3 = { id: 'p3', points: [[20, 21, 22], [23, 24, 25]] };
  store.setPath(p1);
  store.setPath(p2);
  store.setPath(p3);
  assert.equal(store.counts().paths, 3);

  // p2를 새로운 points로 교체 (순서 유지)
  const p2Updated = { id: 'p2', points: [[100, 101, 102], [103, 104, 105]] };
  store.setPath(p2Updated);
  assert.equal(store.counts().paths, 3);

  const paths = store.paths();
  // 순서가 유지되는지 확인: p1, p2(교체됨), p3
  assert.equal(paths[0].id, 'p1');
  assert.equal(paths[1].id, 'p2');
  assert.deepEqual(paths[1].points, [[100, 101, 102], [103, 104, 105]]);
  assert.equal(paths[2].id, 'p3');
});

test('store: removePath는 있는 경로를 지우고 bool을 돌려준다', () => {
  const store = createOverlayStore();

  const p1 = { id: 'p1', points: [[1, 2, 3], [4, 5, 6]] };
  const p2 = { id: 'p2', points: [[10, 11, 12], [13, 14, 15]] };
  store.setPath(p1);
  store.setPath(p2);
  assert.equal(store.counts().paths, 2);

  // 있는 경로 제거
  const removed1 = store.removePath('p1');
  assert.equal(removed1, true);
  assert.equal(store.counts().paths, 1);
  const paths = store.paths();
  assert.equal(paths[0].id, 'p2');

  // 없는 경로 제거
  const removed2 = store.removePath('nonexistent');
  assert.equal(removed2, false);
  assert.equal(store.counts().paths, 1);
});

test('store: clear는 드론·탐지·경로 전부 지운다', () => {
  const store = createOverlayStore();

  // 모든 종류 추가
  store.setDrones([{ id: 'd1', enu: [1, 2, 3] }]);
  store.setDetections([{ id: 'det1', enu: [4, 5, 6] }]);
  store.setPath({ id: 'p1', points: [[7, 8, 9], [10, 11, 12]] });
  assert.deepEqual(store.counts(), { drones: 1, detections: 1, paths: 1 });

  // 전부 지운다
  store.clear();
  assert.deepEqual(store.counts(), { drones: 0, detections: 0, paths: 0 });
  assert.deepEqual(store.drones(), []);
  assert.deepEqual(store.detections(), []);
  assert.deepEqual(store.paths(), []);
});

test('store: 반환값은 깊은 복사이므로 밖에서 고치면 상태가 안 변한다(drones)', () => {
  const store = createOverlayStore();

  const drone = { id: 'd1', enu: [1, 2, 3] };
  store.setDrones([drone]);

  // drones() 반환값을 고친다
  const drones = store.drones();
  drones[0].enu[0] = 999;
  drones[0].id = 'modified';

  // 원래 상태는 변하지 않아야 한다
  const drones2 = store.drones();
  assert.equal(drones2[0].id, 'd1');
  assert.deepEqual(drones2[0].enu, [1, 2, 3]);
});

test('store: 반환값은 깊은 복사이므로 밖에서 고치면 상태가 안 변한다(detections)', () => {
  const store = createOverlayStore();

  const detection = { id: 'det1', enu: [1, 2, 3], kind: 'detection', confidence: 0.8 };
  store.setDetections([detection]);

  // detections() 반환값을 고친다
  const detections = store.detections();
  detections[0].enu[1] = 999;
  detections[0].confidence = 0.1;

  // 원래 상태는 변하지 않아야 한다
  const detections2 = store.detections();
  assert.equal(detections2[0].confidence, 0.8);
  assert.deepEqual(detections2[0].enu, [1, 2, 3]);
});

test('store: 반환값은 깊은 복사이므로 밖에서 고치면 상태가 안 변한다(paths)', () => {
  const store = createOverlayStore();

  const path = { id: 'p1', points: [[1, 2, 3], [4, 5, 6]] };
  store.setPath(path);

  // paths() 반환값을 고친다
  const paths = store.paths();
  paths[0].points[0][0] = 999;
  paths[0].id = 'modified';

  // 원래 상태는 변하지 않아야 한다
  const paths2 = store.paths();
  assert.equal(paths2[0].id, 'p1');
  assert.deepEqual(paths2[0].points, [[1, 2, 3], [4, 5, 6]]);
});

test('store: setX 후에 입력 배열을 고쳐도 상태가 안 변한다(defensive copy)', () => {
  const store = createOverlayStore();

  // 입력 배열 고쳐보기
  const droneList = [{ id: 'd1', enu: [1, 2, 3] }];
  store.setDrones(droneList);
  droneList[0].enu[0] = 999;
  droneList[0].id = 'modified';

  // 상태는 원래대로 유지되어야 한다
  const stored = store.drones();
  assert.equal(stored[0].id, 'd1');
  assert.deepEqual(stored[0].enu, [1, 2, 3]);
});

test('store: setPath 후에 입력을 고쳐도 상태가 안 변한다(defensive copy)', () => {
  const store = createOverlayStore();

  // 입력 객체 고쳐보기
  const path = { id: 'p1', points: [[1, 2, 3], [4, 5, 6]] };
  store.setPath(path);
  path.id = 'modified';
  path.points[0][0] = 999;

  // 상태는 원래대로 유지되어야 한다
  const stored = store.paths()[0];
  assert.equal(stored.id, 'p1');
  assert.deepEqual(stored.points, [[1, 2, 3], [4, 5, 6]]);
});

test('store: 여러 경로의 입력 순서를 지킨다', () => {
  const store = createOverlayStore();

  // 순서대로 추가: p3, p1, p2
  store.setPath({ id: 'p3', points: [[1, 2, 3], [4, 5, 6]] });
  store.setPath({ id: 'p1', points: [[7, 8, 9], [10, 11, 12]] });
  store.setPath({ id: 'p2', points: [[13, 14, 15], [16, 17, 18]] });

  // 반환 순서가 입력 순서대로여야 한다
  const paths = store.paths();
  assert.equal(paths[0].id, 'p3');
  assert.equal(paths[1].id, 'p1');
  assert.equal(paths[2].id, 'p2');

  // p1을 교체해도 순서는 유지된다
  store.setPath({ id: 'p1', points: [[100, 101, 102], [103, 104, 105]] });
  const paths2 = store.paths();
  assert.equal(paths2[0].id, 'p3');
  assert.equal(paths2[1].id, 'p1');
  assert.deepEqual(paths2[1].points, [[100, 101, 102], [103, 104, 105]]);
  assert.equal(paths2[2].id, 'p2');
});

test('store: counts는 현재 개수를 정확히 돌려준다', () => {
  const store = createOverlayStore();

  assert.deepEqual(store.counts(), { drones: 0, detections: 0, paths: 0 });

  store.setDrones([{ id: 'd1', enu: [1, 2, 3] }, { id: 'd2', enu: [4, 5, 6] }]);
  assert.deepEqual(store.counts(), { drones: 2, detections: 0, paths: 0 });

  store.setDetections([{ id: 'det1', enu: [7, 8, 9] }]);
  assert.deepEqual(store.counts(), { drones: 2, detections: 1, paths: 0 });

  store.setPath({ id: 'p1', points: [[1, 2, 3], [4, 5, 6]] });
  store.setPath({ id: 'p2', points: [[7, 8, 9], [10, 11, 12]] });
  assert.deepEqual(store.counts(), { drones: 2, detections: 1, paths: 2 });

  store.removePath('p1');
  assert.deepEqual(store.counts(), { drones: 2, detections: 1, paths: 1 });

  store.clear();
  assert.deepEqual(store.counts(), { drones: 0, detections: 0, paths: 0 });
});

test('store: 복잡한 중첩 구조의 깊은 복사가 제대로 된다', () => {
  const store = createOverlayStore();

  // 복잡한 구조: 여러 자리수의 점들이 있는 경로
  const path = {
    id: 'complex',
    points: [[1.1, 2.2, 3.3], [4.4, 5.5, 6.6], [7.7, 8.8, 9.9]],
  };
  store.setPath(path);

  // 반환된 값의 깊은 점들을 모두 변경
  const retrieved = store.paths()[0];
  retrieved.points[0] = [999, 999, 999];
  retrieved.points[1][0] = 999;

  // 원래 상태 확인
  const checked = store.paths()[0];
  assert.deepEqual(checked.points[0], [1.1, 2.2, 3.3]);
  assert.deepEqual(checked.points[1], [4.4, 5.5, 6.6]);
});

test('store: Raw 읽기는 복사 없이 같은 값을 주고 공개 접근자는 여전히 복사본이다', () => {
  const store = createOverlayStore();
  store.setDrones([{ id: 'd', enu: [1, 2, 3] }]);
  store.setPath({ id: 'p', points: [[0, 0, 0], [1, 1, 1]] });
  assert.equal(store.dronesRaw(), store.dronesRaw());
  assert.notEqual(store.drones(), store.dronesRaw());
  assert.deepEqual(store.pathsRaw(), store.paths());
  const out = store.paths();
  out[0].points[0][0] = 99;
  assert.equal(store.pathsRaw()[0].points[0][0], 0);
  assert.equal(store.hasPath('p'), true);
  assert.equal(store.hasPath('q'), false);
});
