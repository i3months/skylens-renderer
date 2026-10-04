// F-266 ①: VAO 배선 중 vertexAttribPointer 가 던지면 반쯤 배선된 VAO 가 캐시에 남지 않고, 다음 draw 가 다시 배선하며,
// 예외로 끝난 draw 도 묶인 VAO 를 null 로 풀어 둔다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from './index.mjs';
import { packChunk } from '../../server/asset/pack/index.mjs';
import { FORMAT_POINT27 } from '../../contracts/client_raster/index.mjs';

function fakeCanvas(options = {}) {
  const state = { failPointer: false, failCleanup: false, pointerCalls: 0, bound: null, vaoSeq: 0, deletedVaos: [], ...options };
  const base = {
    getShaderParameter: () => true, getProgramParameter: () => true, createShader: () => ({}), createProgram: () => ({}),
    createVertexArray: () => ({ id: ++state.vaoSeq }), getUniformLocation: (_p, name) => ({ name }),
    getParameter: () => [1, 1024], isContextLost: () => false,
    createBuffer: () => ({ live: true }),
    deleteBuffer() {}, bufferData() {},
    bindBuffer() {},
    deleteVertexArray(v) {
      // deleteVertexArray 호출을 기록한다
      state.deletedVaos.push(v?.id ?? v);
      if (state.failCleanup) throw new Error('deleteVertexArray cleanup failed');
    },
    bindVertexArray(v) {
      state.bound = v;
      if (state.failCleanup && v === null) throw new Error('bindVertexArray(null) cleanup failed');
    },
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

test('배선 중 vertexAttribPointer 예외: 반쯤 배선된 VAO 를 삭제한다', async () => {
  const f = fakeCanvas();
  const r = createRenderer({ canvas: f.canvas, maxPieceBytes: 1 << 20, maxResidentBytes: 1 << 20, now: () => 1 });
  r.setView(VIEW);
  await r.uploadPiece(K1, piece(K1));
  r.setArrived([{ segmentId: 3, level: 1, keys: [K1] }]);

  // 초기화 중 삭제된 VAO들(없어야 함)
  assert.equal(f.state.deletedVaos.length, 0, '초기화 중에는 VAO가 삭제되지 않음');
  f.state.failPointer = true;
  assert.throws(() => r.draw(), /vertexAttribPointer failed/);
  // 배선 중 예외가 나면 그 VAO 는 deleteVertexArray 로 즉시 삭제된다
  const deletedAfterFail = f.state.deletedVaos;
  // 반쯤 배선된 VAO 를 캐시에 넣지 않으므로 그것을 삭제해야 한다
  const pieceVaoId = f.state.vaoSeq; // 마지막으로 생성된 VAO id
  assert.ok(deletedAfterFail.includes(pieceVaoId), `반쯤 배선된 piece VAO(id=${pieceVaoId}) 가 삭제됨. 삭제된 id: [${deletedAfterFail}]`);
  r.dispose();
});

test('배선 중 정리 중 예외: 원래 배선 오류가 보존된다', async () => {
  // deleteVertexArray 와 bindVertexArray(null) 이 던질 때도, 원래 배선 오류가 보존되는지 확인한다
  const f = fakeCanvas();
  const r = createRenderer({ canvas: f.canvas, maxPieceBytes: 1 << 20, maxResidentBytes: 1 << 20, now: () => 1 });
  r.setView(VIEW);
  await r.uploadPiece(K1, piece(K1));
  r.setArrived([{ segmentId: 3, level: 1, keys: [K1] }]);

  f.state.failPointer = true;
  f.state.failCleanup = true;
  let thrown;
  try {
    r.draw();
    assert.fail('draw() 는 예외를 던져야 함');
  } catch (err) {
    thrown = err;
  }
  // 배선 중 예외가 나고, finally 에서 정리(bindVertexArray(null), deleteVertexArray) 중 예외가 나도
  // 원래 배선 오류가 보존되어야 한다(정리 예외가 덮지 않음)
  assert.match(thrown.message, /vertexAttribPointer failed/, '원래 오류(vertexAttribPointer failed) 가 보존됨');
  f.state.failCleanup = false; // dispose 가 성공하도록 정리 예외를 끈다
  r.dispose();
});
