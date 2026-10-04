// F-246 ⑦·F-249 ⑨ 시험: 한도 초과 업로드의 draw 크기 Set 캐시와 makeRoom 의 선택 재계산 횟수(걸음 수 계측, 벽시계 아님).
// testHooks.selectDrawable 이 돌려주는 draw 배열의 순회 횟수로 Set 생성 횟수를 센다(Set 생성자가 배열을 한 번 순회한다).
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

const POINT_BYTES = 17;
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
const VIEW = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0], K: { fx: 20, fy: 20, cx: 16.5, cy: 12.5 }, width: 32, height: 24, devicePixelRatio: 1 };
const bytesOf = (i) => Uint8Array.of(i & 255, (i >> 8) & 255, (i >> 16) & 255);

function make(extra = {}) {
  const c = { select: 0, drawIter: 0 };
  const r = createRenderer({
    canvas: fakeCanvas(), decode, maxPieceBytes: 1 << 10, maxResidentBytes: 1 << 26, now: () => 0,
    testHooks: {
      selectDrawable: (k, a) => {
        c.select += 1;
        const res = selectDrawable(k, a);
        const draw = [...res.draw];
        draw[Symbol.iterator] = function* () { c.drawIter += 1; yield* Array.prototype[Symbol.iterator].call(this); };
        return { ...res, draw };
      },
    },
    ...extra,
  });
  r.setView(VIEW);
  return { r, c };
}

test('한도 초과 업로드가 이어져도 선택이 그대로면 draw 크기 Set 은 한 번만 만든다', async () => {
  const { r, c } = make({ maxResidentBytes: 4 * POINT_BYTES });
  r.setArrived(arrivedOf(0));
  await r.uploadPiece(keyOf(0), bytesOf(0)); // 도착 집합 key: 보호 대상
  for (let i = 1; i < 4; i++) await r.uploadPiece(keyOf(i), bytesOf(i)); // 도착 집합 밖(pending)
  r.draw(); // 낡은 선택을 먼저 해소한다
  c.select = 0; c.drawIter = 0;
  for (let i = 4; i < 14; i++) await r.uploadPiece(keyOf(i), bytesOf(i)); // 매번 한도 초과 → 퇴출
  assert.equal(c.select, 0, '선택은 그대로라 다시 돌지 않는다');
  assert.equal(c.drawIter, 1, 'draw 크기 Set 은 선택당 한 번');
  assert.equal(r.residentKeys().includes(keyOf(0)), true, '그리는 조각은 남는다');
});

test('선택이 갱신되면 Set 도 새로 만든다', async () => {
  const { r, c } = make({ maxResidentBytes: 3 * POINT_BYTES });
  for (let i = 0; i < 3; i++) await r.uploadPiece(keyOf(i), bytesOf(i));
  r.setArrived(arrivedOf(0));
  c.drawIter = 0;
  await r.uploadPiece(keyOf(3), bytesOf(3));
  assert.equal(c.drawIter, 1);
  r.setArrived(arrivedOf(0, 3)); // 새 선택
  c.drawIter = 0;
  await r.uploadPiece(keyOf(4), bytesOf(4));
  assert.equal(c.drawIter, 1, '새 선택에는 새 Set');
  assert.ok(r.residentKeys().includes(keyOf(0)) && r.residentKeys().includes(keyOf(3)));
});

test('도착 집합 밖 key 업로드는 한도 초과여도 선택을 다시 돌지 않는다', async () => {
  const { r, c } = make({ maxResidentBytes: 3 * POINT_BYTES });
  for (let i = 0; i < 3; i++) await r.uploadPiece(keyOf(i), bytesOf(i));
  r.setArrived(arrivedOf(0));
  c.select = 0;
  for (let i = 3; i < 9; i++) await r.uploadPiece(keyOf(i), bytesOf(i));
  assert.equal(c.select, 0);
  assert.equal(r.draw().drawnPieces, 1);
  assert.equal(c.select, 0);
});

test('도착 집합 key 의 연속 거부는 같은 상태에서 선택을 한 번만 돈다', async () => {
  const { r, c } = make({ maxResidentBytes: 2 * POINT_BYTES });
  await r.uploadPiece(keyOf(0), bytesOf(0));
  await r.uploadPiece(keyOf(1), bytesOf(1));
  r.setArrived(arrivedOf(0, 1, 2)); // 0·1 은 그리는 조각이라 해제되지 않아 key 2 는 매번 거부된다
  r.draw();
  c.select = 0;
  for (let n = 0; n < 8; n++) {
    await assert.rejects(r.uploadPiece(keyOf(2), bytesOf(2)), (e) => e.code === 'memory' || e.kind === 'memory' || /memory/.test(String(e.code ?? e.kind ?? e.message)));
  }
  assert.ok(c.select <= 1, `거부 8회에 select ${c.select}회`);
});
