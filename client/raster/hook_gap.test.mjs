// F-261: GL 구간 경계 hook 과 첫/마지막 GL 호출 사이의 "사건 없는 CPU 작업"을 잡는다.
// hook_order.test.mjs 는 로그에 남는 사건의 순서만 보므로, onGlUploadStart 와 pool.upload 사이(또는 draw 구간 안)에
// 호출이 없는 CPU 작업(busy loop 등)이 들어가도 통과한다. 호출이 없는 작업은 Proxy 로도 기록할 수 없고, 제품 코드가 이 구간에서
// now 를 부르지도 않아 가짜 now 로도 못 잡는다. 그래서 결정적 판정이 불가능하며, 시험이 찍는 실시각 간격에 아주 넉넉한 상한을 둔다.
//  - 정상 간격은 수 µs~수백 µs 다(가짜 gl 호출 몇 번). 상한 GAP_LIMIT_MS=60 은 정상의 수백 배고, 변이 120 ms 는 그 두 배라 잡는다.
//  - 한 번의 GC·스케줄링 지연으로 거짓 실패가 나지 않게, 같은 시나리오를 REPEAT 번 돌려 간격별 최솟값에 상한을 건다
//    (변이는 매번 120 ms 이상이므로 최솟값도 120 ms 이상, 일시 지연은 최솟값에 영향이 없다).
//  - 시험이 직접 시각을 찍는 것이라 제품 코드의 시계 주입(now)과 무관하며, 산출은 npm test 에서 느려도 판정이 흔들리지 않는다.
//  - 연속 GL 사건 사이(구간 안쪽)의 최대 간격 mid 도 같은 방식(반복 최솟값 ≤ 상한)으로 단언한다. draw 루프 안 drawArrays 앞의 busy wait 같은
//    head/tail 밖 변이는 mid 로만 잡힌다(브라우저 시험에만 의존하지 않는다).
// 측정 간격: (Start→첫 GL 호출), (마지막 GL 호출→End), (onDrawStart→첫 GL 호출), (마지막 GL 호출→onDrawEnd), (연속 GL 호출 사이 최대 mid).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer, toGpuPlanes } from './index.mjs';
import { packChunk } from '../../server/asset/pack/index.mjs';
import { FORMAT_POINT27 } from '../../contracts/client_raster/index.mjs';

const GAP_LIMIT_MS = 60;
const REPEAT = 5;
const clock = () => performance.now();

function fakeCanvas(ev) {
  const base = {
    getShaderParameter: () => true, getProgramParameter: () => true, createShader: () => ({}), createProgram: () => ({}),
    createVertexArray: () => ({}), getUniformLocation: (_p, name) => ({ name }),
    getParameter: () => [1, 1024], isContextLost: () => false,
  };
  const gl = new Proxy(base, {
    get(t, p) {
      if (p in t) return t[p];
      if (typeof p === 'string' && /^[A-Z_0-9]+$/.test(p)) return p;
      if (p === 'createBuffer') return () => { ev.push({ n: 'gl.createBuffer', at: clock() }); return {}; };
      return () => { ev.push({ n: `gl.${String(p)}`, at: clock() }); };
    },
  });
  return { width: 300, height: 150, getContext: (k) => (k === 'webgl2' ? gl : null), addEventListener() {}, removeEventListener() {} };
}

function piece(key) {
  const [segmentId, level, , , lod, chunkIndex] = key.split('.').map(Number);
  return packChunk({
    format: FORMAT_POINT27, segmentId, level, lod, chunkIndex, anchor: { lat: 37.5, lon: 127, alt: 30 },
    fields: { positions: Float32Array.from([0.5, 0.5, 5]), colors: Uint8Array.from([200, 200, 200]), normals: Float32Array.from([0, 0, 1]) },
  });
}
const VIEW = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [-1, -1, 0], K: { fx: 20, fy: 20, cx: 16.5, cy: 12.5 }, width: 32, height: 24, devicePixelRatio: 1 };
const C0 = '3.1.0.0.1.0'; // 성긴 LOD(완전)
const V1 = '3.1.0.0.0.0'; // 세밀한 LOD 첫 chunk
const N1 = '3.1.0.0.0.1'; // 세밀한 LOD 둘째 chunk: 한도가 빠듯하면 올릴 때 C0 가 희생된다

function setup(maxResidentBytes, evicted) {
  const ev = [];
  const mark = (n) => () => { ev.push({ n, at: clock() }); };
  const r = createRenderer({
    canvas: fakeCanvas(ev), maxPieceBytes: 1 << 20, maxResidentBytes, now: () => 1,
    onEvict: (keys) => { evicted?.push(...keys); },
    testHooks: {
      toGpuPlanes: (...a) => toGpuPlanes(...a),
      onGlUploadStart: mark('onGlUploadStart'), onGlUploadEnd: mark('onGlUploadEnd'),
      onDrawStart: mark('onDrawStart'), onDrawEnd: mark('onDrawEnd'),
    },
  });
  return { r, ev };
}

// Start/End 사이의 GL 호출만 골라 [시작→첫 호출, 마지막 호출→끝] 간격(ms)을 돌려준다
function spanGaps(ev, startName, endName) {
  const s = ev.findIndex((e) => e.n === startName);
  const e = ev.findIndex((x, i) => i > s && x.n === endName);
  assert.ok(s >= 0 && e > s, `${startName}/${endName} 짝이 없음: ${ev.map((x) => x.n).join(' ')}`);
  const gl = ev.slice(s + 1, e);
  assert.ok(gl.length > 0 && gl.every((x) => x.n.startsWith('gl.')), `구간 안에 GL 호출이 없거나 다른 사건: ${gl.map((x) => x.n).join(' ')}`);
  let mid = 0;
  for (let i = 1; i < gl.length; i += 1) mid = Math.max(mid, gl[i].at - gl[i - 1].at);
  return { head: gl[0].at - ev[s].at, tail: ev[e].at - gl.at(-1).at, mid };
}

function minOf(list, k) { return Math.min(...list.map((g) => g[k])); }

async function runUpload(maxResidentBytes, prepare, evicted) {
  const { r, ev } = setup(maxResidentBytes, evicted);
  r.setView(VIEW);
  await prepare(r);
  ev.length = 0;
  if (evicted) evicted.length = 0; // 준비 중 희생은 버리고 N1 업로드가 일으킨 희생만 본다
  await r.uploadPiece(N1, piece(N1));
  r.dispose();
  return spanGaps(ev, 'onGlUploadStart', 'onGlUploadEnd');
}

test(`업로드(희생 있음): Start→첫 GL, 마지막 GL→End 간격이 ${GAP_LIMIT_MS} ms 이하(${REPEAT} 회 중 최솟값)`, async () => {
  const gaps = [];
  for (let i = 0; i < REPEAT; i += 1) {
    const evicted = [];
    gaps.push(await runUpload(34, async (r) => {
      await r.uploadPiece(C0, piece(C0));
      await r.uploadPiece(V1, piece(V1));
      r.setArrived([{ segmentId: 3, level: 1, keys: [C0, V1, N1] }]);
      r.draw();
    }, evicted));
    // 한도가 빠듯해 N1 업로드에서 희생이 실제로 났음을 단언한다(한도가 넉넉하면 이 시험이 희생 경로를 타지 않는다)
    assert.ok(evicted.length > 0, `희생 없음: 한도 34 B 에서 onEvict 가 불리지 않음(회차 ${i})`);
  }
  assert.ok(minOf(gaps, 'head') <= GAP_LIMIT_MS, `Start→첫 GL 호출 간격 ${minOf(gaps, 'head').toFixed(2)} ms`);
  assert.ok(minOf(gaps, 'tail') <= GAP_LIMIT_MS, `마지막 GL 호출→End 간격 ${minOf(gaps, 'tail').toFixed(2)} ms`);
  assert.ok(minOf(gaps, 'mid') <= GAP_LIMIT_MS, `연속 GL 호출 사이 최대 간격 ${minOf(gaps, 'mid').toFixed(2)} ms`);
});

test(`업로드(희생 없음): Start→첫 GL, 마지막 GL→End 간격이 ${GAP_LIMIT_MS} ms 이하(${REPEAT} 회 중 최솟값)`, async () => {
  const gaps = [];
  for (let i = 0; i < REPEAT; i += 1) gaps.push(await runUpload(1 << 20, async () => {}));
  assert.ok(minOf(gaps, 'head') <= GAP_LIMIT_MS, `Start→첫 GL 호출 간격 ${minOf(gaps, 'head').toFixed(2)} ms`);
  assert.ok(minOf(gaps, 'tail') <= GAP_LIMIT_MS, `마지막 GL 호출→End 간격 ${minOf(gaps, 'tail').toFixed(2)} ms`);
  assert.ok(minOf(gaps, 'mid') <= GAP_LIMIT_MS, `연속 GL 호출 사이 최대 간격 ${minOf(gaps, 'mid').toFixed(2)} ms`);
});

test(`draw: onDrawStart→첫 GL, 마지막 GL→onDrawEnd 간격이 ${GAP_LIMIT_MS} ms 이하(${REPEAT} 회 중 최솟값)`, async () => {
  const gaps = [];
  for (let i = 0; i < REPEAT; i += 1) {
    const { r, ev } = setup(1 << 20);
    r.setView(VIEW);
    await r.uploadPiece(C0, piece(C0));
    r.setArrived([{ segmentId: 3, level: 1, keys: [C0] }], { deferResult: true });
    ev.length = 0;
    assert.equal(r.draw().drawnPieces, 1);
    gaps.push(spanGaps(ev, 'onDrawStart', 'onDrawEnd'));
    r.dispose();
  }
  assert.ok(minOf(gaps, 'head') <= GAP_LIMIT_MS, `onDrawStart→첫 GL 호출 간격 ${minOf(gaps, 'head').toFixed(2)} ms`);
  assert.ok(minOf(gaps, 'tail') <= GAP_LIMIT_MS, `마지막 GL 호출→onDrawEnd 간격 ${minOf(gaps, 'tail').toFixed(2)} ms`);
  assert.ok(minOf(gaps, 'mid') <= GAP_LIMIT_MS, `연속 GL 호출 사이 최대 간격 ${minOf(gaps, 'mid').toFixed(2)} ms`);
});
