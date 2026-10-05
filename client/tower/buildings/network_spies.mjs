// 네트워크 감시자: 전역·node 모듈의 네트워크 진입점을 가로채 호출을 센다(no_network·integration 시험 공용).
// - 이름으로 가져온 ESM 바인딩(import { lookup } from 'node:dns')은 syncBuiltinESMExports 로 맞춰야 가로채진다.
// - restore() 는 비동기: 동기 루프 직후 setTimeout/setImmediate 로 미뤄진 호출까지 잡도록 짧게 기다린 뒤 원복한다.
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import net from 'node:net';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';

export const SETTLE_MS = 30;

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
  for (const fn of ['lookup', 'resolve']) patch(dns, fn, () => thrower(`dns.${fn}`));
  for (const fn of ['lookup', 'resolve']) patch(dns.promises, fn, () => () => { calls.push(`dns.promises.${fn}`); return Promise.reject(new Error(`감시자: dns.promises.${fn}`)); });
  syncBuiltinESMExports();
  let restored = false;
  const restore = async (settleMs = SETTLE_MS) => {
    if (restored) return;
    restored = true;
    await new Promise((r) => setTimeout(r, settleMs)); // 미뤄진 호출이 원복된 진짜 함수로 나가지 않게 기다린다
    await new Promise((r) => setImmediate(r));
    
    for (const r of restores.reverse()) r();
    syncBuiltinESMExports();
  };
  return { calls, restore };
}
