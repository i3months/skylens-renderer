// 네트워크 호출을 차단하고 횟수를 센다.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';

// 동시·중첩 호출 대비: 활성 호출 목록과 최초 원본 한 벌을 모듈에서 공유한다.
// 첫 호출이 들어올 때만 원본을 저장·스텁을 설치하고, 마지막 호출이 끝날 때만 원본을 복원한다(깊이 계수).
// 스텁이 불리면 가장 최근에 시작한 활성 호출의 카운터를 올린다(중첩이면 안쪽, 동시 호출이면 나중 시작 쪽).
const active = [];
let originals = null;

function count() {
  active[active.length - 1].n++;
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
    return Promise.reject(new Error('Network access blocked'));
  };
  http.get = () => {
    count();
    const req = { on: () => req, end: () => req };
    return req;
  };
  https.get = () => {
    count();
    const req = { on: () => req, end: () => req };
    return req;
  };
  http.request = () => {
    count();
    const req = { on: () => req, end: () => req, write: () => req };
    return req;
  };
  https.request = () => {
    count();
    const req = { on: () => req, end: () => req, write: () => req };
    return req;
  };
  net.Socket.prototype.connect = function connectBlocked() {
    count();
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
  if (active.length === 0) install();
  active.push(me);
  try {
    const result = await Promise.resolve(fn());
    return { result, networkCalls: me.n };
  } finally {
    active.splice(active.indexOf(me), 1);
    if (active.length === 0) restore();
  }
}
