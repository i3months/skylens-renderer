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

// ---- 차단 자체의 단언(F-318 ⑥) : 센 것뿐 아니라 실제로 막혔는지 ----
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

test('fetch 는 Network access blocked 로 거부된다', async () => {
  await runOffline(async () => {
    await assert.rejects(() => globalThis.fetch('https://example.com'), /Network access blocked/);
  });
});

test('dns.lookup 은 원본에 위임하지 않고 콜백에 blocked 오류를 준다', async () => {
  const { result } = await runOffline(() => new Promise((resolve) => {
    dns.lookup('blocked.example.invalid', (err, address) => resolve({ err, address }));
  }));
  assert.ok(result.err instanceof Error);
  assert.match(result.err.message, /^DNS lookup blocked$/);
  assert.strictEqual(result.err.code, undefined);
  assert.strictEqual(result.address, undefined);
});

test('dns.lookup 옵션 인자 형태도 blocked 오류', async () => {
  const { result } = await runOffline(() => new Promise((resolve) => {
    dns.lookup('blocked.example.invalid', { all: true }, (err) => resolve(err));
  }));
  assert.match(result.message, /^DNS lookup blocked$/);
  assert.strictEqual(result.code, undefined);
});

test('dns.promises.lookup 은 blocked 로 거부된다', async () => {
  await runOffline(async () => {
    await assert.rejects(() => dns.promises.lookup('blocked.example.invalid'), (e) => e.message === 'DNS lookup blocked' && e.code === undefined);
  });
});

// ---- F-319 ③ : http/https/net 스텁은 'error' 를 내서 기다리는 쪽이 끝난다 ----
for (const [name, mod] of [['http', http], ['https', https]]) {
  for (const method of ['get', 'request']) {
    test(`${name}.${method} 은 Network access blocked 'error' 를 낸다`, async () => {
      const before = snapshot();
      const { result, networkCalls } = await runOffline(() => new Promise((resolve) => {
        const req = mod[method](`${name}://example.com`, () => resolve('응답이 오면 안 된다'));
        req.on('error', (e) => resolve(e));
        req.end?.();
      }));
      assert.ok(result instanceof Error, String(result));
      assert.match(result.message, /Network access blocked/);
      assert.strictEqual(networkCalls, 1);
      assertRestored(before);
    });
  }
}

test('이슈 재현: new Promise(res => http.get(url, res).on("error", rej)) 가 거부로 끝나고 스텁이 남지 않는다', async () => {
  const before = snapshot();
  await assert.rejects(
    runOffline(() => new Promise((res, rej) => { http.get('http://example.com', res).on('error', rej); })),
    /Network access blocked/,
  );
  assertRestored(before);
});

test('net.Socket connect 도 error 를 낸다', async () => {
  const before = snapshot();
  const { result } = await runOffline(() => new Promise((resolve) => {
    const s = new net.Socket();
    s.on('error', resolve);
    s.connect(80, 'example.com');
  }));
  assert.match(result.message, /Network access blocked/);
  assertRestored(before);
});

test('듣는 쪽이 없으면 프로세스는 죽지 않고 runOffline 이 reject 된다', async () => {
  await assert.rejects(
    () => runOffline(async () => { http.get('http://example.com'); await sleepMs(5); }),
    (e) => e.message === 'Network access blocked',
  );
});

// ---- F-319 ② : 끝난 뒤 붙들린 스텁 ----
test('끝난 뒤 붙들린 fetch 스텁은 TypeError 가 아니라 Network access blocked 로 거부된다', async () => {
  let held;
  await runOffline(() => { held = globalThis.fetch; });
  await assert.rejects(() => held('https://example.com'), (e) => {
    assert.ok(!(e instanceof TypeError), `TypeError: ${e.message}`);
    assert.match(e.message, /^Network access blocked$/);
    return true;
  });
  // 원본은 복원돼 있다.
  assert.notStrictEqual(globalThis.fetch, held);
});

test('끝난 뒤 붙들린 http/dns 스텁도 던지지 않는다', async () => {
  let h;
  await runOffline(() => { h = { get: http.get, lookup: dns.lookup, plookup: dns.promises.lookup }; });
  assert.doesNotThrow(() => h.get('http://example.com'));
  await assert.rejects(() => h.plookup('blocked.example.invalid'), (e) => e.message === 'DNS lookup blocked' && e.code === undefined);
  const err = await new Promise((resolve) => h.lookup('blocked.example.invalid', (e) => resolve(e)));
  assert.match(err.message, /^DNS lookup blocked$/);
  assert.strictEqual(err.code, undefined);
});

// ---- F-319 ⑥ : 동시 호출 계수 귀속 ----
test('동시 호출은 각자 자기 호출만 센다(나중 시작한 쪽으로 쏠리지 않는다)', async () => {
  const before = snapshot();
  const swallow = (p) => p.catch(() => {});
  const a = runOffline(async () => {
    await sleepMs(30); // b 가 시작한 뒤에 호출
    await swallow(globalThis.fetch('https://a/1'));
    await swallow(globalThis.fetch('https://a/2'));
    return 'a';
  });
  const b = runOffline(async () => {
    await sleepMs(5);
    await swallow(globalThis.fetch('https://b/1'));
    await sleepMs(60); // a 가 끝난 뒤에도 남는다
    return 'b';
  });
  const [ra, rb] = await Promise.all([a, b]);
  assert.strictEqual(ra.networkCalls, 2);
  assert.strictEqual(rb.networkCalls, 1);
  assertRestored(before);
});

test('중첩 호출: 안쪽 호출은 안쪽에, 바깥 호출은 바깥에 센다', async () => {
  const { networkCalls, result } = await runOffline(async () => {
    await globalThis.fetch('https://o/1').catch(() => {});
    const inner = await runOffline(async () => {
      await globalThis.fetch('https://i/1').catch(() => {});
      await globalThis.fetch('https://i/2').catch(() => {});
    });
    await globalThis.fetch('https://o/2').catch(() => {});
    return inner.networkCalls;
  });
  assert.strictEqual(result, 2);
  assert.strictEqual(networkCalls, 2);
});

// ---- F-319 ③ : 콜백만 넘긴 http.get 도 멈추지 않고 스텁이 복원된다 ----
test('콜백만 넘긴 http.get/https.get 은 runOffline 을 reject 하고 스텁을 복원한다', async () => {
  for (const [mod, url] of [[http, 'http://example.com'], [https, 'https://example.com']]) {
    const before = snapshot();
    await assert.rejects(
      () => runOffline(() => new Promise(() => { mod.get(url, () => {}); })),
      (e) => e.message === 'Network access blocked',
    );
    assert.deepStrictEqual(snapshot(), before);
  }
});

test('차단 req 스텁은 flushHeaders/getHeader/setNoDelay 를 가진다', async () => {
  await runOffline(() => {
    const req = http.request('http://example.com');
    req.on('error', () => {});
    assert.doesNotThrow(() => { req.flushHeaders(); req.getHeader('x'); req.setNoDelay(true); });
  });
});
