// F-259 ①: 시험 hook(onGlUploadStart/End·onDrawStart/End)이 던져도 렌더러 상태가 깨지지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from './index.mjs';
import { packChunk } from '../../server/asset/pack/index.mjs';
import { FORMAT_POINT27 } from '../../contracts/client_raster/index.mjs';

function fakeCanvas() {
  const state = { failCreate: false };
  const base = {
    getShaderParameter: () => true, getProgramParameter: () => true, createShader: () => ({}), createProgram: () => ({}),
    createVertexArray: () => ({}), getUniformLocation: (_p, name) => ({ name }),
    getParameter: () => [1, 1024], isContextLost: () => false,
    createBuffer: () => (state.failCreate ? null : { live: true }),
    deleteBuffer() {}, bindBuffer() {}, bufferData() {},
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

// 점 1개 형식 1 = 17 B
function piece(key) {
  const [segmentId, level, , , lod, chunkIndex] = key.split('.').map(Number);
  return packChunk({
    format: FORMAT_POINT27, segmentId, level, lod, chunkIndex, anchor: { lat: 37.5, lon: 127, alt: 30 },
    fields: { positions: Float32Array.from([0.5, 0.5, 5]), colors: Uint8Array.from([200, 200, 200]), normals: Float32Array.from([0, 0, 1]) },
  });
}
const VIEW = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [-1, -1, 0], K: { fx: 20, fy: 20, cx: 16.5, cy: 12.5 }, width: 32, height: 24, devicePixelRatio: 1 };
const K1 = '3.1.0.0.0.0';
const K2 = '3.1.0.0.0.1';
const K3 = '3.1.0.0.0.2';
const boom = () => { throw new Error('hook boom'); };

function make(testHooks) {
  const f = fakeCanvas();
  const evicted = [];
  const r = createRenderer({ canvas: f.canvas, maxPieceBytes: 1 << 20, maxResidentBytes: 34, now: () => 1, onEvict: (k) => evicted.push(...k), testHooks });
  return { r, evicted, ...f };
}

test('onGlUploadEnd 가 던져도 업로드 뒤 residentKeys 와 memoryBytes 가 일치하고 K3 가 성공', async () => {
  const { r, evicted } = make({ onGlUploadEnd: boom });
  await r.uploadPiece(K1, piece(K1));
  await r.uploadPiece(K2, piece(K2));
  assert.deepEqual([...r.residentKeys()].sort(), [K1, K2]);
  assert.equal(r.memoryBytes(), 34);
  await r.uploadPiece(K3, piece(K3)); // 한도 34: 가장 오래된 것을 해제하고 성공
  assert.equal([...r.residentKeys()].length, 2);
  assert.equal(r.memoryBytes(), 34);
  assert.deepEqual(evicted, [K1]);
});

test('onGlUploadStart·End 가 모두 던져도 상태 일치', async () => {
  const { r } = make({ onGlUploadStart: boom, onGlUploadEnd: boom });
  await r.uploadPiece(K1, piece(K1));
  await r.uploadPiece(K2, piece(K2));
  await r.uploadPiece(K3, piece(K3));
  assert.equal([...r.residentKeys()].length, 2);
  assert.equal(r.memoryBytes(), 34);
});

test('pool.upload 실패와 hook 예외가 겹쳐도 원래 memory 오류 유지', async () => {
  const { r, state } = make({ onGlUploadEnd: boom, onGlUploadStart: boom });
  await r.uploadPiece(K1, piece(K1));
  await r.uploadPiece(K2, piece(K2));
  state.failCreate = true;
  await assert.rejects(r.uploadPiece(K3, piece(K3)), (e) => e.code === 'memory');
});

test('onGlUploadStart 예외 뒤에도 희생 해제 후 draw 가 drawnPieces 1', async () => {
  const C0 = '3.1.0.0.1.0'; // 성긴 LOD(완전): 처음에 그려지고 희생이 된다
  const { r, state, evicted } = make({ onGlUploadStart: boom });
  r.setView(VIEW);
  await r.uploadPiece(C0, piece(C0));
  await r.uploadPiece(K1, piece(K1));
  r.setArrived([{ segmentId: 3, level: 1, keys: [C0, K1, K2] }]);
  assert.equal(r.draw().drawnPieces, 1);
  state.failCreate = true;
  await assert.rejects(r.uploadPiece(K2, piece(K2)), (e) => e.code === 'memory');
  state.failCreate = false;
  assert.deepEqual(evicted, [C0]);
  assert.equal(r.draw().drawnPieces, 1); // 해제된 C0 가 아니라 남은 K1
});

test('onDrawStart·onDrawEnd 가 던져도 draw 결과가 나온다', async () => {
  const { r } = make({ onDrawStart: boom, onDrawEnd: boom });
  r.setView(VIEW);
  await r.uploadPiece(K1, piece(K1));
  r.setArrived([{ segmentId: 3, level: 1, keys: [K1] }]);
  assert.equal(r.draw().drawnPieces, 1);
  assert.equal(r.draw().drawnPieces, 1);
});
