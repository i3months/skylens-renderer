// F-256 ②: makeRoom 이 희생을 해제한 뒤 pool.upload 가 createBuffer 실패('memory')로 던져도
// draw 는 해제된 key 를 가리키지 않고 남은 조각 중 가장 세밀한 LOD 를 그린다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from './index.mjs';
import { packChunk } from '../../server/asset/pack/index.mjs';
import { FORMAT_POINT27 } from '../../contracts/client_raster/index.mjs';

function fakeCanvas() {
  const state = { failCreate: false, live: 0 };
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
const C0 = '3.1.0.0.1.0'; // 성긴 LOD(lod 1, 완전): 처음에 그려지는 조각
const V1 = '3.1.0.0.0.0'; // 세밀한 LOD(lod 0) 첫 chunk
const N1 = '3.1.0.0.0.1'; // 세밀한 LOD 둘째 chunk (올리는 중 실패)

for (const deferResult of [false, true]) {
  test(`createBuffer 실패 시 draw 가 남은 완전한 LOD 를 그림 (deferResult=${deferResult})`, async () => {
    const { canvas, state } = fakeCanvas();
    const evicted = [];
    const r = createRenderer({ canvas, maxPieceBytes: 1 << 20, maxResidentBytes: 34, now: () => 1, onEvict: (k) => evicted.push(...k) });
    r.setView(VIEW);
    await r.uploadPiece(C0, piece(C0));
    await r.uploadPiece(V1, piece(V1));
    r.setArrived([{ segmentId: 3, level: 1, keys: [C0, V1, N1] }], deferResult ? { deferResult: true } : undefined);
    // 세밀한 LOD 가 덜 상주해 완전한 성긴 LOD 가 그려진다
    assert.equal(r.draw().drawnPieces, 1);

    state.failCreate = true;
    await assert.rejects(r.uploadPiece(N1, piece(N1)), (e) => e.code === 'memory');
    state.failCreate = false;
    assert.deepEqual(evicted, [C0]); // 희생은 이미 해제됨

    // 해제된 C0 를 가리키지 않고 남은 조각(V1)을 그린다
    const s = r.draw();
    assert.equal(s.drawnPieces, 1);
    assert.equal(s.drawnPoints, 1);
    r.dispose();
  });
}
