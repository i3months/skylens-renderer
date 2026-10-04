import test from 'node:test';
import assert from 'node:assert';
import { runOffline } from './index.mjs';
import http from 'node:http';

// 네트워크를 사용하지 않는 함수
test('no network calls', async () => {
  const fn = () => 'result';
  const { result, networkCalls } = await runOffline(fn);
  assert.strictEqual(result, 'result');
  assert.strictEqual(networkCalls, 0);
});

// fetch 한 번 호출
test('fetch once', async () => {
  const fn = async () => {
    try {
      await globalThis.fetch('https://example.com');
    } catch (e) {
      // blocked, ignore
    }
    return 'done';
  };
  const { result, networkCalls } = await runOffline(fn);
  assert.strictEqual(result, 'done');
  assert.strictEqual(networkCalls, 1);
});

// http.get 호출
test('http.get call', async () => {
  const fn = () => {
    http.get('http://example.com');
    return 'done';
  };
  const { result, networkCalls } = await runOffline(fn);
  assert.strictEqual(result, 'done');
  assert.strictEqual(networkCalls, 1);
});

// 예외가 발생해도 원복됨
test('exception restores', async () => {
  const originalFetch = globalThis.fetch;
  
  const fn = () => {
    throw new Error('test error');
  };
  
  try {
    await runOffline(fn);
  } catch (e) {
    // expected
  }
  
  assert.strictEqual(globalThis.fetch, originalFetch);
});

// 중첩 호출과 원복 후 globalThis.fetch가 원래 함수와 동일
test('nested calls restore properly', async (t) => {
  const originalFetch = globalThis.fetch;
  
  const fn = async () => {
    // 중첩 호출
    const { result: nestedResult, networkCalls: nestedCalls } = await runOffline(async () => {
      try {
        await globalThis.fetch('https://example.com');
      } catch (e) {
        // caught
      }
      return 'nested';
    });
    
    assert.strictEqual(nestedResult, 'nested');
    assert.strictEqual(nestedCalls, 1);
    
    return 'outer';
  };
  
  const { result, networkCalls } = await runOffline(fn);
  assert.strictEqual(result, 'outer');
  assert.strictEqual(networkCalls, 0);
  assert.strictEqual(globalThis.fetch, originalFetch);
});

// 비동기 함수 지원
test('async function support', async () => {
  const fn = async () => {
    await new Promise(r => setTimeout(r, 10));
    return 'async result';
  };
  const { result, networkCalls } = await runOffline(fn);
  assert.strictEqual(result, 'async result');
  assert.strictEqual(networkCalls, 0);
});

// 여러 네트워크 호출
test('multiple network calls', async () => {
  const fn = async () => {
    try {
      await globalThis.fetch('https://example.com');
    } catch (e) {}
    
    try {
      await globalThis.fetch('https://example.org');
    } catch (e) {}
    
    http.get('http://example.com');
    
    return 'multiple calls';
  };
  const { result, networkCalls } = await runOffline(fn);
  assert.strictEqual(result, 'multiple calls');
  assert.strictEqual(networkCalls, 3);
});

// ---- F-310·F-315: 모든 차단 대상의 호출 계수와 원본 복원 ----
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
import { measureTowerAssets } from '../../../bench/tower_assets/index.mjs';

function snapshot() {
  return {
    fetch: globalThis.fetch,
    httpGet: http.get,
    httpsGet: https.get,
    httpRequest: http.request,
    httpsRequest: https.request,
    connect: net.Socket.prototype.connect,
    lookup: dns.lookup,
    promisesLookup: dns.promises.lookup,
  };
}

function assertRestored(before) {
  const now = snapshot();
  for (const k of Object.keys(before)) assert.strictEqual(now[k], before[k], `${k} 가 원본이 아니다`);
}

test('https.get 계수', async () => {
  const { networkCalls } = await runOffline(() => { https.get('https://example.com'); });
  assert.strictEqual(networkCalls, 1);
});

test('https.request 계수', async () => {
  const { networkCalls } = await runOffline(() => { https.request('https://example.com'); });
  assert.strictEqual(networkCalls, 1);
});

test('http.request 계수', async () => {
  const { networkCalls } = await runOffline(() => { http.request('http://example.com'); });
  assert.strictEqual(networkCalls, 1);
});

test('net.Socket connect 계수', async () => {
  const { networkCalls } = await runOffline(() => { new net.Socket().connect(80, 'example.com'); });
  assert.strictEqual(networkCalls, 1);
});

test('dns.lookup 계수', async () => {
  const { networkCalls } = await runOffline(() => new Promise((resolve) => {
    dns.lookup('example.com', () => resolve());
  }));
  assert.strictEqual(networkCalls, 1);
});

test('dns.promises.lookup 계수', async () => {
  const { networkCalls } = await runOffline(async () => {
    try { await dns.promises.lookup('example.com'); } catch { /* 차단됨 */ }
  });
  assert.strictEqual(networkCalls, 1);
});

test('실행 뒤 모든 원본 복원(정상·예외)', async () => {
  const before = snapshot();
  await runOffline(() => 1);
  assertRestored(before);
  await assert.rejects(runOffline(() => { throw new Error('x'); }));
  assertRestored(before);
});

test('동시 호출 2건 뒤 모든 원본 복원(50 ms·100 ms)', async () => {
  const before = snapshot();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const [a, b] = await Promise.all([
    runOffline(async () => { await sleep(50); return 'a'; }),
    runOffline(async () => { await sleep(100); return 'b'; }),
  ]);
  assert.strictEqual(a.result, 'a');
  assert.strictEqual(b.result, 'b');
  assertRestored(before);
});

test('동시 호출 중 늦게 끝나는 쪽도 끝까지 차단 상태', async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const before = snapshot();
  const long = runOffline(async () => {
    await sleep(100);
    try { await globalThis.fetch('https://example.com'); } catch { /* 차단됨 */ }
  });
  await runOffline(() => sleep(20));
  assert.notStrictEqual(globalThis.fetch, before.fetch, '앞 호출이 끝나도 뒤 호출은 아직 차단 중');
  const { networkCalls } = await long;
  assert.strictEqual(networkCalls, 1);
  assertRestored(before);
});

test('자산 경로(measureTowerAssets)에서 네트워크 호출 0, 실행 뒤 복원', async () => {
  const before = snapshot();
  const { result, networkCalls } = await runOffline(() => measureTowerAssets());
  assert.strictEqual(networkCalls, 0);
  assert.strictEqual(result.buildings.count, 6191);
  assertRestored(before);
});

test('자산 경로에 fetch 를 심으면 계수된다', async () => {
  const { networkCalls } = await runOffline(async () => {
    measureTowerAssets();
    try { await globalThis.fetch('https://example.com'); } catch { /* 차단됨 */ }
  });
  assert.strictEqual(networkCalls, 1);
});
