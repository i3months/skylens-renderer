// T08.3 가림 컬링 깊이 허용오차 경계 시험(F-143 ④).
// 구현 상수(REL·ABS)를 복사하지 않고 기하로 경계를 세운다.
// 장면: 카메라 원점, R = I, +z 를 봄, 128×128, fx = fy = 100, 점 지름 0.2 m.
//   가림막: z = 10 평면, x,y ∈ [−10, 10], 간격 0.1 m(화면 1 px 간격, 원판 반경 1 px) → 화면 전체(±6.4 m)가 깊이 10 으로 덮인다.
//   피라미드는 이 가림막만으로 만들고, 시험 대상은 따로 만든 계층(상자 하나)이다. 그래서 가림막과 상자가 같은 리프에 섞이지 않는다.
//   상자: x,y ∈ [−1, 1] 의 평면 한 장, 깊이 zb(모든 점이 같은 깊이이므로 리프 상자의 최소 깊이 = zb).
// 경계 논증(독립):
//   - 안쪽(제거 금지): zb ≤ 10 이면 상자는 가림막보다 가깝거나 같은 깊이라 '확실히 뒤'가 아니다. 제거하면 거짓 제거다.
//     float32 반올림 잡음 수준(상대 약 1e-7)의 차이만 나는 zb 도 확실히 뒤가 아니므로 남긴다.
//   - 바깥쪽(제거 허용): 10 + 1e-3 이상은 상대 1e-4 로 float32 반올림 잡음(상대 약 1.2e-7)의 800 배 이상 멀다.
//     가림막이 화면 전체를 덮으므로 이 상자는 확실히 뒤이고, 허용오차는 반올림 잡음만 흡수하면 되므로 제거해야 한다.
//     허용오차를 5 % 로 키우는 변이는 상대 1 % 이내의 뒤쪽 상자를 못 지우므로 여기서 실패한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHierarchy } from '../../lod/hierarchy/index.mjs';
import { buildDepthPyramid, occlusionCull } from './index.mjs';

const PS = 0.2, WALL_Z = 10;
const CAM = Object.freeze({ width: 128, height: 128, K: { fx: 100, fy: 100, cx: 64, cy: 64 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] });

function cloudOf(pts) {
  const n = pts.length;
  const positions = new Float32Array(3 * n), normals = new Float32Array(3 * n), colors = new Uint8Array(3 * n).fill(128);
  pts.forEach((p, i) => { positions.set(p, 3 * i); normals[3 * i + 2] = -1; });
  return { format: 1, count: n, positions, normals, colors };
}
const hierarchyOf = (pts) => buildHierarchy(cloudOf(pts), { edge0M: 0.1, levelCount: 2, maxLeafPoints: 100000 });

function wallPyramid() {
  const pts = [];
  for (let i = -100; i <= 100; i++) for (let j = -100; j <= 100; j++) pts.push([i / 10, j / 10, WALL_Z]);
  return buildDepthPyramid(hierarchyOf(pts), CAM, { size: 16, pointSizeM: PS });
}
function boxHierarchy(zb) {
  const pts = [];
  for (let i = -10; i <= 10; i++) for (let j = -10; j <= 10; j++) pts.push([i / 10, j / 10, zb]);
  return hierarchyOf(pts);
}
const pyr = wallPyramid();
const cullBox = (zb) => { const h = boxHierarchy(zb); return occlusionCull(h, CAM, pyr); };

test('전제: 가림막 피라미드는 화면 전체가 깊이 10', () => {
  for (const v of pyr.levels[0]) assert.equal(v, Math.fround(WALL_Z));
});

test('깊이 허용오차 안쪽(가림막과 같거나 가까움, 반올림 잡음 수준 차이)의 상자는 제거하지 않는다', () => {
  for (const zb of [5, 9.99, 10 - 1e-3, 10, 10 + 5e-7]) {
    const m = cullBox(zb);
    assert.ok(m.length >= 1);
    for (let k = 0; k < m.length; k++) assert.equal(m[k], 1, `zb=${zb} 리프 ${k} 는 남겨야 함`);
  }
});

test('깊이 허용오차 바깥쪽(상대 1e-4 이상 뒤)의 상자는 제거한다', () => {
  for (const zb of [10.001, 10.01, 10.1, 11, 20]) {
    const m = cullBox(zb);
    for (let k = 0; k < m.length; k++) assert.equal(m[k], 0, `zb=${zb} 리프 ${k} 는 제거해야 함`);
  }
});
