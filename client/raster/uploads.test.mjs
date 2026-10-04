// F-243 ①⑥⑦ 시험: 같은 key 동시 업로드 순서 역전, superseded 장부 누수, onEvict 예외.
// 벽시계 단언 없음: 복호 완료 순서는 수동으로 푸는 promise 로 정한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from './index.mjs';
import { FORMAT_POINT27 } from '../../contracts/client_raster/index.mjs';

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

const keyOf = (seg) => `${seg}.0.0.0.0.0`;
const POINT_BYTES = 17; // 형식 1 GPU 평면 B/점
/** n 점짜리 가짜 복호 결과 */
function decoded(key, n) {
  const [segmentId, level, tileX, tileY, lod, chunkIndex] = key.split(".").map(Number);
  return {
    header: { format: FORMAT_POINT27, segmentId, level, tileX, tileY, lod, chunkIndex, pointCount: n, bboxMin: [0, 0, 0], quantExp: 0 },
    planes: {
      pos_e: new Int32Array(n), pos_n: new Int32Array(n), pos_u: new Int32Array(n),
      color_r: new Uint8Array(n), color_g: new Uint8Array(n), color_b: new Uint8Array(n),
      normal_oct_x: new Int8Array(n), normal_oct_y: new Int8Array(n),
    },
  };
}
/** 호출마다 수동으로 끝낼 수 있는 복호기. bytes[0] 은 점 수 */
function manualDecode(key) {
  const pending = [];
  const decode = (bytes) => new Promise((resolve) => {
    pending.push(() => resolve(decoded(bytes[1] === undefined ? key : keyOf(bytes[1]), bytes[0])));
  });
  return { decode, pending };
}
const make = (extra) => createRenderer({ canvas: fakeCanvas(), maxPieceBytes: 1 << 20, maxResidentBytes: 1 << 20, now: () => 0, ...extra });
const total = (m) => (typeof m === 'number' ? m : m.total);

test('F-243 ①: 복호 30ms 5점 → 5ms 3점 순서로 올려도 마지막 시작 업로드(3점)만 상주', async () => {
  const key = keyOf(1);
  const { decode, pending } = manualDecode(key);
  const r = make({ decode });
  const a = r.uploadPiece(key, Uint8Array.of(5)); // 먼저 시작, 늦게 끝남
  const b = r.uploadPiece(key, Uint8Array.of(3)); // 나중 시작, 먼저 끝남
  pending[1]();
  await b;
  pending[0]();
  await a;
  assert.equal(total(r.memoryBytes()), 3 * POINT_BYTES, '옛 업로드가 새 업로드를 덮음');
  assert.deepEqual(r.residentKeys(), [key]);
  assert.deepEqual(r.uploadBookkeeping(), { active: 0, superseded: 0 });
});

test('F-243 ①: 시작 순서대로 끝나도 마지막 시작 업로드만 남는다', async () => {
  const key = keyOf(1);
  const { decode, pending } = manualDecode(key);
  const r = make({ decode });
  const a = r.uploadPiece(key, Uint8Array.of(5));
  const b = r.uploadPiece(key, Uint8Array.of(3));
  pending[0](); await a;
  pending[1](); await b;
  assert.equal(total(r.memoryBytes()), 3 * POINT_BYTES);
});

test('F-243 ⑥: 서로 다른 key 10만 회 releasePiece 뒤 장부 크기 ≤ 진행 중 업로드 수', async () => {
  const { decode, pending } = manualDecode(keyOf(0));
  const r = make({ decode });
  const inflight = [r.uploadPiece(keyOf(0), Uint8Array.of(1, 0)), r.uploadPiece(keyOf(1), Uint8Array.of(1, 1))];
  for (let i = 0; i < 100000; i++) r.releasePiece(keyOf(1000 + i));
  const b = r.uploadBookkeeping();
  assert.ok(b.superseded <= 2, `superseded ${b.superseded}`);
  assert.ok(b.active <= 2);
  // 진행 중 key 를 해제해도 업로드가 끝나면 장부가 비어야 한다
  r.releasePiece(keyOf(0));
  pending[0](); pending[1]();
  await Promise.all(inflight);
  assert.deepEqual(r.uploadBookkeeping(), { active: 0, superseded: 0 });
  assert.deepEqual(r.residentKeys(), [keyOf(1)], '해제된 key 는 되살아나지 않음');
});

test('F-243 ⑦: onEvict 가 던져도 새 조각이 올라간다', async () => {
  const decode = (bytes) => decoded(keyOf(bytes[1]), bytes[0]);
  const evicted = [];
  const r = make({
    decode, maxResidentBytes: 10 * POINT_BYTES,
    onEvict: (keys) => { evicted.push(keys); throw new Error('호출자 오류'); },
  });
  await r.uploadPiece(keyOf(1), Uint8Array.of(8, 1));
  await r.uploadPiece(keyOf(2), Uint8Array.of(8, 2)); // keyOf(1) 퇴출 → onEvict 던짐
  assert.deepEqual(r.residentKeys(), [keyOf(2)]);
  assert.deepEqual(evicted, [[keyOf(1)]], 'onEvict 는 퇴출 한 번에 정확히 한 번, 희생 key 만 알린다');
  await r.uploadPiece(keyOf(2), Uint8Array.of(8, 2)); // 같은 key 교체: 퇴출 없음
  assert.equal(evicted.length, 1);
});
