// 희생 탐색 커서 시험: makeRoom 이 meta 앞쪽 보호 key 를 매 업로드마다 다시 건너뛰지 않아도(증분 후보 목록/커서)
// 고르는 희생 key·순서가 selectDrawable 동치 원본과 같고, 건너뛰는 meta 읽기 횟수가 업로드 수에 비례해 늘지 않는지 본다.
// 호출 횟수·선택 결과만 본다(벽시계 아님). 계측은 export·testHooks 추가 없이 Map.prototype 의 순회 메서드를 잠깐 감싸 세는 방식이다.
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

// 보호(도착) key: 세그먼트 3, 타일마다 lod0 chunk0 하나(완전 → 그린다). 보호 밖: 세그먼트 4(도착 입력에 없음)
const prot = (i) => `3.1.${i}.0.0.0`;
const free = (i) => `4.1.${i}.0.0.0`;
const arrivedOf = (keys) => [{ segmentId: 3, level: 1, keys }];

// 업로드 uploads 회를 돌며 매번 희생 key 를 selectDrawable 원본이 고르는 첫 보호 밖 key(meta 순서)와 맞댄다.
// plan(i) 가 도착 key 배열을 돌려주면 그 업로드 앞에서 setArrived 로 도착 집합을 바꾼다.
async function runAgainstOracle({ resident, uploads, fresh, initialArrived, plan }) {
  const { r, evicted, up } = make(resident.length);
  for (const k of resident) await up(k);
  let arrivedKeys = initialArrived;
  const apply = (keys) => {
    arrivedKeys = keys;
    r.setArrived(arrivedOf(arrivedKeys));
    r.draw();
  };
  apply(arrivedKeys);
  for (let i = 0; i < uploads; i++) {
    const np = plan?.(i);
    if (np) apply(np);
    const x = fresh(i);
    if (x.startsWith('3.') && !arrivedKeys.includes(x)) apply([...arrivedKeys, x]); // 새 도착 key 는 올리기 전에 도착 집합에 넣는다
    const before = r.residentKeys();
    const draw = new Set(selectDrawable([...before, x], arrivedOf(arrivedKeys)).draw);
    const want = before.find((k) => k !== x && !draw.has(k));
    assert.ok(want !== undefined, `업로드 ${i}: 기대 희생이 없음(시험 구성 오류)`);
    evicted.length = 0;
    await up(x);
    assert.deepEqual(evicted, [want], `업로드 ${i}: 희생 key 가 원본과 다름`);
    assert.deepEqual(r.residentKeys(), [...before.filter((k) => k !== want), x], `업로드 ${i}: 상주 순서가 다름`);
  }
  r.dispose();
}

const RESIDENT_200 = [...Array.from({ length: 150 }, (_, i) => prot(i)), ...Array.from({ length: 50 }, (_, i) => free(i))];
const FRONT_150 = RESIDENT_200.slice(0, 150);

test('희생 탐색 커서 ①: 상주 200·보호 앞쪽 150·업로드 20회 모두 원본과 같은 희생을 고른다', async () => {
  await runAgainstOracle({
    resident: RESIDENT_200, initialArrived: FRONT_150, uploads: 20,
    // 짝수 회는 새 도착(보호) key, 홀수 회는 보호 밖 key 를 올린다
    fresh: (i) => (i % 2 === 0 ? prot(1000 + i) : free(1000 + i)),
  });
});

test('희생 탐색 커서 ②: 보호가 중간에 풀리고 새 보호 key 가 앞쪽에 생겨도 20회 뒤 원본과 같다', async () => {
  await runAgainstOracle({
    resident: RESIDENT_200, initialArrived: FRONT_150, uploads: 20,
    fresh: (i) => (i % 3 === 0 ? prot(1000 + i) : free(1000 + i)),
    plan: (i) => {
      // 5회째: 앞쪽 0..29 의 보호가 풀린다(도착 집합에서 빠져 앞쪽 희생 후보가 된다)
      if (i === 5) return FRONT_150.slice(30);
      // 10회째: 보호 밖 영역의 key 가 도착 집합에 들어 새로 보호된다(세그먼트 4 로 올라온 key 는 따로 도착 입력에 실린다)
      if (i === 10) return [...FRONT_150.slice(30), prot(1000), prot(1003)];
      // 15회째: 풀렸던 앞쪽 key 가 다시 보호된다
      if (i === 15) return FRONT_150.slice(10);
      return null;
    },
  });
});

// meta(Map 하위 클래스)의 순회로 읽힌 항목 수를 센다. Map.prototype 의 순회 메서드를 잠깐 감싼다.
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

test('희생 탐색 커서 ③: 상주 4000·보호 앞쪽 3990 에서 업로드 20회의 meta 읽기 총합이 4000 미만이다', async () => {
  const N = 4000;
  const FRONT = 3990;
  const resident = [...Array.from({ length: FRONT }, (_, i) => prot(i)), ...Array.from({ length: N - FRONT }, (_, i) => free(i))];
  const { r, evicted, up } = make(N);
  for (const k of resident) await up(k);
  r.setArrived(arrivedOf(resident.slice(0, FRONT)), { deferResult: true });
  r.draw();
  // 첫 업로드 한 번은 보호 표를 처음 만들 수 있으므로 계측 밖에 둔다(그 뒤 20회가 대상). 올리는 key 는 도착 집합 밖이다
  await up(free(5000));
  const removed = [];
  const reads = await countMetaReads(async () => {
    for (let i = 0; i < 20; i++) {
      evicted.length = 0;
      await up(free(6000 + i));
      removed.push(...evicted);
    }
  });
  assert.equal(removed.length, 20, '업로드마다 희생이 하나씩이어야 함');
  assert.ok(removed.every((k) => k.startsWith('4.')), '보호 key 를 희생으로 고름');
  assert.equal(r.residentKeys().length, N);
  r.dispose();
  assert.ok(reads < N, `업로드 20회의 meta 읽기 ${reads} (4000 미만이어야 함, 건너뛰기를 매번 다시 하면 약 ${20 * FRONT})`);
});
