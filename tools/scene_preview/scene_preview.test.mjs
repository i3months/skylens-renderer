// 장면 미리보기 도구 테스트 (T05.10)
// 합성 점군으로 테스트 (장면 모듈에 의존 안 함)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPreview, encodePng } from './index.mjs';

/**
 * 합성 점군 생성: 바닥 격자(z=0) + 기둥(위로 올라가는 점들)
 * @returns {{format: 1, count: number, positions: Float32Array, normals: Float32Array, colors: Uint8Array}}
 */
function createSyntheticCloud() {
  const points = [];
  const colors = [];

  // 바닥 격자 (z=0, 여러 (x,y) 위치)
  // 화이트 (200,200,200)
  for (let x = -10; x <= 10; x += 5) {
    for (let y = -10; y <= 10; y += 5) {
      points.push([x, 0, y]); // z=0 (바닥)
      colors.push([200, 200, 200]);
    }
  }

  // 기둥 1: (5, 0~20, 5)에서 빨강 (255,0,0)
  for (let y = 0; y <= 20; y += 2) {
    points.push([5, y, 5]);
    colors.push([255, 0, 0]);
  }

  // 기둥 2: (-5, 0~15, -5)에서 초록 (0,255,0)
  for (let y = 0; y <= 15; y += 2) {
    points.push([-5, y, -5]);
    colors.push([0, 255, 0]);
  }

  // 기둥 3: (0, 0~25, 0)에서 파랑 (0,0,255)
  for (let y = 0; y <= 25; y += 2) {
    points.push([0, y, 0]);
    colors.push([0, 0, 255]);
  }

  const n = points.length;
  const positions = new Float32Array(3 * n);
  const normals = new Float32Array(3 * n);
  const colorBytes = new Uint8Array(3 * n);

  for (let i = 0; i < n; i++) {
    const [x, y, z] = points[i];
    const [r, g, b] = colors[i];

    positions[3 * i] = x;
    positions[3 * i + 1] = y;
    positions[3 * i + 2] = z;

    // 단위 법선 (위쪽)
    normals[3 * i] = 0;
    normals[3 * i + 1] = 1;
    normals[3 * i + 2] = 0;

    colorBytes[3 * i] = r;
    colorBytes[3 * i + 1] = g;
    colorBytes[3 * i + 2] = b;
  }

  return {
    format: 1,
    count: n,
    positions,
    normals,
    colors: colorBytes,
  };
}

test('모든 8개 시점에서 이미지 생성', (t) => {
  const cloud = createSyntheticCloud();

  const viewpoints = [
    { eye: [0, 120, 140], target: [0, 5, 0], name: 'aerial_overview' },
    { eye: [90, 60, -90], target: [0, 8, 0], name: 'aerial_oblique_ne' },
    { eye: [0, 200, 1], target: [0, 0, 0], name: 'top_down' },
    { eye: [0, 1.7, 90], target: [0, 6, 0], name: 'street_level' },
    { eye: [30, 3, 45], target: [20, 8, 20], name: 'low_close_box' },
    { eye: [0, 80, 60], target: [0, 0, -20], name: 'tower_high' },
    { eye: [-60, 30, 70], target: [0, 5, 0], name: 'tower_mid' },
    { eye: [-95, 6, 95], target: [40, 5, -40], name: 'edge_far' },
  ];

  const results = [];

  for (const vp of viewpoints) {
    const viewpoint = {
      ...vp,
      up: [0, 1, 0],
      width: 1280,
      height: 720,
      fov_y_deg: 50,
    };

    const { width, height, rgb } = renderPreview(cloud, viewpoint);

    assert.equal(width, 1280, `${vp.name}: 너비 체크`);
    assert.equal(height, 720, `${vp.name}: 높이 체크`);
    assert.equal(rgb.length, 1280 * 720 * 3, `${vp.name}: RGB 크기 체크`);

    // RGB가 완전히 검정색이 아님을 확인 (점이 렌더링됨)
    let nonZeroCount = 0;
    for (let i = 0; i < rgb.length; i++) {
      if (rgb[i] !== 0) nonZeroCount++;
    }
    assert(nonZeroCount > 0, `${vp.name}: 렌더링된 점이 있어야 함`);

    results.push({ vp: vp.name, rgb });
  }

  assert.equal(results.length, 8, '정확히 8개 시점 처리됨');
});

test('같은 입력 → 같은 바이트', (t) => {
  const cloud = createSyntheticCloud();

  const viewpoint = {
    eye: [0, 120, 140],
    target: [0, 5, 0],
    up: [0, 1, 0],
    width: 1280,
    height: 720,
    fov_y_deg: 50,
  };

  const { rgb: rgb1 } = renderPreview(cloud, viewpoint);
  const { rgb: rgb2 } = renderPreview(cloud, viewpoint);

  assert.deepEqual(rgb1, rgb2, '같은 입력은 같은 RGB 출력');

  const png1 = encodePng(1280, 720, rgb1);
  const png2 = encodePng(1280, 720, rgb2);

  assert.deepEqual(png1, png2, '같은 입력은 같은 PNG 바이트');
});

test('PNG 시그니처 확인', (t) => {
  const cloud = createSyntheticCloud();
  const { width, height, rgb } = renderPreview(cloud, {
    eye: [0, 120, 140],
    target: [0, 5, 0],
    up: [0, 1, 0],
    width: 1280,
    height: 720,
    fov_y_deg: 50,
  });

  const png = encodePng(width, height, rgb);

  // PNG 시그니처: 137 80 78 71 13 10 26 10
  assert.equal(png[0], 137, 'PNG 시그니처[0]');
  assert.equal(png[1], 80, 'PNG 시그니처[1]');
  assert.equal(png[2], 78, 'PNG 시그니처[2]');
  assert.equal(png[3], 71, 'PNG 시그니처[3]');
  assert.equal(png[4], 13, 'PNG 시그니처[4]');
  assert.equal(png[5], 10, 'PNG 시그니처[5]');
  assert.equal(png[6], 26, 'PNG 시그니처[6]');
  assert.equal(png[7], 10, 'PNG 시그니처[7]');

  // IHDR 청크 위치: 8(시그니처) + 4(길이) + 4(타입) = 16
  // IHDR 데이터: 너비(4바이트, big-endian) + 높이(4바이트)
  const widthInFile = (png[16] << 24) | (png[17] << 16) | (png[18] << 8) | png[19];
  const heightInFile = (png[20] << 24) | (png[21] << 16) | (png[22] << 8) | png[23];

  assert.equal(widthInFile, 1280, 'PNG IHDR 너비');
  assert.equal(heightInFile, 720, 'PNG IHDR 높이');
});

test('알려진 점이 예상 픽셀에 찍힘', (t) => {
  // 간단한 점군: 특정 위치의 점들
  // 카메라 at [0, 0, -50], looking at origin [0, 0, 0]
  const positions = new Float32Array([
    0, 0, 0,      // 원점 (화면 중앙)
    10, 0, 0,     // x축 상 점
    0, 10, 0,     // y축 상 점
  ]);

  const normals = new Float32Array(9).fill(0);
  normals[1] = 1;
  normals[4] = 1;
  normals[7] = 1;

  const colors = new Uint8Array([
    255, 0, 0,    // 원점: 빨강
    0, 255, 0,    // x축: 초록
    0, 0, 255,    // y축: 파랑
  ]);

  const cloud = {
    format: 1,
    count: 3,
    positions,
    normals,
    colors,
  };

  // 카메라가 [0, 0, -50]에 있고 원점을 바라봄
  // forward = [0, 0, 0] - [0, 0, -50] = [0, 0, 50] (정규화: [0, 0, 1])
  // 원점은 카메라에서 50 떨어짐 (camz = 50)
  const viewpoint = {
    eye: [0, 0, -50],
    target: [0, 0, 0],
    up: [0, 1, 0],
    width: 1280,
    height: 720,
    fov_y_deg: 50,
  };

  const { width, height, rgb } = renderPreview(cloud, viewpoint);

  // 원점이 화면 중앙 근처에 그려져야 함
  const centerX = Math.round(width / 2);
  const centerY = Math.round(height / 2);

  // 중앙 주변 픽셀들을 확인 (±10 픽셀)
  let foundRed = false;
  for (let y = centerY - 10; y <= centerY + 10; y++) {
    for (let x = centerX - 10; x <= centerX + 10; x++) {
      if (x >= 0 && x < width && y >= 0 && y < height) {
        const idx = (y * width + x) * 3;
        if (rgb[idx] === 255 && rgb[idx + 1] === 0 && rgb[idx + 2] === 0) {
          foundRed = true;
          break;
        }
      }
    }
  }

  assert(foundRed, '원점(빨강)이 화면 중앙 근처에 그려짐 (±10 px)');
});

test('카메라 뒤의 점은 그려지지 않음', (t) => {
  const positions = new Float32Array([
    0, 0, 20,     // 카메라 앞 (d > 0)
    0, 0, -20,    // 카메라 뒤 (d < 0)
    0, 0, 0,      // 카메라 정확히 (d = 0)
  ]);

  const normals = new Float32Array(9).fill(0);
  normals[1] = 1;
  normals[4] = 1;
  normals[7] = 1;

  const colors = new Uint8Array([
    255, 0, 0,    // 빨강 (앞, d=20)
    0, 255, 0,    // 초록 (뒤, d=-20)
    0, 0, 255,    // 파랑 (중앙, d=0)
  ]);

  const cloud = {
    format: 1,
    count: 3,
    positions,
    normals,
    colors,
  };

  // 카메라가 [0, 0, 0]에 있고 [0, 0, 1]을 바라봄 (원점 앞쪽)
  // forward = [0, 0, 1] - [0, 0, 0] = [0, 0, 1]
  // Point [0, 0, 20]: rel=[0,0,20], camz=20 > 0 ✓ 렌더링됨
  // Point [0, 0, -20]: rel=[0,0,-20], camz=-20 < 0 ✗ 안 됨
  // Point [0, 0, 0]: rel=[0,0,0], camz=0 = 0 ✗ 안 됨
  const viewpoint = {
    eye: [0, 0, 0],
    target: [0, 0, 1],
    up: [0, 1, 0],
    width: 1280,
    height: 720,
    fov_y_deg: 50,
  };

  const { rgb } = renderPreview(cloud, viewpoint);

  // 빨강만 있어야 하고, 초록은 없어야 함
  let greenCount = 0;

  for (let i = 0; i < rgb.length; i += 3) {
    const g = rgb[i + 1];
    if (g > 0) {
      greenCount++;
    }
  }

  assert.equal(greenCount, 0, '카메라 뒤의 점(초록)은 그려지지 않음');
});

test('가깝고 먼 점 사이 오클루전', (t) => {
  // 같은 (x, y) 위치에 z가 다른 두 점
  const positions = new Float32Array([
    0, 0, 20,     // 카메라에 가까운 점 (d=20)
    0, 0, 40,     // 카메라에서 먼 점 (d=40)
  ]);

  const normals = new Float32Array(6).fill(0);
  normals[1] = 1;
  normals[4] = 1;

  const colors = new Uint8Array([
    255, 0, 0,    // 빨강 (가까움, d=20)
    0, 255, 0,    // 초록 (멀음, d=40)
  ]);

  const cloud = {
    format: 1,
    count: 2,
    positions,
    normals,
    colors,
  };

  // 카메라가 [0, 0, 0]에 있고 [0, 0, 1]을 바라봄
  const viewpoint = {
    eye: [0, 0, 0],
    target: [0, 0, 1],
    up: [0, 1, 0],
    width: 1280,
    height: 720,
    fov_y_deg: 50,
  };

  const { rgb } = renderPreview(cloud, viewpoint);

  // 화면 중앙 근처에서 빨강만 보여야 함 (초록은 가려짐)
  const centerX = Math.round(1280 / 2);
  const centerY = Math.round(720 / 2);

  let redPixels = 0;
  let greenPixels = 0;

  for (let y = centerY - 10; y <= centerY + 10; y++) {
    for (let x = centerX - 10; x <= centerX + 10; x++) {
      if (x >= 0 && x < 1280 && y >= 0 && y < 720) {
        const idx = (y * 1280 + x) * 3;
        const r = rgb[idx];
        const g = rgb[idx + 1];

        if (r === 255 && g === 0) redPixels++;
        if (g === 255 && r === 0) greenPixels++;
      }
    }
  }

  assert(redPixels > greenPixels, '가까운 점이 먼 점을 가림 (오클루전)');
});

test('다양한 화면 크기 처리', (t) => {
  const cloud = createSyntheticCloud();

  const testSizes = [
    { width: 640, height: 480 },
    { width: 1920, height: 1080 },
    { width: 512, height: 512 },
    { width: 2560, height: 1440 },
  ];

  for (const size of testSizes) {
    const { width, height, rgb } = renderPreview(cloud, {
      eye: [0, 50, 50],
      target: [0, 0, 0],
      up: [0, 1, 0],
      width: size.width,
      height: size.height,
      fov_y_deg: 50,
    });

    assert.equal(width, size.width, `크기 ${size.width}x${size.height}: 너비`);
    assert.equal(height, size.height, `크기 ${size.width}x${size.height}: 높이`);
    assert.equal(rgb.length, size.width * size.height * 3, `크기 ${size.width}x${size.height}: RGB 크기`);
  }
});
