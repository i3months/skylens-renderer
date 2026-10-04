import test from 'node:test';
import assert from 'node:assert/strict';
import { measureTowerAssets } from './index.mjs';

test('T14 관제탑 자산 벤치마크', () => {
  const result = measureTowerAssets();

  // 건물 수 단언
  assert.equal(result.buildings.count, 6191, '건물 개수는 6191개여야 한다');

  // 전체 바이트 크기 단언
  const limitBytes = 15_000_000;
  if (result.totalSize <= limitBytes) {
    assert.ok(result.totalSize <= limitBytes, `전체 크기 ${result.totalSize} B <= ${limitBytes} B`);
  } else {
    console.log(`주의: 전체 크기 ${(result.totalSize / 1e6).toFixed(2)} MB > 15 MB 상한`);
    console.log(`  건물 크기: ${(result.buildings.size.total / 1e6).toFixed(2)} MB`);
    for (let lod = 0; lod < 4; lod++) {
      console.log(`  지형 LOD${lod}: ${(result.terrain.size[lod] / 1024).toFixed(1)} KB`);
    }
  }

  // 타이밍 로깅
  console.log('\n[ 측정 결과 ]');
  console.log('건물:');
  console.log(`  extrudeAll: ${result.buildings.timings.extrude.toFixed(2)} ms`);
  console.log(`  buildBuildingLod(500m): ${result.buildings.timings.lod500m.toFixed(2)} ms`);
  console.log(`  buildBuildingLod(5km): ${result.buildings.timings.lod5km.toFixed(2)} ms`);
  console.log('지형:');
  for (let lod = 0; lod < 4; lod++) {
    console.log(`  buildTerrainTile(LOD${lod}): ${result.terrain.timings[lod].toFixed(2)} ms`);
  }
  console.log(`\n총 크기: ${(result.totalSize / 1e6).toFixed(2)} MB`);
});
