#!/usr/bin/env node
// F-253 ②: 지연 setArrived 1회 대 즉시 setArrived 1회 비용(10만 key). 벽시계 측정이라 npm test 에 넣지 않는다.
// 사용: node bench/arrived_check_bench.mjs [key 수=100000] [회차=15]
import { createRenderer } from '../client/raster/index.mjs';
import { checkArrived } from '../client/raster/arrived_check/index.mjs';
import { selectDrawable } from '../contracts/client_raster/index.mjs';

const N = Number(process.argv[2] ?? 100000);
const RUNS = Number(process.argv[3] ?? 15);
const base = {
  createBuffer: () => ({}), deleteBuffer() {}, getShaderParameter: () => true, getProgramParameter: () => true,
  createShader: () => ({}), createProgram: () => ({}), createVertexArray: () => ({}),
  getUniformLocation: (_p, name) => ({ name }), getParameter: (p) => (p === 'ALIASED_POINT_SIZE_RANGE' ? [1, 1024] : 0), isContextLost: () => false,
};
const gl = new Proxy(base, { get(t, p) { if (p in t) return t[p]; if (typeof p === 'string' && /^[A-Z_0-9]+$/.test(p)) return p; return () => {}; } });
const canvas = { width: 300, height: 150, getContext: () => gl, addEventListener() {}, removeEventListener() {} };
const r = createRenderer({ canvas, maxPieceBytes: 1 << 10, maxResidentBytes: 1 << 26, now: () => 0 });
const keys = Array.from({ length: N }, (_, i) => `1.1.${i % 400}.${(i / 400) | 0}.${i % 3}.${i % 7}`);
const list = [{ segmentId: 1, level: 1, keys }];

const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
function time(fn) {
  fn(); // 예열
  const ms = [];
  for (let i = 0; i < RUNS; i++) { const t = performance.now(); fn(); ms.push(performance.now() - t); }
  return median(ms);
}
const imm = time(() => r.setArrived(list));
const def = time(() => r.setArrived(list, { deferResult: true }));
const old = time(() => selectDrawable([], list));
const chk = time(() => checkArrived(list));
console.log(`keys=${N} runs=${RUNS} (median ms)`);
console.log(`immediate setArrived        ${imm.toFixed(1)}`);
console.log(`deferred setArrived (new)   ${def.toFixed(1)}  ratio ${(def / imm).toFixed(2)}`);
console.log(`old deferred check          ${old.toFixed(1)}  (selectDrawable([], list))`);
console.log(`checkArrived alone          ${chk.toFixed(1)}`);
