// F-265 ①: roomResidentChange 의 제거 갈래(releasePiece·희생 해제)도 타일의 chosen 과 base 를 다시 계산하는지 본다.
// 변이 대상: 제거 갈래에서만 chosen 재계산을 빼는 변이, `if (!added) return;` 변이. 퇴출 key 를 selectDrawable 의 draw 집합과 맞대어 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from './index.mjs';
import { selectDrawable, FORMAT_POINT27 } from '../../contracts/client_raster/index.mjs';

const POINT_BYTES = 17;
function fakeCanvas() {
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
  return { width: 300, height: 150, getContext: () => gl, addEventListener() {}, removeEventListener() {} };
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
  const evicted = [];
  const calls = { select: 0 };
  const r = createRenderer({
    canvas: fakeCanvas(), decode, maxPieceBytes: 1 << 10, maxResidentBytes: maxPieces * POINT_BYTES, now: () => 0,
    onEvict: (k) => evicted.push(...k),
    testHooks: { selectDrawable: (k, a) => { calls.select += 1; return selectDrawable(k, a); } },
  });
  r.setView(VIEW);
  return { r, evicted, calls, up: (k) => r.uploadPiece(k, enc(k)) };
}


const F = '4.1.9.0.0.0'; // 도착 밖: 첫 희생
const A = '3.1.0.0.0.0'; // 타일 T 의 lod0 chunk0
const C = '3.1.0.0.0.1'; // T 의 lod0 chunk1: A·C 가 모이면 lod0 가 완전해 A·C 를 그린다
const B = '3.1.0.0.1.0'; // T 의 lod1: lod0 가 완전한 동안은 그리지 않는다
const D = '3.1.1.0.0.0';
const E = '3.1.2.0.0.0';
const G = '3.1.3.0.0.0';
const ARRIVED = [{ segmentId: 3, level: 1, keys: [A, C, B, D, E, G] }];

for (const deferred of [true, false]) {
  test(`F-265 ①: releasePiece 로 lod0 가 깨지면 보호가 B 로 옮겨 가 A 를 퇴출한다 (deferred=${deferred})`, async () => {
    const { r, evicted, up } = make(4);
    for (const k of [F, A, C, B]) await up(k);
    r.setArrived(ARRIVED, deferred ? { deferResult: true } : undefined);
    r.draw();
    await up(D); // 도착 밖 F 가 희생(roomCache 의 resident 가 이때 만들어진다)
    assert.deepEqual(evicted, [F]);
    r.releasePiece(C); // 제거 갈래: T 의 lod0 가 불완전해져 chosen 이 lod1(B)로 바뀐다
    await up(E); // 자리가 있어 퇴출 없음
    assert.deepEqual(evicted, [F]);
    evicted.length = 0;
    const expectDraw = new Set(selectDrawable([...r.residentKeys(), G], ARRIVED).draw);
    assert.deepEqual([...expectDraw].sort(), [B, D, E, G].sort());
    await up(G);
    for (const v of evicted) assert.equal(expectDraw.has(v), false, `그려야 할 ${v} 를 퇴출함`);
    assert.deepEqual(evicted, [A]);
    assert.deepEqual(r.residentKeys().sort(), [B, D, E, G].sort());
    r.dispose();
  });
}
