// 가림 컬링: 퇴화 시점은 isDegenerateView 규칙을 따라 예외 없이 빈 마스크(전부 0)가 된다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHierarchy } from '../../lod/hierarchy/index.mjs';
import { isDegenerateView } from '../degenerate/index.mjs';
import { occlusionCull, buildDepthPyramid } from './index.mjs';

const CAM = Object.freeze({ width: 128, height: 128, K: { fx: 100, fy: 100, cx: 64, cy: 64 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] });

function scene() {
  const n = 2000, positions = new Float32Array(3 * n), normals = new Float32Array(3 * n), colors = new Uint8Array(3 * n).fill(128);
  for (let i = 0; i < n; i++) { positions.set([(i % 40) / 10 - 2, Math.floor(i / 40) / 10 - 2, 10 + (i % 7)], 3 * i); normals[3 * i + 2] = -1; }
  return buildHierarchy({ format: 1, count: n, positions, normals, colors }, { edge0M: 0.5, levelCount: 2, maxLeafPoints: 200 });
}

const cases = {
  'width 1, fx 1e7': { ...CAM, width: 1, height: 1, K: { fx: 1e7, fy: 1e7, cx: 0.5, cy: 0.5 } },
  '8193x8193': { ...CAM, width: 8193, height: 8193, K: { fx: 5000, fy: 5000, cx: 4096, cy: 4096 } },
  '2e9 해상도': { ...CAM, width: 2e9, height: 2e9 },
  'R = 2I': { ...CAM, R: [2, 0, 0, 0, 2, 0, 0, 0, 2] },
  '반사 R': { ...CAM, R: [1, 0, 0, 0, 1, 0, 0, 0, -1] },
  NaN: { ...CAM, t: [NaN, 0, 0] },
  '비정수 해상도': { ...CAM, width: 128.5 },
};

test('퇴화 시점: 전부 0, 던지지 않음, isDegenerateView 와 일치', () => {
  const h = scene();
  assert.ok(occlusionCull(h, CAM).some((v) => v === 1), '정상 카메라는 남기는 리프가 있다');
  for (const [name, cam] of Object.entries(cases)) {
    assert.equal(isDegenerateView(cam), true, name);
    let m;
    assert.doesNotThrow(() => { m = occlusionCull(h, cam); }, name);
    assert.equal(m.length, h.octree.leafCount, name);
    assert.ok(m.every((v) => v === 0), name);
    let p;
    assert.doesNotThrow(() => { p = buildDepthPyramid(h, cam); }, name);
    assert.equal(p.degenerate, true, name);
  }
});

test("입력 오류('cull:')는 그대로", () => {
  const h = scene();
  assert.throws(() => occlusionCull(null, CAM), /^Error: cull:/);
  assert.throws(() => occlusionCull(h, null), /^Error: cull:/);
  // 구조 오류(F-132)는 값 퇴화와 달리 던진다: 빈 객체·R 누락·R 길이 틀림.
  const { R, ...noR } = CAM;
  for (const bad of [{}, noR, { ...CAM, R: CAM.R.slice(0, 8) }]) {
    assert.throws(() => occlusionCull(h, bad), /^Error: cull:/);
    assert.throws(() => buildDepthPyramid(h, bad), /^Error: cull:/);
  }
  assert.throws(() => buildDepthPyramid(h, CAM, { occluderMask: new Uint8Array(1) }), /^Error: cull:/);
});
