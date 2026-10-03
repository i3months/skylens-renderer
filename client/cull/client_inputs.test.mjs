// 클라이언트 입력 오류 시험(F-145, F-146 ①): 모든 구조 오류는 'cull:' 로 시작해야 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { leafBoxesOf } from './index.mjs';

const good = () => ({ leafCount: 1, leafIndex: new Int32Array([0]), boxMin: new Float32Array(3), boxMax: new Float32Array(3) });

test('정상 octree 는 통과한다', () => {
  assert.equal(leafBoxesOf(good()).boxMin.length, 3);
});

test('리프 0 개 계층은 cull: 오류(F-145)', () => {
  assert.throws(() => leafBoxesOf({ ...good(), leafCount: 0 }), /cull:/);
  assert.throws(() => leafBoxesOf({ leafCount: 0, leafIndex: new Int32Array(0), boxMin: new Float32Array(0), boxMax: new Float32Array(0) }), /cull:/);
});

test('던지는 getter·Proxy 는 cull: 오류(F-146 ①)', () => {
  const g = good();
  Object.defineProperty(g, 'boxMin', { get() { throw new TypeError('boom'); } });
  assert.throws(() => leafBoxesOf(g), /cull:/);
  const p = new Proxy({}, { get() { throw new TypeError('proxy boom'); } });
  assert.throws(() => leafBoxesOf(p), /cull:/);
});

test('일반 배열 boxMin·boxMax 는 cull: 오류(F-146 ①)', () => {
  assert.throws(() => leafBoxesOf({ ...good(), boxMin: [0, 0, 0] }), /cull:.*Float32Array/);
  assert.throws(() => leafBoxesOf({ ...good(), boxMax: [0, 0, 0] }), /cull:.*Float32Array/);
});
