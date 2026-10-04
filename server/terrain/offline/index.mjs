// 네트워크 호출을 차단하고 횟수를 센다.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';

// 동시·중첩 호출 대비: 활성 호출 목록과 최초 원본 한 벌을 모듈에서 공유한다.
// 첫 호출이 들어올 때만 원본을 저장·스텁을 설치하고, 마지막 호출이 끝날 때만 원본을 복원한다(깊이 계수).
// 스텁이 불리면 호출한 쪽의 비동기 문맥(AsyncLocalStorage)에 묶인 카운터를 올린다: 중첩이면 안쪽, 동시 호출이면 각자 자기 것.
// 문맥이 없는 호출(차단 중 바깥 코드)은 가장 최근에 시작한 활성 호출에 센다. 활성 호출이 하나도 없으면(끝난 뒤
// 붙들어 둔 스텁을 부르는 경우) 세지 않고 그대로 차단 응답만 낸다(예전에는 active[-1].n 에서 TypeError).
const active = [];
const als = new AsyncLocalStorage();
let originals = null;
const BLOCKED = 'Network access blocked';

function count() {
  const me = als.getStore() ?? active[active.length - 1];
  if (me) me.n++;
  return me;
}

// 'error' 를 듣는 쪽이 없으면(콜백만 넘긴 http.get 등) emit 하면 프로세스가 죽고 안 내면 영영 끝나지 않는다.
// 그래서 호출한 runOffline 을 대신 reject 시켜 finally 가 돌고 스텁이 복원되게 한다.
function deliverBlocked(target, me) {
  process.nextTick(() => {
    if (target.listenerCount('error') > 0) target.emit('error', new Error(BLOCKED));
    else if (me) me.fail(new Error(BLOCKED));
  });
}

/** 차단된 요청 대체물. 'error'(Network access blocked)를 nextTick 에 낸다 — 듣는 쪽이 없으면 runOffline 을 reject 한다. */
function blockedRequest(me) {
  const req = new EventEmitter();
  req.end = () => req;
  req.write = () => true;
  req.destroy = () => req;
  req.abort = () => {};
  req.setHeader = () => req;
  req.setTimeout = () => req;
  req.flushHeaders = () => {};
  req.getHeader = () => undefined;
  req.setNoDelay = () => req;
  deliverBlocked(req, me);
  return req;
}

function install() {
  originals = {
    fetch: globalThis.fetch,
    httpGet: http.get,
    httpsGet: https.get,
    httpRequest: http.request,
    httpsRequest: https.request,
    netConnect: net.Socket.prototype.connect,
    dnsLookup: dns.lookup,
    dnsPromisesLookup: dns.promises.lookup,
  };
  globalThis.fetch = () => {
    count();
    return Promise.reject(new Error(BLOCKED));
  };
  http.get = () => blockedRequest(count());
  https.get = () => blockedRequest(count());
  http.request = () => blockedRequest(count());
  https.request = () => blockedRequest(count());
  net.Socket.prototype.connect = function connectBlocked() {
    deliverBlocked(this, count());
    return this;
  };
  dns.lookup = (hostname, options, callback) => {
    count();
    const cb = typeof options === 'function' ? options : callback;
    if (cb) process.nextTick(() => cb(new Error('DNS lookup blocked')));
  };
  dns.promises.lookup = () => {
    count();
    return Promise.reject(new Error('DNS lookup blocked'));
  };
}

function restore() {
  globalThis.fetch = originals.fetch;
  http.get = originals.httpGet;
  https.get = originals.httpsGet;
  http.request = originals.httpRequest;
  https.request = originals.httpsRequest;
  net.Socket.prototype.connect = originals.netConnect;
  dns.lookup = originals.dnsLookup;
  dns.promises.lookup = originals.dnsPromisesLookup;
  originals = null;
}

/**
 * 주어진 함수를 실행하는 동안 네트워크 호출을 차단하고 횟수를 센다.
 * @param {Function} fn - 실행할 함수 (동기 또는 비동기)
 * @returns {Promise<{result: any, networkCalls: number}>} 실행 결과와 네트워크 호출 횟수
 */
export async function runOffline(fn) {
  const me = { n: 0 };
  const failed = new Promise((_, reject) => { me.fail = reject; });
  failed.catch(() => {}); // 아무도 안 기다려도 unhandled rejection 이 되지 않게 한다
  if (active.length === 0) install();
  active.push(me);
  try {
    const result = await Promise.race([als.run(me, () => Promise.resolve(fn())), failed]);
    return { result, networkCalls: me.n };
  } finally {
    active.splice(active.indexOf(me), 1);
    if (active.length === 0) restore();
  }
}
