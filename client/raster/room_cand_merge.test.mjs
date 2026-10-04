// 복귀 소집합 병합 시험(F-271): index.mjs backAdd 의 1024 초과 병합 분기. 계측·export 추가 없이 업로드 결과(희생 순서)만 본다.
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

// >1024 병합 분기 시험(F-271, index.mjs backAdd): 복귀 소집합(back)이 1024 를 넘고 cand 크기의 1/4 를 넘으면 cand 에 병합해 하나의 Set 으로 만든다.
// 병합 뒤에도 희생 순서가 meta 순서(선택 원본이 고르는 첫 보호 밖 key)여야 한다. 결과로만 본다(계측·export 없음).
const lodKey = (i, lod) => `3.1.${i}.0.${lod}.0`;
const free = (i) => `4.1.${i}.0.0.0`;
const arrivedOf = (keys) => [{ segmentId: 3, level: 1, keys }];

const T = 1100; // 타일 수(lod1 상주 key 타일마다 하나)
const PRE = 1200; // 맨 앞 보호 밖 key: 승격 업로드의 희생을 받아 L1 이 살아남게 한다
const PROMOTE = 1025; // 승격 수 = back 크기. 1025 번째 승격에서 back 이 1024 를 넘는다
const POST = 260; // 병합 뒤 비승격 도착 업로드 수(PRE 의 남은 key 를 지나 L1·F 가 섞인 구간까지 닿는다)
const N = PRE + 2 * T;

test('복귀 병합(F-271): back 이 1024 를 넘어 cand 에 병합된 뒤에도 희생 순서가 meta 순서이다', async () => {
  const evicted = [];
  const r = createRenderer({
    canvas: fakeCanvas(), decode, maxPieceBytes: 1 << 10, maxResidentBytes: N * POINT_BYTES, now: () => 0,
    onEvict: (k) => evicted.push(...k),
  });
  r.setView(VIEW);
  const up = (k) => r.uploadPiece(k, enc(k));
  const pre = Array.from({ length: PRE }, (_, i) => `4.1.${5000 + i}.0.0.0`);
  // [앞 free][L1_i, F_i (타일마다)]: 승격된 L1_i 는 back 에서 cand 의 F 사이로 병합되어야 한다
  const resident = [...pre, ...Array.from({ length: T }, (_, i) => [lodKey(i, 1), free(i)]).flat()];
  const nonPromo = (j) => lodKey(10000 + j, 0);
  const arrivedKeys = [
    ...Array.from({ length: T }, (_, i) => [lodKey(i, 0), lodKey(i, 1)]).flat(),
    ...Array.from({ length: POST }, (_, j) => nonPromo(j)),
    lodKey(9000, 0), // 준비 업로드용 도착 key
  ];
  for (const k of resident) await up(k);
  r.setArrived(arrivedOf(arrivedKeys), { deferResult: true });
  r.draw();
  // 준비 업로드: 보호 표·후보 목록(cand)을 먼저 만든다. 병합은 cand 가 있어야 일어난다
  evicted.length = 0;
  await up(lodKey(9000, 0));
  assert.deepEqual(evicted, [pre[0]]);
  const order = resident.filter((k) => k !== pre[0]);
  order.push(lodKey(9000, 0));
  let preUsed = 1;
  // 승격 업로드 PROMOTE 번(타일 순서는 뒤섞는다): 매번 희생은 앞 free 의 가장 오래된 key. 승격된 L1 은 back 에 쌓이다 1025 번째에 병합된다
  const seen = new Set();
  for (let n = 0; n < PROMOTE; n++) {
    const i = (n * 7919) % T; // 7919 는 T 와 서로소: 겹치지 않는 뒤섞인 순서
    assert.ok(!seen.has(i)); seen.add(i);
    evicted.length = 0;
    await up(lodKey(i, 0));
    assert.deepEqual(evicted, [pre[preUsed]], `승격 ${n}: 희생`);
    order.splice(order.indexOf(pre[preUsed]), 1);
    order.push(lodKey(i, 0));
    preUsed++;
  }
  // 병합 뒤 비승격 도착 key 업로드: 앞 free 를 다 쓴 다음 승격된 L1_i 와 F_i 가 meta 순서로 섞여 희생이 된다
  const victims = [];
  for (let j = 0; j < POST; j++) {
    const x = nonPromo(j);
    const draw = new Set(selectDrawable([...order, x], arrivedOf(arrivedKeys)).draw);
    const want = order.find((k) => k !== x && !draw.has(k));
    assert.ok(want !== undefined, `병합 뒤 ${j}: 기대 희생이 없음(시험 구성 오류)`);
    evicted.length = 0;
    await up(x);
    assert.deepEqual(evicted, [want], `병합 뒤 업로드 ${j}: 희생 key 가 원본과 다름`);
    order.splice(order.indexOf(want), 1);
    order.push(x);
    victims.push(want);
  }
  assert.ok(victims.some((k) => k.startsWith('3.')), '승격된 lod1 key 가 희생으로 뽑혀 병합 위치를 검증해야 함(시험 구성 오류)');
  assert.ok(victims.some((k) => k.startsWith('4.1.') && !pre.includes(k)), '타일 사이 free key 도 희생으로 뽑혀야 함(시험 구성 오류)');
  assert.deepEqual(r.residentKeys(), order);
  r.dispose();
});
