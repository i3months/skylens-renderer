// F-259 ②⑤: makeRoom 의 보호 집합 캐시(roomCache)와 새 key 거부 판정 시험. 호출 횟수·결과만 본다(벽시계 아님).
// 변이 대상: roomCache 적중 조건의 gen 검사·key 검사, setArrived 두 경로의 roomCache 비우기.
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

const POINT_BYTES = 17;
// 바이트에 key 문자열을 실어 보내 한 점짜리 조각으로 복호하는 시험용 decode
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

function make(maxPieces, extra = {}) {
  const evicted = [];
  const calls = { select: 0 };
  const r = createRenderer({
    canvas: fakeCanvas(), decode, maxPieceBytes: 1 << 10, maxResidentBytes: maxPieces * POINT_BYTES, now: () => 0,
    onEvict: (k) => evicted.push(...k),
    testHooks: { selectDrawable: (k, a) => { calls.select += 1; return selectDrawable(k, a); } },
    ...extra,
  });
  r.setView(VIEW);
  const up = (k) => r.uploadPiece(k, enc(k));
  const rejected = (k) => assert.rejects(up(k), (e) => e.code === 'memory');
  return { r, evicted, calls, up, rejected };
}

const R1 = '3.1.0.0.1.0'; // 타일 T1 의 lod1(완전하면 보호)
const Y = '3.1.0.0.0.0'; // T1 의 lod0: 올라오면 lod0 가 완전해져 R1 은 더는 그리지 않는다
const R2 = '3.1.5.0.0.0'; // 타일 T3
const R2B = '3.1.5.0.0.1'; // T3 의 둘째 chunk
const X = '3.1.9.0.0.0'; // 상주가 없는 타일: 어떤 보호도 바꾸지 않는다

for (const deferred of [true, false]) {
  const opt = deferred ? { deferResult: true } : undefined;
  const arrivedAll = [{ segmentId: 3, level: 1, keys: [R1, Y, R2, R2B, X] }];

  test(`F-259 ⑤: 다른 key 거부 직후 Y 업로드는 다시 계산한 보호 집합으로 [R1] 을 퇴출한다 (deferred=${deferred})`, async () => {
    const { r, evicted, up, rejected } = make(2);
    await up(R1);
    await up(R2);
    r.setArrived(arrivedAll, opt);
    r.draw();
    await rejected(X); // R1·R2 모두 그리는 조각
    await up(Y); // Y 가 T1 의 lod0 를 완성: R1 은 보호에서 빠진다. X 의 보호 집합을 재사용하면 여기서 거부된다
    assert.deepEqual(evicted, [R1]);
    assert.deepEqual(r.residentKeys(), [R2, Y]);
    r.dispose();
  });

  test(`F-259 ⑤: releasePiece 뒤 같은 key 재시도는 다시 거부된다 (deferred=${deferred})`, async () => {
    const { r, evicted, up, rejected } = make(2);
    await up(R1);
    await up(R2);
    r.setArrived(arrivedAll, opt);
    r.draw();
    await rejected(X);
    r.releasePiece(R2); // 상주가 바뀐다(metaGen)
    await up(R2B); // 자리가 있어 퇴출 없음. 이제 보호 대상은 R1·R2B
    await rejected(X); // 옛 보호 집합({R1, R2})을 쓰면 R2B 를 퇴출하고 성공한다
    assert.deepEqual(evicted, []);
    assert.deepEqual(r.residentKeys(), [R1, R2B]);
    r.dispose();
  });

  test(`F-259 ⑤·F-260 ①: setArrived 로 도착 입력을 바꾸면 같은 key 재시도는 새 입력으로 판정한다 (deferred=${deferred})`, async () => {
    const { r, evicted, up, rejected } = make(2);
    await up(R1);
    await up(R2);
    r.setArrived(arrivedAll, opt);
    r.draw();
    await rejected(X);
    // R1·R2 가 도착 집합에서 빠지고 X 만 남는다(R1·R2 는 pending): 이제 X 를 올리려고 오래된 R1 을 내보낼 수 있다
    r.setArrived([{ segmentId: 3, level: 1, keys: [X] }], opt);
    await up(X);
    assert.deepEqual(evicted, [R1]);
    r.dispose();
  });
}

test('F-259 ②: 서로 다른 도착 key 300 개의 연속 거부가 select 를 부르지 않는다', async () => {
  const keys = Array.from({ length: 300 }, (_, i) => `3.1.${100 + i}.0.0.0`);
  const { r, calls, up, rejected } = make(2);
  await up(R1);
  await up(R2);
  r.setArrived([{ segmentId: 3, level: 1, keys: [R1, R2, ...keys] }], { deferResult: true });
  r.draw();
  calls.select = 0;
  for (const k of keys) await rejected(k);
  assert.ok(calls.select <= 1, `거부 300회에 select ${calls.select}회`);
  assert.deepEqual(r.residentKeys(), [R1, R2]);
  r.dispose();
});

test('F-259 ②: 같은 타일의 서로 다른 chunk 300 개 거부도 select 를 부르지 않는다', async () => {
  const chunks = Array.from({ length: 300 }, (_, i) => `3.1.0.0.0.${i}`); // R1 의 타일 T1 의 lod0
  const { r, calls, up, rejected } = make(2);
  await up(R1);
  await up(R2);
  r.setArrived([{ segmentId: 3, level: 1, keys: [R1, R2, ...chunks] }]);
  r.draw();
  calls.select = 0;
  for (const k of chunks) await rejected(k); // lod0 는 300 chunk 중 하나뿐이라 완전하지 않아 R1(lod1, 완전)이 그대로 보호된다
  assert.ok(calls.select <= 1, `거부 300회에 select ${calls.select}회`);
  r.dispose();
});

test('F-259 ②: 보호 판정이 selectDrawable 과 같다(무작위 상태에서 새 key 마다 맞대어 봄)', async () => {
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >> 8) % n; };
  const pool = [];
  for (const level of [1, 2]) for (let tx = 0; tx < 3; tx++) for (let lod = 0; lod < 3; lod++) for (let c = 0; c < 2; c++) pool.push(`3.${level}.${tx}.0.${lod}.${c}`);
  for (let round = 0; round < 60; round++) {
    const arrivedKeys = pool.filter(() => rnd(3) > 0);
    const levels = [1, 2].filter((l) => arrivedKeys.some((k) => k.split('.')[1] === String(l)));
    const arrived = levels.map((l) => ({ segmentId: 3, level: l, keys: arrivedKeys.filter((k) => k.split('.')[1] === String(l)) }));
    const cap = 2 + rnd(4);
    const { r, evicted, up } = make(cap);
    const resident = [];
    for (const k of pool.filter(() => rnd(3) === 0).slice(0, cap)) { await up(k); resident.push(k); }
    r.setArrived(arrived, rnd(2) ? { deferResult: true } : undefined);
    if (rnd(2)) r.draw();
    for (const x of pool.filter((k) => arrivedKeys.includes(k) && !resident.includes(k)).slice(0, 6)) {
      const before = r.residentKeys();
      const expectDraw = new Set(selectDrawable([...before, x], arrived).draw);
      evicted.length = 0;
      let ok = true;
      try { await up(x); } catch (e) { assert.equal(e.code, 'memory'); ok = false; }
      for (const v of evicted) assert.equal(expectDraw.has(v), false, `보호 대상 ${v} 를 퇴출함(round ${round}, key ${x})`);
      if (!ok) {
        // 거부는 보호 밖 희생이 모자랄 때만이다
        const unprotected = before.filter((k) => !expectDraw.has(k)).length;
        assert.equal(unprotected, 0, `불필요한 거부(round ${round}, key ${x})`);
      }
    }
    r.dispose();
  }
});
