// 관제탑 오버레이 조립(index.mjs) 시험. 계약(contracts/controlview/overlay.mjs)만 시험하고 구현 세부에 기대지 않는다.
// 기준 수치는 합성 장면의 알려진 값을 시험 안에 박았다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTowerOverlay } from './index.mjs';
import { poseToCameraPose } from '../input/camera.mjs';
import { TOWER_OVERLAY_TEST_NAMES, TOWER_OVERLAY_MODULES } from '../../../contracts/controlview/overlay.mjs';

const NAME_FAIL = 'index: 검사에 실패하면 이전 상태가 그대로다';
const NAME_ORDER = 'index: 입력 순서·개수·id 를 지킨다';
const NAME_NOFAKE = 'index: 받지 않은 위치를 지어내지 않는다(보간·외삽 없음)';

const FOVY = 0.9;
const SIZE = { width: 1280, height: 720 };
// 위치 [0,0,0], 북쪽을 향해 수평으로 본다. fx = 360/tan(0.45) = 745.2566500684364.
const CAM0 = poseToCameraPose({ pos: [0, 0, 0], yaw: 0, pitch: 0 }, FOVY);
const FX = 745.2566500684364;
const U_EAST = 1012.6283250342183; // 640 + FX·0.5
const EPS = 1e-6;

const close = (a, b, eps = EPS, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} vs ${b}`);

test('계약 시험 이름과 모듈 파일이 맞다', () => {
  for (const n of [NAME_FAIL, NAME_ORDER, NAME_NOFAKE]) assert.ok(TOWER_OVERLAY_TEST_NAMES.includes(n), n);
  assert.equal(TOWER_OVERLAY_MODULES.index.file, 'index.mjs');
});

test('index: 알려진 카메라에서 드론의 화면 좌표(숫자 박음)', () => {
  const o = createTowerOverlay();
  o.setDrones([{ id: 'a', enu: [0, 10, 0] }, { id: 'b', enu: [5, 10, 0] }]);
  const { drones } = o.project(CAM0, SIZE);
  assert.equal(drones.length, 2);
  close(drones[0].u, 640); close(drones[0].v, 360); close(drones[0].depth, 10);
  assert.equal(drones[0].visible, true);
  close(drones[1].u, U_EAST); close(drones[1].v, 360); close(drones[1].depth, 10);
  assert.equal(drones[1].visible, true);
  assert.ok(Math.abs(drones[1].u - (640 + FX * 0.5)) < EPS);
});

test(NAME_FAIL, () => {
  const o = createTowerOverlay();
  o.setDrones([{ id: 'a', enu: [0, 10, 0] }]);
  o.setDetections([{ id: 'x', enu: [5, 10, 0] }]);
  o.setPath({ id: 'p', points: [[0, 5, 0], [0, 20, 0]] });
  const countsBefore = o.counts();
  const projBefore = o.project(CAM0, SIZE);
  // 중복 id, 형식 위반, 범위 위반: 모두 던지고 상태는 그대로.
  assert.throws(() => o.setDrones([{ id: 'n1', enu: [0, 1, 0] }, { id: 'n1', enu: [0, 2, 0] }]));
  assert.throws(() => o.setDrones([{ id: 'n2', enu: [0, 1, 0] }, { id: 'n3', enu: [0, 'x', 0] }]), TypeError);
  assert.throws(() => o.setDrones('없음'));
  assert.throws(() => o.setDetections([{ id: 'n4', enu: [0, 1, 0] }, { id: 'n5', enu: [0, 1, 0], confidence: 2 }]));
  assert.throws(() => o.setPath({ id: 'p', points: [[0, 5, 0]] }));
  assert.deepEqual(o.counts(), countsBefore);
  assert.deepEqual(o.project(CAM0, SIZE), projBefore);
});

test(NAME_ORDER, () => {
  const o = createTowerOverlay();
  const ids = ['z', 'a', 'm', 'b', 'q'];
  o.setDrones(ids.map((id, i) => ({ id, enu: [i - 2, 10 + i, 0] })));
  const dIds = ['d3', 'd1', 'd2'];
  o.setDetections(dIds.map((id, i) => ({ id, enu: [i, 20, 0] })));
  const r = o.project(CAM0, SIZE);
  assert.deepEqual(r.drones.map((d) => d.id), ids);
  assert.deepEqual(r.detections.map((d) => d.id), dIds);
  r.drones.forEach((d, i) => close(d.depth, 10 + i, EPS, `깊이 ${d.id}`));
  assert.deepEqual(o.counts(), { drones: 5, detections: 3, paths: 0 });
});

test(NAME_NOFAKE, () => {
  const o = createTowerOverlay();
  // 아무것도 설정하지 않으면 빈 목록.
  assert.deepEqual(o.project(CAM0, SIZE), { drones: [], detections: [], paths: [] });
  o.setDrones([{ id: 'a', enu: [0, 10, 0] }]);
  close(o.project(CAM0, SIZE).drones[0].depth, 10);
  o.setDrones([{ id: 'a', enu: [0, 30, 0] }]);
  const r = o.project(CAM0, SIZE);
  // 두 번째 값만 반영: 첫 값(10)이나 중간(20)·외삽(50) 값은 없다.
  assert.equal(r.drones.length, 1);
  close(r.drones[0].depth, 30);
  for (const bad of [10, 20, 50]) assert.ok(Math.abs(r.drones[0].depth - bad) > 1, `지어낸 깊이 ${bad}`);
  // 다시 호출해도 같은 값(시간·호출 횟수에 따라 변하지 않는다).
  assert.deepEqual(o.project(CAM0, SIZE), r);
});

test('index: setDrones 는 교체이고 누적하지 않는다', () => {
  const o = createTowerOverlay();
  o.setDrones([{ id: 'a', enu: [0, 10, 0] }, { id: 'b', enu: [1, 10, 0] }]);
  o.setDrones([{ id: 'c', enu: [2, 10, 0] }]);
  assert.equal(o.counts().drones, 1);
  assert.deepEqual(o.project(CAM0, SIZE).drones.map((d) => d.id), ['c']);
  o.setDrones([]);
  assert.equal(o.counts().drones, 0);
  assert.deepEqual(o.project(CAM0, SIZE).drones, []);
});

test('index: 경로는 같은 id 면 교체하고 removePath 로 제거한다', () => {
  const o = createTowerOverlay();
  o.setPath({ id: 'p', points: [[0, 5, 0], [0, 20, 0]] });
  o.setPath({ id: 'q', points: [[1, 5, 0], [1, 20, 0]] });
  assert.equal(o.counts().paths, 2);
  o.setPath({ id: 'p', points: [[0, 6, 0], [0, 30, 0]] });
  assert.equal(o.counts().paths, 2);
  const p = o.project(CAM0, SIZE).paths.find((x) => x.id === 'p');
  assert.equal(p.polylines.length, 1);
  const pl = p.polylines[0];
  close(pl[0].depth, 6); close(pl[pl.length - 1].depth, 30);
  assert.equal(o.removePath('p'), true);
  assert.equal(o.removePath('p'), false);
  assert.equal(o.removePath('없는id'), false);
  assert.deepEqual(o.project(CAM0, SIZE).paths.map((x) => x.id), ['q']);
});

test('index: 근평면 뒤로 가는 경로는 앞 조각만 남는다', () => {
  const o = createTowerOverlay({ nearM: 0.1 });
  // 북쪽 5 m 에서 남쪽 -5 m 로 가는 선분: 깊이 0.1 에서 잘린다.
  o.setPath({ id: 'p', points: [[0, 5, 0], [0, -5, 0]] });
  const [pl] = o.project(CAM0, SIZE).paths[0].polylines;
  close(pl[0].depth, 5);
  close(pl[pl.length - 1].depth, 0.1, 1e-9);
});

test('index: 탐지의 kind 기본값은 detection 이고 confidence 는 있을 때만 전달한다', () => {
  const o = createTowerOverlay();
  o.setDetections([
    { id: 'a', enu: [0, 10, 0] },
    { id: 'b', enu: [0, 10, 0], kind: 'alert', confidence: 0.75 },
    { id: 'c', enu: [0, 10, 0], confidence: 0 },
  ]);
  const d = o.project(CAM0, SIZE).detections;
  assert.equal(d[0].kind, 'detection');
  assert.equal('confidence' in d[0], false);
  assert.equal(d[1].kind, 'alert');
  assert.equal(d[1].confidence, 0.75);
  assert.equal(d[2].kind, 'detection');
  assert.equal(d[2].confidence, 0);
});

test('index: 드론의 yaw 는 그대로 돌려주고 없으면 키가 없다', () => {
  const o = createTowerOverlay();
  o.setDrones([{ id: 'a', enu: [0, 10, 0], yaw: 1.25 }, { id: 'b', enu: [0, 10, 0] }, { id: 'c', enu: [0, 10, 0], yaw: 0 }]);
  const d = o.project(CAM0, SIZE).drones;
  assert.equal(d[0].yaw, 1.25);
  assert.equal('yaw' in d[1], false);
  assert.equal(d[2].yaw, 0);
});

test('index: clear 는 드론·탐지·경로를 모두 지운다', () => {
  const o = createTowerOverlay();
  o.setDrones([{ id: 'a', enu: [0, 10, 0] }]);
  o.setDetections([{ id: 'x', enu: [0, 10, 0] }]);
  o.setPath({ id: 'p', points: [[0, 5, 0], [0, 20, 0]] });
  assert.deepEqual(o.counts(), { drones: 1, detections: 1, paths: 1 });
  o.clear();
  assert.deepEqual(o.counts(), { drones: 0, detections: 0, paths: 0 });
  assert.deepEqual(o.project(CAM0, SIZE), { drones: [], detections: [], paths: [] });
});

test('index: 반환 객체는 새 것이라 밖에서 고쳐도 다음 project 는 그대로다', () => {
  const o = createTowerOverlay();
  o.setDrones([{ id: 'a', enu: [0, 10, 0], yaw: 0.5 }]);
  o.setDetections([{ id: 'x', enu: [0, 10, 0], confidence: 0.5 }]);
  o.setPath({ id: 'p', points: [[0, 5, 0], [0, 20, 0]] });
  const first = o.project(CAM0, SIZE);
  const snapshot = JSON.parse(JSON.stringify(first));
  first.drones[0].u = 9999; first.drones[0].id = '변조'; first.drones.push({ id: 'junk' });
  first.detections[0].kind = '변조'; first.detections.length = 0;
  first.paths[0].polylines[0][0].u = 9999; first.paths[0].polylines.length = 0;
  assert.deepEqual(o.project(CAM0, SIZE), snapshot);
  assert.deepEqual(o.counts(), { drones: 1, detections: 1, paths: 1 });
  // 넣은 입력을 밖에서 고쳐도 상태는 그대로다.
  const input = [{ id: 'm', enu: [0, 10, 0] }];
  o.setDrones(input);
  input[0].enu[1] = 99; input[0].id = '변조';
  const r = o.project(CAM0, SIZE).drones;
  assert.equal(r[0].id, 'm');
  close(r[0].depth, 10);
});

test('index: 카메라 뒤 점은 visible=false 이고 u=v=0 이다', () => {
  const o = createTowerOverlay();
  o.setDrones([{ id: 'behind', enu: [0, -10, 0] }]);
  const [d] = o.project(CAM0, SIZE).drones;
  assert.equal(d.visible, false);
  assert.equal(d.u, 0); assert.equal(d.v, 0);
});

test('index: unproject 왕복 오차 ≤ 1 cm', () => {
  const pose = poseToCameraPose({ pos: [120, -340, 85], yaw: 0.7, pitch: -0.4 }, FOVY);
  const pts = [[130, -300, 90], [200, -250, 20], [100, -200, 150], [-500, 800, 40]];
  const o = createTowerOverlay();
  o.setDrones(pts.map((enu, i) => ({ id: `d${i}`, enu })));
  const proj = o.project(pose, SIZE).drones;
  proj.forEach((r, i) => {
    assert.ok(r.depth > 0, `깊이 ${i}`);
    const w = o.unproject(pose, SIZE, r.u, r.v, r.depth);
    assert.equal(w.length, 3);
    for (let k = 0; k < 3; k += 1) assert.ok(Math.abs(w[k] - pts[i][k]) <= 0.01, `점 ${i} 성분 ${k}: ${w[k]} vs ${pts[i][k]}`);
  });
  // 알려진 값: 주점·깊이 10 은 북쪽 10 m.
  const n = o.unproject(CAM0, SIZE, 640, 360, 10);
  close(n[0], 0, 1e-9); close(n[1], 10, 1e-9); close(n[2], 0, 1e-9);
});
