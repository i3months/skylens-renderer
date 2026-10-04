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

// 상주: 보호 밖 key 가 meta 앞쪽, 뒤쪽에 보호 타일마다 lod1 key 하나(그 타일의 고른 LOD 는 1).
// 승격 업로드는 앞쪽의 보호 밖 key 를 희생으로 고르고, 보호에서 빠진 옛 lod1 key 는 meta 에 남아 후보로 돌아온다.
// 도착 입력: 보호 타일마다 lod0·lod1 key, 그리고 비승격 도착 key 용 타일 EXTRA 개(lod0 하나).
const EXTRA = 40;
function setup() {
  const resident = [...Array.from({ length: N - TILES }, (_, i) => free(i)), ...Array.from({ length: TILES }, (_, i) => lodKey(i, 1))];
  const arrivedKeys = [
    ...Array.from({ length: TILES }, (_, i) => [lodKey(i, 0), lodKey(i, 1)]).flat(),
    ...Array.from({ length: EXTRA }, (_, i) => lodKey(1000 + i, 0)),
    lodKey(900, 0), // 계측 전 준비 업로드용 도착 key
  ];
  return { resident, arrivedKeys };
}
async function build() {
  const { resident, arrivedKeys } = setup();
  const { r, evicted, up } = make(N);
  for (const k of resident) await up(k);
  r.setArrived(arrivedOf(arrivedKeys), { deferResult: true });
  r.draw();
  // 첫 도착 key 업로드 한 번은 보호 표·후보 목록을 처음 만들므로 계측 밖에 둔다(rc 경로)
  await up(lodKey(900, 0));
  return { r, evicted, up, arrivedKeys, order: [...resident.filter((k) => k !== free(0)), lodKey(900, 0)] };
}

test('희생 탐색 커서 ①(F-271): LOD 승격 업로드와 비승격 도착 업로드 교대 40회의 meta 읽기 총합이 4×N 미만이고 희생 순서가 원본과 같다', async () => {
  const { r, evicted, up, arrivedKeys, order } = await build();
  const ups = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? lodKey(i / 2, 0) : lodKey(1000 + (i - 1) / 2, 0)));
  const removed = [];
  const reads = await countMetaReads(async () => {
    for (const x of ups) {
      evicted.length = 0;
      await up(x);
      removed.push([...evicted]);
    }
  });
  // 희생 순서: 매 업로드마다 selectDrawable 원본이 고르는 첫 보호 밖 key(meta 순서)와 맞댄다(계측 밖)
  ups.forEach((x, i) => {
    const draw = new Set(selectDrawable([...order, x], arrivedOf(arrivedKeys)).draw);
    const want = order.find((k) => k !== x && !draw.has(k));
    assert.ok(want !== undefined, `업로드 ${i}: 기대 희생이 없음(시험 구성 오류)`);
    assert.deepEqual(removed[i], [want], `업로드 ${i}: 희생 key 가 원본과 다름`);
    order.splice(order.indexOf(want), 1);
    order.push(x);
  });
  assert.deepEqual(r.residentKeys(), order);
  r.dispose();
  // 현재 구현은 승격 업로드마다 후보 목록을 버려 다음 업로드가 meta 전체를 다시 돈다(20 × N 이상). 기준: 4 × N 미만
  assert.ok(reads < 4 * N, `업로드 40회의 meta 읽기 ${reads} (${4 * N} 미만이어야 함)`);
});

test('희생 탐색 커서 ②(F-274 ⑩): 도착 key 업로드(rc 경로) 20회의 meta 읽기 총합이 N 미만이다', async () => {
  const { r, evicted, up } = await build();
  const removed = [];
  const reads = await countMetaReads(async () => {
    for (let i = 0; i < 20; i++) {
      evicted.length = 0;
      await up(lodKey(1000 + i, 0)); // 새 타일의 도착 key: 보호가 늘 뿐 고른 LOD 는 바뀌지 않는다
      removed.push(...evicted);
    }
  });
  assert.equal(removed.length, 20, '업로드마다 희생이 하나씩이어야 함');
  assert.ok(removed.every((k) => k.startsWith('4.')), '보호 key 를 희생으로 고름');
  assert.equal(r.residentKeys().length, N);
  r.dispose();
  assert.ok(reads < N, `도착 key 업로드 20회의 meta 읽기 ${reads} (${N} 미만이어야 함)`);
});
