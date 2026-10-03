// 렌더 뷰 시험(T06.10)

import test from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { viewpointToCamera, renderViews } from './index.mjs';
import { project } from '../../server/raster_ref/project/index.mjs';
import { encodePng } from '../scene_preview/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * PNG 데이터의 SHA256 해시를 계산한다.
 */
function hashPng(pngData) {
  return createHash('sha256').update(pngData).digest('hex');
}

test('viewpointToCamera: aerial_overview 정답 검사', async (t) => {
  // 시점 정보: aerial_overview
  const vp = {
    eye: [0, 120, 140],
    target: [0, 5, 0],
    up: [0, 1, 0],
    width: 1280,
    height: 720,
    fov_y_deg: 50,
  };

  const camera = viewpointToCamera(vp);

  // 검사 1: 리터럴. fy = 360/tan(25°) = 772.02249…(손계산: tan 25° = 0.4663076582 → 360/0.4663076582), cx = 640, cy = 360.
  // 구현과 같은 식으로 기대값을 만들지 않는다.
  assert.ok(Math.abs(camera.K.fy - 772.0224913834) < 1e-6, `fy: ${camera.K.fy}`);
  assert.ok(Math.abs(camera.K.fx - 772.0224913834) < 1e-6, `fx: ${camera.K.fx}`);
  assert.strictEqual(camera.K.cx, 640);
  assert.strictEqual(camera.K.cy, 360);

  // 검사 2: target이 화면 중앙(cx, cy)으로 투영되는지
  const targetWorld = [0, 5, 0];
  const projection = project(camera, targetWorld);
  const cx = 640; // 카메라 객체가 아니라 리터럴과 비교한다
  const cy = 360;
  const uError = Math.abs(projection.u - cx);
  const vError = Math.abs(projection.v - cy);
  assert.ok(uError < 0.01 && vError < 0.01, `target 투영 오차: u=${uError.toFixed(4)}, v=${vError.toFixed(4)}`);

  // 검사 3: 깊이가 |eye - target| = sqrt(115² + 140²) ≈ 181.17
  const expectedDepth = Math.sqrt(115 * 115 + 140 * 140);
  const depthError = Math.abs(projection.d - expectedDepth);
  assert.ok(depthError < 0.1, `깊이 오차: ${depthError.toFixed(4)}`);

  // 검사 4: 위아래가 뒤집히지 않는지 (target보다 위쪽 y 점이 더 작은 v를 가져야 함)
  const pointAbove = [0, 10, 0]; // target보다 위(y=10 > y=5)
  const projAbove = project(camera, pointAbove);
  assert.ok(projAbove.d > 0, '위쪽 점이 카메라 앞에 있어야 함');
  assert.ok(projAbove.v < projection.v, `위쪽 점이 더 작은 v를 가져야 함: ${projAbove.v} < ${projection.v}`);

  // 검사 5: 좌우가 뒤집히지 않는지 (target의 우측 점이 더 큰 u를 가져야 함)
  const pointRight = [10, 5, 0]; // target의 우측(x=10 > x=0)
  const projRight = project(camera, pointRight);
  assert.ok(projRight.d > 0, '우측 점이 카메라 앞에 있어야 함');
  assert.ok(projRight.u > projection.u, `우측 점이 더 큰 u를 가져야 함: ${projRight.u} > ${projection.u}`);
});

test('renderViews: flat_boxes 시드 1 렌더링 (8장 생성)', async (t) => {
  // fixtures/scenes/flat_boxes 로드
  const flatBoxesModule = await import('../../fixtures/scenes/flat_boxes/index.mjs');

  // 시점 로드
  const viewpointsJson = JSON.parse(
    await readFile(join(here, '../../fixtures/viewpoints/synthetic.json'), 'utf8')
  );
  const viewpoints = viewpointsJson.viewpoints;
  assert.strictEqual(viewpoints.length, 8, '시점이 8개여야 함');

  // 점군 생성 (시드 1)
  const sceneResult = flatBoxesModule.generate({ seed: 1, scene: 'flat_boxes' });
  const cloud = sceneResult.cloud;
  assert.ok(cloud.count > 0, '점군에 점이 있어야 함');

  // 렌더링
  const results = renderViews(cloud, viewpoints, { pointSizeM: 0.05 });
  assert.strictEqual(results.length, 8, '렌더링 결과가 8개여야 함');

  // 각 결과 검사
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const vp = viewpoints[i];

    // 렌더링 결과 유효성 검사
    assert.strictEqual(result.width, vp.width, `이미지 ${i} 너비`);
    assert.strictEqual(result.height, vp.height, `이미지 ${i} 높이`);
    assert.ok(result.color instanceof Uint8Array, `이미지 ${i} color는 Uint8Array`);
    assert.ok(result.depth instanceof Float32Array, `이미지 ${i} depth는 Float32Array`);
    assert.ok(result.index instanceof Int32Array, `이미지 ${i} index는 Int32Array`);

    // 빈 영상이 아닌지 검사 (비어있지 않은 픽셀 수 > 0)
    let nonEmptyCount = 0;
    for (let j = 0; j < result.width * result.height; j++) {
      if (result.index[j] !== -1) {
        nonEmptyCount++;
      }
    }
    assert.ok(nonEmptyCount > 0, `이미지 ${i}(${vp.name})이 비어있지 않아야 함`);
  }
});

test('renderViews: 결정적 렌더링 (같은 입력 재실행 시 바이트 동일)', async (t) => {
  const flatBoxesModule = await import('../../fixtures/scenes/flat_boxes/index.mjs');
  const viewpointsJson = JSON.parse(
    await readFile(join(here, '../../fixtures/viewpoints/synthetic.json'), 'utf8')
  );
  const viewpoints = viewpointsJson.viewpoints;

  // 점군 생성 (시드 1)
  const sceneResult1 = flatBoxesModule.generate({ seed: 1, scene: 'flat_boxes' });
  const cloud1 = sceneResult1.cloud;

  // 첫 번째 렌더링
  const results1 = renderViews(cloud1, viewpoints, { pointSizeM: 0.05 });
  const pngs1 = results1.map((r) => encodePng(r.width, r.height, r.color));
  const hashes1 = pngs1.map(hashPng);

  // 점군 다시 생성 (같은 시드)
  const sceneResult2 = flatBoxesModule.generate({ seed: 1, scene: 'flat_boxes' });
  const cloud2 = sceneResult2.cloud;

  // 두 번째 렌더링
  const results2 = renderViews(cloud2, viewpoints, { pointSizeM: 0.05 });
  const pngs2 = results2.map((r) => encodePng(r.width, r.height, r.color));
  const hashes2 = pngs2.map(hashPng);

  // 모든 PNG 해시 비교
  for (let i = 0; i < 8; i++) {
    assert.strictEqual(
      hashes1[i],
      hashes2[i],
      `이미지 ${i} PNG 해시가 같아야 함: ${hashes1[i]} !== ${hashes2[i]}`
    );
  }
});

test('renderViews: 빈 viewpoints 배열 거부', async (t) => {
  const flatBoxesModule = await import('../../fixtures/scenes/flat_boxes/index.mjs');
  const sceneResult = flatBoxesModule.generate({ seed: 1, scene: 'flat_boxes' });
  const cloud = sceneResult.cloud;

  assert.throws(
    () => renderViews(cloud, [], { pointSizeM: 0.05 }),
    /render_views:/,
    '빈 viewpoints 배열은 거부'
  );
});

test('renderViews: null cloud 거부', async (t) => {
  const viewpointsJson = JSON.parse(
    await readFile(join(here, '../../fixtures/viewpoints/synthetic.json'), 'utf8')
  );
  const viewpoints = viewpointsJson.viewpoints;

  assert.throws(
    () => renderViews(null, viewpoints),
    /render_views:/,
    'null cloud는 거부'
  );
});

test('renderViews: viewpoints 내 null 시점 거부', async (t) => {
  const flatBoxesModule = await import('../../fixtures/scenes/flat_boxes/index.mjs');
  const sceneResult = flatBoxesModule.generate({ seed: 1, scene: 'flat_boxes' });
  const cloud = sceneResult.cloud;

  assert.throws(
    () => renderViews(cloud, [null]),
    /render_views:|extrinsics:/,
    'null 시점은 거부'
  );
});

// F-094 ③: eye.x ≠ 0 시점의 R·t 와 한 점의 u·v 를 손계산 리터럴로 고정한다(부호 반전 변이를 잡는다).
// 시점: eye (3,0,4), target 원점, up +y, 640x360, fov 60°. GL 기저(손계산):
//   z_gl = (eye−target)/5 = (0.6, 0, 0.8), x_gl = up×z_gl = (0.8, 0, −0.6), y_gl = z_gl×x_gl = (0, 1, 0)
//   OpenCV R 의 행 = (x_gl, −y_gl, −z_gl) = (0.8,0,−0.6), (0,−1,0), (−0.6,0,−0.8), t = −R_gl·eye 에 y,z 부호 반전 = (0, 0, 5)
//   fy = 180/tan 30° = 311.7691453624
//   세계점 (1,0,0): X_c = (0.8, 0, 4.4) → u = 320 + 311.7691453624·0.8/4.4 = 376.6852991568, v = 180, d = 4.4
//   세계점 (0,1,0): X_c = (0, −1, 5) → u = 320, v = 180 − 311.7691453624/5 = 117.6461709275 (위쪽 점은 v 가 작다)
test('viewpointToCamera: eye.x ≠ 0 시점의 R·t·K 와 한 점의 u·v 리터럴, 좌우 방향', () => {
  const cam = viewpointToCamera({ eye: [3, 0, 4], target: [0, 0, 0], up: [0, 1, 0], width: 640, height: 360, fov_y_deg: 60 });
  const wantR = [0.8, 0, -0.6, 0, -1, 0, -0.6, 0, -0.8];
  wantR.forEach((x, i) => assert.ok(Math.abs(cam.R[i] - x) < 1e-12, `R[${i}] = ${cam.R[i]} vs ${x}`));
  [0, 0, 5].forEach((x, i) => assert.ok(Math.abs(cam.t[i] - x) < 1e-12, `t[${i}] = ${cam.t[i]} vs ${x}`));
  assert.ok(Math.abs(cam.K.fy - 311.7691453624) < 1e-9);
  assert.strictEqual(cam.K.cx, 320);
  assert.strictEqual(cam.K.cy, 180);
  const right = project(cam, [1, 0, 0]);
  assert.ok(Math.abs(right.u - 376.6852991568) < 1e-8, `u ${right.u}`);
  assert.ok(Math.abs(right.v - 180) < 1e-9, `v ${right.v}`);
  assert.ok(Math.abs(right.d - 4.4) < 1e-12);
  assert.ok(right.u > 320, '카메라 오른쪽(x_gl 방향) 점은 u > cx');
  const left = project(cam, [-1, 0, 0]);
  assert.ok(left.u < 320, '반대쪽 점은 u < cx');
  const up = project(cam, [0, 1, 0]);
  assert.ok(Math.abs(up.u - 320) < 1e-9 && Math.abs(up.v - 117.6461709275) < 1e-8, `up ${up.u},${up.v}`);
});

// F-100 ⑦: target ≠ 원점 시점에서 R·t 와 한 점의 u·v 를 손계산 리터럴로 고정한다(t[0] 부호 반전 변이를 잡는다).
// 시점: eye (2,1,3), target (1,1,1), up +y, 640x360, fov 60°. GL 기저(손계산):
//   z_gl = (eye−target)/|(eye−target)| = (1,0,2)/√5 = (0.4472135955, 0, 0.8944271910)
//   x_gl = up×z_gl 정규화 = (0.8944271910, 0, -0.4472135955)
//   y_gl = z_gl×x_gl = (0, 1, 0)
//   OpenCV R: diag(1,-1,-1)·R_gl 적용
//   t_gl = -R_gl·eye 계산 후 OpenCV t: (t_gl[0], -t_gl[1], -t_gl[2]) = (-0.4472135955, 1, 3.5777087640)
//   내부 행렬 K: fy = 180/tan(30°) ≈ 311.7691453624, cx = 320, cy = 180
//   세계점 (1,2,1): X_c = R·(1,2,1) + t = (0, -1, √5) → u = 320, v ≈ 40.5725995365
test('viewpointToCamera: target ≠ 원점인 시점의 R·t·K 와 한 점의 u·v 리터럴', () => {
  const cam = viewpointToCamera({ eye: [2, 1, 3], target: [1, 1, 1], up: [0, 1, 0], width: 640, height: 360, fov_y_deg: 60 });
  assert.ok(Math.abs(cam.K.fy - 311.7691453624) < 1e-9, `fy: ${cam.K.fy}`);
  assert.strictEqual(cam.K.cx, 320);
  assert.strictEqual(cam.K.cy, 180);
  // t 벡터 손계산 리터럴
  assert.ok(Math.abs(cam.t[0] - (-0.4472135954999579)) < 1e-12, `t[0]: ${cam.t[0]}`);
  assert.ok(Math.abs(cam.t[1] - 1.0) < 1e-12, `t[1]: ${cam.t[1]}`);
  assert.ok(Math.abs(cam.t[2] - 3.5777087639996634) < 1e-12, `t[2]: ${cam.t[2]}`);
  const point = project(cam, [1, 2, 1]);
  // 점 (1,2,1) 투영 결과 손계산 리터럴
  assert.ok(Math.abs(point.u - 320) < 1e-12, `u: ${point.u}`);
  assert.ok(Math.abs(point.v - 40.5725995365330334) < 1e-10, `v: ${point.v}`);
  assert.ok(Math.abs(point.d - 2.2360679774997898) < 1e-12, `d: ${point.d}`);
});

// F-093 ①: fov 와 해상도 검사.
test('viewpointToCamera: fov 거부(0·180·400·음수·문자열·NaN·Infinity·극단 1e-300), 정상 경계 허용', () => {
  const base = { eye: [3, 0, 4], target: [0, 0, 0], up: [0, 1, 0], width: 640, height: 360 };
  for (const bad of [0, 180, 400, -10, '60', NaN, Infinity, null, undefined, 1e-300, 1e-4]) {
    assert.throws(() => viewpointToCamera({ ...base, fov_y_deg: bad }), /^Error: render_views:/, `fov ${String(bad)}`);
  }
  assert.throws(() => viewpointToCamera({ ...base, width: 0, fov_y_deg: 60 }), /^Error: render_views:/);
  assert.throws(() => viewpointToCamera({ ...base, height: 1.5, fov_y_deg: 60 }), /^Error: render_views:/);
  for (const bad of [179.91, 179.99, 179.99999999999997]) {
    assert.throws(() => viewpointToCamera({ ...base, fov_y_deg: bad }), /render_views:.*fov_y_deg/, `fov ${bad} should reject`);
  }
  for (const ok of [0.001, 1, 179.9]) {
    const c = viewpointToCamera({ ...base, fov_y_deg: ok });
    assert.ok(Number.isFinite(c.K.fy) && c.K.fy > 0, `fov ${ok}`);
  }
});

// F-094 ④: 시점별 칠한 픽셀 수 리터럴. 출처: flat_boxes seed 1(점 200000개) 을 fixtures/viewpoints/synthetic.json 8시점으로
// 이 저장소의 renderViews 가 처음 통과한 시점에 한 번 실행해 센 값이다(독립 구현이 없어 회귀 고정용 골든이며,
// 시점 변환·투영·원판 규칙이 바뀌면 이 숫자가 달라진다). 시점 순서: aerial_overview, aerial_oblique_ne, top_down,
// street_level, low_close_box, tower_high, tower_mid, edge_far.
const FILLED_005 = [131848, 126594, 139606, 77917, 74189, 110872, 98886, 99822];
const FILLED_020 = [135766, 164581, 139606, 284826, 280093, 167311, 218371, 267421];

test('renderViews: 시점별 칠한 픽셀 수 리터럴(pointSizeM 0.05 와 0.2)과 opts 반영', async () => {
  const { generate } = await import('../../fixtures/scenes/flat_boxes/index.mjs');
  const viewpoints = JSON.parse(await readFile(join(here, '../../fixtures/viewpoints/synthetic.json'), 'utf8')).viewpoints;
  const cloud = generate({ seed: 1, scene: 'flat_boxes' }).cloud;
  const count = (r) => { let n = 0; for (let j = 0; j < r.index.length; j++) if (r.index[j] !== -1) n++; return n; };
  assert.deepStrictEqual(renderViews(cloud, viewpoints, { pointSizeM: 0.05 }).map(count), FILLED_005);
  assert.deepStrictEqual(renderViews(cloud, viewpoints, { pointSizeM: 0.2 }).map(count), FILLED_020);
  assert.deepStrictEqual(renderViews(cloud, viewpoints).map(count), FILLED_005, '기본 pointSizeM 은 0.05');
});
