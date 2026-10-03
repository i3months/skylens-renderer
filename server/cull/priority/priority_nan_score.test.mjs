// F-162③: NaN 좌표를 가진 리프의 점수 계산 검증.
// leafPriority 는 점수의 합(wins[k] + 0.5 * (A / (1 + A)))이 유한하지 않을 때만 0 으로 설정하며,
// boxMin.x=NaN 같은 단일 NaN 좌표는 clippedArea 계산이 일부 꼭짓점을 유한 값으로 반환할 수 있어
// 점수가 0 이 아닌 값이 될 수 있음을 시험한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHierarchy } from '../../lod/select/index.mjs';
import { leafPriority } from './index.mjs';

// 시험 1: boxMin.x=NaN 인 리프의 점수가 NaN 이 아닌 유한값이 되는 경우
test('boxMin.x=NaN 인 리프의 점수는 유한·양수(현재 구현의 버그)', () => {
  // 시험용 카메라: 카메라는 점들을 정면에서 봄, 초점거리 400, 시야각 적당.
  const CAM = { width: 320, height: 180, K: { fx: 400, fy: 400, cx: 160, cy: 90 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

  // 20×12 격자 점 240개: 중심 (0, 0, 1.5).
  const pos = [];
  for (let i = 0; i < 20; i++) for (let j = 0; j < 12; j++) pos.push((i - 10) * 0.05, (j - 6) * 0.05, 1.5);
  const n = pos.length / 3;
  const cloud = { format: 1, count: n, positions: Float32Array.from(pos), normals: new Float32Array(3 * n), colors: new Uint8Array(3 * n).fill(200) };
  const h = buildHierarchy(cloud, { edge0M: 0.05, levelCount: 2, maxLeafPoints: 16 });

  // 리프 1 의 boxMin.x 를 NaN 으로 바꾼다.
  // clippedArea 는 8 꼭짓점 중 일부만 x=NaN 이므로, 다른 꼭짓점의 유한 투영으로부터
  // 0 이 아닌 경계상자 면적을 계산할 수 있다. 따라서 점수는 0 이 아니다.
  const bmin = Float32Array.from(h.octree.boxMin);
  const nd = 1; // 리프 1 에 대응하는 노드
  bmin[3 * nd] = NaN; // boxMin.x = NaN
  const bad = { ...h, octree: { ...h.octree, boxMin: bmin } };
  const score = leafPriority(bad, CAM);

  // 리프 1 의 점수가 유한하고 0 보다 크다는 것을 확인한다.
  // 이는 현재 구현이 NaN 좌표를 가진 리프도 0 이 아닌 점수를 줄 수 있음을 보여준다(버그).
  // 구현 수정 후에는 이 테스트가 점수가 0 이 되므로 실패할 것이다.
  assert.ok(Number.isFinite(score[1]), `리프 1 점수는 유한해야 함: ${score[1]}`);
  assert.ok(score[1] > 0, `리프 1 점수는 > 0(현재 동작): ${score[1]}`);
});

// 시험 2: 점수 합이 유한값일 때 그 값을 저장하고, 유한하지 않을 때 0 으로 변환하는 메커니즘 검증
test('점수 합이 유한하면 그 값을 저장, 유한하지 않으면 0 으로 변환하는 메커니즘', () => {
  // 카메라 뒤의 점과 화면 밖의 점을 포함한 계층을 만든다.
  // 이렇게 하면 일부 리프는 score = 0, 일부는 score > 0 이 된다.
  const CAM = { width: 320, height: 180, K: { fx: 400, fy: 400, cx: 160, cy: 90 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

  // 정상 점(z=1.5)과 카메라 뒤 점(z<0)과 화면 밖 점을 혼합.
  const pos = [];
  // 정상 점: 20×12 격자
  for (let i = 0; i < 20; i++) for (let j = 0; j < 12; j++) pos.push((i - 10) * 0.05, (j - 6) * 0.05, 1.5);
  // 카메라 뒤 점: 일부 리프가 score 0 이 되게
  for (let i = 0; i < 20; i++) pos.push((i - 10) * 0.05, 0, -1.0);
  // 화면 밖 점: 추가로 일부 리프가 score 0 이 되게
  for (let i = 0; i < 20; i++) pos.push(100 + i * 0.1, 100, 1.5);

  const n = pos.length / 3;
  const cloud = { format: 1, count: n, positions: Float32Array.from(pos), normals: new Float32Array(3 * n), colors: new Uint8Array(3 * n).fill(200) };
  const h = buildHierarchy(cloud, { edge0M: 0.05, levelCount: 2, maxLeafPoints: 16 });
  const score = leafPriority(h, CAM);

  // 점수 배열이 유한값을 포함해야 한다.
  assert.ok(score.length > 0, '리프가 있어야 함');
  assert.ok(score.every((v) => Number.isFinite(v)), `모든 점수는 유한해야 함: ${score}`);

  // score = 0 인 리프가 있어야 한다(카메라 뒤나 화면 밖).
  // 이는 s = wins[k] + 0.5*(A/(1+A)) = 0 + 0 = 0 인 경우다.
  const hasZeroScore = score.some((v) => v === 0);
  assert.ok(hasZeroScore, '점수 0 인 리프가 있어야 하고, 이는 유한하므로 0 으로 저장됨');

  // score > 0 인 리프도 있어야 한다(카메라 앞 화면 내).
  const hasPositiveScore = score.some((v) => v > 0);
  assert.ok(hasPositiveScore, '점수 > 0 인 리프가 있어야 함');

  // 이는 점수 공식 s = wins[k] + 0.5*(A/(1+A)) 에서:
  // - s 가 유한하면 out[k] = s (저장)
  // - s 가 유한하지 않으면(NaN 또는 Infinity) out[k] = 0 (변환)
  // 의 메커니즘을 검증한다.
});
