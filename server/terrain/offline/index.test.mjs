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
