// 완료 기준 '옵션 전환 시 네트워크 요청 0' 시험.
// 검사 함수 runNoNetworkCheck(factory) 는 층 팩토리를 받아 실제 층과 가짜 층에 같이 돌린다.
// 실제 층 시험은 환경 변수 없이 ./index.mjs 를 동적으로 불러온다. 아직 없으면 건너뛰지 않고 명확히 실패한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import http2 from 'node:http2';
import dns, { lookup as namedLookup } from 'node:dns';
import { setInterval as namedSetInterval } from 'node:timers';
import { installNetworkSpies } from './network_spies.mjs';
import {
  createFetchOnSetModeFake, createReacceptOnSetModeFake, createCleanFake,
  createDelayedFetchFake, createNamedDnsLookupFake, createSlowDelayedFetchFake,
} from './no_network_fake.mjs';

const MODES = ['points', 'black', 'aerial'];
const SWITCHES = 200;

/** 위에서 내려다보는 카메라(영상 위 = 북, 높이 40 m). 건물 한 동(10 m 상자)이 약 33 화소 폭으로 보인다. */
function topDownCamera() {
  return { width: 160, height: 90, K: { fx: 100, fy: 100, cx: 80, cy: 45 }, R: [1, 0, 0, 0, -1, 0, 0, 0, -1], t: [0, 0, 40] };
}

/** 합성 묶음: 10×10×10 m 상자 한 동. 아래 정점 0..3(wallMask 1), 위 정점 4..7(wallMask 0). image 2×2. */
function syntheticBundle() {
  const h = 5;
  const pos = [
    -5, -5, -h, 5, -5, -h, 5, 5, -h, -5, 5, -h,
    -5, -5, h, 5, -5, h, 5, 5, h, -5, 5, h,
  ];
  const uv = [0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1];
  const idx = [
    4, 5, 6, 4, 6, 7, // 지붕(위에서 볼 때 반시계)
    0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7, // 벽
    0, 3, 2, 0, 2, 1, // 바닥
  ];
  const edges = [];
  for (const [a, b] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) {
    edges.push(...pos.slice(3 * a, 3 * a + 3), ...pos.slice(3 * b, 3 * b + 3));
  }
  const points = [];
  for (let i = -4; i <= 4; i += 2) for (let j = -4; j <= 4; j += 2) points.push(i, j, h);
  return {
    groups: [{
      ids: [1],
      mesh: { positions: new Float32Array(pos), indices: new Uint32Array(idx) },
      edgeLines: new Float32Array(edges),
      uv: new Float32Array(uv),
      wallMask: new Uint8Array([1, 1, 1, 1, 0, 0, 0, 0]),
      points: new Float32Array(points),
    }],
    image: { width: 2, height: 2, rgb: new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]) },
  };
}

const bytesOf = (r) => Buffer.concat([
  Buffer.from(r.color.buffer, r.color.byteOffset, r.color.byteLength),
  Buffer.from(r.depth.buffer, r.depth.byteOffset, r.depth.byteLength),
  Buffer.from(r.index.buffer, r.index.byteOffset, r.index.byteLength),
]);

/**
 * 층 팩토리(() => layer, 비동기 가능)에 대해 '옵션 전환 시 네트워크 0' 을 검사한다.
 * 던지지 않고 { ok, problems, networkCalls, acceptCalls } 를 돌려준다(위반 목록이 비면 ok).
 */
export async function runNoNetworkCheck(factory) {
  const problems = [];
  const spies = installNetworkSpies();
  let acceptCalls = 0;
  try {
    const layer = await factory();
    const origAccept = layer.accept;
    layer.accept = function wrappedAccept(...a) { acceptCalls += 1; return origAccept.apply(this, a); };
    const camera = topDownCamera();

    layer.accept(0, syntheticBundle());
    const firstSeen = new Map(); // 옵션 → 처음 그린 바이트
    for (let i = 0; i < SWITCHES; i += 1) {
      const mode = MODES[i % MODES.length];
      layer.setMode(mode);
      if (layer.mode() !== mode) problems.push(`전환 ${i}: mode() 가 ${layer.mode()} (기대 ${mode})`);
      const bytes = bytesOf(layer.render(camera));
      if (!firstSeen.has(mode)) firstSeen.set(mode, bytes);
      else if (!firstSeen.get(mode).equals(bytes)) problems.push(`전환 ${i}: ${mode} 결과가 처음과 다름(상태 오염)`);
    }
    for (let a = 0; a < MODES.length; a += 1) {
      for (let b = a + 1; b < MODES.length; b += 1) {
        if (firstSeen.get(MODES[a]).equals(firstSeen.get(MODES[b]))) problems.push(`옵션 ${MODES[a]} 와 ${MODES[b]} 의 render 결과가 같음`);
      }
    }
  } catch (e) {
    problems.push(`예외: ${e && e.message}`);
  } finally {
    await spies.restore();
  }
  if (spies.calls.length !== 0) problems.push(`네트워크 감시자 호출 ${spies.calls.length} 번: ${[...new Set(spies.calls)].join(',')}`);
  if (acceptCalls !== 1) problems.push(`accept 호출 ${acceptCalls} 번 (기대 1)`);
  return { ok: problems.length === 0, problems, networkCalls: spies.calls.slice(), acceptCalls };
}

test('실제 층: 옵션 200 번 전환에 네트워크 0, accept 1 번, 옵션별 결과 구별·재현', async () => {
  let mod;
  try {
    mod = await import('./index.mjs');
  } catch (e) {
    assert.fail(`client/tower/buildings/index.mjs 를 불러올 수 없음(조립 전이면 정상 실패): ${e && e.message}`);
  }
  assert.equal(typeof mod.createBuildingsLayer, 'function', 'createBuildingsLayer 를 내보내야 함');
  const r = await runNoNetworkCheck(() => mod.createBuildingsLayer());
  assert.deepEqual(r.problems, []);
  assert.equal(r.networkCalls.length, 0);
  assert.equal(r.acceptCalls, 1);
});

test('감시자 자체: 설치하면 호출을 세고, 원복하면 원래 전역으로 돌아온다', async (t) => {
  const before = {
    fetch: globalThis.fetch, ws: globalThis.WebSocket, req: http.request, lookup: dns.lookup, connect: net.connect,
    plookup: dns.promises.lookup, h2: http2.connect, named: namedLookup,
  };
  const s = installNetworkSpies();
  t.after(() => s.restore()); // 단언이 실패해도 전역을 원복한다(restore 는 두 번 불러도 안전)
  globalThis.fetch('x');
  assert.throws(() => http.request('http://x'));
  assert.throws(() => net.connect(1));
  assert.throws(() => dns.lookup('x', () => {}));
  assert.throws(() => namedLookup('x', () => {}), '이름으로 가져온 lookup 도 잡혀야 함(syncBuiltinESMExports)');
  assert.throws(() => http2.connect('http://x'));
  await assert.rejects(dns.promises.lookup('x'));
  assert.equal(typeof globalThis.WebSocket, 'function');
  assert.deepEqual(s.calls, ['fetch', 'http.request', 'net.connect', 'dns.lookup', 'dns.lookup', 'http2.connect', 'dns.promises.lookup']);
  await s.restore();
  assert.equal(globalThis.fetch, before.fetch);
  assert.equal(globalThis.WebSocket, before.ws);
  assert.equal(http.request, before.req);
  assert.equal(dns.lookup, before.lookup);
  assert.equal(namedLookup, before.named);
  assert.equal(net.connect, before.connect);
  assert.equal(dns.promises.lookup, before.plookup);
  assert.equal(http2.connect, before.h2);
});

test('가짜 층(위반 없음): 검사 함수를 통과한다(양성 대조)', async () => {
  const r = await runNoNetworkCheck(createCleanFake);
  assert.deepEqual(r.problems, []);
  assert.equal(r.acceptCalls, 1);
});

test('음성 (a): setMode 안에서 fetch 를 부르는 층은 검사에서 실패한다', async () => {
  const r = await runNoNetworkCheck(createFetchOnSetModeFake);
  assert.equal(r.ok, false);
  assert.equal(r.networkCalls.length, SWITCHES);
  assert.ok(r.problems.some((p) => p.includes('네트워크 감시자 호출')), r.problems.join('|'));
});

test('음성 (b): 전환마다 accept 를 다시 요구하는 층은 검사에서 실패한다', async () => {
  const r = await runNoNetworkCheck(createReacceptOnSetModeFake);
  assert.equal(r.ok, false);
  assert.equal(r.acceptCalls, 1 + SWITCHES);
  assert.ok(r.problems.some((p) => p.includes('accept 호출')), r.problems.join('|'));
  assert.equal(r.networkCalls.length, 0);
});

test('음성 M4: setTimeout 으로 미룬 fetch 도 감시자가 잡아 검사에서 실패한다', async () => {
  const r = await runNoNetworkCheck(createDelayedFetchFake);
  assert.equal(r.ok, false);
  assert.ok(r.networkCalls.includes('fetch'), r.networkCalls.join(','));
  assert.ok(r.problems.some((p) => p.includes('네트워크 감시자 호출') && p.includes('fetch')), r.problems.join('|'));
});

test('음성 M3: 이름으로 가져온 node:dns lookup 호출도 감시자가 잡아 검사에서 실패한다', async () => {
  const r = await runNoNetworkCheck(createNamedDnsLookupFake);
  assert.equal(r.ok, false);
  assert.ok(r.networkCalls.includes('dns.lookup'), r.networkCalls.join(','));
  assert.ok(r.problems.some((p) => p.includes('네트워크 감시자 호출') && p.includes('dns.lookup')), r.problems.join('|'));
});

test('음성 M5: 1000 ms 뒤로 미룬 fetch 도 mock 타이머 runAll 로 잡혀 검사에서 실패한다', async () => {
  const r = await runNoNetworkCheck(createSlowDelayedFetchFake);
  assert.equal(r.ok, false);
  assert.ok(r.networkCalls.includes('fetch'), r.networkCalls.join(','));
});

test('음성 M6: node:timers 에서 이름으로 가져온 setInterval(600000 ms, unref)로 미룬 fetch 도 실제 층 사본에서 잡혀 검사에서 실패한다', async () => {
  const mod = await import('./index.mjs');
  // 실제 층의 사본: setMode 에서 이름으로 가져온 setInterval 로 600000 ms·unref 타이머를 걸고, 그 안에서 fetch 한다.
  const r = await runNoNetworkCheck(async () => {
    const layer = await mod.createBuildingsLayer();
    const origSetMode = layer.setMode;
    layer.setMode = function mutatedSetMode(m) {
      const out = origSetMode.call(this, m);
      namedSetInterval(() => { globalThis.fetch('http://127.0.0.1:1/aerial.png'); }, 600000).unref();
      return out;
    };
    return layer;
  });
  assert.equal(r.ok, false);
  assert.ok(r.networkCalls.includes('fetch'), r.networkCalls.join(','));
  assert.ok(r.problems.some((p) => p.includes('네트워크 감시자 호출') && p.includes('fetch')), r.problems.join('|'));
});
