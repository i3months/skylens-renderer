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
