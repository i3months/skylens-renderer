// F-245 ⑤: 복구 중 프로그램 재생성이 던지면 onContextRestored 의 둘째 인자(error)로 알리고,
// 이후 draw 는 그리지 않고(droppedFrames 증가) uploadPiece 는 'context' 로 거부하며, 다음 복구가 성공하면 다시 동작한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from './index.mjs';
import { packChunk } from '../../server/asset/pack/index.mjs';
import { FORMAT_POINT27 } from '../../contracts/client_raster/index.mjs';

function fakeCanvas() {
  const calls = [];
  let lostFlag = false;
  const base = {
    calls,
    createBuffer: () => ({}), deleteBuffer() {},
    getShaderParameter: () => true, getProgramParameter: () => true,
    createShader: () => ({}), createProgram: () => ({}),
    createVertexArray: () => ({}), getUniformLocation: (_p, name) => ({ name }),
    getParameter: () => [1, 1024],
    isContextLost: () => lostFlag,
    drawArrays(...a) { calls.push(['drawArrays', ...a]); },
  };
  const gl = new Proxy(base, {
    get(t, p) {
      if (p in t) return t[p];
      if (typeof p === 'string' && /^[A-Z_0-9]+$/.test(p)) return p;
      return () => {};
    },
  });
  const ls = new Map();
  const canvas = {
    width: 300, height: 150,
    getContext: (k) => (k === 'webgl2' ? gl : null),
    addEventListener(t, f) { if (!ls.has(t)) ls.set(t, new Set()); ls.get(t).add(f); },
    removeEventListener(t, f) { ls.get(t)?.delete(f); },
    fire(t) {
      if (t === 'webglcontextlost') lostFlag = true;
      if (t === 'webglcontextrestored') lostFlag = false;
      for (const f of [...(ls.get(t) ?? [])]) f({ preventDefault() {} });
    },
  };
  return { canvas, gl: base };
}

const K = '3.1.0.0.0.0';
const piece = () => packChunk({
  format: FORMAT_POINT27, segmentId: 3, level: 1, lod: 0, chunkIndex: 0,
  anchor: { lat: 37.5, lon: 127, alt: 30 },
  fields: {
    positions: Float32Array.from([0.5, 0.5, 5]), colors: Uint8Array.from([200, 200, 200]),
    normals: Float32Array.from([0, 0, 1]),
  },
});
const VIEW = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [-1, -1, 0], K: { fx: 20, fy: 20, cx: 16.5, cy: 12.5 }, width: 32, height: 24, devicePixelRatio: 1 };

test('복구 중 프로그램 재생성이 던지면 오류가 알려지고 draw 는 건너뛰며 다음 복구에서 되살아난다', async () => {
  const { canvas, gl } = fakeCanvas();
  const r = createRenderer({ canvas, maxPieceBytes: 1 << 20, maxResidentBytes: 1 << 20, now: () => 1 });
  await r.uploadPiece(K, piece());
  r.setView(VIEW);
  r.setArrived([{ segmentId: 3, level: 1, keys: [K] }]);
  assert.equal(r.draw().drawnPieces, 1);

  const seen = [];
  r.onContextRestored((keys, err) => seen.push({ keys, err }));
  canvas.fire('webglcontextlost');
  gl.createVertexArray = () => { throw new Error('vao boom'); };
  canvas.fire('webglcontextrestored');

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].keys, []);
  assert.equal(seen[0].err.code, 'context');
  assert.match(seen[0].err.message, /vao boom/);

  gl.calls.length = 0;
  const s1 = r.draw();
  const s2 = r.draw();
  assert.deepEqual([s1.drawnPieces, s1.drawnPoints, s2.droppedFrames - s1.droppedFrames], [0, 0, 1]);
  assert.equal(gl.calls.filter((c) => c[0] === 'drawArrays').length, 0);
  await assert.rejects(r.uploadPiece(K, piece()), (e) => e.code === 'context');

  // 다음 복구가 성공하면 소실 목록을 알리고 업로드·draw 가 다시 된다
  gl.createVertexArray = () => ({});
  canvas.fire('webglcontextlost');
  canvas.fire('webglcontextrestored');
  assert.deepEqual(seen[1], { keys: [K], err: undefined });
  await r.uploadPiece(K, piece());
  assert.equal(r.draw().drawnPieces, 1);
  r.dispose();
});

test('오류를 받는 콜백이 던져도 실패 상태는 유지된다', async () => {
  const { canvas, gl } = fakeCanvas();
  const r = createRenderer({ canvas, maxPieceBytes: 1 << 20, maxResidentBytes: 1 << 20, now: () => 1 });
  r.setView(VIEW);
  r.onContextRestored(() => { throw new Error('cb'); });
  canvas.fire('webglcontextlost');
  gl.createProgram = () => { throw new Error('prog boom'); };
  assert.throws(() => canvas.fire('webglcontextrestored'), /cb/);
  assert.equal(r.draw().drawnPieces, 0);
  await assert.rejects(r.uploadPiece(K, piece()), (e) => e.code === 'context');
  r.dispose();
});
