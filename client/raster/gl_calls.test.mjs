// F-243 ⑧ 프레임당 GL 호출 수 시험. 가짜 gl 이 호출을 세고(걸음 수, 벽시계 아님), 조각 N = 1·10·100 에서
// 안정된 프레임의 조각별 호출이 정해진 개수로 고정되는지 단언한다.
//  - bindBuffer·vertexAttribPointer·enableVertexAttribArray: 프레임에서 0 (VAO 에 한 번 기록해 둠)
//  - drawArrays: N, bindVertexArray: 조각마다 1 + 마지막 해제 1 = N + 1
//  - u_shade 1i: 값이 바뀔 때만(전부 형식 1 이면 프레임 시작의 1 번뿐)
//  - 컨텍스트 복구 뒤 첫 프레임은 VAO 를 다시 만들고, 다음 프레임부터 다시 0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from './index.mjs';
import { packChunk } from '../../server/asset/pack/index.mjs';
import { FORMAT_POINT27, FORMAT_GAUSS56 } from '../../contracts/client_raster/index.mjs';

function fakeCanvas() {
  const calls = [];
  const base = {
    createBuffer: () => ({}),
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    createShader: () => ({}),
    createProgram: () => ({}),
    createVertexArray() { calls.push(['createVertexArray']); return {}; },
    getUniformLocation: (_p, name) => ({ name }),
    getParameter: (p) => (p === 'ALIASED_POINT_SIZE_RANGE' ? [1, 1024] : 0),
    isContextLost: () => false,
    uniform1i(loc, v) { calls.push(['uniform1i', loc && loc.name, v]); },
  };
  const gl = new Proxy(base, {
    get(t, p) {
      if (p in t) return t[p];
      if (typeof p === 'string' && /^[A-Z_0-9]+$/.test(p)) return p;
      return (...args) => { calls.push([p, ...args]); };
    },
  });
  const listeners = new Map();
  const canvas = {
    width: 300, height: 150,
    getContext: (kind) => (kind === 'webgl2' ? gl : null),
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    fire(type) { for (const fn of [...(listeners.get(type) ?? [])]) fn({ preventDefault() {} }); },
  };
  return { canvas, calls };
}

const ANCHOR = { lat: 37.5, lon: 127, alt: 30 };
const pieceOf = (format, i) => packChunk({
  format, segmentId: 1, level: 1, lod: 0, chunkIndex: i, anchor: ANCHOR,
  fields: format === FORMAT_POINT27
    ? { positions: Float32Array.from([1, 1, 5, 2, 2, 5]), colors: Uint8Array.from([1, 2, 3, 4, 5, 6]), normals: Float32Array.from([0, 0, 1, 0, 0, 1]) }
    : { positions: Float32Array.from([1, 1, 5]), fdc: new Float32Array(3), opacity: new Float32Array(1), scales: new Float32Array(3).fill(-3), rotations: Float32Array.from([1, 0, 0, 0]) },
});
const VIEW = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [-1, -1, 0], K: { fx: 20, fy: 20, cx: 16.5, cy: 12.5 }, width: 32, height: 24, devicePixelRatio: 1 };

async function scene(n, format = FORMAT_POINT27) {
  const f = fakeCanvas();
  const r = createRenderer({ canvas: f.canvas, maxPieceBytes: 1 << 20, maxResidentBytes: 1 << 28 });
  const keys = [];
  for (let i = 0; i < n; i += 1) {
    const key = `1.1.0.0.0.${i}`;
    keys.push(key);
    await r.uploadPiece(key, pieceOf(format, i));
  }
  r.setView(VIEW);
  r.setArrived([{ segmentId: 1, level: 1, keys }]);
  return { ...f, r };
}

const count = (calls, name) => calls.filter((c) => c[0] === name).length;

for (const n of [1, 10, 100]) {
  test(`프레임당 GL 호출: 조각 ${n} 개, 안정 프레임은 조각별 속성 배선 0`, async () => {
    const { r, calls } = await scene(n);
    assert.equal(r.draw().drawnPieces, n); // 첫 프레임: VAO 생성
    calls.length = 0;
    assert.equal(r.draw().drawnPieces, n);
    for (const name of ['bindBuffer', 'vertexAttribPointer', 'enableVertexAttribArray', 'disableVertexAttribArray', 'createVertexArray']) {
      assert.equal(count(calls, name), 0, name);
    }
    assert.equal(count(calls, 'drawArrays'), n);
    assert.equal(count(calls, 'bindVertexArray'), n + 1);
    assert.equal(count(calls, 'uniform1i'), 1, 'u_shade 는 프레임 시작 1 번뿐');
    assert.equal(count(calls, 'uniform3f'), n + 2, '프레임 시작 u_tgl·u_lightDir 2 + 조각별 u_tgl');
    r.dispose();
  });
}

test('첫 프레임은 조각마다 VAO 를 한 번 만들고 배선하며, 호출 수는 조각 수에 선형', async () => {
  const per = [];
  for (const n of [1, 10, 100]) {
    const { r, calls } = await scene(n);
    calls.length = 0; // 업로드·생성자 호출은 제외
    r.draw();
    per.push([count(calls, 'createVertexArray'), count(calls, 'bindBuffer') / n, count(calls, 'vertexAttribPointer') / n]);
    r.dispose();
  }
  for (const [vaos, binds, ptrs] of per) assert.deepEqual([vaos, binds, ptrs].slice(1), [3, 3]);
  assert.deepEqual(per.map((p) => p[0]), [1, 10, 100]);
});

test('u_shade 는 값이 바뀔 때만: 형식 1 → 형식 2 → 형식 2 는 프레임 1 + 전환 1', async () => {
  const f = fakeCanvas();
  const r = createRenderer({ canvas: f.canvas, maxPieceBytes: 1 << 20, maxResidentBytes: 1 << 28 });
  const fm = [FORMAT_POINT27, FORMAT_GAUSS56, FORMAT_GAUSS56];
  const keys = fm.map((_, i) => `1.1.0.0.0.${i}`);
  for (let i = 0; i < 3; i += 1) await r.uploadPiece(keys[i], pieceOf(fm[i], i));
  r.setView(VIEW);
  r.setArrived([{ segmentId: 1, level: 1, keys }]);
  r.draw();
  f.calls.length = 0;
  r.draw();
  assert.deepEqual(f.calls.filter((c) => c[0] === 'uniform1i').map((c) => c[2]), [1, 0]);
  r.dispose();
});

test('컨텍스트 복구 뒤 첫 프레임에 VAO 를 다시 만들고 다음 프레임부터 배선 0', async () => {
  const { r, calls, canvas } = await scene(5);
  r.draw();
  canvas.fire('webglcontextlost');
  let restored = null;
  r.onContextRestored((ks) => { restored = ks; });
  canvas.fire('webglcontextrestored');
  assert.ok(restored, '복구 알림');
  for (const k of restored) await r.uploadPiece(k, pieceOf(FORMAT_POINT27, Number(k.split('.').pop())));
  calls.length = 0;
  assert.equal(r.draw().drawnPieces, 5);
  assert.equal(count(calls, 'createVertexArray'), 5);
  assert.equal(count(calls, 'vertexAttribPointer'), 15);
  calls.length = 0;
  r.draw();
  assert.equal(count(calls, 'createVertexArray') + count(calls, 'vertexAttribPointer') + count(calls, 'bindBuffer'), 0);
  r.dispose();
});

test('해제한 조각의 VAO 는 지우고, 같은 key 재업로드는 새 VAO 로 바뀐다', async () => {
  const { r, calls } = await scene(3);
  r.draw();
  r.releasePiece('1.1.0.0.0.2');
  calls.length = 0;
  r.draw();
  assert.equal(count(calls, 'deleteVertexArray'), 1);
  r.dispose();
});
