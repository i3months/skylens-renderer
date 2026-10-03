// 코덱 벤치마크: codec 0 대비 codec 1 바이트 측정.
// packChunk 로 codec 0 형식 파일을 만들고, encodeChunk 로 codec 1 로 변환해 크기를 비교한다.
// 왕복 확인(decodeChunk 후 점 다중집합 동일)을 측정 중 단언한다.
import { writeFileSync } from 'node:fs';
import { packChunk } from '../../server/asset/pack/index.mjs';
import { encodeChunk, decodeChunk } from '../../server/codec/chunk/index.mjs';
import { parseHeader, FORMAT_POINT27, bodyLayout } from '../../contracts/asset/index.mjs';
import { pointMultiset } from '../../contracts/codec/index.mjs';

const TILE_SIZE = 64;
const TILE_KEY_SPAN = 2 ** 22;
const TILE_KEY_HALF = 2 ** 21;

/**
 * 점군을 타일별로 나누어 codec 0 → codec 1 바이트를 측정한다.
 * 왕복 검증(decodeChunk 후 점 다중집합 동일)을 단언한다.
 * 색 모드(lossyColor) 별로 측정한다.
 * @param {Object} cloud Point27Cloud 또는 cloud.count, cloud.positions 등을 가진 객체
 * @param {Object} [opts]
 * @param {Object} [opts.anchor] 앵커 좌표, 기본 {lat:0, lon:0, alt:0}
 * @returns {{pointCount: number, codec0: {headerBytes: number, bodyBytes: number, totalBytes: number}, codec1Lossless: {...}, codec1Lossy: {...}}}
 */
export function measureCodecBytes(cloud, opts = {}) {
  const { anchor = { lat: 0, lon: 0, alt: 0 } } = opts;
  const n = cloud.count ?? cloud.positions.length / 3;
  if (n < 1) throw new Error('codec bench: 점이 없음');

  // 타일별로 점을 나눈다
  const tiles = new Map();
  for (let i = 0; i < n; i++) {
    const tx = Math.floor(cloud.positions[3 * i] / TILE_SIZE);
    const tz = Math.floor(cloud.positions[3 * i + 2] / TILE_SIZE);
    if (!(Math.abs(tz) < TILE_KEY_HALF) || !(Math.abs(tx) < 2 ** 30)) {
      throw new Error(`codec bench: 타일 좌표 범위 밖 (${tx},${tz})`);
    }
    const key = tx * TILE_KEY_SPAN + tz;
    let arr = tiles.get(key);
    if (!arr) tiles.set(key, (arr = []));
    arr.push(i);
  }

  // 각 타일별로 codec 0/1 크기 측정
  const codec0 = { headerBytes: 0, bodyBytes: 0, totalBytes: 0 };
  const codec1Results = { '무손실': { headerBytes: 0, bodyBytes: 0, totalBytes: 0 }, '손실색': { headerBytes: 0, bodyBytes: 0, totalBytes: 0 } };

  for (const tileIndices of tiles.values()) {
    const m = tileIndices.length;
    const positions = new Float32Array(3 * m);
    const normals = new Float32Array(3 * m);
    const colors = new Uint8Array(3 * m);

    // 타일 내 점들을 복사
    for (let d = 0; d < m; d++) {
      const i = tileIndices[d];
      positions[3 * d] = cloud.positions[3 * i];
      positions[3 * d + 1] = cloud.positions[3 * i + 1];
      positions[3 * d + 2] = cloud.positions[3 * i + 2];
      normals[3 * d] = cloud.normals[3 * i];
      normals[3 * d + 1] = cloud.normals[3 * i + 1];
      normals[3 * d + 2] = cloud.normals[3 * i + 2];
      colors[3 * d] = cloud.colors[3 * i];
      colors[3 * d + 1] = cloud.colors[3 * i + 1];
      colors[3 * d + 2] = cloud.colors[3 * i + 2];
    }

    // codec 0 파일 생성
    const codec0File = packChunk({
      format: FORMAT_POINT27,
      segmentId: 0,
      level: 0,
      lod: 0,
      chunkIndex: 0,
      anchor,
      fields: { positions, normals, colors },
    });

    const h0 = parseHeader(codec0File);
    codec0.headerBytes += h0.headerSize;
    codec0.bodyBytes += h0.bodyBytes;
    codec0.totalBytes += codec0File.length;

    // 두 모드(무손실, 손실색)로 codec 1 인코딩 및 왕복 검증(무손실만)
    for (const [mode, lossyColor] of [['무손실', false], ['손실색', true]]) {
      const codec1File = encodeChunk(codec0File, { lossyColor });
      const h1 = parseHeader(codec1File);

      // 왕복 검증(무손실 색인 경우만): 무손실 색이면 점 다중집합이 동일해야 함
      if (!lossyColor) {
        const decoded = decodeChunk(codec1File);
        const planes0 = readPlanesRaw(codec0File, h0);
        const planesDecoded = readPlanesRaw(decoded, parseHeader(decoded));
        const multiset0 = pointMultiset(planes0);
        const multisetDecoded = pointMultiset(planesDecoded);
        if (multiset0.length !== multisetDecoded.length || !multiset0.every((v, i) => v === multisetDecoded[i])) {
          throw new Error(`codec bench: 왕복 실패 (무손실 색, ${m}점 타일)`);
        }
      }

      codec1Results[mode].headerBytes += h1.headerSize;
      codec1Results[mode].bodyBytes += h1.bodyBytes;
      codec1Results[mode].totalBytes += codec1File.length;
    }
  }

  return {
    pointCount: n,
    codec0: {
      headerBytes: codec0.headerBytes,
      bodyBytes: codec0.bodyBytes,
      totalBytes: codec0.totalBytes,
      bytesPerPoint: (codec0.bodyBytes / n).toFixed(6),
    },
    codec1Lossless: {
      headerBytes: codec1Results['무손실'].headerBytes,
      bodyBytes: codec1Results['무손실'].bodyBytes,
      totalBytes: codec1Results['무손실'].totalBytes,
      bodyBytesPerPoint: (codec1Results['무손실'].bodyBytes / n).toFixed(6),
      totalBytesPerPoint: (codec1Results['무손실'].totalBytes / n).toFixed(6),
      ratioVsCodec0Body: (codec1Results['무손실'].bodyBytes / codec0.bodyBytes).toFixed(6),
    },
    codec1Lossy: {
      headerBytes: codec1Results['손실색'].headerBytes,
      bodyBytes: codec1Results['손실색'].bodyBytes,
      totalBytes: codec1Results['손실색'].totalBytes,
      bodyBytesPerPoint: (codec1Results['손실색'].bodyBytes / n).toFixed(6),
      totalBytesPerPoint: (codec1Results['손실색'].totalBytes / n).toFixed(6),
      ratioVsCodec0Body: (codec1Results['손실색'].bodyBytes / codec0.bodyBytes).toFixed(6),
    },
  };
}

/** codec 0 형식 파일에서 평면을 읽는다(bench/lod/index.mjs 에서 복사). */
function readPlanesRaw(file, h) {
  const { planes } = bodyLayout(h.format, h.pointCount);
  const out = {};
  for (const p of planes) {
    const rel = h.headerSize + p.offset;
    const raw = file.slice(rel, rel + p.bytes);
    out[p.name] = p.type === 'u16' ? new Uint16Array(raw.buffer) : p.type === 'i8' ? new Int8Array(raw.buffer) : raw;
  }
  return out;
}

/**
 * 측정 결과를 표 형식으로 콘솔에 출력.
 * @param {{pointCount, codec0, codec1Lossless, codec1Lossy}} result
 */
export function printTable(result) {
  const { pointCount, codec0, codec1Lossless, codec1Lossy } = result;

  console.log('\n코덱 바이트 측정(점 ' + pointCount.toLocaleString() + '):');
  console.log([
    '코덱',
    '헤더(B)',
    '본문(B)',
    '합계(B)',
    '본문 B/점',
    '합계 B/점',
    'codec0 본문 대비',
  ].join('\t'));

  // Codec 0
  console.log([
    'codec0',
    codec0.headerBytes.toLocaleString(),
    codec0.bodyBytes.toLocaleString(),
    codec0.totalBytes.toLocaleString(),
    codec0.bytesPerPoint,
    (codec0.totalBytes / pointCount).toFixed(6),
    '1.000000',
  ].join('\t'));

  // Codec 1 무손실
  console.log([
    'codec1-lossless',
    codec1Lossless.headerBytes.toLocaleString(),
    codec1Lossless.bodyBytes.toLocaleString(),
    codec1Lossless.totalBytes.toLocaleString(),
    codec1Lossless.bodyBytesPerPoint,
    codec1Lossless.totalBytesPerPoint,
    codec1Lossless.ratioVsCodec0Body,
  ].join('\t'));

  // Codec 1 손실
  console.log([
    'codec1-lossy',
    codec1Lossy.headerBytes.toLocaleString(),
    codec1Lossy.bodyBytes.toLocaleString(),
    codec1Lossy.totalBytes.toLocaleString(),
    codec1Lossy.bodyBytesPerPoint,
    codec1Lossy.totalBytesPerPoint,
    codec1Lossy.ratioVsCodec0Body,
  ].join('\t'));

  const losslessBodyRatio = (parseFloat(codec1Lossless.bodyBytesPerPoint) / 27 * 100).toFixed(1);
  const lossyBodyRatio = (parseFloat(codec1Lossy.bodyBytesPerPoint) / 27 * 100).toFixed(1);
  const losslessTotalRatio = (parseFloat(codec1Lossless.totalBytesPerPoint) / 27 * 100).toFixed(1);
  const lossyTotalRatio = (parseFloat(codec1Lossy.totalBytesPerPoint) / 27 * 100).toFixed(1);

  console.log(
    `\n원본 27 B/점 대비(본문 기준): codec1-lossless ${losslessBodyRatio}%, codec1-lossy ${lossyBodyRatio}%`,
  );
  console.log(
    `원본 27 B/점 대비(합계 기준): codec1-lossless ${losslessTotalRatio}%, codec1-lossy ${lossyTotalRatio}%`,
  );
}

/**
 * 결과를 JSON으로 파일에 저장.
 * @param {Object} result
 * @param {string} filePath
 */
export function writeJSON(result, filePath) {
  const data = {
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    command: `node ${process.argv.slice(1).join(' ')}`,
    pointCount: result.pointCount,
    codec0: result.codec0,
    codec1Lossless: result.codec1Lossless,
    codec1Lossy: result.codec1Lossy,
  };
  writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`\nJSON 저장: ${filePath}`);
}
