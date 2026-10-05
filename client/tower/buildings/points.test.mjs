// rasterizePoints 시험(합성 정답). 카메라 A: R = I, t = 0, 64×48, fx = fy = 50, cx = 32, cy = 24.
//   u = 50·x/z + 32, v = 50·y/z + 24. 점 하나 = (floor(u), floor(v)) 칸 한 화소.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rasterizePoints } from './points.mjs';
import { emptyResult, assertRenderResult, assertCamera } from '../../../contracts/raster/index.mjs';
import { project } from '../../../server/raster_ref/project/index.mjs';

const W = 64, H = 48;
const RGB = [255, 255, 255];
const camA = () => ({ width: W, height: H, K: { fx: 50, fy: 50, cx: 32, cy: 24 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] });
const grp = (pts) => ({ points: new Float32Array(pts.flat()) });
const at = (i, j) => j * W + i;
// 카메라 A 에서 화면 (u, v), 깊이 z 로 투영되는 세계 점
const pt = (u, v, z) => [((u - 32) / 50) * z, ((v - 24) / 50) * z, z];
const painted = (out) => {
  const s = [];
  for (let p = 0; p < W * H; p += 1) if (out.index[p] !== -1) s.push(`${p % W},${Math.floor(p / W)}`);
  return s.sort();
};

test('투영 칸: floor(u), floor(v) 칸 한 화소(round 와 다른 위치로 고른 점)', () => {
  const out = emptyResult(W, H);
  // (10.7, 20.2) → 10,20 (round 면 11,20) / (5.2, 7.9) → 5,7 (round 면 5,8) / (40.6, 30.6) → 40,30 (round 면 41,31)
  rasterizePoints(camA(), [grp([pt(10.7, 20.2, 3), pt(5.2, 7.9, 7), pt(40.6, 30.6, 2)])], RGB, out);
  assertRenderResult(out);
  assert.deepEqual(painted(out), ['10,20', '40,30', '5,7']);
  assert.ok(Math.abs(out.depth[at(10, 20)] - 3) < 1e-6);
  assert.ok(Math.abs(out.depth[at(5, 7)] - 7) < 1e-6);
  assert.deepEqual([...out.color.subarray(3 * at(40, 30), 3 * at(40, 30) + 3)], RGB);
});

test('회전 카메라: 칸이 독립 투영(server project)의 floor 와 같다', () => {
  const a = (25 * Math.PI) / 180;
  const cam = { width: W, height: H, K: { fx: 47, fy: 49, cx: 30.6, cy: 22.9 }, R: [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1], t: [0.3, -0.2, 4] };
  assertCamera(cam);
  const P = new Float32Array([0.5, 0.4, 1.0, -1.1, 0.2, 0.5, 0.9, -0.8, 2.3, -0.3, -0.6, -0.7]);
  const out = emptyResult(W, H);
  rasterizePoints(cam, [{ points: P }], RGB, out);
  const want = [];
  for (let k = 0; k < P.length; k += 3) {
    const p = project(cam, [P[k], P[k + 1], P[k + 2]]);
    assert.ok(p.u >= 0 && p.u < W && p.v >= 0 && p.v < H);
    want.push(`${Math.floor(p.u)},${Math.floor(p.v)}`);
    assert.ok(Math.abs(out.depth[at(Math.floor(p.u), Math.floor(p.v))] - p.d) < 1e-5);
  }
  assert.deepEqual(painted(out), [...new Set(want)].sort());
});

test('깊이 시험: 가까운 점이 이기고, 같은 깊이면 먼저 그린 묶음이 남는다', () => {
  const out = emptyResult(W, H);
  rasterizePoints(camA(), [
    grp([pt(20.5, 10.5, 6), pt(30.5, 12.5, 3)]),
    grp([pt(20.4, 10.6, 4), pt(30.6, 12.4, 5)]),
    grp([pt(30.5, 12.5, 3)]),
  ], RGB, out);
  assert.equal(out.index[at(20, 10)], 1);
  assert.ok(Math.abs(out.depth[at(20, 10)] - 4) < 1e-6);
  assert.equal(out.index[at(30, 12)], 0);
  assert.ok(Math.abs(out.depth[at(30, 12)] - 3) < 1e-6);
  // 이미 있는 면(깊이 5)보다 먼 점은 가려지고, 가까운 점은 쓴다
  const o2 = emptyResult(W, H);
  o2.depth[at(8, 8)] = 5; o2.index[at(8, 8)] = 9;
  o2.depth[at(9, 8)] = 5; o2.index[at(9, 8)] = 9;
  rasterizePoints(camA(), [grp([pt(8.5, 8.5, 5.5), pt(9.5, 8.5, 4.5)])], RGB, o2);
  assert.equal(o2.index[at(8, 8)], 9);
  assert.equal(o2.depth[at(8, 8)], 5);
  assert.equal(o2.index[at(9, 8)], 0);
});

test('카메라 뒤·근평면 안쪽(z ≤ 0.01)·화면 밖 점은 그리지 않는다', () => {
  const out = emptyResult(W, H);
  rasterizePoints(camA(), [grp([
    [0.2, 0.1, -5], // 뒤: 부호 그대로 투영하면 (30, 23) 화면 안
    [-0.4, -0.2, -2], // 뒤: (42, 29)
    [0.00001, 0.00001, 0.005], // 근평면 안쪽: (32.1, 24.1)
    pt(-0.5, 10.5, 3), // u < 0
    pt(64.3, 10.5, 3), // u > W, 칸 64(밖)
    pt(10.5, 48.2, 3), // v ≥ H
  ])], RGB, out);
  assert.deepEqual(painted(out), []);
  assert.ok(out.color.every((c) => c === 0));
});

test('입력 검증: 비유한 좌표·길이·크기', () => {
  const out = emptyResult(W, H);
  assert.throws(() => rasterizePoints(camA(), [grp([[0, NaN, 1]])], RGB, out), TypeError);
  assert.throws(() => rasterizePoints(camA(), [{ points: new Float32Array(4) }], RGB, out), TypeError);
  assert.throws(() => rasterizePoints(camA(), [], RGB, emptyResult(W, H + 1)), RangeError);
});

test('투영 분모는 double 깊이: fround 깊이로 나누면 칸이 밀리는 경계 입력', () => {
  const cam = { width: 2000, height: 4, K: { fx: 1000, fy: 1000, cx: 0, cy: 2 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0.1] };
  const out = emptyResult(2000, 4);
  rasterizePoints(cam, [grp([[1, 0, 1.5]])], RGB, out);
  assert.equal(out.index[2 * 2000 + 625], 0);
  assert.equal(out.index[2 * 2000 + 624], -1);
});
