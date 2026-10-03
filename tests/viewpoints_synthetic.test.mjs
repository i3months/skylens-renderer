// 합성 장면용 뷰포인트 검증 테스트(T05)
// 주의: 이 파일은 테스트 코드이면서 동시에 fixtures/viewpoints/synthetic.json 문서의 검증 명세 역할을 한다.
// fixtures/viewpoints/synthetic.json 은 이 테스트가 정의한 8개 위치만 승인한다.
// 실제 자산용 viewpoints.json(fixtures/viewpoints/viewpoints.json)과는 별개이다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync(new URL('../fixtures/viewpoints/synthetic.json', import.meta.url), 'utf8'));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

test('synthetic_viewpoints_eight_ids_1_to_8', () => {
  assert.equal(doc.scene, 'flat_boxes');
  assert.deepEqual(doc.viewpoints.map((v) => v.id), [1, 2, 3, 4, 5, 6, 7, 8]);
  // 8개 위치의 고정된 이름(숫자·문자열로 명시된 승인 목록)
  const expectedNames = [
    'aerial_overview',
    'aerial_oblique_ne',
    'top_down',
    'street_level',
    'low_close_box',
    'tower_high',
    'tower_mid',
    'edge_far',
  ];
  assert.deepEqual(doc.viewpoints.map((v) => v.name), expectedNames);
  assert.equal(new Set(doc.viewpoints.map((v) => v.name)).size, 8);
});
test('synthetic_viewpoints_fields_valid', () => {
  for (const v of doc.viewpoints) {
    for (const k of ['eye', 'target', 'up']) assert.ok(v[k].length === 3 && v[k].every(Number.isFinite), `${v.name}.${k}`);
    assert.ok(Number.isInteger(v.width) && Number.isInteger(v.height) && v.width > 0 && v.height > 0);
    assert.ok(v.fov_y_deg > 0 && v.fov_y_deg < 180);
    const d = sub(v.target, v.eye);
    assert.ok(Math.hypot(...d) > 1, `${v.name} 시선 길이`);
    const c = cross(d, v.up);
    assert.ok(Math.hypot(...c) / (Math.hypot(...d) * Math.hypot(...v.up)) > 1e-3, `${v.name} 시선·up 평행`);
  }
});
test('synthetic_viewpoints_inside_scene_envelope', () => {
  for (const v of doc.viewpoints) {
    assert.ok(Math.abs(v.eye[0]) <= 200 && Math.abs(v.eye[2]) <= 200 && v.eye[1] > 0 && v.eye[1] <= 200, v.name);
  }
});
test('synthetic_viewpoints_coord_says_enu_meter', () => {
  assert.match(doc.coord, /ENU/);
  assert.match(doc.coord, /1 unit = 1 m/);
});

test('synthetic_viewpoints_fixed_values', () => {
  // 8개 위치의 고정된 eye/target/up/width/height/fov_y_deg 값
  const expectedViewpoints = [
    {
      id: 1,
      name: 'aerial_overview',
      eye: [0, 120, 140],
      target: [0, 5, 0],
      up: [0, 1, 0],
      width: 1280,
      height: 720,
      fov_y_deg: 50,
    },
    {
      id: 2,
      name: 'aerial_oblique_ne',
      eye: [90, 60, -90],
      target: [0, 8, 0],
      up: [0, 1, 0],
      width: 1280,
      height: 720,
      fov_y_deg: 50,
    },
    {
      id: 3,
      name: 'top_down',
      eye: [0, 200, 1],
      target: [0, 0, 0],
      up: [0, 1, 0],
      width: 1280,
      height: 720,
      fov_y_deg: 50,
    },
    {
      id: 4,
      name: 'street_level',
      eye: [0, 1.7, 90],
      target: [0, 6, 0],
      up: [0, 1, 0],
      width: 1280,
      height: 720,
      fov_y_deg: 50,
    },
    {
      id: 5,
      name: 'low_close_box',
      eye: [30, 3, 45],
      target: [20, 8, 20],
      up: [0, 1, 0],
      width: 1280,
      height: 720,
      fov_y_deg: 50,
    },
    {
      id: 6,
      name: 'tower_high',
      eye: [0, 80, 60],
      target: [0, 0, -20],
      up: [0, 1, 0],
      width: 1280,
      height: 720,
      fov_y_deg: 50,
    },
    {
      id: 7,
      name: 'tower_mid',
      eye: [-60, 30, 70],
      target: [0, 5, 0],
      up: [0, 1, 0],
      width: 1280,
      height: 720,
      fov_y_deg: 50,
    },
    {
      id: 8,
      name: 'edge_far',
      eye: [-95, 6, 95],
      target: [40, 5, -40],
      up: [0, 1, 0],
      width: 1280,
      height: 720,
      fov_y_deg: 50,
    },
  ];

  // JSON의 값과 고정된 값 비교
  for (let i = 0; i < doc.viewpoints.length; i++) {
    const jsonVp = doc.viewpoints[i];
    const expectedVp = expectedViewpoints[i];
    assert.deepEqual(jsonVp.id, expectedVp.id, `viewpoint ${i} id`);
    assert.deepEqual(jsonVp.name, expectedVp.name, `viewpoint ${i} name`);
    assert.deepEqual(jsonVp.eye, expectedVp.eye, `viewpoint ${i} eye`);
    assert.deepEqual(jsonVp.target, expectedVp.target, `viewpoint ${i} target`);
    assert.deepEqual(jsonVp.up, expectedVp.up, `viewpoint ${i} up`);
    assert.deepEqual(jsonVp.width, expectedVp.width, `viewpoint ${i} width`);
    assert.deepEqual(jsonVp.height, expectedVp.height, `viewpoint ${i} height`);
    assert.deepEqual(jsonVp.fov_y_deg, expectedVp.fov_y_deg, `viewpoint ${i} fov_y_deg`);
  }
});
