// F-274 VI 시험: meta.clear() 뒤 makeRoom 이 drawingCache.cand 를 버리고 새로 만드는지,
// 그리고 roomProtection 경로 1(보호 key 만 순회)이 활성화되는지 본다.
// 변이 대상: (a) clear() 의 drawingCache.cand = null 삭제 → 시험 (1) 실패,
//           (b) 경로 1 비활성화(후보 목록 대신 meta 전체 순회) → 시험 (2) 실패.
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

// 시험 (1): meta.clear() 뒤 makeRoom 이 drawingCache.cand 를 버린다.
// 선택이 바뀐 뒤 새 upload 시 정확한 희생 key 순서를 고르는지 본다.
test('F-274 VI (1): meta.clear() 뒤 makeRoom 이 drawingCache.cand 를 비우고 현재 선택 기준 희생을 고른다', async () => {
  const canvas = fakeCanvas();
  const evicted = [];
  const r = createRenderer({
    canvas, decode, maxPieceBytes: 1 << 10, maxResidentBytes: 3 * POINT_BYTES, now: () => 0,
    onEvict: (k) => evicted.push(...k),
  });
  r.setView(VIEW);
  const up = (k) => r.uploadPiece(k, enc(k));

  // 초기: 두 prot key 를 올린다 (2*17=34 bytes, 한도 3*17=51 에 여유)
  await up(prot(0));
  await up(prot(1));
  r.setArrived(arrivedOf([prot(0), prot(1)]));
  r.draw();

  // free[0] 을 올린다 (3*17=51 bytes, 정확히 한도). 희생 없음
  // 현재 선택=[prot0, prot1] 이므로 drawingCache.cand 가 만들어진다 (cand=[free0])
  evicted.length = 0;
  await up(free(0));
  assert.deepEqual(evicted, [], '정확히 한도 안이므로 희생 없음');

  // 문맥 소실: meta 비워지고 drawingCache.cand 도 null 로 됨
  canvas.fire('webglcontextlost');
  canvas.fire('webglcontextrestored');
  assert.deepEqual(r.residentKeys(), [], '소실 후 상주 없음');

  // 복구: prot0·prot1·free0 다시 올림
  await up(prot(0));
  await up(prot(1));
  evicted.length = 0;
  await up(free(0));
  assert.deepEqual(r.residentKeys().sort(), [prot(0), prot(1), free(0)].sort());

  // 도착 변경: draw=[prot0] 만 (prot1·free0 은 draw 밖)
  r.setArrived(arrivedOf([prot(0)]));
  r.draw();

  // free[1] 올림. 상주 합 = 3*17=51, 새 piece=17, 총 68 > 한도 51
  // 희생 후보: draw 밖 = [prot1(더 오래됨), free0]
  // 정상: drawingCache.cand 를 null 비우고 새로 만듦 → [prot1, free0] 순회 → prot1 희생
  // 변이(a): drawingCache.cand 는 그대로 [free0] (clear 전 정보) → free0 희생 (잘못)
  evicted.length = 0;
  await up(free(1));
  assert.ok(evicted.length > 0, '한도 초과로 희생 필요');
  assert.deepEqual(evicted, [prot(1)], `희생이 prot1 (더 오래됨)이어야 함. 현재: [${evicted}]`);
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
  const PROTECTED = 1990;
  const protected_keys = [...Array.from({ length: PROTECTED }, (_, i) => prot(i))];
  const free_keys = [...Array.from({ length: N - PROTECTED }, (_, i) => free(i))];
  const resident = [...protected_keys, ...free_keys];
  const canvas = fakeCanvas();
  const evicted = [];
  const r = createRenderer({
    canvas, decode, maxPieceBytes: 1 << 10, maxResidentBytes: N * POINT_BYTES, now: () => 0,
    onEvict: (k) => evicted.push(...k),
  });
  r.setView(VIEW);
  const up = (k) => r.uploadPiece(k, enc(k));

  // 모든 key 올림
  for (const k of resident) await up(k);

  // 도착 설정: draw=[1990 keys], cand=[10 free keys]
  r.setArrived(arrivedOf(protected_keys), { deferResult: true });
  r.draw();

  // 첫 업로드는 보호 표 초기화이므로 계측 밖
  await up(free(5000));

  // 다음 10회 업로드: meta 읽기 횟수 계측
  // 경로 1: 후보 목록만 순회 → reads 약 100
  // 경로 비활성화: meta 전체 순회 → reads 약 19900
  const reads = await countMetaReads(async () => {
    for (let i = 0; i < 10; i++) {
      evicted.length = 0;
      await up(free(6000 + i));
      assert.ok(evicted.length > 0, `업로드 ${i}: 희생 필요`);
      assert.ok(evicted[0].startsWith('4.'), `업로드 ${i}: 보호 key 희생`);
    }
  });
  r.dispose();
  assert.ok(reads < 500, `meta 읽기 ${reads} 이 너무 많음 (경로 1 비활성화)`);
});
