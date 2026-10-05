// 관제탑 폴백 마커(markers.mjs) 시험. 기준 수치는 손으로 계산해 시험 안에 박아 두었다(view.mjs 를 쓰지 않는다).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMarkers } from './markers.mjs';
import { TOWER_FALLBACK_TEST_NAMES } from '../../../contracts/controlview/fallback.mjs';

const NAME = 'markers: 알려진 장면의 화면 좌표(숫자 박음)';
const VIEW = { centerE: 100, centerN: 50, metersPerPx: 0.5 };
const SIZE = { width: 800, height: 600 };

test('계약의 시험 이름에 들어 있다', () => {
  assert.ok(TOWER_FALLBACK_TEST_NAMES.includes(NAME));
});

test(NAME, () => {
  // x = 400 + (e−100)/0.5, y = 300 − (n−50)/0.5
  const drones = [
    { id: 'a', enu: [100, 50, 10], yaw: 1.5 },
    { id: 'b', enu: [300, 50, 0] },     // x = 800 (경계, 밖)
    { id: 'c', enu: [0, 150, 0], yaw: 0 }, // (200, 100)
    { id: 'd', enu: [299.5, 50, 0] },   // x = 799 (안)
    { id: 'e', enu: [100, 350, 0] },    // y = −300 (밖)
    { id: 'f', enu: [-100, -100, 0] },  // (0, 600): x=0 안, y=600 밖
  ];
  const got = buildMarkers(VIEW, SIZE, drones, false);
  assert.deepEqual(got, [
    { id: 'a', x: 400, y: 300, visible: true, yaw: 1.5 },
    { id: 'b', x: 800, y: 300, visible: false },
    { id: 'c', x: 200, y: 100, visible: true, yaw: 0 },
    { id: 'd', x: 799, y: 300, visible: true },
    { id: 'e', x: 400, y: -300, visible: false },
    { id: 'f', x: 0, y: 600, visible: false },
  ]);
});

test('markers: kind·confidence 보존, kind 기본은 detection', () => {
  const dets = [
    { id: 'p', enu: [100, 50, 0], kind: 'person', confidence: 0.75 },
    { id: 'q', enu: [0, 150, 0], kind: 'vehicle' },
    { id: 'r', enu: [100, 50, 0] },
  ];
  assert.deepEqual(buildMarkers(VIEW, SIZE, dets, true), [
    { id: 'p', x: 400, y: 300, visible: true, kind: 'person', confidence: 0.75 },
    { id: 'q', x: 200, y: 100, visible: true, kind: 'vehicle' },
    { id: 'r', x: 400, y: 300, visible: true, kind: 'detection' },
  ]);
});

test('markers: 입력 불변이고 결과는 새 객체이며 빈 목록은 빈 배열', () => {
  const items = [{ id: 'a', enu: [100, 50, 1], yaw: 2 }, { id: 'b', enu: [0, 0, 0] }];
  const copy = structuredClone(items);
  const got = buildMarkers(VIEW, SIZE, items, false);
  assert.deepEqual(items, copy);
  assert.notEqual(got, items);
  got.forEach((g, i) => { assert.notEqual(g, items[i]); assert.equal(g.id, items[i].id); });
  got[0].x = 9;
  assert.deepEqual(items, copy);
  assert.deepEqual(buildMarkers(VIEW, SIZE, [], true), []);
});
