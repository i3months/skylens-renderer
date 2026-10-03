import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync(new URL('../fixtures/viewpoints/synthetic.json', import.meta.url), 'utf8'));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

test('synthetic_viewpoints_eight_ids_1_to_8', () => {
  assert.equal(doc.scene, 'flat_boxes');
  assert.deepEqual(doc.viewpoints.map((v) => v.id), [1, 2, 3, 4, 5, 6, 7, 8]);
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
