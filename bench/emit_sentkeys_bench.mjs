// F-277 ④: emit 의 sentKeys 정리 비용. 정리 전 sentKeys 크기 N 에서 시작해 LEVEL_ARRIVED 당 시간을 두 흐름으로 잰다.
//   'old' : 오래된 창부터 끝난다(미결 N 이 남는다)   'new' : 방금 보낸 새 창이 끝난다(창 끝 이하 전부 정리되므로
//           첫 LA 에서 큐가 전부 비워지고, 이후는 미결 N 이 아니라 거의 빈 큐에서 잰다)
// npm test 밖: node bench/emit_sentkeys_bench.mjs [emit 모듈 경로(기본 ../server/ws/session/emit.mjs)]
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export const W = 4; // 창당 조각 수
const CHUNK = 500;

/** 한 흐름의 LA 당 평균 µs. N 개를 미리 채운 뒤 iters 번 (새 창 W 조각 + LA 1) 을 돈다. */
export function measure(createRecordingEmit, flow, N, iters) {
  const store = { recordSent: () => true, recordLevelArrived: () => true };
  const emit = createRecordingEmit({ store, sessionId: 1, send() {}, encode: () => new Uint8Array(1), minPieceSeq: () => 0 });
  const key = (s) => ({ segmentId: 1, level: 0, lod: 0, chunkIndex: s, tileX: 0, tileY: 0 });
  let seq = 1;
  const piece = () => { emit({ type: 'PIECE', key: key(seq), pieceSeq: seq, chunk: null }); seq++; };
  for (let i = 0; i < N; i++) piece();
  let oldest = 1;
  // 부하가 있는 기계에서도 흔들리지 않게 iters 를 조각(CHUNK)으로 나눠 가장 빠른 조각의 평균을 쓴다.
  let best = Infinity;
  let t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) {
    const first = seq;
    for (let j = 0; j < W; j++) piece();
    if (flow === 'new') emit({ type: 'LEVEL_ARRIVED', segmentId: 1, level: 0, firstPieceSeq: first, pieceCount: W });
    else { emit({ type: 'LEVEL_ARRIVED', segmentId: 1, level: 0, firstPieceSeq: oldest, pieceCount: W }); oldest += W; }
    if ((i + 1) % CHUNK === 0) {
      const t1 = process.hrtime.bigint();
      best = Math.min(best, Number(t1 - t0) / 1000 / CHUNK);
      t0 = t1;
    }
  }
  return best;
}

export const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const mod = process.argv[2] ?? new URL('../server/ws/session/emit.mjs', import.meta.url).href;
  const { createRecordingEmit } = await import(mod.startsWith('file:') ? mod : pathToFileURL(path.resolve(mod)).href);
  const iters = 20000;
  for (const N of [1000, 10000, 60000]) {
    const r = {};
    for (const flow of ['old', 'new']) {
      measure(createRecordingEmit, flow, N, 2000); // 예열
      r[flow] = median(Array.from({ length: 7 }, () => measure(createRecordingEmit, flow, N, iters)));
    }
    console.log(`N=${N}  old-first ${r.old.toFixed(2)} us/LA  new-only ${r.new.toFixed(2)} us/LA  ratio ${(r.old / r.new).toFixed(2)}`);
  }
}
