import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOctree } from './index.mjs';
import { generate } from '../../../fixtures/scenes/terrain/index.mjs';

const mk = (pts) => {
  const n = pts.length;
  const positions = new Float32Array(3 * n);
  pts.forEach((p, i) => positions.set(p, 3 * i));
  return { format: 1, count: n, positions, normals: new Float32Array(3 * n), colors: new Uint8Array(3 * n) };
};

const corners = () => {
  const pts = [];
  for (let z = 0; z < 2; z++) for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) pts.push([10 * x, 10 * y, 10 * z]);
  return pts;
};

// 구조 불변식 전부: 순열, 리프 구간 분할, 리프 상자 포함, 자식 연속·BFS, 리프 번호 순서
function checkInvariants(cloud, t, { maxLeafPoints, maxDepth = 12 }) {
  const n = cloud.count;
  assert.equal(t.order.length, n);
  const seen = new Uint8Array(n);
  for (const p of t.order) { assert.ok(p < n); seen[p]++; }
  assert.ok(seen.every((c) => c === 1), 'order 는 0..n-1 의 순열');
  assert.equal(t.leafStart.length, t.leafCount + 1);
  assert.equal(t.leafStart[0], 0);
  assert.equal(t.leafStart[t.leafCount], n);
  for (let k = 0; k < t.leafCount; k++) assert.ok(t.leafStart[k] <= t.leafStart[k + 1]);
  let nextLeaf = 0;
  const depth = new Int32Array(t.nodeCount);
  for (let i = 0; i < t.nodeCount; i++) {
    const fc = t.firstChild[i], cc = t.childCount[i];
    if (fc < 0) {
      assert.equal(cc, 0);
      assert.equal(t.leafIndex[i], nextLeaf++, '리프 번호는 노드 번호 순');
      const k = t.leafIndex[i];
      for (let q = t.leafStart[k]; q < t.leafStart[k + 1]; q++) {
        const p = t.order[q];
        for (let a = 0; a < 3; a++) {
          const v = cloud.positions[3 * p + a];
          assert.ok(v >= t.boxMin[3 * i + a] && v <= t.boxMax[3 * i + a], `점 ${p} 가 리프 ${k} 상자 밖`);
        }
      }
      if (t.leafStart[k + 1] - t.leafStart[k] > maxLeafPoints) assert.equal(depth[i], maxDepth, '초과 리프는 깊이 한계에서만');
    } else {
      assert.equal(t.leafIndex[i], -1);
      assert.ok(cc >= 1 && cc <= 8);
      assert.ok(fc > i, '자식 번호는 부모보다 큼');
      for (let c = fc; c < fc + cc; c++) {
        depth[c] = depth[i] + 1;
        for (let a = 0; a < 3; a++) { // 자식 상자는 부모 상자 안
          assert.ok(t.boxMin[3 * c + a] >= t.boxMin[3 * i + a] && t.boxMax[3 * c + a] <= t.boxMax[3 * i + a]);
        }
      }
    }
  }
  assert.equal(nextLeaf, t.leafCount);
  // 자식 구간이 겹치지 않고 1..nodeCount-1 을 빈틈없이 덮음
  let expected = 1;
  for (let i = 0; i < t.nodeCount; i++) if (t.childCount[i]) { assert.equal(t.firstChild[i], expected); expected += t.childCount[i]; }
  assert.equal(expected, t.nodeCount);
}

test('점 8개 코너, maxLeafPoints=1: 노드 9, 리프 8, 자식 순서는 x+2y+4z', () => {
  const c = mk(corners());
  const t = buildOctree(c, { maxLeafPoints: 1 });
  assert.equal(t.nodeCount, 9);
  assert.equal(t.leafCount, 8);
  assert.equal(t.firstChild[0], 1);
  assert.equal(t.childCount[0], 8);
  assert.deepEqual([...t.leafIndex], [-1, 0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual([...t.order], [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual([...t.leafStart], [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([...t.boxMin.subarray(0, 3)], [0, 0, 0]);
  assert.deepEqual([...t.boxMax.subarray(0, 3)], [10, 10, 10]);
  assert.deepEqual([...t.boxMin.subarray(3, 6)], [0, 0, 0]); // 첫 자식 = 코너 (0,0,0)
  assert.deepEqual([...t.boxMax.subarray(3, 6)], [5, 5, 5]);
  assert.deepEqual([...t.boxMin.subarray(24, 27)], [5, 5, 5]); // 마지막 자식 = 코너 (10,10,10)
  assert.deepEqual([...t.boxMax.subarray(24, 27)], [10, 10, 10]);
  checkInvariants(c, t, { maxLeafPoints: 1 });
});

test('중심 좌표에 놓인 점은 상위 칸(>=)에 든다', () => {
  const c = mk([[0, 0, 0], [10, 10, 10], [5, 5, 5]]);
  const t = buildOctree(c, { maxLeafPoints: 1 });
  // 루트 자식: 칸 0 = {점 0}(노드 1), 칸 7 = {점 1, 2}(노드 2, 상자 [5,10]). 노드 2 는 중심 7.5 에서 점 2(아래)와 점 1(위)로 갈라짐.
  assert.deepEqual([...t.childCount], [2, 0, 2, 0, 0]);
  assert.equal(t.nodeCount, 5);
  assert.deepEqual([...t.order], [0, 2, 1]);
  assert.deepEqual([...t.boxMin.subarray(6, 9)], [5, 5, 5]);
  checkInvariants(c, t, { maxLeafPoints: 1 });
});

test('점 수 이하의 한도면 루트가 리프, 한 점 적으면 분할', () => {
  const c = mk([[0, 0, 0], [1, 2, 3], [4, 5, 6]]);
  const t = buildOctree(c, { maxLeafPoints: 3 });
  assert.equal(t.nodeCount, 1);
  assert.equal(t.leafCount, 1);
  assert.equal(t.firstChild[0], -1);
  assert.equal(t.leafIndex[0], 0);
  assert.deepEqual([...t.leafStart], [0, 3]);
  assert.ok(buildOctree(c, { maxLeafPoints: 2 }).nodeCount > 1);
});

test('코너 8개 + 안쪽 점 (1,1,1): 손으로 센 노드 13, 리프 9', () => {
  // (1,1,1) 은 코너 (0,0,0) 과 깊이 1..3 에서 같은 칸에 있다(칸 한 변 5, 2.5, 1.25 → 중심 2.5, 1.25, 0.625 보다
  // 깊이 2 까지는 둘 다 아래, 깊이 3 노드(한 변 1.25, 중심 0.625)에서 0 은 아래, 1 은 위로 갈라진다).
  // 깊이별 노드: 0:1, 1:8, 2:1, 3:1, 4:2 → 13. 리프: 깊이 1 의 7개 + 깊이 4 의 2개 = 9.
  const c = mk([...corners(), [1, 1, 1]]);
  const t = buildOctree(c, { maxLeafPoints: 1 });
  assert.equal(t.nodeCount, 13);
  assert.equal(t.leafCount, 9);
  assert.deepEqual([...t.childCount], [8, 1, 0, 0, 0, 0, 0, 0, 0, 1, 2, 0, 0]);
  assert.equal(t.childCount[0], 8);
  assert.equal(t.childCount.reduce((a, b) => a + b, 0), 12); // 루트 외 모든 노드는 어떤 부모의 자식
  // BFS: 노드 1..8 이 깊이 1, 노드 9 = 깊이 2, 10 = 깊이 3, 11..12 = 깊이 4
  assert.equal(t.firstChild[1], 9);
  assert.equal(t.childCount[1], 1);
  assert.equal(t.firstChild[9], 10);
  assert.equal(t.childCount[9], 1);
  assert.equal(t.firstChild[10], 11);
  assert.equal(t.childCount[10], 2);
  assert.equal(t.leafIndex[11], 7);
  assert.equal(t.leafIndex[12], 8);
  assert.deepEqual([...t.order.subarray(7, 9)], [0, 8]);
  checkInvariants(c, t, { maxLeafPoints: 1 });
});

test('250k 지형: 모든 리프가 maxLeafPoints 이하이고 불변식 성립', () => {
  const { cloud } = generate({ count: 250000 });
  const opts = { maxLeafPoints: 4096, maxDepth: 12 };
  const t = buildOctree(cloud, opts);
  checkInvariants(cloud, t, opts);
  let maxLeaf = 0;
  for (let k = 0; k < t.leafCount; k++) maxLeaf = Math.max(maxLeaf, t.leafStart[k + 1] - t.leafStart[k]);
  assert.ok(maxLeaf <= 4096, `최대 리프 점 수 ${maxLeaf}`);
  assert.ok(t.leafCount > 8, '실제로 분할됨');
  // 더 작은 한도에서도 성립하고, 한도가 작을수록 리프가 늘어난다
  const t2 = buildOctree(cloud, { maxLeafPoints: 512 });
  checkInvariants(cloud, t2, { maxLeafPoints: 512 });
  let max2 = 0;
  for (let k = 0; k < t2.leafCount; k++) max2 = Math.max(max2, t2.leafStart[k + 1] - t2.leafStart[k]);
  assert.ok(max2 <= 512);
  assert.ok(t2.leafCount > t.leafCount);
});

test('maxDepth 도달 시 한도를 넘어도 리프', () => {
  const { cloud } = generate({ count: 5000 });
  const t = buildOctree(cloud, { maxLeafPoints: 1, maxDepth: 2 });
  checkInvariants(cloud, t, { maxLeafPoints: 1, maxDepth: 2 });
  assert.ok(t.nodeCount <= 1 + 8 + 64);
  let big = 0;
  for (let k = 0; k < t.leafCount; k++) if (t.leafStart[k + 1] - t.leafStart[k] > 1) big++;
  assert.ok(big > 0);
  assert.equal(buildOctree(cloud, { maxLeafPoints: 1, maxDepth: 0 }).nodeCount, 1); // 깊이 0 이면 루트만
});

test('같은 위치 점 1만 개: 종료하고 깊이 한계까지 한 갈래', () => {
  const c = mk(Array.from({ length: 10000 }, () => [3.5, -2, 7]));
  const t = buildOctree(c, { maxLeafPoints: 16, maxDepth: 12 });
  assert.equal(t.leafCount, 1);
  assert.equal(t.nodeCount, 13); // 깊이 0..12 한 갈래
  assert.equal(t.leafStart[1], 10000);
  checkInvariants(c, t, { maxLeafPoints: 16, maxDepth: 12 });
  // 두 곳에 5000 개씩: 루트에서 갈라진 뒤 각자 한 갈래(1 + 2·12)
  const c2 = mk(Array.from({ length: 10000 }, (_, i) => (i % 2 ? [0, 0, 0] : [4, 4, 4])));
  const t2 = buildOctree(c2, { maxLeafPoints: 16 });
  assert.equal(t2.leafCount, 2);
  assert.equal(t2.nodeCount, 25);
  checkInvariants(c2, t2, { maxLeafPoints: 16 });
});

test('빈 입력: 빈 리프 하나', () => {
  const t = buildOctree(mk([]));
  assert.equal(t.nodeCount, 1);
  assert.equal(t.leafCount, 1);
  assert.equal(t.order.length, 0);
  assert.deepEqual([...t.leafStart], [0, 0]);
  assert.equal(t.firstChild[0], -1);
  assert.equal(t.leafIndex[0], 0);
});

test('점 1개: 루트 리프, 상자가 점을 포함하고 퇴화하지 않음', () => {
  const c = mk([[1.5, -2.25, 100.1]]);
  const t = buildOctree(c, { maxLeafPoints: 1 });
  assert.equal(t.nodeCount, 1);
  assert.deepEqual([...t.order], [0]);
  assert.deepEqual([...t.leafStart], [0, 1]);
  for (let a = 0; a < 3; a++) assert.ok(t.boxMin[a] < t.boxMax[a]);
  checkInvariants(c, t, { maxLeafPoints: 1 });
});

test('비유한 좌표와 잘못된 옵션을 거부', () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    const c = mk([[0, 0, 0], [1, 1, 1]]);
    c.positions[4] = bad;
    assert.throws(() => buildOctree(c), /lod:/);
  }
  const c = mk([[0, 0, 0]]);
  for (const o of [{ maxLeafPoints: 0 }, { maxLeafPoints: 1.5 }, { maxLeafPoints: NaN }, { maxDepth: -1 }, { maxDepth: 2.5 }]) assert.throws(() => buildOctree(c, o), /lod:/);
  assert.throws(() => buildOctree({ ...c, format: 2 }), /lod:/);
  assert.throws(() => buildOctree(null), /lod:/);
});

test('결정적이고 입력을 바꾸지 않는다', () => {
  const { cloud } = generate({ count: 20000 });
  const before = cloud.positions.slice();
  const a = buildOctree(cloud, { maxLeafPoints: 100 });
  const b = buildOctree(cloud, { maxLeafPoints: 100 });
  for (const key of Object.keys(a)) assert.deepEqual(a[key], b[key], key);
  assert.deepEqual(cloud.positions, before);
});

test('Float32 로 정확히 표현되지 않는 좌표도 상자 안에 남는다(바깥쪽 반올림)', () => {
  const c = mk([[0.1, 0.2, 0.3], [0.7, 0.9, 1.1], [0.3, 0.1, 0.7], [0.61, 0.33, 0.9], [1.1, 0.7, 0.1]]);
  for (const m of [1, 2]) checkInvariants(c, buildOctree(c, { maxLeafPoints: m }), { maxLeafPoints: m });
});
