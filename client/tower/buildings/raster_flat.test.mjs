// T15.3 rasterizeFlat 시험. 정답은 시험 안에서 구현과 코드를 공유하지 않는 해석식(투영·광선 교차)으로 따로 구한다.
// 카메라는 contracts/raster 규약(X_c = R·X_w + t, OpenCV 축). 경계 모호성을 없애려고 투영 경계를 화소 중심에서 먼 값으로 잡는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyResult } from '../../../contracts/raster/index.mjs';
import { rasterizeFlat } from './raster_flat.mjs';

// 위에서 아래를 보는 160×90 카메라. 카메라 중심 (0,0,100), x_c = 동, y_c = 남, z_c = 아래.
//   d = 100 − z, u = 100·x/d + 80, v = −100·y/d + 45.
const topCam = () => ({ width: 160, height: 90, K: { fx: 100, fy: 100, cx: 80, cy: 45 }, R: [1, 0, 0, 0, -1, 0, 0, 0, -1], t: [0, 0, 100] });

// 시점 C 에서 target 을 보는 카메라(OpenCV 축: x = 오른쪽, y = 아래, z = 앞). 세계 위쪽은 +z.
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

function group(verts, tris) {
  return {
    ids: [1],
    mesh: { positions: new Float32Array(verts.flat()), indices: new Uint32Array(tris.flat()) },
    edgeLines: new Float32Array(0),
    uv: new Float32Array(2 * verts.length),
    wallMask: new Uint8Array(verts.length),
    points: new Float32Array(0),
  };
}

// 지붕 사각형(남서·남동·북동·북서, 위에서 볼 때 반시계).
const roof = (x0, x1, y0, y1, z) => group([[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]], [[0, 1, 2], [0, 2, 3]]);

// 상자(지붕 + 벽 4 + 바닥). 면마다 정점을 따로 둔다.
function box(x0, x1, y0, y1, z0, z1) {
  const v = []; const tr = [];
  const quad = (a, b, c, d) => { const o = v.length; v.push(a, b, c, d); tr.push([o, o + 1, o + 2], [o, o + 2, o + 3]); };
  quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
  quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
  quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
  quad([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]);
  quad([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]);
  quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]);
  return group(v, tr);
}

const white = () => [255, 255, 255];
const f32 = Math.fround;

test('위에서 본 지붕: 덮인 화소 집합이 투영 사각형 안 화소 중심과 완전히 같고 깊이 = 카메라 z', () => {
  // 투영 경계 u ∈ (54.2, 98.3), v ∈ (29.2, 57.3) 이 되도록 고른 좌표(z=20 → d=80, u = 1.25x + 80, v = −1.25y + 45).
  const x0 = -20.64; const x1 = 14.64; const y0 = -9.84; const y1 = 12.64; const z = 20;
  const cam = topCam();
  const out = emptyResult(160, 90);
  rasterizeFlat(cam, [roof(x0, x1, y0, y1, z)], white, out);
  // 독립 해석식: Float32 로 저장된 좌표를 투영해 경계를 구한다.
  const d = 100 - f32(z);
  const uMin = 100 * f32(x0) / d + 80; const uMax = 100 * f32(x1) / d + 80;
  const vMin = -100 * f32(y1) / d + 45; const vMax = -100 * f32(y0) / d + 45;
  // 경계는 화소 중심과 정수 모서리 모두에서 0.15 px 이상 떨어져 있어야 시험이 모호하지 않다.
  for (const b of [uMin, uMax, vMin, vMax]) {
    const fr = b - Math.floor(b);
    assert.ok(Math.abs(fr - 0.5) > 0.15 && fr > 0.15 && fr < 0.85, `경계 ${b} 가 모호함`);
  }
  // 화소 중심 개수 공식: #{i : lo < i + 0.5 < hi} = floor(hi − 0.5) − ceil(lo − 0.5) + 1 (경계가 중심이 아닐 때)
  const nCols = Math.floor(uMax - 0.5) - Math.ceil(uMin - 0.5) + 1;
  const nRows = Math.floor(vMax - 0.5) - Math.ceil(vMin - 0.5) + 1;
  assert.equal(nCols, 44); assert.equal(nRows, 28);
  let filled = 0;
  for (let j = 0; j < 90; j += 1) {
    for (let i = 0; i < 160; i += 1) {
      const inside = i + 0.5 > uMin && i + 0.5 < uMax && j + 0.5 > vMin && j + 0.5 < vMax;
      const p = j * 160 + i;
      assert.equal(out.index[p], inside ? 0 : -1, `화소 (${i},${j})`);
      if (inside) {
        filled += 1;
        assert.ok(Math.abs(out.depth[p] - 80) <= 1e-4, `깊이 ${out.depth[p]}`);
        assert.deepEqual([...out.color.subarray(3 * p, 3 * p + 3)], [255, 255, 255]);
      } else {
        assert.equal(out.depth[p], 0);
      }
    }
  }
  assert.equal(filled, nCols * nRows);
  // 경계 화소를 명시: 첫 열 54, 마지막 열 97, 첫 행 29, 마지막 행 57.
  assert.equal(out.index[45 * 160 + 54], 0); assert.equal(out.index[45 * 160 + 53], -1);
  assert.equal(out.index[45 * 160 + 97], 0); assert.equal(out.index[45 * 160 + 98], -1);
  assert.equal(out.index[29 * 160 + 80], 0); assert.equal(out.index[28 * 160 + 80], -1);
  assert.equal(out.index[56 * 160 + 80], 0); assert.equal(out.index[57 * 160 + 80], -1);
});

// 화소 중심 광선과 평면 z_w = 0 의 교점 깊이(카메라 z) 와 교점 세계 좌표.
function rayGround(cam, i, j) {
  const { fx, fy, cx, cy } = cam.K; const R = cam.R; const t = cam.t;
  const dc = [(i + 0.5 - cx) / fx, (j + 0.5 - cy) / fy, 1];
  const dw = [0, 1, 2].map((k) => R[k] * dc[0] + R[3 + k] * dc[1] + R[6 + k] * dc[2]); // Rᵀ·dc
  const C = [0, 1, 2].map((k) => -(R[k] * t[0] + R[3 + k] * t[1] + R[6 + k] * t[2])); // −Rᵀ·t
  const s = -C[2] / dw[2];
  return { s, x: C[0] + s * dw[0], y: C[1] + s * dw[1] };
}

test('비스듬한 카메라: 원근 보정 깊이가 광선–평면 교점 깊이와 1e-4 이내', () => {
  const cam = lookCam([0, -60, 40], [0, 20, 0]);
  const out = emptyResult(160, 90);
  const X0 = -30; const X1 = 30; const Y0 = -20; const Y1 = 60;
  rasterizeFlat(cam, [roof(X0, X1, Y0, Y1, 0)], white, out);
  let checked = 0; let maxSpread = 0; let dMin = Infinity; let dMax = 0;
  for (let j = 0; j < 90; j += 1) {
    for (let i = 0; i < 160; i += 1) {
      const p = j * 160 + i;
      const { s, x, y } = rayGround(cam, i, j);
      const inside = s > 0 && x > X0 && x < X1 && y > Y0 && y < Y1;
      const margin = Math.min(Math.abs(x - X0), Math.abs(x - X1), Math.abs(y - Y0), Math.abs(y - Y1));
      if (margin < 1e-3) continue; // 경계 위 표본은 건너뛴다
      assert.equal(out.index[p] !== -1, inside, `화소 (${i},${j})`);
      if (inside) {
        assert.ok(Math.abs(out.depth[p] - s) <= 1e-4, `화소 (${i},${j}) 깊이 ${out.depth[p]} 정답 ${s}`);
        checked += 1; dMin = Math.min(dMin, s); dMax = Math.max(dMax, s);
      }
    }
  }
  maxSpread = dMax - dMin;
  assert.ok(checked > 3000, `검사 화소 ${checked}`);
  assert.ok(maxSpread > 20, '깊이 변화가 커야 선형 보간과 구별된다');
});

// 카메라 = 세계(R=I, t=0) 에서 화소 중심 광선 (a,b,1)·s 와 삼각형의 교점(무게중심 좌표 포함).
function rayTri(cam, i, j, P) {
  const a = (i + 0.5 - cam.K.cx) / cam.K.fx; const b = (j + 0.5 - cam.K.cy) / cam.K.fy;
  const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
  const cross = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
  const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  const dir = [a, b, 1];
  const e1 = sub(P[1], P[0]); const e2 = sub(P[2], P[0]);
  const h = cross(dir, e2); const det = dot(e1, h);
  const sv = sub([0, 0, 0], P[0]);
  const bu = dot(sv, h) / det;
  const q = cross(sv, e1);
  const bv = dot(dir, q) / det;
  const s = dot(e2, q) / det;
  return { s, b0: 1 - bu - bv, b1: bu, b2: bv };
}

test('근평면 걸침 삼각형: 카메라 앞 부분만 정확히 그린다(광선 교차 정답과 화소·깊이 일치)', () => {
  const cam = { width: 160, height: 90, K: { fx: 100, fy: 100, cx: 80, cy: 45 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
  const P = [[-2, -1, 4], [3, -1, 4], [0, 1.5, -3]].map((v) => v.map(f32)); // 셋째 꼭짓점은 카메라 뒤
  const out = emptyResult(160, 90);
  rasterizeFlat(cam, [group(P, [[0, 1, 2]])], white, out);
  let n = 0; let nearest = Infinity;
  for (let j = 0; j < 90; j += 1) {
    for (let i = 0; i < 160; i += 1) {
      const p = j * 160 + i;
      const { s, b0, b1, b2 } = rayTri(cam, i, j, P);
      if (Math.min(Math.abs(b0), Math.abs(b1), Math.abs(b2)) < 1e-6) continue;
      const inside = b0 > 0 && b1 > 0 && b2 > 0 && s > 0.01;
      assert.equal(out.index[p] !== -1, inside, `화소 (${i},${j})`);
      if (inside) {
        assert.ok(Math.abs(out.depth[p] - s) <= 1e-4 * Math.max(1, s), `화소 (${i},${j}) 깊이 ${out.depth[p]} 정답 ${s}`);
        n += 1; nearest = Math.min(nearest, s);
      }
    }
  }
  assert.ok(n > 2000, `덮인 화소 ${n}`);
  assert.ok(nearest < 1, '카메라에 가까운 부분(절단 근처)도 그려져야 한다');
});

test('카메라 뒤 삼각형·근평면 안쪽 삼각형은 그리지 않는다', () => {
  const cam = { width: 160, height: 90, K: { fx: 100, fy: 100, cx: 80, cy: 45 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
  const out = emptyResult(160, 90);
  let calls = 0;
  rasterizeFlat(cam, [
    group([[-1, -1, -2], [1, -1, -2], [0, 1, -2]], [[0, 1, 2]]),
    group([[-1, -1, 0.005], [1, -1, 0.005], [0, 1, 0.005]], [[0, 1, 2]]),
  ], () => { calls += 1; return [255, 255, 255]; }, out);
  assert.equal(calls, 0);
  assert.deepEqual(out, emptyResult(160, 90));
});

test('앞뒤 가림: 가까운 상자가 순서와 무관하게 이기고, out 에 이미 있는 깊이와 비교한다', () => {
  const far = box(-30, 10, -10, 10, 0, 20); // 지붕 d = 80
  const near = box(-5, 25, -5, 15, 0, 50); // 지붕 d = 50
  const pFar = 45 * 160 + 55; // 세계 (−20, 0): far 지붕만
  const pBoth = 45 * 160 + 80; // 세계 (0, 0): 둘 다
  for (const order of [[far, near], [near, far]]) {
    const out = emptyResult(160, 90);
    const nearIdx = order.indexOf(near);
    rasterizeFlat(topCam(), order, (g) => (g === nearIdx ? [10, 20, 30] : [200, 100, 50]), out);
    assert.equal(out.index[pBoth], nearIdx);
    assert.ok(Math.abs(out.depth[pBoth] - 50) <= 1e-4);
    assert.deepEqual([...out.color.subarray(3 * pBoth, 3 * pBoth + 3)], [10, 20, 30]);
    assert.equal(out.index[pFar], 1 - nearIdx);
    assert.ok(Math.abs(out.depth[pFar] - 80) <= 1e-4);
  }
  // 층 합성: out 이 비어 있지 않을 때 더 가까울 때만 쓴다.
  const out = emptyResult(160, 90);
  out.depth[pBoth] = 30; out.index[pBoth] = 9; out.color.set([1, 2, 3], 3 * pBoth);
  out.depth[pFar] = 200; out.index[pFar] = 9; out.color.set([1, 2, 3], 3 * pFar);
  rasterizeFlat(topCam(), [far, near], white, out);
  assert.equal(out.index[pBoth], 9); assert.equal(out.depth[pBoth], 30);
  assert.deepEqual([...out.color.subarray(3 * pBoth, 3 * pBoth + 3)], [1, 2, 3]);
  assert.equal(out.index[pFar], 0); assert.ok(Math.abs(out.depth[pFar] - 80) <= 1e-4);
});

test('같은 깊이는 앞선 묶음을 유지한다', () => {
  const a = roof(-10.2, 10.2, -10.2, 10.2, 20);
  const out = emptyResult(160, 90);
  rasterizeFlat(topCam(), [a, a], (g) => (g === 0 ? [1, 1, 1] : [2, 2, 2]), out);
  let n = 0;
  for (let p = 0; p < out.index.length; p += 1) {
    if (out.index[p] !== -1) { n += 1; assert.equal(out.index[p], 0); assert.equal(out.color[3 * p], 1); }
  }
  assert.ok(n > 0);
});

test('빈 묶음과 빈 목록: 아무것도 그리지 않고 묶음 번호는 목록 순서 그대로', () => {
  const out0 = emptyResult(160, 90);
  rasterizeFlat(topCam(), [], white, out0);
  assert.deepEqual(out0, emptyResult(160, 90));
  const out = emptyResult(160, 90);
  const seen = new Set();
  rasterizeFlat(topCam(), [group([], []), roof(-10.2, 10.2, -10.2, 10.2, 20)], (g, tri) => { seen.add(`${g}:${tri}`); return [9, 9, 9]; }, out);
  assert.deepEqual([...seen].sort(), ['1:0', '1:1']);
  assert.equal(out.index[45 * 160 + 80], 1);
});

test('잘못된 입력은 던진다(비유한 정점, 범위 밖 인덱스, 크기 다른 out)', () => {
  assert.throws(() => rasterizeFlat(topCam(), [group([[0, 0, NaN], [1, 0, 0], [0, 1, 0]], [[0, 1, 2]])], white, emptyResult(160, 90)), TypeError);
  assert.throws(() => rasterizeFlat(topCam(), [group([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [[0, 1, 3]])], white, emptyResult(160, 90)), TypeError);
  assert.throws(() => rasterizeFlat(topCam(), [], white, emptyResult(10, 10)), TypeError);
});
