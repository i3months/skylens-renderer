// LOD 벤치마크: 구간(점군 전체) 단계별 자산 크기 집계.
// 점군을 server/lod/hierarchy 로 단계별 축소하고, 단계마다 64 m 타일(x,z 기준)별로 팩해 바이트를 합산한다.
// 타일 하나에 점이 많아 한 조각에 못 담으면 packChunk 가 던지는 오류를 그대로 올린다(0 바이트로 숨기지 않는다).
import { writeFileSync } from 'node:fs';
import { packChunk } from '../../server/asset/pack/index.mjs';
import { FORMAT_POINT27 } from '../../contracts/asset/index.mjs';
import { buildHierarchy } from '../../server/lod/hierarchy/index.mjs';
import { materialize } from '../../server/lod/select/index.mjs';

const TILE_SIZE = 64;
const TILE_KEY_SPAN = 2 ** 22;
const TILE_KEY_HALF = 2 ** 21;

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
    // 타일 키는 정수(tx·2^22 + tz). 문자열 키 Map 은 점마다 문자열을 만들어 느렸다. 값(타일 구성·순서)은 같다.
    const tiles = new Map();
    const lp = lv.positions; // 단계별 대표점 위치(indices 순서, hierarchy 가 미리 담음)
    for (let s = 0; s < lv.count; s++) {
      const tx = Math.floor(lp[3 * s] / TILE_SIZE), tz = Math.floor(lp[3 * s + 2] / TILE_SIZE);
      if (!(Math.abs(tz) < TILE_KEY_HALF) || !(Math.abs(tx) < 2 ** 30)) throw new Error(`lod bench: 타일 좌표 범위 밖 (${tx},${tz})`);
      const key = tx * TILE_KEY_SPAN + tz;
      let arr = tiles.get(key);
      if (!arr) tiles.set(key, (arr = []));
      arr.push(s);
    }
    let bytes = 0;
    for (const list of tiles.values()) {
      const m = list.length;
      const positions = new Float32Array(3 * m), normals = new Float32Array(3 * m), colors = new Uint8Array(3 * m);
      for (let d = 0; d < m; d++) {
        const s = list[d];
        positions[3 * d] = lp[3 * s]; positions[3 * d + 1] = lp[3 * s + 1]; positions[3 * d + 2] = lp[3 * s + 2];
        normals[3 * d] = lv.normals[3 * s]; normals[3 * d + 1] = lv.normals[3 * s + 1]; normals[3 * d + 2] = lv.normals[3 * s + 2];
        colors[3 * d] = lv.colors[3 * s]; colors[3 * d + 1] = lv.colors[3 * s + 1]; colors[3 * d + 2] = lv.colors[3 * s + 2];
      }
      bytes += packChunk({ format: FORMAT_POINT27, segmentId: 0, level: Math.min(lv.level, 3), lod: 0, chunkIndex: 0, anchor, fields: { positions, normals, colors } }).length;
    }
    points.push(lv.count);
    bytesByLevel.push(bytes);
    chunksByLevel.push(tiles.size);
  }
  return { points, bytesByLevel, chunksByLevel };
}

/**
 * materialize 시간 측정. 계층의 모든 리프를 단계 0 으로 고르고 그중 keepRatio 만큼(결정적 해시로) 선택해 materialize 한다.
 * 값만 보고하며 문턱 검사는 하지 않는다. maxMs 는 첫 호출을 포함한 회차 최댓값(F-099 ③ 확인 기준이 보는 값).
 * positionBytes 는 단계별 미리 담은 위치(levels[l].positions)의 총 바이트(대표점당 12 B).
 * @returns {{selectedPoints: number, totalPoints: number, medianMs: number, maxMs: number, runsMs: number[], positionBytes: number, representativePoints: number}}
 */
export function measureMaterialize(hierarchy, { keepRatio = 0.736, runs = 5 } = {}) {
  const { octree, levels } = hierarchy;
  const leafLevel = new Uint8Array(octree.leafCount).fill(255);
  let pointCount = 0;
  for (let k = 0; k < octree.leafCount; k++) {
    // 리프 번호 기반 고정 해시(시드 무관, 재현 가능)
    if (((Math.imul(k + 1, 2654435761) >>> 0) / 4294967296) < keepRatio) {
      leafLevel[k] = 0;
      pointCount += levels[0].leafStart[k + 1] - levels[0].leafStart[k];
    }
  }
  const sel = { leafLevel, pointCount };
  const runsMs = [];
  for (let r = 0; r < runs; r++) {
    const t0 = performance.now();
    materialize(hierarchy, sel);
    runsMs.push(performance.now() - t0);
  }
  const sorted = [...runsMs].sort((a, b) => a - b);
  let positionBytes = 0, representativePoints = 0;
  for (const lv of levels) { positionBytes += lv.positions.byteLength; representativePoints += lv.count; }
  return { selectedPoints: pointCount, totalPoints: hierarchy.cloud.count, medianMs: sorted[sorted.length >> 1], maxMs: sorted[sorted.length - 1], runsMs, positionBytes, representativePoints };
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
export function writeJSON(result, filePath, extra = {}) {
  const data = {
    timestamp: new Date().toISOString(),
    points: result.points,
    bytesByLevel: result.bytesByLevel,
    totalBytes: result.bytesByLevel.reduce((a, b) => a + b, 0),
    ...extra,
  };
  writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`\nJSON 저장: ${filePath}`);
}
