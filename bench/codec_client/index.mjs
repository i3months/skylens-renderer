// 클라이언트 codec 1 복호 벤치마크 구현.
// 1M 점(50k 점 조각 20개) 복호 시간 측정(무손실·손실 모드별).
import { encodeChunk } from '../../server/codec/chunk/index.mjs';
import { decodeChunkClient } from '../../client/codec/index.mjs';
import { packChunk } from '../../server/asset/pack/index.mjs';
import { FORMAT_POINT27 } from '../../contracts/asset/index.mjs';
import { mortonOrder } from '../../server/codec/order/index.mjs';
import { generate as generateFlatBoxes } from '../../fixtures/scenes/flat_boxes/index.mjs';
import { readHeaderClient, readPlanesClient } from '../../client/asset/index.mjs';
import { pointMultiset, COLOR_MODE } from '../../contracts/codec/index.mjs';

/**
 * 원본 synthetic 점을 생성하고 평면을 반환(테스트용).
 * 원본 raw 파일(codec 0)에서 직접 읽은 평면을 반환한다.
 * pointMultiset 으로 비교하므로 morton 순서는 무관하다.
 * @param {number} pointCount 점 수
 * @param {number} seed seed
 * @returns {{pos_e: Uint16Array, pos_n: Uint16Array, pos_u: Uint16Array, color_r: Uint8Array, color_g: Uint8Array, color_b: Uint8Array, normal_oct_x: Int8Array, normal_oct_y: Int8Array}}
 */
export function extractOriginalPlanes(pointCount, seed) {
  const rng = (() => {
    let s = seed >>> 0;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / (2 ** 32); };
  })();

  const positions = new Float32Array(pointCount * 3);
  const normals = new Float32Array(pointCount * 3);
  const colors = new Uint8Array(pointCount * 3);

  for (let i = 0; i < pointCount; i++) {
    positions[3 * i] = rng() * 63.99;
    positions[3 * i + 1] = rng() * 63.99;
    positions[3 * i + 2] = rng() * 63.99;

    let nx = rng() * 2 - 1;
    let ny = rng() * 2 - 1;
    let nz = rng() * 2 - 1;
    const len = Math.hypot(nx, ny, nz);
    normals[3 * i] = nx / len;
    normals[3 * i + 1] = ny / len;
    normals[3 * i + 2] = nz / len;

    colors[3 * i] = Math.floor(rng() * 256);
    colors[3 * i + 1] = Math.floor(rng() * 256);
    colors[3 * i + 2] = Math.floor(rng() * 256);
  }

  const rawFile = packChunk({
    format: FORMAT_POINT27,
    segmentId: 0,
    level: 0,
    lod: 0,
    chunkIndex: 0,
    anchor: { lat: 37.5, lon: 127, alt: 30 },
    fields: { positions, normals, colors },
  });

  // 원본 raw 파일(codec 0)에서 직접 평면을 읽는다(encode/decode 없음)
  const header = readHeaderClient(rawFile);
  const planes = readPlanesClient(rawFile, header);
  return planes;
}

/**
 * 조각 하나를 synthetic 점 데이터로 만든다.
 * 모든 점은 한 타일(0-64 m) 내에 있어야 한다.
 * @param {number} pointCount 이 조각의 점 수
 * @param {number} seed 재현 가능한 seed
 * @param {Object} opts 옵션
 * @param {boolean} [opts.lossy=false] 손실 색 압축 사용 여부
 * @returns {Uint8Array} codec 1 부호화 파일
 */
export function createChunk(pointCount, seed, opts = {}) {
  const rng = (() => {
    let s = seed >>> 0;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / (2 ** 32); };
  })();

  const positions = new Float32Array(pointCount * 3);
  const normals = new Float32Array(pointCount * 3);
  const colors = new Uint8Array(pointCount * 3);

  for (let i = 0; i < pointCount; i++) {
    // 위치: 0~63.99 m 범위(한 타일 내, 타일 크기 64 m)
    positions[3 * i] = rng() * 63.99;
    positions[3 * i + 1] = rng() * 63.99;
    positions[3 * i + 2] = rng() * 63.99;

    // 법선: 정규화된 난수 벡터
    let nx = rng() * 2 - 1;
    let ny = rng() * 2 - 1;
    let nz = rng() * 2 - 1;
    const len = Math.hypot(nx, ny, nz);
    normals[3 * i] = nx / len;
    normals[3 * i + 1] = ny / len;
    normals[3 * i + 2] = nz / len;

    // 색: 난수 RGB
    colors[3 * i] = Math.floor(rng() * 256);
    colors[3 * i + 1] = Math.floor(rng() * 256);
    colors[3 * i + 2] = Math.floor(rng() * 256);
  }

  // codec 0 (raw planar) 파일로 pack
  const rawFile = packChunk({
    format: FORMAT_POINT27,
    segmentId: 0,
    level: 0,
    lod: 0,
    chunkIndex: 0,
    anchor: { lat: 37.5, lon: 127, alt: 30 },
    fields: { positions, normals, colors },
  });

  // codec 0 → codec 1
  return encodeChunk(rawFile, { lossyColor: opts.lossy });
}

/**
 * 복호 시간 측정(여러 회차, 중앙값·최솟값 반환).
 * 첫 호출은 warm-JIT 으로 따로 표기된다.
 * @param {Uint8Array[]} chunks codec 1 파일 배열
 * @param {Object} opts
 * @param {number} [opts.runs=5] 반복 회수
 * @param {boolean} [opts.expectedLossy] 손실 모드 여부(검증용, 생략 시 검증 안함)
 * @returns {{totalTime: number, totalPoints: number, runs: {ms: number[], median: number, min: number}, warmJIT: number, throughput: number, colorModes: number[]}}
 */
export function measureDecode(chunks, { runs = 5, expectedLossy = null } = {}) {
  const allTimes = [];
  const colorModes = [];

  // 첫 호출: warm-JIT (JIT 컴파일 포함)
  let warmJIT = 0;
  {
    const t0 = performance.now();
    for (const chunk of chunks) {
      const result = decodeChunkClient(chunk);
      if (expectedLossy !== null) {
        colorModes.push(result.colorMode);
      }
    }
    warmJIT = performance.now() - t0;
    allTimes.push(warmJIT);
  }

  // 나머지 회차
  for (let run = 1; run < runs; run++) {
    const t0 = performance.now();
    for (const chunk of chunks) {
      decodeChunkClient(chunk);
    }
    const elapsed = performance.now() - t0;
    allTimes.push(elapsed);
  }

  // 중앙값·최솟값은 warm-JIT 을 제외한 부분에서 계산
  const sortedTimes = allTimes.length > 1 ? [...allTimes.slice(1)].sort((a, b) => a - b) : [];
  const median = sortedTimes.length > 0 ? sortedTimes[Math.floor(sortedTimes.length / 2)] : warmJIT;
  const min = sortedTimes.length > 0 ? Math.min(...sortedTimes) : warmJIT;
  const totalTime = allTimes.reduce((a, b) => a + b, 0) / runs;

  // 총 점 수 계산 및 colorMode 검증
  const totalPoints = chunks.reduce((sum, chunk) => {
    const { header } = decodeChunkClient(chunk);
    return sum + header.pointCount;
  }, 0);

  // colorMode 검증: expectedLossy 가 지정된 경우
  if (expectedLossy !== null) {
    if (expectedLossy) {
      // 손실 모드: 모든 청크의 colorMode 가 COLOR_MODE.QUANT2(1) 이어야 함
      colorModes.forEach((mode, i) => {
        if (mode !== COLOR_MODE.QUANT2) {
          throw new Error(`청크 ${i} 의 색 모드가 손실(${COLOR_MODE.QUANT2})이어야 하는데 ${mode} 임`);
        }
      });
    } else {
      // 무손실 모드: 모든 청크의 colorMode 가 COLOR_MODE.QUANT2(1) 이 아니어야 함
      colorModes.forEach((mode, i) => {
        if (mode === COLOR_MODE.QUANT2) {
          throw new Error(`청크 ${i} 의 색 모드가 무손실이어야 하는데 손실(${COLOR_MODE.QUANT2})임`);
        }
      });
    }
  }

  return {
    totalTime,
    totalPoints,
    runs: { ms: allTimes, median, min, warmJIT },
    throughput: totalPoints / (totalTime / 1000),
    colorModes,
  };
}

/**
 * 색 모드별(lossless, lossy) 측정 결과 반환.
 * @param {Object} opts
 * @param {number} [opts.points=1000000] 총 점 수
 * @param {number} [opts.runs=5] 반복 회수
 * @param {number} [opts.chunkSize=50000] 조각당 점 수(실제 요청점 수와 같이 사용)
 * @returns {{lossless: {...}, lossy: {...}}}
 */
export function benchmark({ points = 1000000, runs = 5, chunkSize = 50000 } = {}) {
  // 점 수에 맞춰 조각 개수 및 크기 결정
  const chunkCount = Math.max(1, Math.ceil(points / chunkSize));
  const pointsPerChunk = Math.ceil(points / chunkCount); // 각 조각이 가질 점 수

  // 무손실 모드
  const chunksCopy = Array.from({ length: chunkCount }, (_, i) => createChunk(pointsPerChunk, i, { lossy: false }));
  const losslessResult = measureDecode(chunksCopy, { runs, expectedLossy: false });

  // 손실 모드
  const chunksDecode = Array.from({ length: chunkCount }, (_, i) => createChunk(pointsPerChunk, i + 1000, { lossy: true }));
  const lossyResult = measureDecode(chunksDecode, { runs, expectedLossy: true });

  return {
    lossless: losslessResult,
    lossy: lossyResult,
  };
}

/**
 * 벤치마크 결과를 표 형식으로 포맷.
 * @param {Object} result
 * @returns {string}
 */
export function formatResultTable(result) {
  const lines = [];
  lines.push('색 모드별 복호 성능:');
  lines.push(['모드', '총 점', '평균 시간(ms)', '중앙값(ms)', '최솟값(ms)', 'warm-JIT(ms)', '점/초'].join('\t'));

  for (const [mode, data] of Object.entries(result)) {
    const modeLabel = mode === 'lossless' ? '무손실' : '손실';
    lines.push([
      modeLabel,
      data.totalPoints.toLocaleString(),
      data.totalTime.toFixed(1),
      data.runs.median.toFixed(1),
      data.runs.min.toFixed(1),
      data.runs.warmJIT.toFixed(1),
      (data.throughput / 1e6).toFixed(3),
    ].join('\t'));
  }

  return lines.join('\n');
}
