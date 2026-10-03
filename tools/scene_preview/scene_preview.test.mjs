// 장면 미리보기 도구 테스트 (T05.10)
// 합성 점군으로 테스트 (장면 모듈에 의존 안 함)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderPreview, encodePng } from './index.mjs';
import { parseSeedArg } from './cli.mjs';
import { point27ToGauss56 } from '../../contracts/scenes/index.mjs';
import { cameraExtrinsics, intrinsics, worldToCamera, projectCamera } from '../../bench/baseline/ref_images/index.mjs';

const SYNTHETIC_VIEWPOINTS = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../fixtures/viewpoints/synthetic.json', import.meta.url)), 'utf-8'),
).viewpoints;

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

  const viewpoints = SYNTHETIC_VIEWPOINTS;

  const results = [];

  for (const vp of viewpoints) {
    const { width, height, rgb } = renderPreview(cloud, vp);

    assert.equal(width, 1280, `${vp.name}: 너비 체크`);
    assert.equal(height, 720, `${vp.name}: 높이 체크`);
    assert.equal(rgb.length, 1280 * 720 * 3, `${vp.name}: RGB 크기 체크`);

    // RGB가 완전히 검정색이 아님을 확인 (점이 렌더링됨)
    let nonZeroCount = 0;
    for (let i = 0; i < rgb.length; i++) {
      if (rgb[i] !== 0) nonZeroCount++;
    }
    assert(nonZeroCount > 0, `${vp.name}: 렌더링된 점이 있어야 함`);

    results.push({ vp: vp.name, key: Buffer.from(rgb.buffer, rgb.byteOffset, rgb.length).toString('base64') });
  }

  // 시점마다 다른 그림이어야 한다(시점을 무시하고 같은 그림을 내면 fail)
  assert.equal(new Set(results.map((r) => r.key)).size, 8, '8개 시점의 RGB 가 서로 모두 다름');
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

  // 청크를 처음부터 끝까지 읽어 순서·CRC·IHDR 나머지 바이트·IDAT 내용을 검사한다(F-085 ⑤).
  const chunks = readChunks(png);
  assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND'], '청크 순서');
  for (const c of chunks) assert.equal(c.crc, c.crcExpect, `${c.type} CRC`);
  const ihdr = chunks[0].data;
  assert.equal(ihdr.length, 13, 'IHDR 길이 13');
  assert.equal(ihdr[8], 8, 'IHDR 비트 깊이 8');
  assert.equal(ihdr[9], 2, 'IHDR 색 타입 2(RGB)');
  assert.equal(ihdr[10], 0, 'IHDR 압축 0');
  assert.equal(ihdr[11], 0, 'IHDR 필터 0');
  assert.equal(ihdr[12], 0, 'IHDR 인터레이스 0');
  assert.equal(chunks[2].data.length, 0, 'IEND 비어 있음');
  const raw = inflateSync(chunks[1].data);
  const stride = 1 + width * 3;
  assert.equal(raw.length, height * stride, 'IDAT 풀린 길이 = height·(1+3·width)');
  let nonZero = 0;
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * stride], 0, `스캔라인 ${y} 필터 바이트 0`);
    const line = raw.subarray(y * stride + 1, (y + 1) * stride);
    const src = rgb.subarray(y * width * 3, (y + 1) * width * 3);
    assert.ok(Buffer.compare(Buffer.from(line), Buffer.from(src)) === 0, `스캔라인 ${y} rgb 일치`);
    for (const b of src) if (b) nonZero++;
  }
  assert.ok(nonZero > 0, '비교한 rgb 에 0 이 아닌 바이트가 있어야 의미 있음');
});

/** 시험 안에서 따로 짠 CRC-32(ISO-HDLC, 다항식 0xEDB88320) — 대상 모듈의 표를 쓰지 않는다. */
function crc32(bytes) {
  let c = ~0 >>> 0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (~c) >>> 0;
}

/** PNG 바이트를 청크 목록으로 읽는다. */
function readChunks(png) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out = [];
  let o = 8;
  while (o < png.length) {
    const len = view.getUint32(o, false);
    const type = String.fromCharCode(png[o + 4], png[o + 5], png[o + 6], png[o + 7]);
    const data = png.subarray(o + 8, o + 8 + len);
    const crc = view.getUint32(o + 8 + len, false);
    out.push({ type, data, crc, crcExpect: crc32(png.subarray(o + 4, o + 8 + len)) });
    o += 12 + len;
  }
  assert.equal(o, png.length, '청크가 파일 끝에서 정확히 끝남');
  return out;
}

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

test('축 밖 점이 해석 픽셀 위치에 찍힘(±1 px)', () => {
  // eye (0,0,-50) → target 원점, 점 (0,5,0): d=50, f=(720/2)/tan(25°), v=360−f·5/50, u=640
  const cloud = {
    format: 1, count: 1,
    positions: new Float32Array([0, 5, 0]),
    normals: new Float32Array([0, 0, -1]),
    colors: Uint8Array.of(255, 0, 0),
  };
  const vp = { eye: [0, 0, -50], target: [0, 0, 0], up: [0, 1, 0], width: 1280, height: 720, fov_y_deg: 50 };
  const { width, height, rgb } = renderPreview(cloud, vp);
  const hits = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 3;
    if (rgb[i] === 255 && rgb[i + 1] === 0 && rgb[i + 2] === 0) hits.push([x, y]);
  }
  assert.equal(hits.length, 1);
  const f = 360 / Math.tan((25 * Math.PI) / 180);
  const vExpect = 360 - (f * 5) / 50;
  assert.ok(Math.abs(hits[0][1] - vExpect) <= 1, `v ${hits[0][1]} vs ${vExpect}`);
  assert.ok(Math.abs(hits[0][0] - 640) <= 1, `u ${hits[0][0]}`);
});

// ---------------------------------------------------------------------------
// F-082: 좌우 방향(GL 오른손 규약)과 floor 픽셀 매핑.
// 정답은 시험 안의 독립 look-at 식으로 만든다: forward = normalize(target − eye),
// right = normalize(forward × up), upN = right × forward, d = (p−eye)·forward,
// u = W/2 + f·((p−eye)·right)/d, v = H/2 − f·((p−eye)·upN)/d, f = (H/2)/tan(fov/2).

const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vnorm = (a) => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };

function analyticUV(p, { eye, target, up, width, height, fov_y_deg }) {
  const fwd = vnorm(vsub(target, eye));
  const right = vnorm(vcross(fwd, up));
  const upN = vcross(right, fwd);
  const r = vsub(p, eye);
  const d = vdot(r, fwd);
  const f = height / 2 / Math.tan((fov_y_deg * Math.PI) / 360);
  return { u: width / 2 + (f * vdot(r, right)) / d, v: height / 2 - (f * vdot(r, upN)) / d, d };
}

/** 점 하나(빨강)를 그려 찍힌 픽셀 목록을 돌려준다. */
function renderOne(p, vp) {
  const cloud = { format: 1, count: 1, positions: Float32Array.from(p), normals: Float32Array.of(0, 1, 0), colors: Uint8Array.of(255, 0, 0) };
  const { width, height, rgb } = renderPreview(cloud, vp);
  const hits = [];
  for (let i = 0; i < width * height; i++) if (rgb[3 * i] === 255) hits.push([i % width, Math.floor(i / width)]);
  return hits;
}

test('F-082: 남쪽에서 북쪽을 볼 때 동쪽 점은 화면 오른쪽(u > 중앙)', () => {
  // eye (0,0,10)(남쪽, z=−북), target 원점, 64×48. 동쪽 (3,0,0) 은 오른쪽.
  const vp = { eye: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], width: 64, height: 48, fov_y_deg: 50 };
  const hits = renderOne([3, 0, 0], vp);
  assert.equal(hits.length, 1);
  const [px, py] = hits[0];
  // 해석값: f = 24/tan25° = 51.468…, u = 32 + f·3/10 = 47.44, v = 24
  const f = 24 / Math.tan((25 * Math.PI) / 180);
  const uExpect = 32 + (f * 3) / 10;
  assert.ok(px > 32, `동쪽 점 u ${px} 는 중앙 32 보다 오른쪽이어야 함`);
  assert.ok(Math.abs(px - uExpect) <= 1, `u ${px} vs 해석값 ${uExpect}`);
  assert.equal(px, Math.floor(uExpect));
  assert.equal(py, 24);
  // 서쪽 점은 왼쪽
  const west = renderOne([-3, 0, 0], vp);
  assert.equal(west.length, 1);
  assert.ok(Math.abs(west[0][0] - (32 - (f * 3) / 10)) <= 1, `서쪽 u ${west[0][0]}`);
  assert.ok(west[0][0] < 32);
});

test('F-082: top_down 시점에서 동쪽 (30,0,0) → u 755.8±1', () => {
  const vp = SYNTHETIC_VIEWPOINTS.find((v) => v.name === 'top_down');
  assert.ok(vp, 'synthetic.json 에 top_down');
  const hits = renderOne([30, 0, 0], vp);
  assert.equal(hits.length, 1);
  assert.ok(Math.abs(hits[0][0] - 755.8) <= 1, `u ${hits[0][0]} vs 755.8`);
  const a = analyticUV([30, 0, 0], vp);
  assert.ok(Math.abs(a.u - 755.8) < 0.05, `시험 해석식 자체 점검 u ${a.u}`);
  assert.equal(hits[0][0], Math.floor(a.u));
  assert.equal(hits[0][1], Math.floor(a.v));
});

test('F-082: x≠0 축 밖 점의 u·v (북쪽에서 남쪽을 보면 동쪽이 왼쪽)', () => {
  // eye (0,0,−50) 은 북쪽, 원점(남쪽)을 본다. 오른쪽 = forward × up = (0,0,1)×(0,1,0) = (−1,0,0) → 동쪽은 왼쪽.
  const vp = { eye: [0, 0, -50], target: [0, 0, 0], up: [0, 1, 0], width: 1280, height: 720, fov_y_deg: 50 };
  const f = 360 / Math.tan((25 * Math.PI) / 180);
  const hits = renderOne([10, 5, 0], vp);
  assert.equal(hits.length, 1);
  const uExpect = 640 - (f * 10) / 50; // 474.9
  const vExpect = 360 - (f * 5) / 50; // 282.8
  assert.ok(Math.abs(hits[0][0] - uExpect) <= 1, `u ${hits[0][0]} vs ${uExpect}`);
  assert.ok(Math.abs(hits[0][1] - vExpect) <= 1, `v ${hits[0][1]} vs ${vExpect}`);
  assert.ok(hits[0][0] < 640);
  // 비스듬한 시점·일반 위치 점들도 독립 해석식과 floor 픽셀이 같아야 함
  const oblique = { eye: [37, 22, -18], target: [-4, 3, 9], up: [0, 1, 0], width: 320, height: 240, fov_y_deg: 60 };
  for (const p of [[-10, 0, 12], [5, 8, 3], [-20, 2, 30], [0, 15, -2]]) {
    const a = analyticUV(p, oblique);
    assert.ok(a.d > 0 && a.u >= 0 && a.u < 320 && a.v >= 0 && a.v < 240, `시험 점 ${p} 가 화면 안`);
    const h = renderOne(p, oblique);
    assert.equal(h.length, 1, `점 ${p}`);
    assert.deepEqual(h[0], [Math.floor(a.u), Math.floor(a.v)], `점 ${p}: 해석 u ${a.u} v ${a.v}`);
  }
});

test('F-082: 픽셀 매핑은 floor([i,i+1) 구간), 반올림 아님', () => {
  const vp = { eye: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], width: 64, height: 48, fov_y_deg: 50 };
  const f = 24 / Math.tan((25 * Math.PI) / 180);
  // u = 40.75, v = 24 − 5.75 = 18.25 이 되도록 고른 점(d=10): floor → (40,18), round 이면 (41,18)
  const p = [(10 * 8.75) / f, (10 * 5.75) / f, 0];
  // u = 32 − 8.75 = 23.75 이 되도록 고른 점: floor → 23, round 이면 24
  const q = [(-10 * 8.25) / f, (-10 * 6.6) / f, 0]; // u 23.75, v 30.6
  assert.deepEqual(renderOne(p, vp), [[40, 18]]);
  assert.deepEqual(renderOne(q, vp), [[23, 30]]);
});

test('F-082: 8시점에서 미리보기 픽셀 = ref_images projectCamera 의 floor 픽셀(1 px 이내)', () => {
  assert.equal(SYNTHETIC_VIEWPOINTS.length, 8);
  // 장면 범위(x,z∈[−100,100], y 0~40) 안 격자점. 색에 번호를 넣어 픽셀에서 점을 되찾는다.
  const pts = [];
  for (let x = -100; x <= 100; x += 10) for (let z = -100; z <= 100; z += 10) for (const y of [0, 7, 23]) pts.push([x + 0.37, y, z - 0.61]);
  const n = pts.length;
  const cloud = { format: 1, count: n, positions: new Float32Array(3 * n), normals: new Float32Array(3 * n), colors: new Uint8Array(3 * n) };
  for (let i = 0; i < n; i++) {
    cloud.positions.set(pts[i], 3 * i);
    cloud.normals[3 * i + 1] = 1;
    const id = i + 1;
    cloud.colors.set([id >> 16 & 255, id >> 8 & 255, id & 255], 3 * i);
  }
  for (const vp of SYNTHETIC_VIEWPOINTS) {
    const { R, t } = cameraExtrinsics(vp);
    const K = intrinsics(vp);
    const { width, height, rgb } = renderPreview(cloud, vp);
    const found = new Map();
    for (let i = 0; i < width * height; i++) {
      const id = (rgb[3 * i] << 16) | (rgb[3 * i + 1] << 8) | rgb[3 * i + 2];
      if (id) found.set(id - 1, [i % width, Math.floor(i / width)]);
    }
    // 참조 투영으로 화면 안에 들고 다른 점과 같은 픽셀을 나누지 않는 점만 대조(z-버퍼 경합 제외)
    const refPix = new Map();
    const owners = new Map();
    for (let i = 0; i < n; i++) {
      const pr = projectCamera(K, worldToCamera(R, t, Array.from(cloud.positions.subarray(3 * i, 3 * i + 3))));
      if (!pr) continue;
      const px = Math.floor(pr.u);
      const py = Math.floor(pr.v);
      if (px < 0 || px >= width || py < 0 || py >= height) continue;
      refPix.set(i, [px, py, pr.u, pr.v]);
      const key = py * width + px;
      owners.set(key, (owners.get(key) ?? 0) + 1);
    }
    let checked = 0;
    for (const [i, [px, py, u, v]] of refPix) {
      if (owners.get(py * width + px) !== 1) continue;
      const got = found.get(i);
      assert.ok(got, `${vp.name}: 점 ${i} (참조 u ${u.toFixed(2)} v ${v.toFixed(2)}) 이 그려지지 않음`);
      assert.ok(Math.abs(got[0] - px) <= 1 && Math.abs(got[1] - py) <= 1, `${vp.name}: 점 ${i} 미리보기 ${got} vs 참조 ${[px, py]}`);
      checked++;
    }
    // 화면 안에 아무 점도 들지 않는 시점이면 대조가 공허하므로 하한을 둔다
    assert.ok(checked >= 50, `${vp.name}: 대조한 점 ${checked} ≥ 50`);
    // 화면 밖 점(참조 기준)은 미리보기에도 없어야 한다
    for (const i of found.keys()) assert.ok(refPix.has(i), `${vp.name}: 점 ${i} 는 참조상 화면 밖인데 그려짐`);
  }
});

// ---------------------------------------------------------------------------
// F-086 ⑤: 미리보기 입력 검증 — 모두 'scene_preview:' 로 시작하는 Error.

const okVp = { eye: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], width: 64, height: 48, fov_y_deg: 50 };
const okCloud = () => ({ format: 1, count: 1, positions: Float32Array.of(0, 0, 0), normals: Float32Array.of(0, 1, 0), colors: Uint8Array.of(9, 9, 9) });
const SP_ERR = { name: 'Error', message: /^scene_preview: / };

test('F-086 ⑤: 잘못된 시점은 scene_preview: 오류', () => {
  const bad = {
    'fov 0': { fov_y_deg: 0 },
    'fov NaN': { fov_y_deg: NaN },
    'fov 음수': { fov_y_deg: -30 },
    'fov 180': { fov_y_deg: 180 },
    'fov 문자열': { fov_y_deg: '50' },
    'eye==target': { eye: [1, 2, 3], target: [1, 2, 3] },
    '시선∥up': { eye: [0, 10, 0], target: [0, 0, 0] },
    '시선∥−up': { eye: [0, -10, 0], target: [0, 0, 0] },
    'up 영벡터': { up: [0, 0, 0] },
    'up NaN': { up: [0, NaN, 0] },
    'eye 길이 2': { eye: [0, 10] },
    'target Infinity': { target: [0, Infinity, 0] },
    'width 0': { width: 0 },
    'width NaN': { width: NaN },
    'width 비정수': { width: 64.5 },
    'width 음수': { width: -64 },
    'height 0': { height: 0 },
    'height NaN': { height: NaN },
    'height 비정수': { height: 47.2 },
  };
  for (const [name, patch] of Object.entries(bad)) {
    assert.throws(() => renderPreview(okCloud(), { ...okVp, ...patch }), SP_ERR, name);
  }
  assert.throws(() => renderPreview(okCloud(), null), SP_ERR, '시점 null');
});

test('F-086 ⑤: 잘못된 점군(56 B·colors 없음·count 이상)은 scene_preview: 오류, count 0·1 은 통과', () => {
  const c27 = okCloud();
  assert.throws(() => renderPreview(point27ToGauss56(c27), okVp), SP_ERR, '56 B(format 2) 입력');
  assert.throws(() => renderPreview({ ...c27, colors: undefined }, okVp), SP_ERR, 'colors 없음');
  assert.throws(() => renderPreview({ ...c27, count: NaN }, okVp), SP_ERR, 'count NaN');
  assert.throws(() => renderPreview({ ...c27, count: -1 }, okVp), SP_ERR, 'count 음수');
  assert.throws(() => renderPreview({ ...c27, count: 0.5 }, okVp), SP_ERR, 'count 비정수');
  assert.throws(() => renderPreview({ ...c27, count: 2 }, okVp), SP_ERR, 'count 가 배열 길이보다 큼');
  assert.throws(() => renderPreview(null, okVp), SP_ERR, '점군 null');
  const empty = renderPreview({ format: 1, count: 0, positions: new Float32Array(0), normals: new Float32Array(0), colors: new Uint8Array(0) }, okVp);
  assert.equal(empty.rgb.length, 64 * 48 * 3);
  assert.ok(empty.rgb.every((b) => b === 0), 'count 0 → 빈(검정) 이미지');
  const one = renderPreview(c27, okVp);
  assert.deepEqual(Array.from(one.rgb.subarray((24 * 64 + 32) * 3, (24 * 64 + 32) * 3 + 3)), [9, 9, 9], 'count 1 → 원점이 (32,24)');
});

// ---------------------------------------------------------------------------
// F-088 ⑯: encodePng 입력 검증, ⑮: CLI 시드 엄격 파싱.

test('F-088 ⑯: encodePng 는 폭 0·rgb 길이 불일치·2^32 폭을 거부', () => {
  assert.throws(() => encodePng(0, 4, new Uint8Array(0)), SP_ERR, '폭 0');
  assert.throws(() => encodePng(4, 0, new Uint8Array(0)), SP_ERR, '높이 0');
  assert.throws(() => encodePng(4, 4, new Uint8Array(4 * 4 * 3 - 1)), SP_ERR, 'rgb 길이 부족');
  assert.throws(() => encodePng(4, 4, new Uint8Array(4 * 4 * 3 + 3)), SP_ERR, 'rgb 길이 초과');
  assert.throws(() => encodePng(2 ** 32, 1, new Uint8Array(3)), SP_ERR, '폭 2^32');
  assert.throws(() => encodePng(2 ** 31, 1, new Uint8Array(3)), SP_ERR, '폭 2^31 (PNG 상한 2^31−1 초과)');
  assert.throws(() => encodePng(4.5, 4, new Uint8Array(54)), SP_ERR, '폭 비정수');
  assert.throws(() => encodePng(NaN, 4, new Uint8Array(0)), SP_ERR, '폭 NaN');
  assert.throws(() => encodePng(2, 2, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), SP_ERR, 'rgb 가 Uint8Array 아님');
  const png = encodePng(1, 1, Uint8Array.of(1, 2, 3));
  const chunks = readChunks(png);
  assert.deepEqual(Array.from(inflateSync(chunks[1].data)), [0, 1, 2, 3], '1×1 은 정상');
});

test('F-088 ⑮: CLI 시드는 10진 정수만(12abc·1e3 등 거부)', () => {
  for (const s of ['12abc', '1e3', '-1', '+5', '1.5', '5.0', '', ' 1', '1 ', '0x10', '4294967296', '99999999999', 'NaN']) {
    assert.throws(() => parseSeedArg(s), SP_ERR, JSON.stringify(s));
  }
  assert.equal(parseSeedArg('0'), 0);
  assert.equal(parseSeedArg('7'), 7);
  assert.equal(parseSeedArg('007'), 7);
  assert.equal(parseSeedArg('4294967295'), 4294967295);
  // 실제 CLI 도 같은 입력에서 0 아닌 종료 코드와 scene_preview: 오류
  const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
  for (const s of ['12abc', '1e3']) {
    const r = spawnSync(process.execPath, [cli, 'flat_boxes', s, '/nonexistent-scene-preview-out'], { encoding: 'utf-8' });
    assert.notEqual(r.status, 0, `cli ${s} 종료 코드`);
    assert.match(r.stderr, /^scene_preview: /, `cli ${s} stderr`);
  }
});

// ---------------------------------------------------------------------------
// F-090 ⑤·F-091: 상한·경계·동률 시험.

test('F-091 ①: 같은 깊이면 먼저 온 점이 이긴다', () => {
  const cloud = {
    format: 1,
    count: 2,
    positions: Float32Array.of(0, 0, 0, 0, 0, 0),
    normals: Float32Array.of(0, 1, 0, 0, 1, 0),
    colors: Uint8Array.of(11, 22, 33, 44, 55, 66),
  };
  const { rgb } = renderPreview(cloud, okVp);
  const o = (24 * 64 + 32) * 3;
  assert.deepEqual(Array.from(rgb.subarray(o, o + 3)), [11, 22, 33]);
});

test('F-090 ⑤: 픽셀 수 상한(1.6e7) 초과는 할당 전에 거부', () => {
  assert.throws(() => renderPreview(okCloud(), { ...okVp, width: 4001, height: 4000 }), { name: 'Error', message: /^scene_preview: .*너무 큼/ });
  assert.throws(() => renderPreview(okCloud(), { ...okVp, width: 20000, height: 20000 }), { name: 'Error', message: /^scene_preview: .*너무 큼/ });
  // 바이트 수 기준(×3 ≤ 2^31)으로는 통과했을 크기도 거부해야 한다
  assert.throws(() => renderPreview(okCloud(), { ...okVp, width: 20000, height: 1000 }), { name: 'Error', message: /^scene_preview: .*너무 큼/ });
  const ok = renderPreview({ format: 1, count: 0, positions: new Float32Array(0), normals: new Float32Array(0), colors: new Uint8Array(0) }, { ...okVp, width: 4000, height: 4000 });
  assert.equal(ok.rgb.length, 4000 * 4000 * 3, '경계값(정확히 1.6e7)은 통과');
});

test('F-091 ②: colors 길이 부족·positions 길이 부족·거의 평행한 up 거부', () => {
  const c = okCloud();
  assert.throws(() => renderPreview({ ...c, count: 2, positions: new Float32Array(6), colors: Uint8Array.of(1, 2, 3, 4, 5) }, okVp), { name: 'Error', message: /^scene_preview: .*colors/ }, 'colors 길이 < 3·count');
  assert.throws(() => renderPreview({ ...c, colors: [9, 9, 9] }, okVp), { name: 'Error', message: /^scene_preview: .*colors/ }, 'colors 가 Uint8Array 아님');
  assert.throws(() => renderPreview({ ...c, count: 2, positions: Float32Array.of(0, 0, 0), colors: new Uint8Array(6) }, okVp), { name: 'Error', message: /^scene_preview: .*positions/ }, 'positions 길이 < 3·count');
  // 시선과 up 사이 각의 사인이 문턱(1e-6) 바로 아래면 거부, 바로 위면 통과
  const base = { ...okVp, eye: [0, 0, 0], target: [0, 1, 0], up: [0, 1, 0] };
  assert.throws(() => renderPreview(c, { ...base, up: [0.5e-6, 1, 0] }), { name: 'Error', message: /^scene_preview: .*평행/ }, 'sin 5e-7');
  assert.doesNotThrow(() => renderPreview(c, { ...base, up: [2e-6, 1, 0] }), 'sin 2e-6');
});

test('F-091 ②: encodePng 스캔라인 버퍼 상한 초과는 rgb 길이 검사 전에 거부', () => {
  // 폭 715827883·높이 3 → 스캔라인 3·(1+3·715827883) > 2^31−1. 폭·높이 개별 상한은 통과한다.
  assert.throws(() => encodePng(715827883, 3, new Uint8Array(3)), { name: 'Error', message: /^scene_preview: .*너무 큼/ });
  assert.throws(() => encodePng(3, 715827883, new Uint8Array(3)), { name: 'Error', message: /^scene_preview: .*너무 큼/ });
});

test('F-091 ⑤: CLI 는 Object.prototype 이름(__proto__·toString)을 장면으로 받지 않는다', () => {
  const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
  for (const name of ['__proto__', 'toString', 'constructor', 'hasOwnProperty']) {
    const r = spawnSync(process.execPath, [cli, name, '1', '/nonexistent-scene-preview-out'], { encoding: 'utf-8' });
    assert.notEqual(r.status, 0, `${name} 종료 코드`);
    assert.match(r.stderr, /알 수 없는 장면/, `${name} stderr`);
  }
});
