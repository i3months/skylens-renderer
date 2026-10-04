// F-266 ①: VAO 배선 중 vertexAttribPointer 가 던지면 반쯤 배선된 VAO 가 캐시에 남지 않고, 다음 draw 가 다시 배선하며,
// 예외로 끝난 draw 도 묶인 VAO 를 null 로 풀어 둔다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from './index.mjs';
import { packChunk } from '../../server/asset/pack/index.mjs';
import { FORMAT_POINT27 } from '../../contracts/client_raster/index.mjs';

function fakeCanvas() {
  const state = { failPointer: false, pointerCalls: 0, bound: null, vaoSeq: 0 };
  const base = {
    getShaderParameter: () => true, getProgramParameter: () => true, createShader: () => ({}), createProgram: () => ({}),
    createVertexArray: () => ({ id: ++state.vaoSeq }), getUniformLocation: (_p, name) => ({ name }),
    getParameter: () => [1, 1024], isContextLost: () => false,
    createBuffer: () => ({ live: true }),
    deleteBuffer() {}, bindBuffer() {}, bufferData() {},
    bindVertexArray(v) { state.bound = v; },
    vertexAttribPointer() {
      state.pointerCalls += 1;
      if (state.failPointer) throw new Error('vertexAttribPointer failed');
    },
  };
  const gl = new Proxy(base, {
    get(t, p) {
      if (p in t) return t[p];
      if (typeof p === 'string' && /^[A-Z_0-9]+$/.test(p)) return p;
      return () => {};
    },
  });
  const canvas = { width: 300, height: 150, getContext: (k) => (k === 'webgl2' ? gl : null), addEventListener() {}, removeEventListener() {} };
  return { canvas, state };
}

function piece(key) {
  const [segmentId, level, , , lod, chunkIndex] = key.split('.').map(Number);
  return packChunk({
    format: FORMAT_POINT27, segmentId, level, lod, chunkIndex, anchor: { lat: 37.5, lon: 127, alt: 30 },
    fields: { positions: Float32Array.from([0.5, 0.5, 5]), colors: Uint8Array.from([200, 200, 200]), normals: Float32Array.from([0, 0, 1]) },
  });
}
const VIEW = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [-1, -1, 0], K: { fx: 20, fy: 20, cx: 16.5, cy: 12.5 }, width: 32, height: 24, devicePixelRatio: 1 };
const K1 = '3.1.0.0.0.0';

test('배선 중 vertexAttribPointer 예외: 다음 draw 가 다시 배선하고 묶인 VAO 는 null', async () => {
  const f = fakeCanvas();
  const r = createRenderer({ canvas: f.canvas, maxPieceBytes: 1 << 20, maxResidentBytes: 1 << 20, now: () => 1 });
  r.setView(VIEW);
  await r.uploadPiece(K1, piece(K1));
  r.setArrived([{ segmentId: 3, level: 1, keys: [K1] }]);

  f.state.failPointer = true;
  assert.throws(() => r.draw(), /vertexAttribPointer failed/);
  assert.equal(f.state.bound, null, '예외로 끝난 draw 뒤 묶인 VAO 는 null');
  const afterFail = f.state.pointerCalls;
  assert.equal(afterFail, 1, '첫 vertexAttribPointer 에서 던짐');

  f.state.failPointer = false;
  const res = r.draw();
  assert.ok(f.state.pointerCalls >= afterFail + 3, '다음 draw 에서 vertexAttribPointer 를 다시 호출(배선 재시도)');
  assert.equal(res.drawnPieces, 1);
  assert.equal(f.state.bound, null, '정상 draw 뒤에도 묶인 VAO 는 null');

  // 배선이 끝난 VAO 는 캐시되어 그다음 draw 에서는 다시 배선하지 않는다
  const calls = f.state.pointerCalls;
  r.draw();
  assert.equal(f.state.pointerCalls, calls);
  r.dispose();
});
