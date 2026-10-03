// F-128 ②: orderChunks 의 순위는 mask 에 의존하지 않는다 — mask 로 고른 리프의 순서 = 전체 순서에서 그 리프만 거른 것.
// 가려짐 점수는 마스크 0 리프까지 깊이 버퍼에 그려서 구하므로(mask 0 리프를 건너뛰면 뒤쪽 리프의 점수가 올라 순위가 바뀐다),
// 마스크 0 리프를 투영에서 건너뛰는 최적화는 같은 출력을 보장하지 못한다. 이 시험은 그 불변식을 고정한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHierarchy } from '../../lod/select/index.mjs';
import { orderChunks, leafPriority } from './index.mjs';

const CAM = { width: 320, height: 180, K: { fx: 400, fy: 400, cx: 160, cy: 90 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
// 앞층(z=1.2)은 뒤층(z=1.7)을 일부만 가린다: 앞층은 화면 왼쪽 절반만 덮는다.
const pos = [];
for (let i = 0; i < 40; i++) for (let j = 0; j < 24; j++) {
  pos.push((i - 20) * 0.025, (j - 12) * 0.025, 1.7); // 뒤층 전체
  if (i < 20) pos.push((i - 20) * 0.025, (j - 12) * 0.025, 1.2); // 앞층 왼쪽
}
const n = pos.length / 3;
const cloud = { format: 1, count: n, positions: Float32Array.from(pos), normals: new Float32Array(3 * n), colors: new Uint8Array(3 * n).fill(200) };
const h = buildHierarchy(cloud, { edge0M: 0.05, levelCount: 2, maxLeafPoints: 16 });
const L = h.octree.leafCount;
const all = new Uint8Array(L).fill(1);

test('orderChunks: 마스크 부분집합의 순서 = 전체 순서를 부분집합으로 거른 것 (여러 마스크)', () => {
  const full = orderChunks(h, CAM, all);
  assert.equal(full.length, L);
  const score = leafPriority(h, CAM);
  assert.ok(new Set(score).size > 3, '점수가 다양해야 시험이 의미 있음');
  for (const mod of [2, 3, 5, 7]) {
    const mask = new Uint8Array(L);
    for (let k = 0; k < L; k++) mask[k] = k % mod === 0 ? 1 : 0;
    const got = Array.from(orderChunks(h, CAM, mask));
    const want = Array.from(full).filter((k) => mask[k] === 1);
    assert.deepEqual(got, want, `mod ${mod}`);
  }
});

test('orderChunks: 점수는 mask 와 무관하게 leafPriority 로 정해진다(마스크 0 리프도 가림막으로 남는다)', () => {
  const score = leafPriority(h, CAM);
  const mask = new Uint8Array(L);
  for (let k = 0; k < L; k++) mask[k] = score[k] > 0 ? 1 : 0;
  const got = Array.from(orderChunks(h, CAM, mask));
  const want = Array.from({ length: L }, (_, k) => k).filter((k) => mask[k]).sort((a, b) => score[b] - score[a] || a - b);
  assert.deepEqual(got, want);
});
