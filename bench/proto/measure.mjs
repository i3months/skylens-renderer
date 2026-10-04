// 실제 송출 경로 바이트 측정(T11.11, F-187 ③).
// 합성 장면 → server/asset/pack(.skla 조각) → server/scheduler(createScheduler 공개 서명) → server/proto/codec(PIECE)
//   → server/ws/frame(encodeFrame 실제 프레임)의 바이트 길이를 장부에 기록한다. 손으로 적은 숫자는 없다.
// 이 파일은 scheduler·codec·frame 을 import 만 하고 고치지 않는다.

import { generate as generateLevels, levelCloud } from '../../fixtures/scenes/levels/index.mjs';
import { packChunk } from '../../server/asset/pack/index.mjs';
import { createScheduler } from '../../server/scheduler/index.mjs';
import { encodeMessage } from '../../server/proto/codec/index.mjs';
import { encodeFrame, OPCODES } from '../../server/ws/frame/index.mjs';
import { FORMAT_POINT27, TILE_SIZE_M } from '../../contracts/asset/index.mjs';
import { createByteLedger, SEGMENT_BUDGET_BYTES } from './index.mjs';

// 조각 하나의 최대 점 수. 27 B 점 2만 개 = 약 0.2 MB 로 한 PIECE 가 본문 상한(4,194,304 B)에 한참 못 미친다.
export const MAX_POINTS_PER_CHUNK = 20000;
// 틱당 송출 예산(B). 스케줄러 배치 크기만 정하고 총 바이트에는 영향이 없다.
export const BUDGET_BYTES_PER_TICK = 1_000_000;
// 합성 장면 기본값: levels 장면 구간 N 개, 구간 최고 수준 점 수.
export const DEFAULT_SEGMENTS = 4;
export const DEFAULT_POINTS_PER_SEGMENT = 100000;
export const DEFAULT_SEED = 1;

const ANCHOR = { lat: 0, lon: 0, alt: 0 };

/** 장면 좌표(x=동, y=위, z=-북) → ENU(동, 북, 위). server/scheduler/initial/testing 의 sceneToEnu 와 같은 규칙이다. */
const sceneToEnu = (a, i) => [a[3 * i], -a[3 * i + 2], a[3 * i + 1]];

/**
 * 장면 좌표 점군(27 B)을 ENU 로 바꾼 뒤 packChunk 가 받아들이는 타일(동·북 인덱스 기준, packChunk 와 같다)별로 나눠 .skla 조각 목록을 만든다.
 * 타일은 ENU 의 (동, 북) 으로 정한다. 장면 구간의 북쪽 [-50, 50] m 는 tileY ∈ {-1, 0} 을 덮는다.
 * @returns {{key: {segmentId:number, level:number, lod:number, chunkIndex:number, tileX:number, tileY:number}, skla: Uint8Array}[]}
 */
export function packCloudPieces(cloud, { segmentId, level, maxPoints = MAX_POINTS_PER_CHUNK }) {
  const groups = new Map();
  for (let i = 0; i < cloud.count; i++) {
    const [e, n] = sceneToEnu(cloud.positions, i);
    const tx = Math.floor(e / TILE_SIZE_M);
    const ty = Math.floor(n / TILE_SIZE_M);
    const id = `${tx}:${ty}`;
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { tx, ty, idx: [] }));
    g.idx.push(i);
  }
  const pieces = [];
  let chunkIndex = 0;
  for (const g of [...groups.values()].sort((a, b) => a.tx - b.tx || a.ty - b.ty)) {
    for (let s = 0; s < g.idx.length; s += maxPoints) {
      const part = g.idx.slice(s, s + maxPoints);
      const n = part.length;
      const positions = new Float32Array(3 * n);
      const normals = new Float32Array(3 * n);
      const colors = new Uint8Array(3 * n);
      part.forEach((src, k) => {
        positions.set(sceneToEnu(cloud.positions, src), 3 * k);
        normals.set(sceneToEnu(cloud.normals, src), 3 * k);
        for (let a = 0; a < 3; a++) colors[3 * k + a] = cloud.colors[3 * src + a];
      });
      const skla = packChunk({
        format: FORMAT_POINT27, segmentId, level, lod: 0, chunkIndex, anchor: ANCHOR,
        fields: { positions, normals, colors },
      });
      pieces.push({ key: { segmentId, level, lod: 0, chunkIndex, tileX: g.tx, tileY: g.ty }, skla });
      chunkIndex++;
    }
  }
  return pieces;
}

const keyText = (k) => `${k.segmentId}:${k.level}:${k.lod}:${k.chunkIndex}:${k.tileX}:${k.tileY}`;

/**
 * 합성 장면(levels)의 구간 조각을 실제 송출 경로로 흘려 프레임 바이트를 장부에 기록한다.
 * 수준 0..3 을 낮은 수준부터 한 수준씩 큐에 넣고 비울 때까지 nextBatch 를 부른다(낮은 수준부터 오름차순으로 넣으므로, 스케줄러가 나간 최고 수준을 기억해도(F-190) 거절되는 항목은 없다).
 * @param {{segments?: number, pointsPerSegment?: number, seed?: number, budgetBytesPerTick?: number, onFrame?: (frame: Uint8Array, key: object, skla: Uint8Array) => void}} [opts]
 * @returns {{ledger: ReturnType<typeof createByteLedger>, rows: {segmentId:number, pieces:number, sklaBytes:number, frameBytes:number}[]}}
 */
export function measureSyntheticScene(opts = {}) {
  const segments = opts.segments ?? DEFAULT_SEGMENTS;
  const scene = generateLevels({ seed: opts.seed ?? DEFAULT_SEED, segments, count: opts.pointsPerSegment ?? DEFAULT_POINTS_PER_SEGMENT });
  const scheduler = createScheduler({ budgetBytesPerTick: opts.budgetBytesPerTick ?? BUDGET_BYTES_PER_TICK });
  const ledger = createByteLedger();
  const rows = [];
  let pieceSeq = 1;

  for (let segmentId = 0; segmentId < segments; segmentId++) {
    const row = { segmentId, pieces: 0, sklaBytes: 0, frameBytes: 0 };
    for (let level = 0; level < 4; level++) {
      const pieces = packCloudPieces(levelCloud(scene, segmentId, level), { segmentId, level });
      const byKey = new Map();
      for (const p of pieces) {
        byKey.set(keyText(p.key), p.skla);
        scheduler.enqueue({ key: p.key, bytes: p.skla.length, priority: 0, level });
      }
      for (let batch = scheduler.nextBatch(); batch.length > 0; batch = scheduler.nextBatch()) {
        for (const item of batch) {
          const skla = byKey.get(keyText(item.key));
          const payload = encodeMessage({ type: 'PIECE', pieceSeq: pieceSeq++, key: item.key, chunk: skla });
          const frame = encodeFrame(OPCODES.BINARY, payload);
          ledger.record(frame.length, { segmentId, phase: 'segment' });
          opts.onFrame?.(frame, item.key, skla);
          row.pieces++;
          row.sklaBytes += skla.length;
          row.frameBytes += frame.length;
        }
      }
    }
    rows.push(row);
  }
  return { ledger, rows };
}

/**
 * 구간별 표(구간 | 조각 수 | 프레임 바이트 | 3,000,000 B 대비 % | 판정). 초과 구간은 미달로 표시한다.
 * @param {{segmentId:number, pieces:number, frameBytes:number}[]} rows
 */
export function formatSegmentTable(rows, budget = SEGMENT_BUDGET_BYTES) {
  const lines = [`구간\t조각\t프레임바이트\t예산%(${budget} B)\t판정`];
  for (const r of rows) {
    const pct = (Math.round((r.frameBytes / budget) * 10000) / 100).toFixed(2);
    const verdict = r.frameBytes <= budget ? '충족' : `미달(초과 ${r.frameBytes - budget} B)`;
    lines.push(`${r.segmentId}\t${r.pieces}\t${r.frameBytes}\t${pct}%\t${verdict}`);
  }
  return lines.join('\n');
}
