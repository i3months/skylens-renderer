// F-246 ⑦ 시험: selectDrawable 재계산 횟수(걸음 수 계측, 벽시계 아님). testHooks.selectDrawable 로 호출 수를 센다.
// 규칙: 재계산은 setArrived(도착 이벤트)와, 도착 집합에 든 key 가 올라온 뒤의 첫 draw 에서 프레임당 최대 1회다.
// 도착 집합에 없는 새 key 는 직전 선택에서 pending 이라 다시 돌지 않는다. makeRoom 은 선택을 다시 돌지 않는다.
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
const POINT_BYTES = 17; // 형식 1, 1 점
const keyOf = (i) => `1.1.${i}.0.0.0`; // 한 수준(1)·타일 i
const arrivedOf = (...ids) => [{ segmentId: 1, level: 1, keys: ids.map(keyOf) }];

/** 1 점짜리 조각을 돌려주는 복호기. bytes[0..3] 은 타일 번호(리틀 엔디언) */
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

function make(extra = {}) {
  const steps = { select: 0 };
  const r = createRenderer({
    canvas: fakeCanvas(), decode, maxPieceBytes: 1 << 10, maxResidentBytes: 1 << 26, now: () => 0,
    testHooks: { selectDrawable: (k, a) => { steps.select += 1; return selectDrawable(k, a); } },
    ...extra,
  });
  r.setView(VIEW);
  return { r, steps };
}

test('10만 key 상주: 도착 집합에 없는 새 key 업로드 1건 뒤 draw 의 selectDrawable 호출 0', async () => {
  const { r, steps } = make();
  for (let i = 0; i < 100000; i++) await r.uploadPiece(keyOf(i), bytesOf(i));
  r.setArrived(arrivedOf(0, 1, 2));
  assert.equal(steps.select, 1, 'setArrived 는 도착 이벤트마다 1회');
  steps.select = 0;
  await r.uploadPiece(keyOf(100000), bytesOf(100000)); // 도착 집합 밖: 직전 선택에서 pending
  const st = r.draw();
  assert.equal(steps.select, 0, 'draw 가 selectDrawable 을 다시 돌았다');
  assert.equal(st.drawnPieces, 3);
  r.draw();
  assert.equal(steps.select, 0);
});

test('업로드가 연속돼도 도착 집합 key 는 프레임당 selectDrawable ≤ 1', async () => {
  const { r, steps } = make();
  for (let i = 0; i < 50; i++) await r.uploadPiece(keyOf(i), bytesOf(i));
  r.setArrived(arrivedOf(...Array.from({ length: 50 }, (_, i) => i)));
  steps.select = 0;
  for (let f = 0; f < 3; f++) {
    for (let j = 0; j < 5; j++) await r.uploadPiece(keyOf(f * 5 + j), bytesOf(f * 5 + j)); // 도착 집합 key 다시 올림
    const st = r.draw();
    r.draw(); // 같은 프레임 안 다시 그려도 늘지 않는다
    assert.equal(steps.select, f + 1, `프레임 ${f}: 프레임당 최대 1회`);
    assert.equal(st.drawnPieces, 50);
  }
});

test('상주 전에 setArrived 한 key 는 올라온 뒤 다음 draw 에서 그려진다', async () => {
  const { r, steps } = make();
  r.setArrived(arrivedOf(7));
  assert.equal(r.draw().drawnPieces, 0);
  await r.uploadPiece(keyOf(7), bytesOf(7));
  steps.select = 0;
  assert.equal(r.draw().drawnPieces, 1);
  assert.equal(steps.select, 1);
});

test('makeRoom: 한도 여유가 있으면 선택을 돌지 않고, 한도에 닿아도 다시 돌지 않는다', async () => {
  const { r, steps } = make({ maxResidentBytes: 4 * POINT_BYTES });
  r.setArrived(arrivedOf(0, 1, 2));
  steps.select = 0;
  for (let i = 0; i < 4; i++) await r.uploadPiece(keyOf(i), bytesOf(i)); // 여유 있음: 0,1,2(도착 집합), 3(밖)
  assert.equal(steps.select, 0);
  await r.uploadPiece(keyOf(4), bytesOf(4)); // 한도 도달 → makeRoom 이 희생 선택
  assert.equal(steps.select, 0, 'makeRoom 이 selectDrawable 을 돌았다');
  // 도착 집합 key(0,1,2: 직전 선택 뒤 올라옴)는 보호되고 도착 집합 밖의 가장 오래된 3 이 퇴출
  assert.deepEqual([...r.residentKeys()].sort(), [keyOf(0), keyOf(1), keyOf(2), keyOf(4)].sort());
  assert.equal(r.draw().drawnPieces, 3);
});
