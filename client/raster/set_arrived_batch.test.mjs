// F-248 ④ 시험: setArrived 지연 경로. 걸음 수(selectDrawable 호출 수)로 센다(벽시계 아님).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from './index.mjs';
import { selectDrawable, FORMAT_POINT27 } from '../../contracts/client_raster/index.mjs';

function fakeCanvas() {
  const base = {
    createBuffer: () => ({}), deleteBuffer() {},
    getShaderParameter: () => true, getProgramParameter: () => true,
    createShader: () => ({}), createProgram: () => ({}), createVertexArray: () => ({}),
    getUniformLocation: (_p, name) => ({ name }),
    getParameter: (p) => (p === 'ALIASED_POINT_SIZE_RANGE' ? [1, 1024] : 0),
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

const VIEW = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0], K: { fx: 20, fy: 20, cx: 16.5, cy: 12.5 }, width: 32, height: 24, devicePixelRatio: 1 };
const keyOf = (i) => `1.1.${i}.0.0.0`;
const arrivedOf = (...ids) => [{ segmentId: 1, level: 1, keys: ids.map(keyOf) }];

function decode(bytes) {
  const i = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16);
  return {
    header: { format: FORMAT_POINT27, segmentId: 1, level: 1, tileX: i, tileY: 0, lod: 0, chunkIndex: 0, pointCount: 1, bboxMin: [0, 0, 1], quantExp: 0 },
    planes: {
      pos_e: new Int32Array(1), pos_n: new Int32Array(1), pos_u: new Int32Array(1),
      color_r: Uint8Array.of(9), color_g: Uint8Array.of(9), color_b: Uint8Array.of(9),
      normal_oct_x: new Int8Array(1), normal_oct_y: new Int8Array(1),
    },
  };
}
const bytesOf = (i) => Uint8Array.of(i & 255, (i >> 8) & 255, (i >> 16) & 255);

function make() {
  const steps = { select: 0 };
  const r = createRenderer({
    canvas: fakeCanvas(), decode, maxPieceBytes: 1 << 10, maxResidentBytes: 1 << 26, now: () => 0,
    testHooks: { selectDrawable: (k, a) => { steps.select += 1; return selectDrawable(k, a); } },
  });
  r.setView(VIEW);
  return { r, steps };
}

test('지연 setArrived 1000회 뒤 draw 1회: selectDrawable ≤ 1, 결과는 마지막 입력 기준', async () => {
  const { r, steps } = make();
  for (let i = 0; i < 20; i++) await r.uploadPiece(keyOf(i), bytesOf(i));
  for (let n = 1; n <= 1000; n++) {
    const ids = Array.from({ length: (n % 20) + 1 }, (_, i) => i);
    assert.equal(r.setArrived(arrivedOf(...ids), { deferResult: true }), undefined);
  }
  assert.equal(steps.select, 0);
  const st = r.draw();
  assert.ok(steps.select <= 1, `select ${steps.select}`);
  assert.equal(st.drawnPieces, (1000 % 20) + 1);
  r.draw();
  assert.ok(steps.select <= 1);
});

test('반환값 경로는 그대로 즉시 계산한다', async () => {
  const { r, steps } = make();
  for (let i = 0; i < 3; i++) await r.uploadPiece(keyOf(i), bytesOf(i));
  const res = r.setArrived(arrivedOf(0, 1));
  assert.equal(steps.select, 1);
  assert.deepEqual(res.draw, [keyOf(0), keyOf(1)]);
  assert.deepEqual(res.discard, [keyOf(2)]); // 같은 수준인데 완료 집합 밖
  r.draw();
  assert.equal(steps.select, 1);
});

test('지연 경로: 모양이 틀린 입력은 즉시 거부', () => {
  const { r } = make();
  assert.throws(() => r.setArrived([], { deferResult: true }), { code: 'piece' });
  assert.throws(() => r.setArrived([{ segmentId: 1, level: 1, keys: [] }], { deferResult: true }), { code: 'piece' });
});
