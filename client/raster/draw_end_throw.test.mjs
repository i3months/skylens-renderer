// F-264 ①: gl.drawArrays 가 던지면 원래 오류가 전파되고 onDrawStart/onDrawEnd 가 짝으로 1회씩 불린다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from './index.mjs';
import { packChunk } from '../../server/asset/pack/index.mjs';
import { FORMAT_POINT27 } from '../../contracts/client_raster/index.mjs';

function fakeCanvas() {
  const state = { failDrawArrays: false };
  const base = {
    getShaderParameter: () => true, getProgramParameter: () => true, createShader: () => ({}), createProgram: () => ({}),
    createVertexArray: () => ({}), getUniformLocation: (_p, name) => ({ name }),
    getParameter: () => [1, 1024], isContextLost: () => false,
    createBuffer: () => ({ live: true }),
    deleteBuffer() {}, bindBuffer() {}, bufferData() {},
    drawArrays() { if (state.failDrawArrays) throw new Error('drawArrays failed'); },
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

test('gl.drawArrays 가 던지면 원래 오류가 전파되고 onDrawStart/onDrawEnd 가 각각 1회 호출', async () => {
  let startCalls = 0;
  let endCalls = 0;
  const f = fakeCanvas();
  const r = createRenderer({
    canvas: f.canvas, maxPieceBytes: 1 << 20, maxResidentBytes: 34, now: () => 1,
    testHooks: {
      onDrawStart: () => { startCalls += 1; },
      onDrawEnd: () => { endCalls += 1; },
    },
  });
  r.setView(VIEW);
  await r.uploadPiece(K1, piece(K1));
  r.setArrived([{ segmentId: 3, level: 1, keys: [K1] }]);

  // 정상 draw: onDrawStart/onDrawEnd 각각 1회
  r.draw();
  assert.equal(startCalls, 1, 'onDrawStart called once on normal draw');
  assert.equal(endCalls, 1, 'onDrawEnd called once on normal draw');

  // gl.drawArrays 실패: 원래 오류가 전파되고 hook 도 호출됨
  f.state.failDrawArrays = true;
  try {
    r.draw();
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.message, 'drawArrays failed', 'original error propagates');
  }
  assert.equal(startCalls, 2, 'onDrawStart called on failed draw');
  assert.equal(endCalls, 2, 'onDrawEnd called even on failed draw');
});

test('gl.drawArrays 실패와 onDrawEnd 예외가 겹쳐도 원래 drawArrays 오류 유지', async () => {
  const f = fakeCanvas();
  const r = createRenderer({
    canvas: f.canvas, maxPieceBytes: 1 << 20, maxResidentBytes: 34, now: () => 1,
    testHooks: {
      onDrawEnd: () => { throw new Error('onDrawEnd failed'); },
    },
  });
  r.setView(VIEW);
  await r.uploadPiece(K1, piece(K1));
  r.setArrived([{ segmentId: 3, level: 1, keys: [K1] }]);

  f.state.failDrawArrays = true;
  try {
    r.draw();
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.message, 'drawArrays failed', 'original drawArrays error takes priority over onDrawEnd error');
  }
});
