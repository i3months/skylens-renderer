// LOD 벤치마크: 구간(점군 전체) 단계별 자산 크기 집계.
// 점군을 server/lod/hierarchy 로 단계별 축소하고, 단계마다 64 m 타일(x,z 기준)별로 팩해 바이트를 합산한다.
// 타일 하나에 점이 많아 한 조각에 못 담으면 packChunk 가 던지는 오류를 그대로 올린다(0 바이트로 숨기지 않는다).
import { writeFileSync } from 'node:fs';
import { packChunk } from '../../server/asset/pack/index.mjs';
import { FORMAT_POINT27 } from '../../contracts/asset/index.mjs';
import { buildHierarchy } from '../../server/lod/hierarchy/index.mjs';

const TILE_SIZE = 64;

/**
 * @param {Object} cloud Point27Cloud
 * @param {Object} opts
 * @param {number} [opts.edge0M=0.05] 단계 0 의 칸 한 변(m). 단계 l 은 edge0M·2^l
 * @param {number} [opts.levelCount=4]
 * @param {Object} [opts.anchor]
 * @returns {{points: number[], bytesByLevel: number[], chunksByLevel: number[]}}
 */
export function measureSegmentBytes(cloud, opts = {}) {
  const { edge0M = 0.05, levelCount = 4, anchor = { lat: 0, lon: 0, alt: 0 }, maxLeafPoints = 4096 } = opts;
  const h = buildHierarchy(cloud, { edge0M, levelCount, maxLeafPoints });
  const points = [], bytesByLevel = [], chunksByLevel = [];
  for (const lv of h.levels) {
    const tiles = new Map();
    for (let s = 0; s < lv.count; s++) {
      const i = lv.indices[s];
      const key = `${Math.floor(cloud.positions[3 * i] / TILE_SIZE)},${Math.floor(cloud.positions[3 * i + 2] / TILE_SIZE)}`;
      let arr = tiles.get(key);
      if (!arr) tiles.set(key, (arr = []));
      arr.push(s);
    }
    let bytes = 0;
    for (const list of tiles.values()) {
      const m = list.length;
      const positions = new Float32Array(3 * m), normals = new Float32Array(3 * m), colors = new Uint8Array(3 * m);
      list.forEach((s, d) => {
        positions.set(cloud.positions.subarray(3 * lv.indices[s], 3 * lv.indices[s] + 3), 3 * d);
        normals.set(lv.normals.subarray(3 * s, 3 * s + 3), 3 * d);
        colors.set(lv.colors.subarray(3 * s, 3 * s + 3), 3 * d);
      });
      bytes += packChunk({ format: FORMAT_POINT27, segmentId: 0, level: Math.min(lv.level, 3), lod: 0, chunkIndex: 0, anchor, fields: { positions, normals, colors } }).length;
    }
    points.push(lv.count);
    bytesByLevel.push(bytes);
    chunksByLevel.push(tiles.size);
  }
  return { points, bytesByLevel, chunksByLevel };
}

/**
 * 측정 결과를 표 형식으로 콘솔에 출력.
 * @param {{points: number[], bytesByLevel: number[]}} result
 * @param {number} [targetBytes] 목표 바이트(참고용, 기본 3MB)
 */
export function printTable(result, targetBytes = 3e6) {
  const { points, bytesByLevel } = result;
  const MB = (b) => (b / 1e6).toFixed(3);

  console.log('\n레벨별 자산 크기 측정:');
  console.log(
    ['Lv', '점', 'Bytes', '크기(MB)', '누적(MB)', '목표 대비'].join('\t'),
  );

  let cumulative = 0;
  bytesByLevel.forEach((bytes, lv) => {
    cumulative += bytes;
    const pct = ((cumulative / targetBytes) * 100).toFixed(1);
    console.log(
      [
        lv,
        points[lv],
        bytes.toLocaleString(),
        MB(bytes),
        MB(cumulative),
        `${pct}%`,
      ].join('\t'),
    );
  });

  console.log(`\n최종 누적 크기: ${MB(cumulative)} MB (목표: ${MB(targetBytes)} MB)`);
}

/**
 * 결과를 JSON으로 파일에 저장.
 * @param {{points: number[], bytesByLevel: number[]}} result
 * @param {string} filePath
 */
export function writeJSON(result, filePath) {
  const data = {
    timestamp: new Date().toISOString(),
    points: result.points,
    bytesByLevel: result.bytesByLevel,
    totalBytes: result.bytesByLevel.reduce((a, b) => a + b, 0),
  };
  writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`\nJSON 저장: ${filePath}`);
}
