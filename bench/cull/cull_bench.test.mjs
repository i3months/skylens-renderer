import test from 'node:test';
import assert from 'node:assert/strict';
import { measureCullCost } from './index.mjs';
import { generate as generateTerrain } from '../../fixtures/scenes/terrain/index.mjs';
import { generate as generateLarge } from '../../fixtures/scenes/large/index.mjs';
import { buildHierarchy } from '../../server/lod/hierarchy/index.mjs';
import { boxMayBeVisible } from '../../server/lod/select/view_check.mjs';

// 테스트용 카메라 생성
function createTestCamera(options = {}) {
  const {
    width = 800,
    height = 600,
    fx = 400,
    fy = 400,
    cx = 400,
    cy = 300,
    R = [1, 0, 0, 0, 1, 0, 0, 0, 1],
    t = [0, 0, -10],
  } = options;
  return { width, height, K: { fx, fy, cx, cy }, R, t };
}

test('컬링 비용 측정: 입력 검증 - hierarchy 누락', () => {
  const cameras = [createTestCamera()];
  assert.throws(() => measureCullCost(null, cameras), /cull:/);
});

test('컬링 비용 측정: 입력 검증 - cameras 비어있음', () => {
  const scene = generateTerrain({ seed: 42, count: 10000 });
  const hierarchy = buildHierarchy(scene.cloud, { edge0M: 0.3, levelCount: 2 });
  assert.throws(() => measureCullCost(hierarchy, []), /cull:/);
});

test('컬링 비용 측정: 입력 검증 - repeats 오류', () => {
  const scene = generateTerrain({ seed: 42, count: 10000 });
  const hierarchy = buildHierarchy(scene.cloud, { edge0M: 0.3, levelCount: 2 });
  const cameras = [createTestCamera()];
  assert.throws(() => measureCullCost(hierarchy, cameras, { repeats: 0 }), /cull:/);
  assert.throws(() => measureCullCost(hierarchy, cameras, { repeats: -1 }), /cull:/);
  assert.throws(() => measureCullCost(hierarchy, cameras, { repeats: 1.5 }), /cull:/);
});

test('컬링 비용 측정: 결과 형태 검증(숫자 유한·양수)', () => {
  const scene = generateTerrain({ seed: 42, count: 10000 });
  const hierarchy = buildHierarchy(scene.cloud, { edge0M: 0.3, levelCount: 2 });
  const cameras = [createTestCamera()];

  const stages = {
    frustum: (hierarchy, camera) => {
      const leafCount = hierarchy.octree.leafCount;
      const mask = new Uint8Array(leafCount);
      for (let k = 0; k < leafCount; k++) {
        const level = hierarchy.levels[0];
        const s = level.leafStart[k], se = level.leafStart[k + 1];
        if (s < se) {
          const pos = level.positions;
          const mn = [pos[3 * s], pos[3 * s + 1], pos[3 * s + 2]];
          const mx = [pos[3 * s], pos[3 * s + 1], pos[3 * s + 2]];
          for (let i = s + 1; i < se; i++) {
            mn[0] = Math.min(mn[0], pos[3 * i]);
            mn[1] = Math.min(mn[1], pos[3 * i + 1]);
            mn[2] = Math.min(mn[2], pos[3 * i + 2]);
            mx[0] = Math.max(mx[0], pos[3 * i]);
            mx[1] = Math.max(mx[1], pos[3 * i + 1]);
            mx[2] = Math.max(mx[2], pos[3 * i + 2]);
          }
          mask[k] = boxMayBeVisible(camera, mn, mx) ? 1 : 0;
        }
      }
      return mask;
    },
  };

  const result = measureCullCost(hierarchy, cameras, { stages, repeats: 2 });

  // perViewMs 형태 검증
  assert.ok(typeof result.perViewMs === 'object');
  assert.ok(typeof result.perViewMs.median === 'number');
  assert.ok(typeof result.perViewMs.p95 === 'number');
  assert.ok(typeof result.perViewMs.max === 'number');
  assert.ok(Number.isFinite(result.perViewMs.median) && result.perViewMs.median >= 0);
  assert.ok(Number.isFinite(result.perViewMs.p95) && result.perViewMs.p95 >= 0);
  assert.ok(Number.isFinite(result.perViewMs.max) && result.perViewMs.max >= 0);

  // perStageMs 형태 검증
  assert.ok(typeof result.perStageMs === 'object');
  assert.ok('frustum' in result.perStageMs);
  const frustumStats = result.perStageMs.frustum;
  assert.ok(typeof frustumStats.median === 'number');
  assert.ok(typeof frustumStats.p95 === 'number');
  assert.ok(typeof frustumStats.max === 'number');
  assert.ok(Number.isFinite(frustumStats.median) && frustumStats.median >= 0);
  assert.ok(Number.isFinite(frustumStats.p95) && frustumStats.p95 >= 0);
  assert.ok(Number.isFinite(frustumStats.max) && frustumStats.max >= 0);

  // 통계 일관성: median <= p95 <= max
  assert.ok(result.perViewMs.median <= result.perViewMs.p95);
  assert.ok(result.perViewMs.p95 <= result.perViewMs.max);
  assert.ok(frustumStats.median <= frustumStats.p95);
  assert.ok(frustumStats.p95 <= frustumStats.max);

  console.log(`테스트 통과: perViewMs=${result.perViewMs.median.toFixed(3)}ms, frustum=${frustumStats.median.toFixed(3)}ms`);
});

test('컬링 비용 측정: 느린 단계 스텁(5ms busy-wait) 감지', () => {
  const scene = generateTerrain({ seed: 42, count: 10000 });
  const hierarchy = buildHierarchy(scene.cloud, { edge0M: 0.3, levelCount: 2 });
  const cameras = [createTestCamera()];

  const stages = {
    fast: (hierarchy, camera) => new Uint8Array(hierarchy.octree.leafCount).fill(1),
    slow: (hierarchy, camera) => {
      // 5ms busy-wait (setTimeout 없이)
      const deadline = performance.now() + 5;
      while (performance.now() < deadline);
      return new Uint8Array(hierarchy.octree.leafCount).fill(1);
    },
  };

  const result = measureCullCost(hierarchy, cameras, { stages, repeats: 2 });

  // slow 단계가 5ms 이상으로 감지되어야 함
  assert.ok(result.perStageMs.slow.median >= 4.5, `느린 단계 median=${result.perStageMs.slow.median}ms, 5ms 이상 예상`);
  console.log(`테스트 통과: slow 단계=${result.perStageMs.slow.median.toFixed(3)}ms 감지됨`);
});

test('컬링 비용 측정: 단계 이름 일치 검증', () => {
  const scene = generateTerrain({ seed: 42, count: 10000 });
  const hierarchy = buildHierarchy(scene.cloud, { edge0M: 0.3, levelCount: 2 });
  const cameras = [createTestCamera()];

  const stageNames = ['frustum', 'backface', 'distance'];
  const stages = {};
  for (const name of stageNames) {
    stages[name] = (hierarchy, camera) => new Uint8Array(hierarchy.octree.leafCount).fill(1);
  }

  const result = measureCullCost(hierarchy, cameras, { stages, repeats: 1 });

  // 결과의 perStageMs 에 모든 단계 이름이 있어야 함
  for (const name of stageNames) {
    assert.ok(name in result.perStageMs, `단계 "${name}" 이 perStageMs 에 없음`);
  }

  // 정확히 그 이름들만 있어야 함
  assert.deepEqual(Object.keys(result.perStageMs).sort(), stageNames.sort());

  console.log(`테스트 통과: 단계 이름 확인 [${stageNames.join(', ')}]`);
});

// 실제 측정: 작은 장면
test('컬링 비용 측정: 작은 장면(20k 점) 실측', () => {
  const scene = generateTerrain({ seed: 42, count: 20000 });
  const hierarchy = buildHierarchy(scene.cloud, { edge0M: 0.3, levelCount: 2 });
  const leafCount = hierarchy.octree.leafCount;

  // 테스트 카메라 3개
  const cameras = [
    createTestCamera({ t: [0, 0, -10] }),
    createTestCamera({ t: [10, 10, -15] }),
    createTestCamera({ t: [-10, -10, -20] }),
  ];

  const stages = {
    frustum: (hierarchy, camera) => {
      const mask = new Uint8Array(leafCount).fill(1);
      for (let k = 0; k < leafCount; k++) {
        const level = hierarchy.levels[0];
        const s = level.leafStart[k], se = level.leafStart[k + 1];
        if (s < se) {
          const pos = level.positions;
          const mn = [pos[3 * s], pos[3 * s + 1], pos[3 * s + 2]];
          const mx = [pos[3 * s], pos[3 * s + 1], pos[3 * s + 2]];
          for (let i = s + 1; i < se; i++) {
            mn[0] = Math.min(mn[0], pos[3 * i]); mn[1] = Math.min(mn[1], pos[3 * i + 1]); mn[2] = Math.min(mn[2], pos[3 * i + 2]);
            mx[0] = Math.max(mx[0], pos[3 * i]); mx[1] = Math.max(mx[1], pos[3 * i + 1]); mx[2] = Math.max(mx[2], pos[3 * i + 2]);
          }
          mask[k] = boxMayBeVisible(camera, mn, mx) ? 1 : 0;
        }
      }
      return mask;
    },
  };

  const result = measureCullCost(hierarchy, cameras, { stages, repeats: 3 });

  console.log(`\n측정 결과(20k 점, 리프=${leafCount}, 카메라=3, 반복=3):`);
  console.log(`  perViewMs: median=${result.perViewMs.median.toFixed(3)}ms, p95=${result.perViewMs.p95.toFixed(3)}ms, max=${result.perViewMs.max.toFixed(3)}ms`);
  console.log(`  frustum: median=${result.perStageMs.frustum.median.toFixed(3)}ms, p95=${result.perStageMs.frustum.p95.toFixed(3)}ms, max=${result.perStageMs.frustum.max.toFixed(3)}ms`);

  // 기본 검증: 메트릭이 있어야 함
  assert.ok(result.perViewMs.median > 0);
  assert.ok(result.perStageMs.frustum.median > 0);
});

// 실제 측정: 큰 장면
test('컬링 비용 측정: 큰 장면 측정', () => {
  const scene = generateLarge({ seed: 42, count: 100000 });
  const hierarchy = buildHierarchy(scene.cloud, { edge0M: 0.5, levelCount: 2 });
  const leafCount = hierarchy.octree.leafCount;

  const cameras = [createTestCamera(), createTestCamera({ t: [50, 20, -30] })];

  const stages = {
    frustum: (hierarchy, camera) => {
      const mask = new Uint8Array(leafCount).fill(1);
      for (let k = 0; k < leafCount; k++) {
        const level = hierarchy.levels[0];
        const s = level.leafStart[k], se = level.leafStart[k + 1];
        if (s < se) {
          const pos = level.positions;
          const mn = [pos[3 * s], pos[3 * s + 1], pos[3 * s + 2]];
          const mx = [pos[3 * s], pos[3 * s + 1], pos[3 * s + 2]];
          for (let i = s + 1; i < se; i++) {
            mn[0] = Math.min(mn[0], pos[3 * i]); mn[1] = Math.min(mn[1], pos[3 * i + 1]); mn[2] = Math.min(mn[2], pos[3 * i + 2]);
            mx[0] = Math.max(mx[0], pos[3 * i]); mx[1] = Math.max(mx[1], pos[3 * i + 1]); mx[2] = Math.max(mx[2], pos[3 * i + 2]);
          }
          mask[k] = boxMayBeVisible(camera, mn, mx) ? 1 : 0;
        }
      }
      return mask;
    },
  };

  const result = measureCullCost(hierarchy, cameras, { stages, repeats: 5 });

  console.log(`\n측정 결과(100k 점, 리프=${leafCount}, 카메라=2, 반복=5):`);
  console.log(`  perViewMs: median=${result.perViewMs.median.toFixed(3)}ms, p95=${result.perViewMs.p95.toFixed(3)}ms, max=${result.perViewMs.max.toFixed(3)}ms`);
  console.log(`  frustum: median=${result.perStageMs.frustum.median.toFixed(3)}ms, p95=${result.perStageMs.frustum.p95.toFixed(3)}ms, max=${result.perStageMs.frustum.max.toFixed(3)}ms`);

  assert.ok(result.perViewMs.median > 0);
  assert.ok(result.perStageMs.frustum.median > 0);
});
