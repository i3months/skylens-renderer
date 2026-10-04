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

test('지연 경로: 모양이 틀린 입력은 즉시 거부(빈 keys 항목은 piece, F-258)', () => {
  const { r } = make();
  const mixed = [{ segmentId: 1, level: 1, keys: [keyOf(0)] }, { segmentId: 1, level: 2, keys: [] }];
  assert.throws(() => r.setArrived([{ segmentId: 1, level: 1, keys: [] }], { deferResult: true }), { code: 'piece' });
  assert.throws(() => r.setArrived(mixed, { deferResult: true }), { code: 'piece' });
  assert.throws(() => r.setArrived(mixed), { code: 'piece' });
});

test('빈 arrived 배열 []은 즉시·지연 모두 받고 이후 draw 0 조각(F-260 6)', async () => {
  for (const defer of [false, true]) {
    const { r } = make();
    for (let i = 0; i < 3; i++) await r.uploadPiece(keyOf(i), bytesOf(i));
    r.setArrived(arrivedOf(0, 1), { deferResult: true });
    assert.equal(r.draw().drawnPieces, 2);
    let res;
    assert.doesNotThrow(() => { res = defer ? r.setArrived([], { deferResult: true }) : r.setArrived([]); });
    assert.equal(defer ? res : res.draw.length, defer ? undefined : 0);
    assert.equal(r.draw().drawnPieces, 0, defer ? 'deferred' : 'immediate');
  }
});

test('지연 경로: key 형식·level 범위 오류는 호출 시점에 piece 로 던지고, 직전 선택은 그대로 draw·uploadPiece 가 정상(F-250 ①)', async () => {
  const { r } = make();
  for (let i = 0; i < 3; i++) await r.uploadPiece(keyOf(i), bytesOf(i));
  r.setArrived(arrivedOf(0, 1), { deferResult: true });
  assert.equal(r.draw().drawnPieces, 2);
  const bad = [
    [{ segmentId: 3, level: 1, keys: ['bogus'] }], // key 형식
    [{ segmentId: 1, level: 9, keys: [keyOf(2)] }], // level 범위
    [{ segmentId: 2, level: 1, keys: [keyOf(2)] }], // (segmentId, level) 불일치
    [{ segmentId: 1, level: 1, keys: [keyOf(2)] }, { segmentId: 1, level: 1, keys: ['bogus'] }], // 뒤 항목만 틀림
  ];
  for (const input of bad) assert.throws(() => r.setArrived(input, { deferResult: true }), { code: 'piece' });
  // 던진 뒤에도 draw 는 직전 선택(0, 1)으로 매번 정상이다
  assert.equal(r.draw().drawnPieces, 2);
  assert.equal(r.draw().drawnPieces, 2);
  // 관계없는 정상 업로드도 거부되지 않는다
  await r.uploadPiece(keyOf(3), bytesOf(3));
  assert.equal(r.draw().drawnPieces, 2);
});

test('지연 경로: 던진 입력은 한도 초과 업로드의 자리 만들기도 막지 않는다', async () => {
  const evicted = [];
  const probe = make().r;
  await probe.uploadPiece(keyOf(0), bytesOf(0));
  const per = probe.memoryBytes(); // 조각 하나의 바이트(한도를 2 조각으로 잡는다)
  probe.dispose();
  const r = createRenderer({
    canvas: fakeCanvas(), decode, maxPieceBytes: 1 << 10, maxResidentBytes: 2 * per, now: () => 0,
    onEvict: (k) => evicted.push(...k),
  });
  r.setView(VIEW);
  await r.uploadPiece(keyOf(0), bytesOf(0));
  await r.uploadPiece(keyOf(1), bytesOf(1));
  r.setArrived(arrivedOf(0), { deferResult: true });
  assert.throws(() => r.setArrived([{ segmentId: 1, level: 9, keys: [keyOf(2)] }], { deferResult: true }), { code: 'piece' });
  await r.uploadPiece(keyOf(2), bytesOf(2)); // 넘침: 직전 선택(0)으로 자리를 만든다
  assert.deepEqual(evicted, [keyOf(1)]);
});
