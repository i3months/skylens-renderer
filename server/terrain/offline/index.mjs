// 네트워크 호출을 차단하고 횟수를 센다.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';

/**
 * 주어진 함수를 실행하는 동안 네트워크 호출을 차단하고 횟수를 센다.
 * @param {Function} fn - 실행할 함수 (동기 또는 비동기)
 * @returns {Promise<{result: any, networkCalls: number}>} 실행 결과와 네트워크 호출 횟수
 */
export async function runOffline(fn) {
  let networkCalls = 0;

  // 원본 함수들 저장
  const originalFetch = globalThis.fetch;
  const originalHttpGet = http.get;
  const originalHttpsGet = https.get;
  const originalHttpRequest = http.request;
  const originalHttpsRequest = https.request;
  const originalNetConnect = net.Socket.prototype.connect;
  const originalDnsLookup = dns.lookup;
  const originalDnsLookupPromise = dns.promises.lookup;

  try {
    // globalThis.fetch 차단
    globalThis.fetch = () => {
      networkCalls++;
      return Promise.reject(new Error('Network access blocked'));
    };

    // http.get 차단
    http.get = () => {
      networkCalls++;
      const req = { on: () => req, end: () => req };
      return req;
    };

    // https.get 차단
    https.get = () => {
      networkCalls++;
      const req = { on: () => req, end: () => req };
      return req;
    };

    // http.request 차단
    http.request = () => {
      networkCalls++;
      const req = { on: () => req, end: () => req, write: () => req };
      return req;
    };

    // https.request 차단
    https.request = () => {
      networkCalls++;
      const req = { on: () => req, end: () => req, write: () => req };
      return req;
    };

    // net.Socket.prototype.connect 차단
    net.Socket.prototype.connect = function(...args) {
      networkCalls++;
      return this;
    };

    // dns.lookup 차단
    dns.lookup = (hostname, options, callback) => {
      networkCalls++;
      const cb = typeof options === 'function' ? options : callback;
      if (cb) {
        process.nextTick(() => cb(new Error('DNS lookup blocked')));
      }
    };

    // dns.promises.lookup 차단
    dns.promises.lookup = () => {
      networkCalls++;
      return Promise.reject(new Error('DNS lookup blocked'));
    };

    // 함수 실행
    const result = await Promise.resolve(fn());

    return { result, networkCalls };
  } finally {
    // 원본 함수들 복원
    globalThis.fetch = originalFetch;
    http.get = originalHttpGet;
    https.get = originalHttpsGet;
    http.request = originalHttpRequest;
    https.request = originalHttpsRequest;
    net.Socket.prototype.connect = originalNetConnect;
    dns.lookup = originalDnsLookup;
    dns.promises.lookup = originalDnsLookupPromise;
  }
}