// F-162③/F-164①: NaN 좌표를 가진 리프의 점수 계산 검증.
// 계약(leaf_check)상 NaN 상자 좌표는 구조 오류가 아니라 단계별 정책대로 통과한다. leafPriority 는 단일 NaN 좌표가 있어도
// clippedArea 가 나머지 꼭짓점의 유한 투영으로 면적을 계산하므로 점수는 유한하다(NaN 이 점수로 새지 않는다).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHierarchy } from '../../lod/select/index.mjs';
import { leafPriority } from './index.mjs';

// 시험 1: 리프 k 의 노드(leafIndex.indexOf(k))의 boxMin.x 를 NaN 으로 바꾸면 그 리프 점수가 바뀌되 유한하다.
test('리프 노드의 boxMin.x=NaN 이면 그 리프 점수가 바뀌지만 유한하다', () => {
  const CAM = { width: 320, height: 180, K: { fx: 400, fy: 400, cx: 160, cy: 90 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

  // 20×12 격자 점 240개: 중심 (0, 0, 1.5).
  const pos = [];
  for (let i = 0; i < 20; i++) for (let j = 0; j < 12; j++) pos.push((i - 10) * 0.05, (j - 6) * 0.05, 1.5);
  const n = pos.length / 3;
  const cloud = { format: 1, count: n, positions: Float32Array.from(pos), normals: new Float32Array(3 * n), colors: new Uint8Array(3 * n).fill(200) };
  const h = buildHierarchy(cloud, { edge0M: 0.05, levelCount: 2, maxLeafPoints: 16 });

  const before = leafPriority(h, CAM);
  const k = 1;
  assert.ok(k < h.octree.leafCount, '리프 1 이 있어야 함');
  // nd=1 같은 번호는 내부 노드일 수 있으므로(leafIndex[nd] = -1) 리프 k 의 노드를 leafIndex 에서 찾는다.
  const nd = Array.from(h.octree.leafIndex).indexOf(k);
  assert.ok(nd >= 0, `리프 ${k} 의 노드를 찾아야 함`);

  const bmin = Float32Array.from(h.octree.boxMin); // 새 typed array: 검사 캐시가 다시 검사하게 한다
  bmin[3 * nd] = NaN;
  const bad = { ...h, octree: { ...h.octree, boxMin: bmin } };
  const after = leafPriority(bad, CAM);

  assert.ok(Number.isFinite(before[k]) && Number.isFinite(after[k]), `점수는 유한해야 함: ${before[k]} → ${after[k]}`);
  assert.notEqual(after[k], before[k], `NaN 주입 전후 리프 ${k} 점수가 달라야 함(상자가 실제로 쓰임): ${before[k]}`);
  // 다른 리프는 영향받지 않는다.
  for (let i = 0; i < before.length; i++) if (i !== k) assert.equal(after[i], before[i], `리프 ${i} 점수는 그대로여야 함`);
});

// 시험 2: 카메라 뒤·화면 밖 리프는 0, 화면 안 리프는 양수, 모든 점수 유한.
// 참고: index.mjs 의 `Number.isFinite(s) ? s : 0` 가드는 유효한 카메라(퇴화 검사 통과)·상자(±Infinity 거부)에서는 닿지 않는 방어 코드다.
test('카메라 뒤·화면 밖 리프는 점수 0, 화면 안 리프는 양수이며 모든 점수는 유한', () => {
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
  assert.ok(hasZeroScore, '점수 0 인 리프가 있어야 하고, 모든 점수가 유한');

  // score > 0 인 리프도 있어야 한다(카메라 앞 화면 내).
  const hasPositiveScore = score.some((v) => v > 0);
  assert.ok(hasPositiveScore, '점수 > 0 인 리프가 있어야 함');
});
