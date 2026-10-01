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

// 좌표계 문구의 의미 단위 검사. 문구가 달라도 아래 사실을 말하면 통과하고, 오도하면 실패한다.
//  1) scene 좌표로 시작, 2) sceneFrame 정규화 틀을 가리킴, 3) GeoAnchor/ENU 가 아님을 밝힘, 4) 1 unit = 1 m 라고 하지 않음.
const NEG = /(GeoAnchor|ENU).{0,30}(아님|아니|무관|not\b)/i;
const CLAIMS_METRIC = /1\s*unit\s*=\s*1\s*(m\b|미터|meter)/i;
function coordProblems(text) {
  const out = [];
  if (typeof text !== 'string' || !/^scene\b/.test(text)) out.push('scene 으로 시작하지 않음');
  if (typeof text === 'string') {
    if (!/sceneFrame/.test(text)) out.push('sceneFrame 틀을 가리키지 않음');
    if (!NEG.test(text)) out.push('GeoAnchor ENU 가 아님을 밝히지 않음');
    if (CLAIMS_METRIC.test(text)) out.push('1 unit = 1 m 라고 주장');
    if (/원점의 GeoAnchor/.test(text)) out.push('원점을 GeoAnchor 로 설명');
  }
  return out;
}

test('viewpoints_coord_string_is_scene', () => {
  assert.deepEqual(coordProblems(doc.coord), [], 'coord 가 사실과 다른 설명을 한다');
  const noteIssues = coordProblems(`scene ${doc.note}`).filter((m) => !/scene 으로|sceneFrame 틀/.test(m));
  assert.deepEqual(noteIssues, [], 'note 가 사실과 다른 설명을 한다');
  assert.match(doc.note, /diag\(1,\s*-1,\s*-1\)/, 'note 에 OpenCV<->GL diag(1,-1,-1) 명시');
});

test('viewpoints_coord_rewording_passes_misleading_fails', () => {
  // 문구만 바꾼 설명은 통과
  assert.deepEqual(coordProblems('scene (sceneFrame 정규화 좌표, y 가 위, 단위는 원좌표/s 라서 미터가 아니고 ENU 와 무관: GeoAnchor ENU 아님)'), []);
  assert.deepEqual(coordProblems('scene, sceneFrame 기준. GeoAnchor ENU 가 아니다. 1 unit 은 PLY 원좌표의 1/s.'), []);
  // 오도하는 설명은 실패
  assert.ok(coordProblems('scene (GeoAnchor ENU, 1 unit = 1 m)').length >= 2);
  assert.ok(coordProblems('scene (sceneFrame, 원점은 GeoAnchor ENU 원점, y=up)').some((m) => /아님을 밝히지/.test(m)));
  assert.ok(coordProblems('scene (sceneFrame; 1 unit = 1 m; GeoAnchor ENU 아님)').some((m) => /1 m/.test(m)));
  assert.ok(coordProblems('scene (sceneFrame; 1 unit = 1 meter; GeoAnchor ENU 아님)').some((m) => /1 m/.test(m)));
  assert.ok(coordProblems('ENU, x=east y=up z=-north').some((m) => /scene 으로/.test(m)));
  assert.ok(coordProblems('scene (y=up; GeoAnchor ENU 아님)').some((m) => /sceneFrame/.test(m)));
  assert.ok(coordProblems('scene (sceneFrame 정규화 틀의 원점의 GeoAnchor)').length > 0);
  assert.ok(coordProblems(undefined).length > 0);
});

test('viewpoints_eight_unique_ids', () => {
  assert.equal(doc.viewpoints.length, 8);
  for (const v of doc.viewpoints) assert.ok(Number.isInteger(v.id), `id ${v.id} 정수 아님`);
  assert.equal(new Set(doc.viewpoints.map((v) => v.id)).size, doc.viewpoints.length, 'id 중복');
  assert.equal(new Set(doc.viewpoints.map((v) => v.name)).size, doc.viewpoints.length, 'name 중복');
  for (const v of doc.viewpoints) assert.match(v.name, /^[\w-]+$/, `시점 ${v.id} name 은 파일 이름에 안전해야 함`);
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
  // 자체 촬영(demoPreview)은 회전 없음, 틀은 demoPreview 한 파일에서 앱과 같은 stride 표본으로 구한다.
  // 값 자체의 고정(44, 0.05 ...)은 ref_images 테스트가 앱 이식 결과와 대조해 맡는다. 여기서는 형식과 의미만 본다.
  assert.equal(f.rotate, 'none');
  assert.ok(Number.isFinite(f.targetExtent) && f.targetExtent > 0);
  assert.ok(f.percentileLo >= 0 && f.percentileLo < f.percentileHi && f.percentileHi <= 1);
  assert.ok(Number.isFinite(f.clipMargin) && f.clipMargin >= 0);
  assert.ok(Number.isInteger(f.sampleTarget) && f.sampleTarget > 0);
  assert.match(f.framePly, /^res\/static\/demo\/[\w.-]+\.ply$/);
  assert.match(f.source, /develop .*sceneSource\.ts/);
  assert.doesNotMatch(f.source, /skylens_client\/data/, 'main 브랜치 경로를 근거로 쓰지 않는다');
});

test('viewpoints_size_and_fov_valid', () => {
  for (const v of doc.viewpoints) {
    assert.ok(Number.isInteger(v.width) && v.width > 0, `시점 ${v.id} width`);
    assert.ok(Number.isInteger(v.height) && v.height > 0, `시점 ${v.id} height`);
    assert.ok(v.fov_y_deg > 0 && v.fov_y_deg < 180, `시점 ${v.id} fov`);
  }
});

test('viewpoints_eyes_within_scene_frame_scale', () => {
  // 시점은 앱 틀(최대 변 targetExtent, 원점 중심)에 맞춘다: 눈은 원점에서 1.4·extent 안, 시선 목표는 틀 상자(±extent/2, 높이 0..extent) 안.
  const E = doc.sceneFrame.targetExtent;
  for (const v of doc.viewpoints) {
    assert.ok(Math.hypot(...v.eye) <= 1.4 * E, `시점 ${v.id} 가 틀에서 너무 멀다`);
    assert.ok(Math.abs(v.target[0]) <= E / 2 && Math.abs(v.target[2]) <= E / 2 && v.target[1] >= 0 && v.target[1] <= E, `시점 ${v.id} target`);
  }
});
