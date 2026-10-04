// F-259 ②: makeRoom 의 새 key 거부 비용. 상주 N 조각이 모두 그리는 조각일 때 서로 다른 도착 key 300 개를 연속으로 거부시키고
// testHooks.selectDrawable 호출 수와 시간을 잰다. npm test 밖(node bench/room_reject_bench.mjs [N] [거부 수]).
// select 호출 수는 N 과 거부 수에 관계없이 상수(0~1)여야 한다. 시간은 참고용이다.
import { createRenderer } from '../client/raster/index.mjs';
import { selectDrawable, FORMAT_POINT27 } from '../contracts/client_raster/index.mjs';

// F-262: node bench/room_reject_bench.mjs f262 [N...] 은 한도 가득 상태의 연속 업로드(희생 1개 뒤 성공) 시간을 N 별로 잰다.
const F262 = process.argv[2] === 'f262';
const N = Number(F262 ? 4000 : (process.argv[2] ?? 4000));
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


// F-262: 상주 N 중 절반은 도착 밖(희생 후보), 절반은 도착 조각(보호). 한도 가득. 도착 집합의 새 key 1000 개를 연속 업로드한다.
// 매번 희생 1개를 해제한 뒤 성공한다. 업로드 성공마다 meta 가 바뀌어도 시간이 N 에 거의 선형이어야 하고 select 호출은 0 이어야 한다.
async function f262(n, uploads = 1000) {
  let calls = 0;
  const r = createRenderer({
    canvas, decode, maxPieceBytes: 1 << 10, maxResidentBytes: n * 17, now: () => 0,
    testHooks: { selectDrawable: (k, a) => { calls += 1; return selectDrawable(k, a); } },
  });
  r.setView({ R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0], K: { fx: 20, fy: 20, cx: 16.5, cy: 12.5 }, width: 32, height: 24, devicePixelRatio: 1 });
  const inside = [];
  for (let i = 0; i < n; i++) {
    const k = i % 2 === 0 ? `4.1.${i}.0.0.0` : `3.1.${i}.0.0.0`; // 짝수: 도착 밖, 홀수: 도착 조각(타일마다 lod0 chunk 1개)
    if (i % 2 === 1) inside.push(k);
    await r.uploadPiece(k, enc(k));
  }
  const fresh = Array.from({ length: uploads }, (_, i) => `3.1.${n + i}.0.0.0`);
  r.setArrived([{ segmentId: 3, level: 1, keys: [...inside, ...fresh] }], { deferResult: true });
  r.draw();
  calls = 0;
  const t0 = process.hrtime.bigint();
  let evicted = 0;
  for (const k of fresh) {
    await r.uploadPiece(k, enc(k));
    evicted += 1;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`F-262 N=${n} 연속 업로드 ${evicted}개: select 호출 ${calls}, ${ms.toFixed(1)} ms`);
  r.dispose();
}
if (F262) {
  const sizes = process.argv.length > 3 ? process.argv.slice(3).map(Number) : [2000, 4000, 8000];
  for (const n of sizes) await f262(n);
  process.exit(0);
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
