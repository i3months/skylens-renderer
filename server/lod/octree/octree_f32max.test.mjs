// F-112 ②: 점이 Float32 최댓값 근처라 정육면체 루트가 범위를 넘어도 상자는 유한하고 빌더의 계층이 검사를 통과해야 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOctree } from './index.mjs';
import { buildHierarchy, selectLevels, materialize, assertHierarchyInput } from '../select/index.mjs';
import { viewpointToCamera } from '../../../tools/render_views/index.mjs';

const F32_MAX = 3.4028234663852886e38;
const mk = (flat) => {
  const n = flat.length / 3;
  return { format: 1, count: n, positions: Float32Array.from(flat), normals: new Float32Array(3 * n), colors: new Uint8Array(3 * n) };
};
const CASES = {
  '두 점 (0,2e38,1)·(2e38,3e38,1)': [0, 2e38, 1, 2e38, 3e38, 1],
  '음의 방향 (0,-2e38,1)·(-2e38,-3e38,1)': [0, -2e38, 1, -2e38, -3e38, 1],
  '최댓값 끝 점 ±F32_MAX': [F32_MAX, F32_MAX, F32_MAX, -F32_MAX, -F32_MAX, -F32_MAX],
};
const camera = viewpointToCamera({ eye: [0, 0, -10], target: [0, 0, 0], up: [0, 1, 0], fov_y_deg: 50, width: 64, height: 48 });

for (const [name, pts] of Object.entries(CASES)) {
  test(`${name}: 상자가 모두 유한하고 점이 리프 상자 안에 든다`, () => {
    const cloud = mk(pts);
    const t = buildOctree(cloud, { maxLeafPoints: 1 });
    for (const v of t.boxMin) assert.ok(Number.isFinite(v));
    for (const v of t.boxMax) assert.ok(Number.isFinite(v));
    let inside = 0;
    for (let i = 0; i < t.nodeCount; i++) {
      const k = t.leafIndex[i];
      if (k < 0) continue;
      for (let q = t.leafStart[k]; q < t.leafStart[k + 1]; q++) {
        const p = t.order[q];
        for (let a = 0; a < 3; a++) {
          const x = cloud.positions[3 * p + a];
          assert.ok(t.boxMin[3 * i + a] <= x && x <= t.boxMax[3 * i + a], `점 ${p} 축 ${a} 가 상자 밖`);
        }
        inside++;
      }
    }
    assert.equal(inside, cloud.count);
  });

  test(`${name}: buildHierarchy 결과를 selectLevels·materialize 가 거부하지 않는다`, () => {
    const h = buildHierarchy(mk(pts), { edge0M: 0.5, levelCount: 3, maxLeafPoints: 1 });
    assert.doesNotThrow(() => assertHierarchyInput(h));
    let sel;
    assert.doesNotThrow(() => { sel = selectLevels(h, camera, { thresholdPx: 0.5 }); });
    assert.doesNotThrow(() => materialize(h, sel));
  });
}
