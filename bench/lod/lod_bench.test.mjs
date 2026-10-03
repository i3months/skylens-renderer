import test from 'node:test';
import assert from 'node:assert/strict';
import { generate as generateTerrain } from '../../fixtures/scenes/terrain/index.mjs';
import { measureSegmentBytes } from './index.mjs';

// 작은 장면 20k 점으로 단계별 바이트 단조 감소 확인
test('LOD 벤치: 작은 장면(20k 점) 레벨별 바이트 단조 감소', () => {
  const scene = generateTerrain({ seed: 42, count: 20000, format: 1 });
  const cloud = scene.cloud;

  const result = measureSegmentBytes(cloud, {
    edge0M: 64,
    levelCount: 4,
  });

  const { points, bytesByLevel } = result;

  // 기본 검사: 각 레벨에 점이 있어야 함
  assert.ok(points.length === 4, `예상 4개 레벨, 실제 ${points.length}`);
  assert.ok(bytesByLevel.length === 4, '바이트 데이터 4개 필요');

  // 점 수는 감소해야 함(레벨이 높을수록 거침)
  for (let i = 1; i < points.length; i++) {
    assert.ok(
      points[i] <= points[i - 1],
      `레벨 ${i}의 점(${points[i]})이 레벨 ${i - 1}(${points[i - 1]})보다 많음`,
    );
  }

  // 바이트도 감소해야 함(더 적은 점 → 더 작은 자산)
  for (let i = 1; i < bytesByLevel.length; i++) {
    assert.ok(
      bytesByLevel[i] <= bytesByLevel[i - 1],
      `레벨 ${i}의 바이트(${bytesByLevel[i]})가 레벨 ${i - 1}(${bytesByLevel[i - 1]})보다 많음`,
    );
  }

  console.log(`테스트 통과: 점 ${points} / 바이트 ${bytesByLevel}`);
});

// 다른 시드로도 단조성 확인
test('LOD 벤치: 다른 시드(20k 점)도 바이트 단조 감소', () => {
  const seeds = [1, 7, 99];

  for (const seed of seeds) {
    const scene = generateTerrain({ seed, count: 20000, format: 1 });
    const result = measureSegmentBytes(scene.cloud, { levelCount: 4 });

    for (let i = 1; i < result.bytesByLevel.length; i++) {
      assert.ok(
        result.bytesByLevel[i] <= result.bytesByLevel[i - 1],
        `seed ${seed} 레벨 ${i}에서 단조성 위반`,
      );
    }
  }
});

// 커스텀 리듀서 테스트
test('LOD 벤치: 커스텀 리듀서 사용 가능', () => {
  const scene = generateTerrain({ seed: 5, count: 20000, format: 1 });

  let reducerCalled = false;
  const customReducer = (positions, normals, colors, cellSize, boundMin) => {
    reducerCalled = true;
    // 기본 동작: 칸마다 첫 점만
    const selected = new Map();
    const n = positions.length / 3;
    for (let i = 0; i < n; i++) {
      const e = positions[3 * i];
      const n_ = positions[3 * i + 1];
      const cellE = Math.floor((e - boundMin[0]) / cellSize);
      const cellN = Math.floor((n_ - boundMin[1]) / cellSize);
      const cellKey = `${cellE},${cellN}`;
      if (!selected.has(cellKey)) {
        selected.set(cellKey, i);
      }
    }
    const indices = Array.from(selected.values());
    const reducedPositions = new Float32Array(indices.length * 3);
    const reducedNormals = new Float32Array(indices.length * 3);
    const reducedColors = new Uint8Array(indices.length * 3);
    indices.forEach((srcIdx, dstIdx) => {
      for (let a = 0; a < 3; a++) {
        reducedPositions[3 * dstIdx + a] = positions[3 * srcIdx + a];
        reducedNormals[3 * dstIdx + a] = normals[3 * srcIdx + a];
        reducedColors[3 * dstIdx + a] = colors[3 * srcIdx + a];
      }
    });
    return { positions: reducedPositions, normals: reducedNormals, colors: reducedColors };
  };

  const result = measureSegmentBytes(scene.cloud, {
    levelCount: 2,
    reduce: customReducer,
  });

  assert.ok(reducerCalled, '커스텀 리듀서가 호출되지 않음');
  assert.ok(result.bytesByLevel.length === 2);
});
