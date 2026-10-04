// T12.7 '집계값 = 실제 버퍼 합': meter.total() == pool.residentBytes() == 가짜 gl 이 실제로 받은 바이트(살아 있는 버퍼 합).
// 렌더러는 meter 를 밖으로 내지 않으므로, 렌더러 수준에서는 memoryBytes()(=pool)와 gl 실측, 그리고 meter 가 makeRoom 에
// 미치는 영향(자기 크기 차감·해제 뒤 항목 제거)으로 확인하고, 렌더러와 같은 순서로 meter·pool 을 직접 굴려 세 값을 대조한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from './index.mjs';
import { createBufferPool } from './buffers/index.mjs';
import { createMemoryMeter } from './memory/index.mjs';
import { packChunk } from '../../server/asset/pack/index.mjs';
import { FORMAT_POINT27 } from '../../contracts/client_raster/index.mjs';

/** 가짜 gl: 버퍼마다 bufferData 로 받은 바이트를 적고, 살아 있는 버퍼의 합(liveBytes)과 누계(uploadedTotal)를 센다. */
function fakeGl() {
  const g = { live: new Map(), bound: null, uploadedTotal: 0, ARRAY_BUFFER: 1, STATIC_DRAW: 2 };
  g.liveBytes = () => { let s = 0; for (const v of g.live.values()) s += v; return s; };
  g.createBuffer = () => { const b = {}; g.live.set(b, 0); return b; };
  g.deleteBuffer = (b) => { g.live.delete(b); };
  g.bindBuffer = (_t, b) => { g.bound = b; };
  g.bufferData = (_t, data) => { g.live.set(g.bound, data.byteLength); g.uploadedTotal += data.byteLength; };
  return g;
}

/** createRenderer 용 가짜 캔버스(나머지 gl 호출은 무시). */
function fakeCanvas() {
  const f = fakeGl();
  const base = {
    getShaderParameter: () => true, getProgramParameter: () => true, createShader: () => ({}), createProgram: () => ({}),
    createVertexArray: () => ({}), getUniformLocation: (_p, name) => ({ name }),
    getParameter: (p) => (p === 'ALIASED_POINT_SIZE_RANGE' ? [1, 1024] : 0), isContextLost: () => false,
  };
  const gl = new Proxy(f, {
    get(t, p) {
      if (p in t) return t[p];
      if (p in base) return base[p];
      if (typeof p === 'string' && /^[A-Z_0-9]+$/.test(p)) return p;
      return () => {};
    },
  });
  return { canvas: { width: 300, height: 150, getContext: (k) => (k === 'webgl2' ? gl : null), addEventListener() {}, removeEventListener() {} }, gl: f };
}

const ANCHOR = { lat: 37.5, lon: 127, alt: 30 };
// 점 1개 형식 1 = 17 B(위치 12 + 색 3 + 법선 2)
function piece(key, points = 1) {
  const [segmentId, level, , , lod, chunkIndex] = key.split('.').map(Number);
  const pos = []; for (let i = 0; i < points; i++) pos.push(0.5 + i, 0.5, 5);
  return packChunk({
    format: FORMAT_POINT27, segmentId, level, lod, chunkIndex, anchor: ANCHOR,
    fields: {
      positions: Float32Array.from(pos), colors: new Uint8Array(3 * points).fill(200),
      normals: Float32Array.from(Array.from({ length: points }, () => [0, 0, 1]).flat()),
    },
  });
}
const arrivedOf = (...keys) => ({ segmentId: 3, level: 1, keys });
const isMemory = (e) => e.code === 'memory';

function make(maxResidentBytes, extra = {}) {
  const f = fakeCanvas();
  const r = createRenderer({ canvas: f.canvas, maxPieceBytes: 1 << 20, maxResidentBytes, ...extra });
  return { r, gl: f.gl };
}

const K = ['3.1.0.0.0.0', '3.1.0.0.0.1', '3.1.0.0.0.2', '3.1.0.0.0.3'];

test('렌더러: 올리기·교체·해제·퇴출 뒤 memoryBytes == 가짜 gl 에 실제 남은 버퍼 바이트', async () => {
  const evicted = [];
  const { r, gl } = make(51, { onEvict: (k) => evicted.push(...k) });
  const check = (expected) => {
    assert.equal(r.memoryBytes(), expected);
    assert.equal(gl.liveBytes(), expected);
  };
  await r.uploadPiece(K[0], piece(K[0])); check(17);
  await r.uploadPiece(K[1], piece(K[1], 2)); check(17 + 34);
  await r.uploadPiece(K[1], piece(K[1], 1)); check(34); // 교체(작게)
  await r.uploadPiece(K[1], piece(K[1], 2)); check(51); // 교체(크게)
  r.releasePiece(K[0]); check(34);
  r.releasePiece(K[0]); check(34); // 중복 해제
  await r.uploadPiece(K[2], piece(K[2])); check(51);
  await r.uploadPiece(K[3], piece(K[3])); // 한도 초과: 가장 오래된 것(K[1], 34 B)을 퇴출
  assert.deepEqual(evicted, [K[1]]);
  check(34);
  assert.deepEqual(r.residentKeys(), [K[2], K[3]]);
  // 누계 올림량은 상주량보다 크다: 집계는 누계가 아니라 살아 있는 버퍼 합이다
  assert.ok(gl.uploadedTotal > r.memoryBytes());
  r.dispose();
  assert.equal(gl.liveBytes(), 0);
  assert.equal(r.memoryBytes(), 0);
});

test('렌더러(M4e): 한도가 꽉 찬 상태에서 그리는 조각을 같은 key 로 교체해도 성공, 다른 조각을 퇴출하지 않음', async () => {
  const evicted = [];
  const { r, gl } = make(34, { onEvict: (k) => evicted.push(...k) });
  await r.uploadPiece(K[0], piece(K[0]));
  await r.uploadPiece(K[1], piece(K[1]));
  r.setArrived([arrivedOf(K[0], K[1])]); // 둘 다 그림: 퇴출 불가
  // 자기 크기를 빼지 않으면 17 + 17 + 17 > 34 로 보아 memory 로 거부한다
  await r.uploadPiece(K[0], piece(K[0]));
  assert.equal(r.memoryBytes(), 34);
  assert.equal(gl.liveBytes(), 34);
  assert.deepEqual(evicted, []);
  assert.deepEqual(r.residentKeys(), [K[1], K[0]]);
  // 교체로 커지는 경우는 34 - 17 + 34 > 34 이므로 거부, 기존 조각은 유지
  await assert.rejects(r.uploadPiece(K[0], piece(K[0], 2)), isMemory);
  assert.equal(r.memoryBytes(), 34);
  assert.equal(gl.liveBytes(), 34);
  assert.deepEqual(r.residentKeys(), [K[1], K[0]]);
  r.dispose();
});

test('렌더러(M4e): 그리지 않는 조각을 같은 key 로 교체할 때 이웃을 퇴출하지 않음', async () => {
  const evicted = [];
  const { r } = make(34, { onEvict: (k) => evicted.push(...k) });
  await r.uploadPiece(K[0], piece(K[0]));
  await r.uploadPiece(K[1], piece(K[1]));
  await r.uploadPiece(K[0], piece(K[0])); // 둘 다 pending: 자기 크기를 안 빼면 K[1] 을 퇴출한다
  assert.deepEqual(evicted, []);
  assert.deepEqual(r.residentKeys().sort(), [K[0], K[1]]);
  assert.equal(r.memoryBytes(), 34);
  r.dispose();
});

test('렌더러(해제 뒤 표 정리): 해제된 key 를 다시 올릴 때 옛 크기가 남아 거짓 여유를 만들지 않음', async () => {
  const { r, gl } = make(51);
  await r.uploadPiece(K[0], piece(K[0], 2)); // 34 B
  await r.uploadPiece(K[1], piece(K[1])); // 17
  r.releasePiece(K[0]); // 표에 34 B 가 남으면 다음 계산이 틀어진다
  await r.uploadPiece(K[2], piece(K[2])); // 17
  await r.uploadPiece(K[0], piece(K[0])); // 17 → 합 51
  assert.equal(r.memoryBytes(), 51);
  assert.equal(gl.liveBytes(), 51);
  r.setArrived([arrivedOf(K[0], K[1], K[2])]); // 전부 그림
  // 꽉 참 + 그리는 조각뿐: 17 B 더는 거부되고 아무것도 해제되지 않는다
  await assert.rejects(r.uploadPiece(K[3], piece(K[3])), isMemory);
  assert.equal(gl.liveBytes(), 51);
  assert.equal(r.memoryBytes(), 51);
  assert.deepEqual(r.residentKeys().sort(), [K[0], K[1], K[2]]);
  r.dispose();
});

test('렌더러(해제 뒤 표 정리): 해제한 큰 조각을 다시 올릴 때 옛 크기 대신 실제 상주로 퇴출을 계산', async () => {
  const evicted = [];
  const { r, gl } = make(51, { onEvict: (k) => evicted.push(...k) });
  await r.uploadPiece(K[0], piece(K[0], 2)); // 34 B
  r.releasePiece(K[0]); // 표에 34 B 가 남아 있으면 아래 계산이 34 만큼 틀어진다
  await r.uploadPiece(K[1], piece(K[1]));
  await r.uploadPiece(K[2], piece(K[2]));
  // 34 + 34 > 51 이므로 가장 오래된 K[1] 을 퇴출해야 한다. 옛 크기가 남으면 퇴출 없이 풀이 memory 로 거부한다
  await r.uploadPiece(K[0], piece(K[0], 2));
  assert.deepEqual(evicted, [K[1]]);
  assert.equal(r.memoryBytes(), 51);
  assert.equal(gl.liveBytes(), 51);
  r.dispose();
});

test('meter·pool·gl 대조: 렌더러와 같은 순서(올리기·교체·해제·퇴출)로 세 값이 늘 같다', () => {
  const gl = fakeGl();
  const pool = createBufferPool({ gl, maxPieceBytes: 1 << 20, maxResidentBytes: 1 << 20 });
  const meter = createMemoryMeter();
  const planes = (n) => ({ header: {}, planes: { position: new Float32Array(3 * n), color: new Uint8Array(3 * n) } });
  const up = (key, n) => { const r = pool.upload(key, planes(n)); meter.remove(key); meter.add(key, r.bytes); };
  const drop = (key) => { pool.release(key); meter.remove(key); };
  const same = (label) => {
    assert.equal(meter.total(), pool.residentBytes(), `${label}: meter == pool`);
    assert.equal(pool.residentBytes(), gl.liveBytes(), `${label}: pool == gl`);
    assert.deepEqual(Object.keys(meter.byKey()).sort(), pool.keys().sort(), `${label}: key 집합`);
  };
  up('a', 4); same('올리기');
  up('b', 2); same('올리기 2');
  up('a', 1); same('교체(작게)');
  up('a', 9); same('교체(크게)');
  drop('b'); same('해제');
  drop('b'); same('중복 해제');
  up('c', 3); drop('a'); same('퇴출');
  drop('c'); same('전부 해제');
  assert.equal(meter.total(), 0);
  assert.equal(gl.live.size, 0);
});
