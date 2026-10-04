import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientRasterError } from '../../../contracts/client_raster/index.mjs';
import { createBufferPool } from './index.mjs';

// 가짜 gl: 만든 버퍼·지운 버퍼·올린 바이트를 센다
function fakeGl({ failCreateAt = 0 } = {}) {
  const g = { created: 0, deleted: 0, live: new Set(), uploaded: 0, ARRAY_BUFFER: 1, STATIC_DRAW: 2 };
  g.createBuffer = () => {
    g.created++;
    if (g.created === failCreateAt) return null;
    const b = { id: g.created }; g.live.add(b); return b;
  };
  g.deleteBuffer = (b) => { g.deleted++; g.live.delete(b); };
  g.bindBuffer = () => {};
  g.bufferData = (_t, data) => { g.uploaded += data.byteLength; };
  return g;
}
// 평면 3개: 8 + 4 + 4 = 16 B
const piece = () => ({ header: {}, planes: { a: new Uint16Array(4), b: new Uint8Array(4), c: new Uint8Array(4) } });
const isCode = (c) => (e) => e instanceof ClientRasterError && e.code === c;

test('올리면 상주 16 B, 평면 3 개 버퍼, key 목록', () => {
  const gl = fakeGl(); const p = createBufferPool({ gl, maxPieceBytes: 16, maxResidentBytes: 48 });
  p.upload('1.0.0.0.0.0', piece());
  assert.equal(p.residentBytes(), 16); assert.equal(gl.created, 3); assert.equal(gl.uploaded, 16);
  assert.equal(p.has('1.0.0.0.0.0'), true); assert.deepEqual(p.keys(), ['1.0.0.0.0.0']);
});

test('중복 해제 허용, 해제 뒤 createBuffer == deleteBuffer', () => {
  const gl = fakeGl(); const p = createBufferPool({ gl, maxPieceBytes: 16, maxResidentBytes: 48 });
  p.upload('k', piece());
  assert.equal(p.release('k'), true); assert.equal(p.release('k'), false); p.release('없음');
  assert.equal(p.residentBytes(), 0); assert.equal(gl.created, 3); assert.equal(gl.deleted, 3); assert.equal(gl.live.size, 0);
});

test('maxPieceBytes 초과 -> piece, 버퍼 만들지 않음', () => {
  const gl = fakeGl(); const p = createBufferPool({ gl, maxPieceBytes: 15, maxResidentBytes: 48 });
  assert.throws(() => p.upload('k', piece()), isCode('piece'));
  assert.equal(gl.created, 0); assert.equal(p.has('k'), false);
});

test('상한 초과 -> memory, 기존 조각 유지, 누수 0', () => {
  const gl = fakeGl(); const p = createBufferPool({ gl, maxPieceBytes: 16, maxResidentBytes: 32 });
  p.upload('a', piece()); p.upload('b', piece());
  assert.throws(() => p.upload('c', piece()), isCode('memory'));
  assert.equal(p.residentBytes(), 32); assert.deepEqual(p.keys(), ['a', 'b']);
  p.clear();
  assert.equal(p.residentBytes(), 0); assert.equal(gl.created, 6); assert.equal(gl.deleted, 6);
});

test('같은 key 재업로드는 교체(상주 16 유지), 한도 꽉 차도 교체 가능', () => {
  const gl = fakeGl(); const p = createBufferPool({ gl, maxPieceBytes: 16, maxResidentBytes: 16 });
  p.upload('a', piece()); p.upload('a', piece());
  assert.equal(p.residentBytes(), 16); assert.equal(gl.created, 6); assert.equal(gl.deleted, 3);
  p.release('a'); assert.equal(gl.created, gl.deleted);
});

test('중간 createBuffer 실패 -> 만든 버퍼 회수, memory', () => {
  const gl = fakeGl({ failCreateAt: 3 }); const p = createBufferPool({ gl, maxPieceBytes: 16, maxResidentBytes: 48 });
  assert.throws(() => p.upload('k', piece()), isCode('memory'));
  assert.equal(gl.live.size, 0); assert.equal(gl.created, 3); assert.equal(gl.deleted, 2);
  assert.equal(p.residentBytes(), 0); assert.equal(p.has('k'), false);
});

test('잘못된 입력 -> piece, 잘못된 한도 -> memory', () => {
  const gl = fakeGl(); const p = createBufferPool({ gl, maxPieceBytes: 16, maxResidentBytes: 48 });
  assert.throws(() => p.upload('', piece()), isCode('piece'));
  assert.throws(() => p.upload('k', { planes: {} }), isCode('piece'));
  assert.throws(() => p.upload('k', { planes: { a: [1, 2] } }), isCode('piece'));
  assert.throws(() => p.upload('k', null), isCode('piece'));
  assert.throws(() => createBufferPool({ gl, maxPieceBytes: 0, maxResidentBytes: 1 }), isCode('memory'));
  assert.throws(() => createBufferPool({ gl: null, maxPieceBytes: 1, maxResidentBytes: 1 }), isCode('context'));
});

test('여러 조각 올리고 일부 해제 -> 상주량 정확, 전부 해제 뒤 누수 0', () => {
  const gl = fakeGl(); const p = createBufferPool({ gl, maxPieceBytes: 16, maxResidentBytes: 160 });
  for (let i = 0; i < 10; i++) p.upload(`k${i}`, piece());
  assert.equal(p.residentBytes(), 160);
  for (let i = 0; i < 4; i++) p.release(`k${i}`);
  assert.equal(p.residentBytes(), 96); assert.equal(p.keys().length, 6);
  p.clear(); p.clear();
  assert.equal(gl.created, 30); assert.equal(gl.deleted, 30);
});

test('교체 중 createBuffer 실패 -> 기존 조각(버퍼·상주량·key)이 그대로, 새로 만든 버퍼만 회수', () => {
  const gl = fakeGl({ failCreateAt: 5 }); const p = createBufferPool({ gl, maxPieceBytes: 16, maxResidentBytes: 16 });
  const first = p.upload('a', piece()); // 버퍼 1~3
  const before = [...gl.live];
  assert.throws(() => p.upload('a', piece()), isCode('memory')); // 두 번째 평면(5번째 생성)에서 실패
  assert.equal(p.residentBytes(), 16); assert.deepEqual(p.keys(), ['a']);
  assert.equal(p.get('a'), first.buffers);
  assert.deepEqual([...gl.live], before); // 기존 3 개만 살아 있다
  assert.equal(gl.deleted, 1); // 실패한 교체가 만든 버퍼 하나만 지웠다(기존 것은 지우지 않음)
  p.release('a'); assert.equal(gl.live.size, 0);
});

test('교체 중 bufferData 가 던져도 기존 조각 유지', () => {
  const gl = fakeGl(); const p = createBufferPool({ gl, maxPieceBytes: 16, maxResidentBytes: 16 });
  const first = p.upload('a', piece());
  const orig = gl.bufferData; let n = 0;
  gl.bufferData = (...a) => { if (++n === 2) throw new Error('OUT_OF_MEMORY'); orig(...a); };
  assert.throws(() => p.upload('a', piece()), /OUT_OF_MEMORY/);
  assert.equal(p.get('a'), first.buffers); assert.equal(p.residentBytes(), 16);
  assert.equal(gl.live.size, 3);
});
