// T15.3 rasterizeTextured 시험. 이중선형 정답은 손 계산 값과, 구현과 코드를 공유하지 않는 시험 내부 식으로 따로 구한다.
// uv 규약(계약 buildings.mjs): (0,0) = 영상 왼쪽 위(북서), v = 0 이 북쪽, 영상 행 0 = 북 → row = v·H − 0.5, col = u·W − 0.5.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyResult } from '../../../contracts/raster/index.mjs';
import { BUILDINGS_DEFAULTS } from '../../../contracts/controlview/buildings.mjs';
import { rasterizeTextured } from './raster_tex.mjs';

// 위에서 아래를 보는 160×90 카메라(중심 (0,0,100)): d = 100 − z, u = 100·x/d + 80, v = −100·y/d + 45.
const topCam = () => ({ width: 160, height: 90, K: { fx: 100, fy: 100, cx: 80, cy: 45 }, R: [1, 0, 0, 0, -1, 0, 0, 0, -1], t: [0, 0, 100] });

function lookCam(C, target, width = 160, height = 90, f = 100) {
  const n = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const fw = n([target[0] - C[0], target[1] - C[1], target[2] - C[2]]);
  const right = n(cross(fw, [0, 0, 1]));
  const down = cross(fw, right);
  const R = [...right, ...down, ...fw];
  const t = [0, 1, 2].map((r) => -(R[3 * r] * C[0] + R[3 * r + 1] * C[1] + R[3 * r + 2] * C[2]));
  return { width, height, K: { fx: f, fy: f, cx: width / 2, cy: height / 2 }, R, t };
}

// 영상 범위 [X0,X1]×[Y0,Y1] 를 덮는 지붕(u = 동쪽 상대 위치, v = 0 이 북쪽).
function texRoof(X0, X1, Y0, Y1, z, wall = [0, 0, 0, 0]) {
  const verts = [[X0, Y0, z], [X1, Y0, z], [X1, Y1, z], [X0, Y1, z]];
  return {
    ids: [1],
    mesh: { positions: new Float32Array(verts.flat()), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) },
    edgeLines: new Float32Array(0),
    uv: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]), // 남서·남동·북동·북서 (v = 0 이 북)
    wallMask: new Uint8Array(wall),
    points: new Float32Array(0),
  };
}

// 2×2 영상: 행 0 = 북(북서, 북동), 행 1 = 남(남서, 남동).
const NW = [200, 0, 0]; const NE = [0, 100, 0]; const SW = [0, 0, 40]; const SE = [20, 20, 20];
const img2 = () => ({ width: 2, height: 2, rgb: new Uint8Array([...NW, ...NE, ...SW, ...SE]) });
const px = (out, i, j) => [...out.color.subarray(3 * (j * out.width + i), 3 * (j * out.width + i) + 3)];

// 시험용 독립 이중선형(가장자리 클램프, 반올림).
function refSample(image, u, v) {
  const col = u * image.width - 0.5; const row = v * image.height - 0.5;
  const cl = (k, n) => Math.min(n - 1, Math.max(0, k));
  const c0 = Math.floor(col); const r0 = Math.floor(row); const ax = col - c0; const ay = row - r0;
  const at = (r, c, k) => image.rgb[3 * (cl(r, image.height) * image.width + cl(c, image.width)) + k];
  return [0, 1, 2].map((k) => Math.round(
    (1 - ax) * (1 - ay) * at(r0, c0, k) + ax * (1 - ay) * at(r0, c0 + 1, k) + (1 - ax) * ay * at(r0 + 1, c0, k) + ax * ay * at(r0 + 1, c0 + 1, k),
  ));
}

// 지붕(z=20 → d=80, u = 1.25x + 80, v = −1.25y + 45) 중심 (0.4, −0.4) 이 화소 (80,45) 중심에 오고,
// 경계 u ∈ (60.3, 100.7), v ∈ (30.4, 60.6) 가 화소 중심에서 먼 범위 → 41 × 31 화소.
const X0 = 0.4 - 16.16; const X1 = 0.4 + 16.16; const Y0 = -0.4 - 12.08; const Y1 = -0.4 + 12.08;

test('2×2 영상 지붕: 손 계산 이중선형 값과 일치(v = 0 이 북)', () => {
  const out = emptyResult(160, 90);
  rasterizeTextured(topCam(), [texRoof(X0, X1, Y0, Y1, 20)], img2(), out);
  // 중심 화소 (80,45): u = v = 0.5 → col = row = 0.5 → 네 색 평균 = (220,120,60)/4.
  assert.deepEqual(px(out, 80, 45), [55, 30, 15]);
  // 북서 모서리 근처 (61,31): 세계 (−14.8, 10.8) → u ≈ 0.030, v ≈ 0.964 → col, row < 0 → 북서 색 그대로.
  assert.deepEqual(px(out, 61, 31), NW);
  // 남동 모서리 근처 (99,59): 세계 (15.6, −11.6) → u ≈ 0.970, v ≈ 0.036 → 남동 색.
  assert.deepEqual(px(out, 99, 59), SE);
  // 북동 (99,31) / 남서 (61,59).
  assert.deepEqual(px(out, 99, 31), NE);
  assert.deepEqual(px(out, 61, 59), SW);
  // (70,40): 세계 (−7.6, 3.6) → u = 8.16/32.32, v = 16.08/24.16 → col ≈ 0.00495, row ≈ 0.16887.
  //   R = 200·(1−0.00495)(1−0.16887) + 20·0.00495·0.16887 ≈ 165.4 → 165, G ≈ 0.43 → 0, B = 40·0.99505·0.16887 + 0.0167 ≈ 6.74 → 7.
  assert.deepEqual(px(out, 70, 40), [165, 0, 7]);
  // 덮인 화소 전부를 독립 식과 비교(위에서 보면 uv 는 화면에서 아핀).
  let n = 0;
  for (let j = 0; j < 90; j += 1) {
    for (let i = 0; i < 160; i += 1) {
      const p = j * 160 + i;
      const x = (i + 0.5 - 80) / 1.25; const y = -(j + 0.5 - 45) / 1.25;
      const inside = x > X0 && x < X1 && y > Y0 && y < Y1;
      assert.equal(out.index[p] !== -1, inside, `화소 (${i},${j})`);
      if (!inside) continue;
      n += 1;
      assert.ok(Math.abs(out.depth[p] - 80) <= 1e-4);
      assert.deepEqual(px(out, i, j), refSample(img2(), (x - X0) / (X1 - X0), 1 - (y - Y0) / (Y1 - Y0)), `화소 (${i},${j})`);
    }
  }
  assert.equal(n, 41 * 31);
});

test('비스듬한 카메라: uv 는 원근 보정(1/z 보간 후 나눔)으로 광선 교점 uv 와 일치(±1)', () => {
  // 1×64 세로 기울기 영상: 행 r(0 = 북) 값 = 4r. 남북 방향 원근 보정이 틀리면 크게 어긋난다.
  const H = 64;
  const rgb = new Uint8Array(3 * H);
  for (let r = 0; r < H; r += 1) rgb.set([4 * r, 4 * r, 4 * r], 3 * r);
  const image = { width: 1, height: H, rgb };
  const cam = lookCam([0, -60, 40], [0, 20, 0]);
  const A0 = -30; const A1 = 30; const B0 = -20; const B1 = 60;
  const out = emptyResult(160, 90);
  rasterizeTextured(cam, [texRoof(A0, A1, B0, B1, 0)], image, out);
  const { fx, fy, cx, cy } = cam.K; const R = cam.R; const t = cam.t;
  const C = [0, 1, 2].map((k) => -(R[k] * t[0] + R[3 + k] * t[1] + R[6 + k] * t[2]));
  let n = 0; let worst = 0;
  for (let j = 0; j < 90; j += 1) {
    for (let i = 0; i < 160; i += 1) {
      const p = j * 160 + i;
      if (out.index[p] === -1) continue;
      const dc = [(i + 0.5 - cx) / fx, (j + 0.5 - cy) / fy, 1];
      const dw = [0, 1, 2].map((k) => R[k] * dc[0] + R[3 + k] * dc[1] + R[6 + k] * dc[2]);
      const s = -C[2] / dw[2];
      const y = C[1] + s * dw[1];
      const ref = refSample(image, 0.5, 1 - (y - B0) / (B1 - B0));
      worst = Math.max(worst, Math.abs(out.color[3 * p] - ref[0]));
      n += 1;
    }
  }
  assert.ok(n > 3000);
  assert.ok(worst <= 1, `최대 차 ${worst}`);
});

test('요(yaw) 회전 카메라: 동서 기울기 영상에서 u 도 원근 보정(광선 교점 u 와 일치 ±1)', () => {
  // 64×1 동서 기울기 영상: 열 c 값 = 4c. 한 행뿐이라 v 는 영향이 없고 u 만 결과를 정한다.
  const W = 64;
  const rgb = new Uint8Array(3 * W);
  for (let c = 0; c < W; c += 1) rgb.set([4 * c, 4 * c, 4 * c], 3 * c);
  const image = { width: W, height: 1, rgb };
  // 북동쪽 위에서 남서쪽을 비스듬히 보는 카메라: 동서·남북 모두 깊이가 달라진다.
  const cam = lookCam([60, 60, 35], [0, 0, 0]);
  const A0 = -30; const A1 = 30;
  const out = emptyResult(160, 90);
  rasterizeTextured(cam, [texRoof(A0, A1, -30, 30, 0)], image, out);
  const { fx, fy, cx, cy } = cam.K; const R = cam.R; const t = cam.t;
  const C = [0, 1, 2].map((k) => -(R[k] * t[0] + R[3 + k] * t[1] + R[6 + k] * t[2]));
  let n = 0; let worst = 0;
  for (let j = 0; j < 90; j += 1) {
    for (let i = 0; i < 160; i += 1) {
      const p = j * 160 + i;
      if (out.index[p] === -1) continue;
      const dc = [(i + 0.5 - cx) / fx, (j + 0.5 - cy) / fy, 1];
      const dw = [0, 1, 2].map((k) => R[k] * dc[0] + R[3 + k] * dc[1] + R[6 + k] * dc[2]);
      const x = C[0] + (-C[2] / dw[2]) * dw[0]; // 광선이 지붕 평면(z=0)과 만나는 동쪽 좌표
      const ref = refSample(image, (x - A0) / (A1 - A0), 0.5);
      worst = Math.max(worst, Math.abs(out.color[3 * p] - ref[0]));
      n += 1;
    }
  }
  assert.ok(n > 1500, `덮인 화소 ${n}`);
  assert.ok(worst <= 1, `최대 차 ${worst}`);
});

test('wallMask=1 정점이 하나라도 있는 삼각형은 faceRgb, 영상 색을 섞지 않는다', () => {
  const face = [...BUILDINGS_DEFAULTS.faceRgb];
  const white = { width: 2, height: 2, rgb: new Uint8Array(12).fill(255) };
  // 정점 0(남서)만 벽: 두 삼각형 (0,1,2), (0,2,3) 모두 정점 0 을 가지므로 전부 검정.
  const out = emptyResult(160, 90);
  rasterizeTextured(topCam(), [texRoof(X0, X1, Y0, Y1, 20, [1, 0, 0, 0])], white, out);
  // 정점 1(남동)만 벽: 삼각형 (0,1,2) 만 검정, (0,2,3)(북서 쪽) 은 흰색.
  const out2 = emptyResult(160, 90);
  rasterizeTextured(topCam(), [texRoof(X0, X1, Y0, Y1, 20, [0, 1, 0, 0])], white, out2);
  let n = 0;
  for (let p = 0; p < out.index.length; p += 1) {
    if (out.index[p] === -1) continue;
    n += 1;
    assert.deepEqual([...out.color.subarray(3 * p, 3 * p + 3)], face);
  }
  assert.equal(n, 41 * 31);
  assert.deepEqual(px(out2, 99, 59), face); // 남동(삼각형 0,1,2)
  assert.deepEqual(px(out2, 61, 31), [255, 255, 255]); // 북서(삼각형 0,2,3)
  // 세운 벽 사각형(전부 wallMask 1)을 비스듬히 보면 덮인 화소가 모두 faceRgb.
  const wall = {
    ...texRoof(0, 0, 0, 0, 0, [1, 1, 1, 1]),
    mesh: { positions: new Float32Array([-10, 10, 0, 10, 10, 0, 10, 10, 15, -10, 10, 15]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) },
  };
  const out3 = emptyResult(160, 90);
  rasterizeTextured(lookCam([0, -60, 40], [0, 20, 0]), [wall], white, out3);
  let m = 0;
  for (let p = 0; p < out3.index.length; p += 1) {
    if (out3.index[p] === -1) continue;
    m += 1;
    assert.deepEqual([...out3.color.subarray(3 * p, 3 * p + 3)], face);
  }
  assert.ok(m > 100);
});

test('image 가 null 이면 전부 faceRgb(깊이·번호는 채움), uv 없이도 그린다', () => {
  const out = emptyResult(160, 90);
  const g = texRoof(X0, X1, Y0, Y1, 20);
  rasterizeTextured(topCam(), [{ ...g, uv: undefined, wallMask: undefined }], null, out);
  let n = 0;
  for (let p = 0; p < out.index.length; p += 1) {
    if (out.index[p] === -1) continue;
    n += 1;
    assert.equal(out.index[p], 0);
    assert.ok(Math.abs(out.depth[p] - 80) <= 1e-4);
    assert.deepEqual([...out.color.subarray(3 * p, 3 * p + 3)], [...BUILDINGS_DEFAULTS.faceRgb]);
  }
  assert.equal(n, 41 * 31);
});

test('가림·층 합성·빈 묶음은 rasterizeFlat 과 같은 규약', () => {
  const lowRoof = texRoof(X0, X1, Y0, Y1, 20); // d = 80
  const highRoof = texRoof(-5.3, 5.3, -5.3, 5.3, 50); // d = 50, 화면 (69.4..90.6)
  const empty = { ...lowRoof, mesh: { positions: new Float32Array(0), indices: new Uint32Array(0) }, uv: new Float32Array(0), wallMask: new Uint8Array(0) };
  const out = emptyResult(160, 90);
  const pre = 45 * 160 + 62;
  out.depth[pre] = 10; out.index[pre] = 7; out.color.set([1, 2, 3], 3 * pre);
  rasterizeTextured(topCam(), [empty, highRoof, lowRoof], img2(), out);
  assert.equal(out.index[45 * 160 + 80], 1);
  assert.ok(Math.abs(out.depth[45 * 160 + 80] - 50) <= 1e-4);
  assert.equal(out.index[45 * 160 + 65], 2);
  assert.equal(out.index[pre], 7); assert.equal(out.depth[pre], 10);
  assert.deepEqual(px(out, 62, 45), [1, 2, 3]);
});

test('카메라 뒤·근평면 걸침: 뒤는 비우고 걸친 지붕은 앞 부분만 그린다', () => {
  const cam = { width: 160, height: 90, K: { fx: 100, fy: 100, cx: 80, cy: 45 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
  const behind = { ...texRoof(0, 1, 0, 1, 0), mesh: { positions: new Float32Array([-1, -1, -2, 1, -1, -2, 1, 1, -2, -1, 1, -2]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) } };
  const out = emptyResult(160, 90);
  rasterizeTextured(cam, [behind], img2(), out);
  assert.deepEqual(out, emptyResult(160, 90));
  // 바닥 평면 y = 1(카메라 아래 1 m)에 놓인 사각형, z ∈ [−5, 20] 로 카메라 뒤까지 걸친다.
  const straddle = { ...texRoof(0, 1, 0, 1, 0), mesh: { positions: new Float32Array([-3, 1, -5, 3, 1, -5, 3, 1, 20, -3, 1, 20]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) } };
  const out2 = emptyResult(160, 90);
  rasterizeTextured(cam, [straddle], img2(), out2);
  let n = 0;
  for (let j = 0; j < 90; j += 1) {
    for (let i = 0; i < 160; i += 1) {
      const p = j * 160 + i;
      const b = (j + 0.5 - 45) / 100; const a = (i + 0.5 - 80) / 100;
      const s = b > 0 ? 1 / b : -1; // 광선이 y = 1 평면에 닿는 깊이
      const x = a * s;
      const inside = s > 0.01 && s < 20 && x > -3 && x < 3;
      if (Math.abs(s - 20) < 1e-3 || Math.abs(Math.abs(x) - 3) < 1e-3) continue;
      assert.equal(out2.index[p] !== -1, inside, `화소 (${i},${j})`);
      if (inside) { n += 1; assert.ok(Math.abs(out2.depth[p] - s) <= 1e-4 * Math.max(1, s)); }
    }
  }
  assert.ok(n > 1000);
});
