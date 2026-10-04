// F-262: 업로드 성공·희생 해제·releasePiece 마다 makeRoom 의 상주 표(resident·base)를 그 key 의 타일 하나만 고치는지 본다.
// 호출 횟수·판정 결과만 본다(벽시계 아님). 변이 대상: roomResidentChange 의 추가·제거 두 갈래, clear 시 roomCache 비우기.
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

test('F-262: 한도 가득 연속 업로드가 select 를 부르지 않고 도착 밖 조각만 차례로 희생한다', async () => {
  const n = 40;
  const { r, evicted, calls, up } = make(n);
  const outside = [];
  const inside = [];
  for (let i = 0; i < n; i++) {
    const k = i % 2 === 0 ? `4.1.${i}.0.0.0` : `3.1.${i}.0.0.0`;
    (i % 2 === 0 ? outside : inside).push(k);
    await up(k);
  }
  const fresh = Array.from({ length: 15 }, (_, i) => `3.1.${n + i}.0.0.0`);
  r.setArrived([{ segmentId: 3, level: 1, keys: [...inside, ...fresh] }], { deferResult: true });
  r.draw();
  calls.select = 0;
  for (const k of fresh) await up(k);
  assert.equal(calls.select, 0);
  assert.deepEqual(evicted, outside.slice(0, fresh.length));
  assert.equal(r.residentKeys().length, n);
  r.dispose();
});

test('F-262: 업로드 성공·희생 해제·releasePiece 가 섞여도 보호 판정이 selectDrawable 과 같다', async () => {
  let seed = 777;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >> 8) % n; };
  const pool = [];
  for (const level of [1, 2]) for (let tx = 0; tx < 4; tx++) for (let lod = 0; lod < 3; lod++) for (let c = 0; c < 2; c++) pool.push(`3.${level}.${tx}.0.${lod}.${c}`);
  for (let round = 0; round < 60; round++) {
    const arrivedKeys = pool.filter(() => rnd(4) > 0);
    const arrived = [1, 2].map((l) => ({ segmentId: 3, level: l, keys: arrivedKeys.filter((k) => k.split('.')[1] === String(l)) })).filter((a) => a.keys.length);
    const { r, evicted, calls, up } = make(3 + rnd(4));
    r.setArrived(arrived, rnd(2) ? { deferResult: true } : undefined);
    r.draw();
    calls.select = 0;
    for (let step = 0; step < 30; step++) {
      const x = pool[rnd(pool.length)];
      if (rnd(4) === 0) { r.releasePiece(x); continue; }
      if (!arrivedKeys.includes(x) || r.residentKeys().includes(x)) continue;
      const before = r.residentKeys();
      const expectDraw = new Set(selectDrawable([...before, x], arrived).draw);
      evicted.length = 0;
      let ok = true;
      try { await up(x); } catch (e) { assert.equal(e.code, 'memory'); ok = false; }
      for (const v of evicted) assert.equal(expectDraw.has(v), false, `보호 대상 ${v} 를 퇴출함(round ${round}, step ${step})`);
      if (!ok) assert.equal(before.filter((k) => !expectDraw.has(k)).length, 0, `불필요한 거부(round ${round}, step ${step})`);
      else assert.ok(r.residentKeys().includes(x));
      if (step % 10 === 9) r.draw(); // 가끔 선택을 다시 돌려 select 가 이 경로 밖에서만 불리게 한다
    }
    r.dispose();
  }
});
