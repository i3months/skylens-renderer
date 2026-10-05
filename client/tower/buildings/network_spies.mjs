// 네트워크 감시자: 전역·node 모듈의 네트워크 진입점을 가로채 호출을 센다(no_network·integration 시험 공용).
// - 이름으로 가져온 ESM 바인딩(import { lookup } from 'node:dns')은 syncBuiltinESMExports 로 맞춰야 가로채진다.
// - 감시 구간에는 mock.timers 로 setTimeout 을 가짜로 바꿔 둔다. restore() 는 원복 전에 runAll 로 미뤄진 타이머(지연 길이 무관)를
//   모두 즉시 실행해 그 안의 호출을 기록하고, 그 뒤 setImmediate 로 한 번 비운다. 지연 변이가 감시자 밖으로 새지 않는다.
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import net from 'node:net';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import { mock } from 'node:test';

const realSetImmediate = setImmediate; // mock 대상은 setTimeout 뿐이라 setImmediate 는 진짜다

/** 호출 횟수를 세는 감시자를 전역·node 모듈에 건다. await restore() 로 모두 원복하고, calls 로 기록을 읽는다. */
export function installNetworkSpies() {
  const calls = [];
  const restores = [];
  const patch = (obj, key, make) => {
    const had = Object.prototype.hasOwnProperty.call(obj, key);
    const orig = obj[key];
    obj[key] = make();
    restores.push(() => { if (had) obj[key] = orig; else delete obj[key]; });
  };
  const thrower = (name) => () => { calls.push(name); throw new Error(`감시자: ${name}`); };
  patch(globalThis, 'fetch', () => () => { calls.push('fetch'); return new Promise(() => {}); });
  patch(globalThis, 'WebSocket', () => function SpyWebSocket() { calls.push('WebSocket'); throw new Error('감시자: WebSocket 생성'); });
  patch(globalThis, 'XMLHttpRequest', () => function SpyXHR() { calls.push('XMLHttpRequest'); throw new Error('감시자: XMLHttpRequest 생성'); });
  for (const [label, mod] of [['http', http], ['https', https]]) {
    for (const fn of ['request', 'get']) patch(mod, fn, () => thrower(`${label}.${fn}`));
  }
  patch(http2, 'connect', () => thrower('http2.connect'));
  for (const fn of ['connect', 'createConnection']) patch(net, fn, () => thrower(`net.${fn}`));
  patch(net.Socket.prototype, 'connect', () => function spyConnect() { calls.push('net.Socket.connect'); throw new Error('감시자: Socket.connect'); });
  // dns 는 lookup·resolve 외에 resolve4/6·resolveTxt 등 resolve*, reverse, lookupService, Resolver 인스턴스 메서드도 모두 가로챈다.
  const dnsNames = (obj) => Object.getOwnPropertyNames(obj)
    .filter((k) => /^(lookup|lookupService|resolve\w*|reverse)$/.test(k) && typeof obj[k] === 'function');
  for (const fn of dnsNames(dns)) patch(dns, fn, () => thrower(`dns.${fn}`));
  for (const fn of dnsNames(dns.Resolver.prototype)) patch(dns.Resolver.prototype, fn, () => thrower(`dns.Resolver.${fn}`));
  for (const fn of dnsNames(dns.promises)) patch(dns.promises, fn, () => () => { calls.push(`dns.promises.${fn}`); return Promise.reject(new Error(`감시자: dns.promises.${fn}`)); });
  for (const fn of dnsNames(dns.promises.Resolver.prototype)) patch(dns.promises.Resolver.prototype, fn, () => () => { calls.push(`dns.promises.Resolver.${fn}`); return Promise.reject(new Error(`감시자: dns.promises.Resolver.${fn}`)); });
  syncBuiltinESMExports();
  // 나머지(node:timers 이름 가져오기 등)는 integration 파일 끝 감시에 맡긴다.
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let restored = false;
  const restore = async () => {
    if (restored) return;
    restored = true;
    try {
      // 미뤄진 타이머를 길이와 상관없이 실행해 호출을 기록한다. 실행 중 새로 걸린 타이머까지 비운다.
      for (let i = 0; i < 5; i += 1) {
        mock.timers.runAll();
        await new Promise((r) => realSetImmediate(r)); // 타이머가 이어붙인 setImmediate·마이크로태스크까지 비운다
        mock.timers.runAll();
      }
    } finally {
      mock.timers.reset();
      for (const r of restores.reverse()) r();
      syncBuiltinESMExports();
    }
  };
  return { calls, restore };
}
