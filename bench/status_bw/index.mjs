// 현황판 경로 대역폭 측정(T13.9). SPEC §4 S6: 초기 ≤ 15 MB + 구간당 ≤ 3 MB, 웹소켓 프레임 바이트 합.
//   초기 = 접속부터 첫 프레임까지 = WELCOME + 구간 0 의 수준 0 PIECE 들 + 그 LEVEL_ARRIVED (server/scheduler/initial 의 정의와 같다).
//   구간당 = 한 구간의 수준 0..3 PIECE 전체 + 수준마다 LEVEL_ARRIVED 1 개.
// 합성 장면 → packChunk(.skla) → PIECE/LEVEL_ARRIVED(encodeMessage) → encodeFrame 의 실제 길이를 센다. 손으로 적은 숫자는 없다.
// bench/proto/measure.mjs 의 packCloudPieces 를 재사용하고 그 파일은 고치지 않는다.

import { generate as generateLevels, levelCloud } from '../../fixtures/scenes/levels/index.mjs';
import { encodeMessage } from '../../server/proto/codec/index.mjs';
import { encodeFrame, OPCODES } from '../../server/ws/frame/index.mjs';
import { packCloudPieces } from '../proto/measure.mjs';

const frameLen = (msg) => encodeFrame(OPCODES.BINARY, encodeMessage(msg)).length;

/**
 * @param {{segments?: number, pointsPerSegment?: number, seed?: number}} [opts]
 * @returns {{segments:number, pointsPerSegment:number, welcomeBytes:number, initialBytes:number,
 *   initialLevels:number[], rows:{segmentId:number, points:number, pieces:number, frameBytes:number,
 *   levels:{level:number, points:number, pieces:number, pieceBytes:number, arrivedBytes:number, frameBytes:number}[]}[]}}
 */
export function measureStatusBandwidth(opts = {}) {
  const segments = opts.segments ?? 4;
  const pointsPerSegment = opts.pointsPerSegment ?? 100000;
  const scene = generateLevels({ seed: opts.seed ?? 1, segments, count: pointsPerSegment });
  let pieceSeq = 1;
  const welcomeBytes = frameLen({ type: 'WELCOME', sessionId: 1, resumed: false, nextPieceSeq: 1 });
  const rows = [];
  for (let segmentId = 0; segmentId < segments; segmentId++) {
    const levels = [];
    for (let level = 0; level < 4; level++) {
      const cloud = levelCloud(scene, segmentId, level);
      const pieces = packCloudPieces(cloud, { segmentId, level });
      const firstPieceSeq = pieceSeq;
      let pieceBytes = 0;
      for (const p of pieces) pieceBytes += frameLen({ type: 'PIECE', pieceSeq: pieceSeq++, key: p.key, chunk: p.skla });
      const arrivedBytes = frameLen({ type: 'LEVEL_ARRIVED', segmentId, level, pieceCount: pieces.length, firstPieceSeq });
      levels.push({ level, points: cloud.count, pieces: pieces.length, pieceBytes, arrivedBytes, frameBytes: pieceBytes + arrivedBytes });
    }
    rows.push({
      segmentId,
      points: levels.reduce((s, l) => s + l.points, 0),
      pieces: levels.reduce((s, l) => s + l.pieces, 0),
      frameBytes: levels.reduce((s, l) => s + l.frameBytes, 0),
      levels,
    });
  }
  const initialLevels = [rows[0].levels[0].frameBytes];
  return { segments, pointsPerSegment, welcomeBytes, initialBytes: welcomeBytes + initialLevels[0], initialLevels, rows };
}
