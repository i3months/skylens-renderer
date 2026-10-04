// F-274 VI 시험: 희생 후보 목록(cand) 세 갈래를 각각 잡는다.
// (1) 선택 기반 보호의 drawingCache.cand 가 meta.clear() 뒤에 버려지는가 (변이 M12: clear() 의 cand = null 삭제)
// (2) roomProtection 경로 1(base 밖 후보만 순회)이 켜져 있는가 (변이 M13: 경로 1 비활성화 → meta 전체 순회, reads 폭증)
// (3) 복귀 소집합(back)과 병합해 돌 때 한도가 채워지면 바로 멈추는가 (변이 M16: `break cands` 제거 → 희생 과다)
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
    fire(t) {
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

const prot = (i) => `3.1.${i}.0.0.${i % 2}`;
const free = (i) => `4.1.${i}.0.0.0`;
const arrivedOf = (keys) => [{ segmentId: 3, level: 1, keys }];

// 시험 (1): meta.clear() 가 drawingCache.cand(선택 기반 보호 경로의 희생 후보 목록)를 버린다.
// clear 전에 도착 밖 key 를 한도 초과로 올려(희생 업로드) dc.cand 를 만들어 두고, clear 뒤에는 setArrived 도 도착 key 업로드도 하지 않는다
// (도착 key 를 올리면 선택이 낡아 다음 makeRoom 이 선택·drawingCache 를 새로 만들어 clear() 의 효과를 가린다).
// 같은 선택·drawingCache 가 남은 채 다른 key 를 올려 넘치게 하면, clear() 가 cand 를 비우지 않았을 때 meta 에 없는 옛 key 가 희생으로 골라져 실패한다.
test('F-274 VI (1): meta.clear() 뒤 makeRoom 이 drawingCache.cand 를 비우고 현재 meta 기준 희생을 고른다', async () => {
  const canvas = fakeCanvas();
  const evicted = [];
  const r = createRenderer({
    canvas, decode, maxPieceBytes: 1 << 10, maxResidentBytes: 3 * POINT_BYTES, now: () => 0,
    onEvict: (k) => evicted.push(...k),
  });
  r.setView(VIEW);
  const up = (k) => r.uploadPiece(k, enc(k));

  // 도착 key 는 prot0 하나. 한도 3개를 도착 밖 key 둘과 함께 채운다(희생 없음)
  await up(prot(0));
  await up(free(0));
  await up(free(1));
  r.setArrived(arrivedOf([prot(0)]));
  r.draw();
  assert.deepEqual(evicted, [], '한도 안이므로 희생 없음');

  // 희생 업로드: 도착 밖 key 라 선택 기반 경로를 타며 dc.cand=[free0, free1] 이 만들어지고 free0 이 희생된다(free2 가 cand 뒤에 붙는다)
  await up(free(2));
  assert.deepEqual(evicted, [free(0)], '희생 업로드가 free0 을 해제해야 함(dc.cand 생성)');

  // 문맥 소실: meta.clear() 가 dc.cand 를 null 로 돌려야 한다
  canvas.fire('webglcontextlost');
  canvas.fire('webglcontextrestored');
  assert.deepEqual(r.residentKeys(), [], '소실 후 상주 없음');

  // setArrived·도착 key 업로드 없이 다른 도착 밖 key 로 한도를 채우고 넘친다
  evicted.length = 0;
  await up(free(10));
  await up(free(11));
  await up(free(12));
  assert.deepEqual(evicted, [], '한도 안이므로 희생 없음');
  // 정상: cand 를 meta 에서 새로 만들어 free10 이 희생. 변이 M12: 옛 cand 의 free1·free2(meta 에 없음)를 골라 던지거나 틀린 key 를 희생
  await up(free(13));
  assert.deepEqual(evicted, [free(10)], `meta 순서로 가장 오래된 free10 이 희생이어야 함. 현재: [${evicted}]`);
  assert.deepEqual(r.residentKeys().sort(), [free(11), free(12), free(13)].sort());
  r.dispose();
});

// 시험 (2): roomProtection 경로 1 은 후보 목록만 순회한다.
async function countMetaReads(body) {
  const P = Map.prototype;
  const orig = { entries: P.entries, keys: P.keys, values: P.values, forEach: P.forEach };
  const counter = { reads: 0 };
  const counted = (self) => self.constructor !== Map;
  function wrap(it, self) {
    if (!counted(self)) return it;
    return (function* gen() { for (const v of it) { counter.reads++; yield v; } })();
  }
  P.entries = function entries() { return wrap(orig.entries.call(this), this); };
  P[Symbol.iterator] = P.entries;
  P.keys = function keys() { return wrap(orig.keys.call(this), this); };
  P.values = function values() { return wrap(orig.values.call(this), this); };
  P.forEach = function forEach(fn, thisArg) {
    if (!counted(this)) return orig.forEach.call(this, fn, thisArg);
    return orig.forEach.call(this, (v, k, m) => { counter.reads++; fn.call(thisArg, v, k, m); }, thisArg);
  };
  try {
    await body();
  } finally {
    P.entries = orig.entries; P[Symbol.iterator] = orig.entries; P.keys = orig.keys; P.values = orig.values; P.forEach = orig.forEach;
  }
  return counter.reads;
}

test('F-274 VI (2): roomProtection 경로 1 은 후보 목록만 순회해 meta 읽기가 업로드 수에 비례해 늘지 않는다', async () => {
  const N = 2000;
  const PROTECTED = 1980;
  const newTile = (i) => `3.1.${50000 + i}.0.0.0`; // 도착 집합에 들고 아직 상주가 아닌 새 타일 key → makeRoom 경로 1
  const protectedKeys = Array.from({ length: PROTECTED }, (_, i) => prot(i)); // meta 앞쪽
  const freeKeys = Array.from({ length: N - PROTECTED }, (_, i) => free(i)); // meta 뒤쪽, 도착 밖
  const fresh = Array.from({ length: 11 }, (_, i) => newTile(i));
  const canvas = fakeCanvas();
  const evicted = [];
  const r = createRenderer({
    canvas, decode, maxPieceBytes: 1 << 10, maxResidentBytes: N * POINT_BYTES, now: () => 0,
    onEvict: (k) => evicted.push(...k),
  });
  r.setView(VIEW);
  const up = (k) => r.uploadPiece(k, enc(k));

  for (const k of [...protectedKeys, ...freeKeys]) await up(k); // 한도를 정확히 채운다
  r.setArrived(arrivedOf([...protectedKeys, ...fresh]), { deferResult: true });
  r.draw();

  // 첫 업로드는 보호 표·후보 목록을 만드는 meta 전체 순회이므로 계측 밖
  await up(fresh[0]);

  // 다음 10회: 보호 key 가 meta 앞쪽 1980 개여도 경로 1 은 후보(free) 만 돌아 meta 읽기가 거의 없다.
  // 경로 1 을 끄면 업로드마다 meta 를 앞에서부터 돌아 약 1980*10 회 읽는다
  const reads = await countMetaReads(async () => {
    for (let i = 1; i <= 10; i++) {
      evicted.length = 0;
      await up(fresh[i]);
      assert.equal(evicted.length, 1, `업로드 ${i}: 희생 1 개`);
      assert.ok(evicted[0].startsWith('4.'), `업로드 ${i}: 보호 아닌 key 희생`);
    }
  });
  r.dispose();
  assert.ok(reads < 3 * N, `meta 읽기 ${reads} 이 3N=${3 * N} 이상 (경로 1 비활성화)`);
});

// 시험 (3): 복귀 소집합(back)이 있는 채 경로 1 로 돌 때, 한도가 채워지면 back 도 더 희생하지 않고 멈춘다.
// 고른 LOD 가 1 → 0 으로 바뀌면 타일 T 의 lod1 key 둘(b0, b1)이 보호에서 빠져 back 이 된다(meta 앞쪽, cand 의 g 보다 앞).
test('F-274 VI (3): 후보·복귀 병합 순회는 한도가 채워지면 멈춘다', async () => {
  const canvas = fakeCanvas();
  const evicted = [];
  const r = createRenderer({
    canvas, decode, maxPieceBytes: 1 << 10, maxResidentBytes: 5 * POINT_BYTES, now: () => 0,
    onEvict: (k) => evicted.push(...k),
  });
  r.setView(VIEW);
  const up = (k) => r.uploadPiece(k, enc(k));
  const [b0, b1, h, x1, x2] = ['3.1.100.0.1.0', '3.1.100.0.1.1', '3.1.100.0.0.0', '3.1.200.0.0.0', '3.1.201.0.0.0'];

  for (const k of [free(0), free(1), b0, b1, free(2)]) await up(k); // meta 순서, 한도를 채운다
  r.setArrived(arrivedOf([b0, b1, h, x1, x2]));
  r.draw();

  await up(x1); // 경로 1: 후보 목록을 만든다. free0 희생
  assert.deepEqual(evicted, [free(0)]);
  evicted.length = 0;
  await up(h); // lod0 완전 → 고른 LOD 1→0: b0·b1 이 back 으로. 이 업로드는 보호가 base 와 달라 meta 순회로 free1 희생
  assert.deepEqual(evicted, [free(1)]);
  evicted.length = 0;
  await up(x2); // 경로 1: back=[b0,b1], cand=[free2]. b0 하나로 충분하므로 b1 은 남아야 한다
  assert.deepEqual(evicted, [b0], `희생은 b0 하나여야 함. 현재: [${evicted}]`);
  assert.ok(r.residentKeys().includes(b1));
  r.dispose();
});
