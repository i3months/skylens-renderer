import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync(new URL('../fixtures/viewpoints/viewpoints.json', import.meta.url), 'utf8'));

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(...a);
// sin(시선, up). 평행하면 0.
const sinAngle = (d, up) => norm(cross(d, up)) / (norm(d) * norm(up));

test('viewpoints_anchor_exists_and_in_range', () => {
  const a = doc.anchor;
  assert.ok(a && typeof a === 'object', 'anchor 없음');
  for (const k of ['lat', 'lon', 'alt']) {
    assert.equal(typeof a[k], 'number', `anchor.${k} 는 숫자여야 함`);
    assert.ok(Number.isFinite(a[k]), `anchor.${k} 유한하지 않음`);
  }
  assert.ok(a.lat >= -90 && a.lat <= 90, 'lat 범위 -90..90');
  assert.ok(a.lon >= -180 && a.lon <= 180, 'lon 범위 -180..180');
  assert.equal(typeof doc.anchor_source, 'string');
  assert.match(doc.anchor_source, /config\.ts:\d+/, '출처 파일:줄 필요');
});

test('viewpoints_coord_string_is_scene', () => {
  assert.equal(doc.coord, 'scene (x=east, y=up, z=-north), 1 unit = 1 m; PLY 원좌표에 sceneFrame(앱이 스플랫을 그리는 틀)을 적용한 뒤의 좌표');
  assert.match(doc.coord, /^scene \(x=east, y=up, z=-north\)/, 'coord 는 scene 으로 시작');
  assert.ok(!/^ENU/.test(doc.coord), 'coord 가 ENU 로 시작하면 안 됨');
  assert.ok(!/^scene\b/.test('ENU, x=east y=up z=-north'), '음성: ENU 표기는 scene 접두 검사에 걸리지 않는다');
  assert.match(doc.note, /diag\(1,-1,-1\)/, 'note 에 OpenCV<->GL diag(1,-1,-1) 명시');
});

test('viewpoints_eight_unique_ids', () => {
  assert.equal(doc.viewpoints.length, 8);
  assert.equal(new Set(doc.viewpoints.map((v) => v.id)).size, 8);
});

test('viewpoints_up_not_parallel_to_view_dir', () => {
  for (const v of doc.viewpoints) {
    for (const k of ['eye', 'target', 'up']) {
      assert.ok(Array.isArray(v[k]) && v[k].length === 3 && v[k].every(Number.isFinite), `시점 ${v.id} ${k} 형식`);
    }
    const d = sub(v.target, v.eye);
    assert.ok(norm(d) > 0, `시점 ${v.id} eye==target`);
    assert.ok(norm(v.up) > 0, `시점 ${v.id} up 영벡터`);
    assert.ok(sinAngle(d, v.up) > 1e-3, `시점 ${v.id} up 이 시선과 평행`);
  }
});

test('viewpoints_negative_parallel_up_detected', () => {
  // 음성: 수직 하향 시선과 up=[0,1,0] 은 평행으로 판정되어야 한다.
  assert.ok(sinAngle([0, -100, 0], [0, 1, 0]) <= 1e-3);
  assert.ok(sinAngle([0, 0, -100], [0, 1, 0]) > 0.99);
});

test('viewpoints_scene_frame_declared', () => {
  const f = doc.sceneFrame;
  assert.equal(f.rotate, 'x180');
  assert.equal(f.targetExtent, 44);
  assert.ok(f.percentileLo >= 0 && f.percentileLo < f.percentileHi && f.percentileHi <= 1);
  assert.ok(f.clipMargin >= 0);
  assert.match(f.source, /sceneSource\.ts/);
  assert.match(doc.coord, /sceneFrame/, 'coord 가 점군 틀을 가리켜야 함');
});

test('viewpoints_size_and_fov_valid', () => {
  for (const v of doc.viewpoints) {
    assert.ok(Number.isInteger(v.width) && v.width > 0, `시점 ${v.id} width`);
    assert.ok(Number.isInteger(v.height) && v.height > 0, `시점 ${v.id} height`);
    assert.ok(v.fov_y_deg > 0 && v.fov_y_deg < 180, `시점 ${v.id} fov`);
  }
});

test('viewpoints_eyes_within_scene_frame_scale', () => {
  // 시점은 앱 틀(최대 변 44 m, 원점 중심)에 맞춘다: 눈은 원점에서 150 m 안.
  for (const v of doc.viewpoints) assert.ok(Math.hypot(...v.eye) <= 150, `시점 ${v.id} 가 틀에서 너무 멀다`);
});
