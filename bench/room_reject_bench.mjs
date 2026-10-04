// F-259 ②: makeRoom 의 새 key 거부 비용. 상주 N 조각이 모두 그리는 조각일 때 서로 다른 도착 key 300 개를 연속으로 거부시키고
// testHooks.selectDrawable 호출 수와 시간을 잰다. npm test 밖(node bench/room_reject_bench.mjs [N] [거부 수]).
// select 호출 수는 N 과 거부 수에 관계없이 상수(0~1)여야 한다. 시간은 참고용이다.
import { createRenderer } from '../client/raster/index.mjs';
import { selectDrawable, FORMAT_POINT27 } from '../contracts/client_raster/index.mjs';

const N = Number(process.argv[2] ?? 4000);
const REJECTS = Number(process.argv[3] ?? 300);

const base = {
  createBuffer: () => ({}), deleteBuffer() {}, getShaderParameter: () => true, getProgramParameter: () => true,
  createShader: () => ({}), createProgram: () => ({}), createVertexArray: () => ({}),
  getUniformLocation: (_p, name) => ({ name }), getParameter: (p) => (p === 'ALIASED_POINT_SIZE_RANGE' ? [1, 1024] : 0),
  isContextLost: () => false,
};
const gl = new Proxy(base, {
  get(t, p) {
    if (p in t) return t[p];
    if (typeof p === 'string' && /^[A-Z_0-9]+$/.test(p)) return p;
    return () => {};
  },
});
const canvas = { width: 300, height: 150, getContext: () => gl, addEventListener() {}, removeEventListener() {} };
const enc = (key) => new TextEncoder().encode(key);
function decode(bytes) {
  const [segmentId, level, tileX, tileY, lod, chunkIndex] = new TextDecoder().decode(bytes).split('.').map(Number);
  return {
    header: { format: FORMAT_POINT27, segmentId, level, tileX, tileY, lod, chunkIndex, pointCount: 1, bboxMin: [0, 0, 1], quantExp: 0 },
    planes: {
      pos_e: new Int32Array(1), pos_n: new Int32Array(1), pos_u: new Int32Array(1),
      color_r: Uint8Array.of(9), color_g: Uint8Array.of(9), color_b: Uint8Array.of(9),
      normal_oct_x: new Int8Array(1), normal_oct_y: new Int8Array(1),
    },
  };
}

let selectCalls = 0;
const r = createRenderer({
  canvas, decode, maxPieceBytes: 1 << 10, maxResidentBytes: N * 17, now: () => 0,
  testHooks: { selectDrawable: (k, a) => { selectCalls += 1; return selectDrawable(k, a); } },
});
r.setView({ R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0], K: { fx: 20, fy: 20, cx: 16.5, cy: 12.5 }, width: 32, height: 24, devicePixelRatio: 1 });

const resident = Array.from({ length: N }, (_, i) => `3.1.${i}.0.0.0`); // 타일마다 lod0 chunk 1개: 모두 완전해서 그린다
const fresh = Array.from({ length: REJECTS }, (_, i) => `3.1.${N + i}.0.0.0`); // 상주 없는 타일의 도착 key
const sameTile = Array.from({ length: REJECTS }, (_, i) => `3.1.0.0.0.${i + 1}`); // 상주 key 와 같은 타일의 도착 key
for (const k of resident) await r.uploadPiece(k, enc(k));
r.setArrived([{ segmentId: 3, level: 1, keys: [...resident, ...fresh, ...sameTile] }], { deferResult: true });
r.draw();

for (const [name, keys] of [['서로 다른 타일의 새 key', fresh], ['같은 타일의 새 chunk', sameTile]]) {
  selectCalls = 0;
  const t0 = process.hrtime.bigint();
  let rejected = 0;
  for (const k of keys) {
    try { await r.uploadPiece(k, enc(k)); } catch (e) { if (e.code === 'memory') rejected += 1; else throw e; }
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`N=${N} ${name} ${keys.length}개: 거부 ${rejected}, select 호출 ${selectCalls}, ${ms.toFixed(1)} ms`);
}
r.dispose();
