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

  // 검사 1: fy = 360/tan(25°) = 771.97…
  const expectedFy = 360 / Math.tan((50 * Math.PI) / 360);
  assert.ok(Math.abs(camera.K.fy - expectedFy) < 0.01, `fy 오차: ${Math.abs(camera.K.fy - expectedFy)}`);

  // 검사 2: target이 화면 중앙(cx, cy)으로 투영되는지
  const targetWorld = [0, 5, 0];
  const projection = project(camera, targetWorld);
  const cx = camera.K.cx;
  const cy = camera.K.cy;
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
