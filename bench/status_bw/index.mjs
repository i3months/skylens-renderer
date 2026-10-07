// 현황판 경로 대역폭 측정(T13.9, T13.B, T13.HQ). 웹소켓 프레임 바이트 합을 잰다(MB = 10^6 B).
//   초기 = 접속부터 첫 프레임까지 = WELCOME + 구간 0 의 수준 0 PIECE 들 + 그 LEVEL_ARRIVED (server/scheduler/initial 의 정의와 같다).
//   구간당 = 한 구간의 수준 0..3 PIECE 전체 + 수준마다 LEVEL_ARRIVED 1 개.
// 합성 장면 → packChunk(.skla) → [codec 1 encodeChunk] → PIECE/LEVEL_ARRIVED(encodeMessage) → encodeFrame 의 실제 길이를 센다.
// 손으로 적은 숫자는 없다. bench/proto/measure.mjs 의 packCloudPieces 를 재사용하고 그 파일은 고치지 않는다.
//
// 송출 구성(opts):
//   codec   0(기본, 무압축 평면 .skla) | 1(SKLC1, server/codec/chunk encodeChunk, 무손실 색)
// 송출 점은 언제나 원본 수준 점 전부다(솎기·구간 바이트 예산 없음).
// T13.HQ(사람 결정: 대역폭 상한 없음, 화질 우선)로 S6 송출 구성은 codec 1 만이고, 구간당 바이트는 출력만 한다.

import { generate as generateLevels, levelCloud } from '../../fixtures/scenes/levels/index.mjs';
import { encodeMessage } from '../../server/proto/codec/index.mjs';
import { encodeFrame, OPCODES } from '../../server/ws/frame/index.mjs';
import { encodeChunk } from '../../server/codec/chunk/index.mjs';
import { packCloudPieces } from '../proto/measure.mjs';
import { INITIAL_BUDGET_BYTES } from '../proto/index.mjs';

// 초기 문턱(10^6 B 기준)만 둔다. 현황판 구간당 상한은 T13.HQ 에서 폐지됐다(관제탑 3 MB 는 별개).
export const STATUS_BW_LIMITS = Object.freeze({ initialBytes: INITIAL_BUDGET_BYTES });

// S6 송출 구성(T13.HQ): 무손실 codec 1 로 원본 점 전부를 보낸다. 구간 바이트 예산·솎기 없음.
export const S6_SEND_CONFIG = Object.freeze({ codec: 1 });

const frameLen = (msg) => encodeFrame(OPCODES.BINARY, encodeMessage(msg)).length;

/**
 * @param {{segments?: number, pointsPerSegment?: number, seed?: number, codec?: 0|1}} [opts]
 * @returns {{segments:number, pointsPerSegment:number, codec:number, welcomeBytes:number,
 *   initialBytes:number, initialLevels:number[], rows:{segmentId:number, points:number, sourcePoints:number, pieces:number, frameBytes:number,
 *   levels:{level:number, points:number, sourcePoints:number, pieces:number, pieceBytes:number, arrivedBytes:number, frameBytes:number}[]}[]}}
 */
export function measureStatusBandwidth(opts = {}) {
  const segments = opts.segments ?? 4;
  const pointsPerSegment = opts.pointsPerSegment ?? 100000;
  const codec = opts.codec ?? 0;
  if (codec !== 0 && codec !== 1) throw new RangeError(`codec 은 0 또는 1: ${codec}`);
  const scene = generateLevels({ seed: opts.seed ?? 1, segments, count: pointsPerSegment });
  const welcomeBytes = frameLen({ type: 'WELCOME', sessionId: 1, resumed: false, nextPieceSeq: 1 });

  let pieceSeq = 1;
  const rows = [];
  for (let segmentId = 0; segmentId < segments; segmentId++) {
    const levels = [];
    for (let level = 0; level < 4; level++) {
      const cloud = levelCloud(scene, segmentId, level);
      const pieces = packCloudPieces(cloud, { segmentId, level });
      const firstPieceSeq = pieceSeq;
      let pieceBytes = 0;
      for (const p of pieces) pieceBytes += frameLen({ type: 'PIECE', pieceSeq: pieceSeq++, key: p.key, chunk: codec === 1 ? encodeChunk(p.skla) : p.skla });
      const arrivedBytes = frameLen({ type: 'LEVEL_ARRIVED', segmentId, level, pieceCount: pieces.length, firstPieceSeq });
      levels.push({ level, points: cloud.count, sourcePoints: cloud.count, pieces: pieces.length, pieceBytes, arrivedBytes, frameBytes: pieceBytes + arrivedBytes });
    }
    rows.push({
      segmentId,
      points: levels.reduce((s, l) => s + l.points, 0),
      sourcePoints: levels.reduce((s, l) => s + l.sourcePoints, 0),
      pieces: levels.reduce((s, l) => s + l.pieces, 0),
      frameBytes: levels.reduce((s, l) => s + l.frameBytes, 0),
      levels,
    });
  }
  const initialLevels = [rows[0].levels[0].frameBytes];
  return { segments, pointsPerSegment, codec, welcomeBytes, initialBytes: welcomeBytes + initialLevels[0], initialLevels, rows };
}
