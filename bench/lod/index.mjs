// LOD 벤치마크: 구간 내 자산 크기 집계.
// edge0M = 구간 경계 좌표(m)
// levelCount = 생성할 레벨 수(0..3)
// reducer = 칸당 첫 점 선택(기본) | 커스텀 함수
import { writeFileSync } from 'node:fs';
import { packChunk } from '../../server/asset/pack/index.mjs';
import { FORMAT_POINT27, LEVEL_COUNT } from '../../contracts/asset/index.mjs';

/**
 * 기본 그리드 축소(voxel 병합 후 교체 예정).
 * 칸당 첫 점을 선택한다. 빈 칸은 건너뛴다.
 * @param {number[]} positions 3n 배열, [e, n, u] 순
 * @param {number[]} normals 3n 배열
 * @param {Uint8Array} colors 3n 배열
 * @param {number} cellSize 칸 크기(m)
 * @param {number[]} boundMin 격자 원점
 * @returns {{positions: Float32Array, normals: Float32Array, colors: Uint8Array, indices: number[]}}
 */
function defaultVoxelReduce(positions, normals, colors, cellSize, boundMin) {
  const selected = new Map(); // 칸 인덱스 → 점 인덱스

  const n = positions.length / 3;
  for (let i = 0; i < n; i++) {
    const e = positions[3 * i];
    const n_ = positions[3 * i + 1];

    // 칸 좌표 계산
    const cellE = Math.floor((e - boundMin[0]) / cellSize);
    const cellN = Math.floor((n_ - boundMin[1]) / cellSize);
    const cellKey = `${cellE},${cellN}`;

    // 이미 이 칸에 점이 있으면 건너뛴다(첫 점만 취함)
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

  return { positions: reducedPositions, normals: reducedNormals, colors: reducedColors, indices };
}

/**
 * 구간 내 자산 크기 측정 및 집계.
 * @param {Object} cloud Point27Cloud: {format, count, positions, normals, colors}
 * @param {Object} opts
 * @param {number} opts.edge0M 구간 경계(m)
 * @param {number} opts.levelCount 딜레이 패턴 수준(1..4)
 * @param {Function} [opts.reduce] 커스텀 축소 함수(cellSize, boundMin) => {positions, normals, colors}
 * @param {Object} [opts.anchor] 지리 앵커(기본값: {lat: 0, lon: 0, alt: 0})
 * @returns {{points: number[], bytesByLevel: number[]}}
 */
export function measureSegmentBytes(cloud, opts = {}) {
  const { edge0M = 64, levelCount = 4, reduce = defaultVoxelReduce, anchor = { lat: 0, lon: 0, alt: 0 } } = opts;

  if (!Number.isInteger(levelCount) || levelCount < 1 || levelCount > LEVEL_COUNT) {
    throw new Error(`levelCount must be 1..${LEVEL_COUNT}, got ${levelCount}`);
  }

  const positions = cloud.positions;
  const normals = cloud.normals;
  const colors = cloud.colors;

  // 단일 타일 내의 점들만 선택(packChunk 제약: 점들이 하나의 타일 안에 있어야 함)
  // 타일 크기 = 64m, 타일 좌표 = floor(좌표 / 64)
  const TILE_SIZE = 64;
  const n = cloud.count;

  // 첫 점의 타일을 기준으로 함
  let selectedTile = null;
  const singleTileIndices = [];
  for (let i = 0; i < n; i++) {
    const e = positions[3 * i];
    const n_ = positions[3 * i + 1];
    const tileE = Math.floor(e / TILE_SIZE);
    const tileN = Math.floor(n_ / TILE_SIZE);

    if (selectedTile === null) {
      selectedTile = [tileE, tileN];
    }

    if (tileE === selectedTile[0] && tileN === selectedTile[1]) {
      singleTileIndices.push(i);
    }
  }

  // 선택된 타일의 점들로 부분 cloud 생성
  const reducedCloud = {
    count: singleTileIndices.length,
    positions: new Float32Array(singleTileIndices.length * 3),
    normals: new Float32Array(singleTileIndices.length * 3),
    colors: new Uint8Array(singleTileIndices.length * 3),
  };

  singleTileIndices.forEach((srcIdx, dstIdx) => {
    for (let a = 0; a < 3; a++) {
      reducedCloud.positions[3 * dstIdx + a] = positions[3 * srcIdx + a];
      reducedCloud.normals[3 * dstIdx + a] = normals[3 * srcIdx + a];
      reducedCloud.colors[3 * dstIdx + a] = colors[3 * srcIdx + a];
    }
  });

  // 구간 경계 계산
  let boundMin = [Infinity, Infinity, Infinity];
  let boundMax = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < reducedCloud.count; i++) {
    for (let a = 0; a < 3; a++) {
      const v = reducedCloud.positions[3 * i + a];
      if (v < boundMin[a]) boundMin[a] = v;
      if (v > boundMax[a]) boundMax[a] = v;
    }
  }

  const points = [];
  const bytesByLevel = [];

  // 레벨별 축소 및 팩
  for (let level = 0; level < levelCount; level++) {
    // 칸 크기: 레벨이 올라갈수록 거칠어진다
    // 기본: 레벨 0 = 2m, 1 = 4m, 2 = 8m, 3 = 16m
    const cellSize = Math.pow(2, level + 1);

    const reduced = reduce(
      reducedCloud.positions,
      reducedCloud.normals,
      reducedCloud.colors,
      cellSize,
      boundMin,
    );

    const pointCount = reduced.positions.length / 3;
    points.push(pointCount);

    // 팩: Point27 형식으로 자산 생성
    try {
      const packed = packChunk({
        format: FORMAT_POINT27,
        segmentId: 0,
        level,
        lod: 0,
        chunkIndex: 0,
        anchor,
        fields: {
          positions: reduced.positions,
          normals: reduced.normals,
          colors: reduced.colors,
        },
      });

      bytesByLevel.push(packed.length);
    } catch (err) {
      // 팩 실패(범위 초과 등) → 빈 자산
      bytesByLevel.push(0);
    }
  }

  return { points, bytesByLevel };
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
