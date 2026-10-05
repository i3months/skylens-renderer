// rasterizeLines 시험(합성 정답). 기대값은 시험 안에서 손 계산 또는 독립 투영 공식으로 구한다.
// 카메라 A: R = I, t = 0, 64×48, fx = fy = 50, cx = 32, cy = 24 → u = 50·x/z + 32, v = 50·y/z + 24.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rasterizeLines } from './lines.mjs';
import { emptyResult, assertRenderResult, assertCamera } from '../../../contracts/raster/index.mjs';
import { BUILDINGS_DEFAULTS } from '../../../contracts/controlview/buildings.mjs';
import { project } from '../../../server/raster_ref/project/index.mjs';

const W = 64, H = 48;
const RGB = [200, 150, 100];
const camA = () => ({ width: W, height: H, K: { fx: 50, fy: 50, cx: 32, cy: 24 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] });
const grp = (segs) => ({ edgeLines: new Float32Array(segs.flat()) });
const painted = (out) => {
  const s = [];
  for (let p = 0; p < W * H; p += 1) if (out.index[p] !== -1) s.push(`${p % W},${Math.floor(p / W)}`);
  return s.sort();
};
const at = (out, i, j) => j * W + i;
const near = (a, b, rel = 1e-5) => Math.abs(a - b) <= rel * Math.abs(b);

// 회전 카메라(y 축 30°, 그다음 x 축 −10°)와 이동. 투영 정답은 server/raster_ref/project 로 구한다.
function camB() {
  const a = (30 * Math.PI) / 180, b = (-10 * Math.PI) / 180;
  const Ry = [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
  const Rx = [1, 0, 0, 0, Math.cos(b), -Math.sin(b), 0, Math.sin(b), Math.cos(b)];
  const R = [];
  for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) R.push(Rx[i * 3] * Ry[j] + Rx[i * 3 + 1] * Ry[3 + j] + Rx[i * 3 + 2] * Ry[6 + j]);
  const cam = { width: W, height: H, K: { fx: 55, fy: 52, cx: 31.3, cy: 23.7 }, R, t: [0.4, -0.3, 6] };
  assertCamera(cam);
  return cam;
}

test('회전 카메라: 선분 시작·끝 칸 = 독립 투영의 floor 칸, 깊이 = 끝점 깊이, 연결됨', () => {
  const cam = camB();
  const A = [-1.2, 0.7, 0.3], B = [1.9, -0.4, 2.1];
  const fa = Float32Array.from(A), fb = Float32Array.from(B);
  const pa = project(cam, [fa[0], fa[1], fa[2]]), pb = project(cam, [fb[0], fb[1], fb[2]]);
  // 독립 공식으로도 한 번 더(R 행 우선)
  const R = cam.R, t = cam.t;
  const zc = R[6] * fa[0] + R[7] * fa[1] + R[8] * fa[2] + t[2];
  const xc = R[0] * fa[0] + R[1] * fa[1] + R[2] * fa[2] + t[0];
  assert.ok(Math.abs(55 * xc / zc + 31.3 - pa.u) < 1e-9);
  for (const p of [pa, pb]) assert.ok(p.u > 0 && p.u < W && p.v > 0 && p.v < H && p.d > 0.01, JSON.stringify(p));
  const out = emptyResult(W, H);
  rasterizeLines(cam, [grp([[...A, ...B]])], RGB, out);
  assertRenderResult(out);
  const ia = at(out, Math.floor(pa.u), Math.floor(pa.v)), ib = at(out, Math.floor(pb.u), Math.floor(pb.v));
  assert.equal(out.index[ia], 0);
  assert.equal(out.index[ib], 0);
  // 끝점 칸은 같은 칸 안의 열(행) 표본이 덮어쓸 수 있으므로, 한 칸 안에서 변할 수 있는 깊이 폭만큼 허용한다.
  const span = Math.max(Math.abs(Math.floor(pb.u) - Math.floor(pa.u)), Math.abs(Math.floor(pb.v) - Math.floor(pa.v))) + 1;
  const tol = (1.5 * Math.abs(pb.d - pa.d)) / span + 1e-4;
  assert.ok(Math.abs(out.depth[ia] - pa.d) <= tol, `시작 깊이 ${out.depth[ia]} vs ${pa.d}`);
  assert.ok(Math.abs(out.depth[ib] - pb.d) <= tol, `끝 깊이 ${out.depth[ib]} vs ${pb.d}`);
  // 색
  assert.deepEqual([...out.color.subarray(3 * ia, 3 * ia + 3)], RGB);
  // 칠한 화소 수 ≥ 주축 칸 수, 모든 깊이는 두 끝 깊이 사이
  const n = painted(out).length;
  assert.ok(n >= span && n <= span + 2, `화소 수 ${n}, 주축 ${span}`);
  const lo = Math.min(pa.d, pb.d) * (1 - 1e-5), hi = Math.max(pa.d, pb.d) * (1 + 1e-5);
  for (let p = 0; p < W * H; p += 1) if (out.index[p] === 0) assert.ok(out.depth[p] >= lo && out.depth[p] <= hi);
  // 8-연결: 칠한 화소마다 이웃(8방향)에 칠한 화소가 있다
  for (let p = 0; p < W * H; p += 1) {
    if (out.index[p] !== 0) continue;
    const i = p % W, j = Math.floor(p / W);
    let nb = 0;
    for (let dj = -1; dj <= 1; dj += 1) for (let di = -1; di <= 1; di += 1) {
      if ((di || dj) && i + di >= 0 && i + di < W && j + dj >= 0 && j + dj < H && out.index[at(out, i + di, j + dj)] === 0) nb += 1;
    }
    assert.ok(nb >= 1, `고립 화소 ${i},${j}`);
  }
});

test('수평선 한 줄: 화소 수 = floor(u1) − floor(u0) + 1 = 21, 한 행, 깊이 5', () => {
  // z = 5, v = 50·y/5 + 24 = 24.5 → y = 0.05. u0 = 10.3 → x = (10.3−32)/10, u1 = 30.8 → x = (30.8−32)/10
  const out = emptyResult(W, H);
  rasterizeLines(camA(), [grp([[(10.3 - 32) / 10, 0.05, 5, (30.8 - 32) / 10, 0.05, 5]])], RGB, out);
  const want = [];
  for (let i = 10; i <= 30; i += 1) want.push(`${i},24`);
  assert.deepEqual(painted(out), want.sort());
  assert.equal(painted(out).length, 21);
  assert.equal(out.index[at(out, 9, 24)], -1, '왼쪽 끝 바로 밖 화소는 비어 있다');
  assert.equal(out.index[at(out, 31, 24)], -1, '오른쪽 끝 바로 밖 화소는 비어 있다');
  for (let i = 10; i <= 30; i += 1) assert.ok(near(out.depth[at(out, i, 24)], 5));
});

test('깊이 정답: 원근 보정(1/z 선형) 깊이가 열 중심마다 손 계산과 같다', () => {
  // A = (−0.5, 0.02, 2) → (u,v) = (19.5, 24.5), B = (1.5, 0.06, 6) → (44.5, 24.5). 열 19..44 = 26 화소.
  // 열 i 중심 u = i+0.5 에서 k = (u−32)/50, 선 위 점 X = A + τ(B−A): (−0.5+2τ)/(2+4τ) = k → τ = (2k+0.5)/(2−4k), z = 2+4τ.
  const out = emptyResult(W, H);
  rasterizeLines(camA(), [grp([[-0.5, 0.02, 2, 1.5, 0.06, 6]])], RGB, out);
  const want = [];
  for (let i = 19; i <= 44; i += 1) want.push(`${i},24`);
  assert.deepEqual(painted(out), want.sort());
  for (let i = 19; i <= 44; i += 1) {
    const k = (i + 0.5 - 32) / 50;
    const z = 2 + (4 * (2 * k + 0.5)) / (2 - 4 * k);
    assert.ok(near(out.depth[at(out, i, 24)], z), `열 ${i}: ${out.depth[at(out, i, 24)]} vs ${z}`);
  }
  // 화면 선형 보간(원근 보정 없음)이라면 가운데 열은 다른 값이다(정답이 구분력을 갖는지 확인)
  const zLin = 2 + ((31.5 - 19.5) / 25) * 4;
  assert.ok(Math.abs(out.depth[at(out, 31, 24)] - zLin) > 0.3);
});

test('깊이 편향: 면 위(같은 깊이)·편향 안쪽의 선은 보이고, 면 뒤의 선은 가려진다', () => {
  // 면: 행 24 전체를 깊이 5, 번호 7 로 채운다(앞서 그린 검정 면 흉내).
  const face = () => {
    const out = emptyResult(W, H);
    for (let i = 0; i < W; i += 1) { out.depth[at(out, i, 24)] = 5; out.index[at(out, i, 24)] = 7; }
    return out;
  };
  const seg = (z) => [[(10.5 - 32) / 50 * z, 0.1 * z / 10, z, (20.5 - 32) / 50 * z, 0.1 * z / 10, z]]; // v = 24.5, 열 10..20
  const cnt = (out, g) => { let n = 0; for (let i = 0; i < W; i += 1) if (out.index[at(out, i, 24)] === g) n += 1; return n; };
  assert.equal(BUILDINGS_DEFAULTS.lineDepthBiasM, 0.05);
  // 면 위의 선(같은 깊이): 기본 편향 0.05 로 보인다. 깊이는 선 깊이(편향 없이) 5.
  let out = face();
  rasterizeLines(camA(), [grp(seg(5))], RGB, out);
  assert.equal(cnt(out, 0), 11);
  assert.ok(near(out.depth[at(out, 15, 24)], 5));
  // 편향 안쪽(면보다 0.03 m 뒤): 보인다
  out = face();
  rasterizeLines(camA(), [grp(seg(5.03))], RGB, out);
  assert.equal(cnt(out, 0), 11);
  assert.ok(near(out.depth[at(out, 15, 24)], 5.03));
  // 면 뒤 0.2 m: 가려진다(면 그대로)
  out = face();
  rasterizeLines(camA(), [grp(seg(5.2))], RGB, out);
  assert.equal(cnt(out, 0), 0);
  assert.equal(cnt(out, 7), W);
  // 편향 0 이면 같은 깊이 선은 그리지 않는다(엄격히 가까울 때만)
  out = face();
  rasterizeLines(camA(), [grp(seg(5))], RGB, out, { depthBias: 0 });
  assert.equal(cnt(out, 0), 0);
  // 면 앞의 선은 편향과 무관하게 보인다
  out = face();
  rasterizeLines(camA(), [grp(seg(4))], RGB, out, { depthBias: 0 });
  assert.equal(cnt(out, 0), 11);
});

test('근평면에 걸친 선분: z ≥ 0.01 부분만, 화소 집합과 깊이가 손 계산과 같다', () => {
  // 카메라 공간 x = 0.2, y = 0.1 고정, z: −3 → 5. 화면에서 u = 10/z + 32, v = 5/z + 24 → v = 24 + (u−32)/2.
  // B (z=5) = (34, 25). 근평면 z = 0.01 점은 (1032, 524) 화면 밖 → 화면 경계 u = 64 에서 잘린다. 열 34..63.
  // 근평면에서 자르지 않으면 z = −3 끝이 (28.67, 22.33) 로 반대편에 투영되어 열 28..33 이 칠해진다.
  const out = emptyResult(W, H);
  rasterizeLines(camA(), [grp([[0.2, 0.1, -3, 0.2, 0.1, 5]])], RGB, out);
  assertRenderResult(out);
  const want = new Set();
  for (let i = 34; i <= 63; i += 1) want.add(`${i},${Math.floor(24 + (i + 0.5 - 32) / 2)}`);
  want.add('34,25');
  assert.deepEqual(painted(out), [...want].sort());
  for (let i = 35; i <= 63; i += 1) {
    const z = 10 / (i + 0.5 - 32);
    assert.ok(near(out.depth[at(out, i, Math.floor(24 + (i + 0.5 - 32) / 2))], z), `열 ${i}`);
  }
  for (let p = 0; p < W * H; p += 1) if (out.index[p] === 0) assert.ok(out.depth[p] >= 0.01 && out.depth[p] <= 5 * (1 + 1e-6));
});

test('카메라 뒤 선분과 근평면 안쪽(z < 0.01) 선분은 아무것도 그리지 않는다', () => {
  const out = emptyResult(W, H);
  rasterizeLines(camA(), [grp([
    [0.2, 0.1, -3, -0.4, 0.3, -1], // 둘 다 뒤
    [0.0001, 0.0001, 0.005, -0.0001, 0.0002, 0.009], // 둘 다 근평면 안쪽
    [-1, 0.5, -0.5, 1, -0.5, -2],
  ])], RGB, out);
  assert.deepEqual(painted(out), []);
  assert.ok(out.color.every((c) => c === 0));
});

test('화면 밖: 완전히 밖인 선분은 0 화소, 화면을 가로지르는 선분은 화면 폭만큼(64)', () => {
  let out = emptyResult(W, H);
  rasterizeLines(camA(), [grp([
    [10, 0, 5, 20, 1, 5], // u = 132..232, 오른쪽 밖
    [-1, -10, 5, 1, -12, 5], // v < 0, 위쪽 밖
    [-10, -5, 5, -5, -10, 5], // 왼쪽 위 모서리 밖을 지나감
  ])], RGB, out);
  assert.deepEqual(painted(out), []);
  // u = −100 .. 200, v = 24.5, z = 5 → 열 0..63 전부
  out = emptyResult(W, H);
  rasterizeLines(camA(), [grp([[(-100 - 32) / 10, 0.05, 5, (200 - 32) / 10, 0.05, 5]])], RGB, out);
  const want = [];
  for (let i = 0; i < W; i += 1) want.push(`${i},24`);
  assert.deepEqual(painted(out), want.sort());
});

test('묶음 번호: index = 묶음 순서, 가까운 선이 이긴다', () => {
  const out = emptyResult(W, H);
  const s = (z) => [(5.5 - 32) / 50 * z, 0.01 * z, z, (15.5 - 32) / 50 * z, 0.01 * z, z]; // v = 24.5, 열 5..15
  rasterizeLines(camA(), [grp([s(8)]), grp([]), grp([s(4)]), grp([s(9)])], RGB, out, { depthBias: 0 });
  for (let i = 5; i <= 15; i += 1) {
    assert.equal(out.index[at(out, i, 24)], 2);
    assert.ok(near(out.depth[at(out, i, 24)], 4));
  }
});

test('입력 검증: 비유한 좌표·길이·크기·편향', () => {
  const out = emptyResult(W, H);
  assert.throws(() => rasterizeLines(camA(), [grp([[0, 0, NaN, 1, 1, 1]])], RGB, out), TypeError);
  assert.throws(() => rasterizeLines(camA(), [{ edgeLines: new Float32Array(5) }], RGB, out), TypeError);
  assert.throws(() => rasterizeLines(camA(), [], RGB, emptyResult(W + 1, H)), RangeError);
  assert.throws(() => rasterizeLines(camA(), [], RGB, out, { depthBias: NaN }), RangeError);
  assert.throws(() => rasterizeLines(camA(), [], [0, 0, 256], out), RangeError);
});
