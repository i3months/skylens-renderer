// F-265 ③: 문맥 소실로 meta.clear 가 불릴 때 roomCache 도 비우는지 본다(비우지 않으면 소실 전 상주가 resident 표에 남는다).
// 변이 대상: clear 안의 roomCache = null 삭제.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from './index.mjs';
import { selectDrawable, FORMAT_POINT27 } from '../../contracts/client_raster/index.mjs';

const POINT_BYTES = 17;
function fakeCanvas() {
  let lostFlag = false;
  const base = {
    createBuffer: () => ({}), deleteBuffer() {}, getShaderParameter: () => true, getProgramParameter: () => true,
    createShader: () => ({}), createProgram: () => ({}), createVertexArray: () => ({}),
    getUniformLocation: (_p, name) => ({ name }), getParameter: (p) => (p === 'ALIASED_POINT_SIZE_RANGE' ? [1, 1024] : 0),
    isContextLost: () => lostFlag,
  };
  const gl = new Proxy(base, {
    get(t, p) {
      if (p in t) return t[p];
      if (typeof p === 'string' && /^[A-Z_0-9]+$/.test(p)) return p;
      return () => {};
    },
  });
  const ls = new Map();
  return {
    width: 300, height: 150, getContext: () => gl,
    addEventListener(t, f) { if (!ls.has(t)) ls.set(t, new Set()); ls.get(t).add(f); },
    removeEventListener(t, f) { ls.get(t)?.delete(f); },
    fire(t) { // recovery_fail.test.mjs 와 같은 방식으로 문맥 소실·복구를 흉내 낸다
      if (t === 'webglcontextlost') lostFlag = true;
      if (t === 'webglcontextrestored') lostFlag = false;
      for (const f of [...(ls.get(t) ?? [])]) f({ preventDefault() {} });
    },
  };
}
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
const VIEW = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0], K: { fx: 20, fy: 20, cx: 16.5, cy: 12.5 }, width: 32, height: 24, devicePixelRatio: 1 };
function make(maxPieces) {
  const canvas = fakeCanvas();
  const evicted = [];
  const calls = { select: 0 };
  const r = createRenderer({
    canvas, decode, maxPieceBytes: 1 << 10, maxResidentBytes: maxPieces * POINT_BYTES, now: () => 0,
    onEvict: (k) => evicted.push(...k),
    testHooks: { selectDrawable: (k, a) => { calls.select += 1; return selectDrawable(k, a); } },
  });
  r.setView(VIEW);
  return { r, canvas, evicted, calls, up: (k) => r.uploadPiece(k, enc(k)) };
}


const A0 = '3.1.0.0.0.0'; // 타일 T 의 lod0 chunk0
const A1 = '3.1.0.0.0.1'; // T 의 lod0 chunk1: 둘이 모이면 lod0 가 완전하다
const B = '3.1.0.0.1.0'; // T 의 lod1: 소실 뒤엔 T 의 유일한 상주라 그려야 한다
const Z = '3.1.1.0.0.0';
const W = '3.1.2.0.0.0';
const X = '3.1.3.0.0.0';
const ARRIVED = [{ segmentId: 3, level: 1, keys: [A0, A1, B, Z, W, X] }];

for (const deferred of [true, false]) {
  test(`F-265 ③: 문맥 소실·복구 뒤 새 key 거부는 소실 전 resident 표를 쓰지 않는다 (deferred=${deferred})`, async () => {
    const { r, canvas, evicted, up } = make(2);
    await up(A0);
    await up(A1);
    r.setArrived(ARRIVED, deferred ? { deferResult: true } : undefined);
    r.draw();
    await assert.rejects(up(X), (e) => e.code === 'memory'); // A0·A1 모두 그리는 조각: roomCache 가 만들어진다
    canvas.fire('webglcontextlost');
    canvas.fire('webglcontextrestored');
    assert.deepEqual(r.residentKeys(), []);
    await up(B);
    await up(Z);
    // 소실 뒤 상주는 B·Z 뿐이고 둘 다 그린다. 옛 resident 표가 남으면 T 의 lod0 가 완전하다고 보아 B 를 내보낸다
    const expectDraw = new Set(selectDrawable([B, Z, W], ARRIVED).draw);
    assert.deepEqual([...expectDraw].sort(), [B, W, Z].sort());
    await assert.rejects(up(W), (e) => e.code === 'memory');
    assert.deepEqual(evicted, []);
    assert.deepEqual(r.residentKeys().sort(), [B, Z].sort());
    r.dispose();
  });
}
