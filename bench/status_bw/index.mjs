// 현황판 경로 대역폭 측정(T13.9, T13.B). SPEC §4 S6: 초기 ≤ 15 MB + 구간당 ≤ 3 MB (MB = 10^6 B), 웹소켓 프레임 바이트 합.
//   초기 = 접속부터 첫 프레임까지 = WELCOME + 구간 0 의 수준 0 PIECE 들 + 그 LEVEL_ARRIVED (server/scheduler/initial 의 정의와 같다).
//   구간당 = 한 구간의 수준 0..3 PIECE 전체 + 수준마다 LEVEL_ARRIVED 1 개.
// 합성 장면 → packChunk(.skla) → [codec 1 encodeChunk] → PIECE/LEVEL_ARRIVED(encodeMessage) → encodeFrame 의 실제 길이를 센다.
// 손으로 적은 숫자는 없다. bench/proto/measure.mjs 의 packCloudPieces 를 재사용하고 그 파일은 고치지 않는다.
//
// 송출 구성(opts):
//   codec               0(기본, 무압축 평면 .skla) | 1(SKLC1, server/codec/chunk encodeChunk, 무손실 색)
//   segmentByteBudget   없으면(기본) 원본 수준 점 전부. 주면 server/scheduler/segment_budget 의 fitSegmentBudget 으로
//                       구간 프레임 바이트 합이 이 값 이하가 되도록 수준마다 공간 균일 솎기(원본 점의 부분집합)를 한다.
//                       이 구성에서는 점을 모턴 순으로 늘어놓은 뒤 조각을 자른다.
// 기본값은 T13 기준 구성(무압축·솎기 없음)이고, S6 송출 구성은 S6_SEND_CONFIG(결정 0043)다.

import { generate as generateLevels, levelCloud } from '../../fixtures/scenes/levels/index.mjs';
import { encodeMessage } from '../../server/proto/codec/index.mjs';
import { encodeFrame, OPCODES } from '../../server/ws/frame/index.mjs';
import { encodeChunk } from '../../server/codec/chunk/index.mjs';
import { createSpatialThinner, fitSegmentBudget, makeFloorAllocate, S6_LOW_LEVEL_FLOOR } from '../../server/scheduler/segment_budget/index.mjs';
import { packCloudPieces } from '../proto/measure.mjs';
import { INITIAL_BUDGET_BYTES, SEGMENT_BUDGET_BYTES } from '../proto/index.mjs';

// S6 문턱(10^6 B 기준). bench/proto 의 고정 상수를 그대로 쓴다.
export const STATUS_BW_LIMITS = Object.freeze({ initialBytes: INITIAL_BUDGET_BYTES, perSegmentBytes: SEGMENT_BUDGET_BYTES });

// S6 송출 구성(결정 0043·0050): codec 1 + 구간 바이트 예산(S6 구간당 문턱 그대로) 안에서 공간 균일 솎기, 낮은 수준은 원본의 2% 만 보장하고 나머지는 최고 수준에 준다.
export const S6_SEND_CONFIG = Object.freeze({ codec: 1, segmentByteBudget: SEGMENT_BUDGET_BYTES, allocate: makeFloorAllocate(S6_LOW_LEVEL_FLOOR) });

const frameLen = (msg) => encodeFrame(OPCODES.BINARY, encodeMessage(msg)).length;

/** 원본 색인 idx 의 점만 담은 27 B 점군(값은 원본 그대로). */
function subsetCloud(cloud, idx) {
  const n = idx.length;
  const positions = new Float32Array(3 * n);
  const normals = new Float32Array(3 * n);
  const colors = new Uint8Array(3 * n);
  for (let j = 0; j < n; j++) {
    const i = idx[j];
    for (let a = 0; a < 3; a++) {
      positions[3 * j + a] = cloud.positions[3 * i + a];
      normals[3 * j + a] = cloud.normals[3 * i + a];
      colors[3 * j + a] = cloud.colors[3 * i + a];
    }
  }
  return { format: cloud.format, count: n, positions, normals, colors };
}

/**
 * @param {{segments?: number, pointsPerSegment?: number, seed?: number, codec?: 0|1, segmentByteBudget?: number}} [opts]
 * @returns {{segments:number, pointsPerSegment:number, codec:number, segmentByteBudget:number|null, welcomeBytes:number,
 *   initialBytes:number, initialLevels:number[], rows:{segmentId:number, points:number, sourcePoints:number, pieces:number,
 *   frameBytes:number, thinned:boolean, budgetTries:{points:number, bytes:number}[],
 *   levels:{level:number, points:number, sourcePoints:number, pieces:number, pieceBytes:number, arrivedBytes:number, frameBytes:number}[]}[]}}
 */
export function measureStatusBandwidth(opts = {}) {
  const segments = opts.segments ?? 4;
  const pointsPerSegment = opts.pointsPerSegment ?? 100000;
  const codec = opts.codec ?? 0;
  if (codec !== 0 && codec !== 1) throw new RangeError(`codec 은 0 또는 1: ${codec}`);
  const segmentByteBudget = opts.segmentByteBudget ?? null;
  // T13.T 튜닝 훅: 솎기 도구 공장(기본 createSpatialThinner)과 수준별 점 배분 함수(기본 levelPointTargets). 기본값이면 동작은 이전과 같다.
  const makeThinner = opts.createThinner ?? createSpatialThinner;
  const allocate = opts.allocate;
  const scene = generateLevels({ seed: opts.seed ?? 1, segments, count: pointsPerSegment });
  const welcomeBytes = frameLen({ type: 'WELCOME', sessionId: 1, resumed: false, nextPieceSeq: 1 });

  // 수준 하나를 점 k 개로 만들어 실제 조각·바이트를 돌려준다. PIECE 머리의 pieceSeq 는 고정 폭(u32)이라 바이트는 순번과 무관하다.
  const buildLevel = (segmentId, level, source, thinner, k) => {
    // 예산 구성에서는 솎지 않는 경우에도 모턴 순으로 늘어놓아 조각이 공간적으로 모이게 한다(결정 0043). 기본 구성은 원본 순서 그대로.
    const cloud = segmentByteBudget === null ? source : subsetCloud(source, thinner.select(k));
    const pieces = packCloudPieces(cloud, { segmentId, level }).map((p) => ({ key: p.key, skla: codec === 1 ? encodeChunk(p.skla) : p.skla }));
    let pieceBytes = 0;
    for (const p of pieces) pieceBytes += frameLen({ type: 'PIECE', pieceSeq: 1, key: p.key, chunk: p.skla });
    const arrivedBytes = frameLen({ type: 'LEVEL_ARRIVED', segmentId, level, pieceCount: pieces.length, firstPieceSeq: 1 });
    return { k: cloud.count, pieces, pieceBytes, arrivedBytes };
  };

  let pieceSeq = 1;
  const rows = [];
  for (let segmentId = 0; segmentId < segments; segmentId++) {
    const sources = [0, 1, 2, 3].map((level) => levelCloud(scene, segmentId, level));
    const thinners = sources.map((c) => makeThinner(c.positions, c));
    const last = [null, null, null, null]; // 수준별 마지막 구성 캐시
    const build = (level, k) => {
      if (last[level]?.k === Math.min(k, sources[level].count)) return last[level];
      return (last[level] = buildLevel(segmentId, level, sources[level], thinners[level], k));
    };
    const counts = sources.map((c) => c.count);
    let targets = counts;
    let thinned = false;
    let budgetTries = [];
    if (segmentByteBudget !== null) {
      const fit = fitSegmentBudget({
        counts,
        maxBytes: segmentByteBudget,
        allocate,
        measure: (t) => t.reduce((s, k, level) => { const b = build(level, k); return s + b.pieceBytes + b.arrivedBytes; }, 0),
      });
      ({ targets, thinned } = fit);
      budgetTries = fit.tries;
    }
    const levels = [];
    for (let level = 0; level < 4; level++) {
      const b = build(level, targets[level]);
      const firstPieceSeq = pieceSeq;
      let pieceBytes = 0;
      for (const p of b.pieces) pieceBytes += frameLen({ type: 'PIECE', pieceSeq: pieceSeq++, key: p.key, chunk: p.skla });
      const arrivedBytes = frameLen({ type: 'LEVEL_ARRIVED', segmentId, level, pieceCount: b.pieces.length, firstPieceSeq });
      levels.push({ level, points: b.k, sourcePoints: counts[level], pieces: b.pieces.length, pieceBytes, arrivedBytes, frameBytes: pieceBytes + arrivedBytes });
    }
    rows.push({
      segmentId,
      points: levels.reduce((s, l) => s + l.points, 0),
      sourcePoints: levels.reduce((s, l) => s + l.sourcePoints, 0),
      pieces: levels.reduce((s, l) => s + l.pieces, 0),
      frameBytes: levels.reduce((s, l) => s + l.frameBytes, 0),
      thinned,
      budgetTries,
      levels,
    });
  }
  const initialLevels = [rows[0].levels[0].frameBytes];
  return { segments, pointsPerSegment, codec, segmentByteBudget, welcomeBytes, initialBytes: welcomeBytes + initialLevels[0], initialLevels, rows };
}
