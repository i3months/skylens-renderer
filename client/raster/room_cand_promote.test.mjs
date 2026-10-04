// 희생 후보 목록 시험(F-271·F-274 ⑩): makeRoom 이 업로드마다 meta 를 다시 돌지 않는지 본다.
// 호출 횟수·선택 결과만 본다(벽시계 아님). 계측은 export·testHooks 추가 없이 Map.prototype 의 순회 메서드를 측정 구간에서만 감싸 세는 방식이다
// (room_victim_cursor.test.mjs 와 같다). 승격 업로드 = 타일의 lod0 key 가 올라와 고른 LOD 가 1 → 0 으로 바뀌어 lod1 key 가 보호에서 빠지는 업로드.
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

function make(cap) {
  const evicted = [];
  const r = createRenderer({
    canvas: fakeCanvas(), decode, maxPieceBytes: 1 << 10, maxResidentBytes: cap * POINT_BYTES, now: () => 0,
    onEvict: (k) => evicted.push(...k),
  });
  r.setView(VIEW);
  return { r, evicted, up: (k) => r.uploadPiece(k, enc(k)) };
}

// 보호(도착) key: 세그먼트 3(타일마다 lod 0·1 chunk0 한 개씩이 도착 입력에 실림). 보호 밖: 세그먼트 4(도착 입력에 없음)
const lodKey = (i, lod) => `3.1.${i}.0.${lod}.0`;
const free = (i) => `4.1.${i}.0.0.0`;
const arrivedOf = (keys) => [{ segmentId: 3, level: 1, keys }];

// meta(Map 하위 클래스)의 순회로 읽힌 항목 수를 센다. Map.prototype 의 순회 메서드를 측정 구간에서만 감싼다.
// 렌더러의 meta 만 세려고 기본 Map 이 아닌 인스턴스(constructor !== Map)만 센다.
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

const N = 4000; // 상주 key 수(= 한도)
const TILES = 100; // 보호 타일 수

// 도착 입력: 보호 타일마다 lod0·lod1 key, 그리고 비승격 도착 key 용 타일 EXTRA 개(lod0 하나).
// 상주 배치는 시험마다 다르다(아래 layout). 둘 다 상주 수 = 한도 N 이라 업로드마다 희생이 하나 나간다.
const EXTRA = 40;
const PREFIX = 12; // ① 의 맨 앞 보호 밖 key 수: 앞선 승격 업로드의 희생을 여기서 받아 lod1 key 가 살아남게 한다
// tiles: 보호 타일 수, xb: 비승격 도착 key 타일 번호의 시작(보호 타일 번호와 겹치지 않게 한다)
function arrivedList(tiles = TILES, xb = 1000) {
  return [
    ...Array.from({ length: tiles }, (_, i) => [lodKey(i, 0), lodKey(i, 1)]).flat(),
    ...Array.from({ length: EXTRA }, (_, i) => lodKey(xb + i, 0)),
    lodKey(xb + 900, 0), // 계측 전 준비 업로드용 도착 key
  ];
}
// ① 배치: [앞 free PREFIX][L1_i, F_i, F'_i (타일마다)][나머지 free]. 승격으로 보호에서 빠진 L1_i 가 복귀 소집합(back)에 들어가
// cand 의 free 사이(meta 원래 위치)에 끼어야 하므로 free 가 L1 앞에 몰려 있지 않게 섞는다
function layoutInterleaved() {
  const pre = Array.from({ length: PREFIX }, (_, i) => `4.1.${5000 + i}.0.0.0`);
  const mid = Array.from({ length: TILES }, (_, i) => [lodKey(i, 1), free(2 * i), free(2 * i + 1)]).flat();
  const rest = Array.from({ length: N - PREFIX - 3 * TILES }, (_, i) => free(1000 + i));
  return [...pre, ...mid, ...rest];
}
// ② 배치: 보호 key(타일마다 lod1 하나) PROT2 개가 meta 앞쪽(N 의 대부분), 보호 밖 key 가 뒤쪽.
// 경로 1(base 밖 후보 목록)을 끄면 업로드마다 앞쪽 보호 key 를 건너뛰어 읽기가 20×PROT2 ≥ 3×N 이 된다
const PROT2 = 3600;
const XB2 = 100000;
function layoutProtectedFront() {
  return [...Array.from({ length: PROT2 }, (_, i) => lodKey(i, 1)), ...Array.from({ length: N - PROT2 }, (_, i) => free(i))];
}
async function build(resident, tiles = TILES, xb = 1000) {
  const arrivedKeys = arrivedList(tiles, xb);
  const { r, evicted, up } = make(N);
  for (const k of resident) await up(k);
  r.setArrived(arrivedOf(arrivedKeys), { deferResult: true });
  r.draw();
  // 첫 도착 key 업로드 한 번은 보호 표·후보 목록을 처음 만들므로 계측 밖에 둔다(rc 경로)
  evicted.length = 0;
  await up(lodKey(xb + 900, 0));
  const order = resident.filter((k) => k !== evicted[0]);
  order.push(lodKey(xb + 900, 0));
  return { r, evicted, up, arrivedKeys, order };
}

test('희생 탐색 커서 ①(F-271): back 이 cand 사이에 끼는 배치에서 섞인 승격·재보호 뒤 희생 순서가 selectDrawable 원본과 같고 meta 읽기 총합이 4×N 미만이다', async () => {
  const { r, evicted, up, arrivedKeys, order } = await build(layoutInterleaved());
  const N1 = (j) => lodKey(1000 + j, 0); // 비승격 도착 key
  // 승격 타일 순서를 뒤섞어 back 에 meta 순번과 다른 순서로 들어가게 한다. rel = releasePiece(승격 lod0): 그 타일이 lod1 로 돌아가 L1 이 다시 보호된다
  const ops = [];
  const P = (i) => ops.push({ up: lodKey(i, 0) });
  const U = (j) => ops.push({ up: N1(j) });
  const R = (i) => ops.push({ rel: lodKey(i, 0) });
  P(2); P(0); U(0); P(1); R(1); P(4); U(1); P(3); R(3); U(2);
  for (let j = 3; j < 25; j++) { U(j); if (j === 8) P(6); if (j === 14) P(5); }
  for (let j = 25; j < 36; j++) U(j);
  const removed = [];
  let releases = 0;
  const reads = await countMetaReads(async () => {
    for (const op of ops) {
      evicted.length = 0;
      if (op.rel !== undefined) { r.releasePiece(op.rel); removed.push({ rel: op.rel }); releases++; } else { await up(op.up); removed.push({ up: op.up, victims: [...evicted] }); }
    }
  });
  // 희생 순서: 매 업로드마다 selectDrawable 원본이 고르는 첫 보호 밖 key(meta 순서)와 맞댄다(계측 밖)
  ops.forEach((op, i) => {
    if (op.rel !== undefined) {
      order.splice(order.indexOf(op.rel), 1);
      return;
    }
    const x = op.up;
    let want = [];
    if (order.length + 1 > N) {
      const draw = new Set(selectDrawable([...order, x], arrivedOf(arrivedKeys)).draw);
      const w = order.find((k) => k !== x && !draw.has(k));
      assert.ok(w !== undefined, `단계 ${i}: 기대 희생이 없음(시험 구성 오류)`);
      want = [w];
      order.splice(order.indexOf(w), 1);
    }
    assert.deepEqual(removed[i].victims, want, `단계 ${i}(${x}): 희생 key 가 원본과 다름`);
    order.push(x);
  });
  assert.equal(releases, 2);
  assert.deepEqual(r.residentKeys(), order);
  r.dispose();
  assert.ok(reads < 4 * N, `meta 읽기 ${reads} (${4 * N} 미만이어야 함)`);
});

test('희생 탐색 커서 ②(F-274 ⑩): 보호 key 가 meta 앞쪽일 때 새 타일 도착 key 업로드(rc 경로) 20회의 meta 읽기 총합이 3×N 미만이다', async () => {
  const { r, evicted, up } = await build(layoutProtectedFront(), PROT2, XB2);
  const removed = [];
  const reads = await countMetaReads(async () => {
    for (let i = 0; i < 20; i++) {
      evicted.length = 0;
      await up(lodKey(XB2 + i, 0)); // 새 타일의 도착 key: 보호가 늘 뿐 고른 LOD 는 바뀌지 않는다
      removed.push(...evicted);
    }
  });
  assert.equal(removed.length, 20, '업로드마다 희생이 하나씩이어야 함');
  assert.ok(removed.every((k) => k.startsWith('4.')), '보호 key 를 희생으로 고름');
  assert.equal(r.residentKeys().length, N);
  r.dispose();
  assert.ok(reads < 3 * N, `도착 key 업로드 20회의 meta 읽기 ${reads} (${3 * N} 미만이어야 함)`);
});
