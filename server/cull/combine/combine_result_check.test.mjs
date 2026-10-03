// F-146 ②: compute 가 undefined 를 돌려도 결과가 캐시되고, 배열 hierarchy 가 통과한다.
// compute 결과가 객체(비배열, null 아님)인지 검사해 아니면 'cull:' 오류, 그 결과는 캐시하지 않는다.
// 배열 hierarchy 도 'cull:' 오류.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cachedNormalCones } from './index.mjs';

test('cachedNormalCones: compute 가 undefined 를 돌리면 cull: 오류, 캐시하지 않음', () => {
  const h = { octree: { leafCount: 1 }, levels: [{ normals: new Float32Array(), leafStart: new Uint32Array() }] };
  let calls = 0;
  const compute = () => { calls++; return undefined; };

  // 첫 호출에서 오류
  assert.throws(
    () => cachedNormalCones(h, compute),
    { message: /^cull:/ }
  );
  assert.equal(calls, 1);

  // 캐시되지 않아서 두 번째 호출에서 compute 가 다시 불림
  assert.throws(
    () => cachedNormalCones(h, compute),
    { message: /^cull:/ }
  );
  assert.equal(calls, 2);
});

test('cachedNormalCones: compute 가 배열을 돌리면 cull: 오류, 캐시하지 않음', () => {
  const h = { octree: { leafCount: 1 }, levels: [{ normals: new Float32Array(), leafStart: new Uint32Array() }] };
  let calls = 0;
  const compute = () => { calls++; return [1, 2, 3]; };

  // 첫 호출에서 오류
  assert.throws(
    () => cachedNormalCones(h, compute),
    { message: /^cull:/ }
  );
  assert.equal(calls, 1);

  // 캐시되지 않아서 두 번째 호출에서 compute 가 다시 불림
  assert.throws(
    () => cachedNormalCones(h, compute),
    { message: /^cull:/ }
  );
  assert.equal(calls, 2);
});

test('cachedNormalCones: compute 가 null 을 돌리면 cull: 오류, 캐시하지 않음', () => {
  const h = { octree: { leafCount: 1 }, levels: [{ normals: new Float32Array(), leafStart: new Uint32Array() }] };
  let calls = 0;
  const compute = () => { calls++; return null; };

  // 첫 호출에서 오류
  assert.throws(
    () => cachedNormalCones(h, compute),
    { message: /^cull:/ }
  );
  assert.equal(calls, 1);

  // 캐시되지 않아서 두 번째 호출에서 compute 가 다시 불림
  assert.throws(
    () => cachedNormalCones(h, compute),
    { message: /^cull:/ }
  );
  assert.equal(calls, 2);
});

test('cachedNormalCones: compute 가 primitive 를 돌리면 cull: 오류, 캐시하지 않음', () => {
  const h = { octree: { leafCount: 1 }, levels: [{ normals: new Float32Array(), leafStart: new Uint32Array() }] };
  let calls = 0;
  const compute = () => { calls++; return 42; };

  // 첫 호출에서 오류
  assert.throws(
    () => cachedNormalCones(h, compute),
    { message: /^cull:/ }
  );
  assert.equal(calls, 1);

  // 캐시되지 않아서 두 번째 호출에서 compute 가 다시 불림
  assert.throws(
    () => cachedNormalCones(h, compute),
    { message: /^cull:/ }
  );
  assert.equal(calls, 2);
});

test('cachedNormalCones: hierarchy 가 배열이면 cull: 오류', () => {
  const compute = () => ({});

  assert.throws(
    () => cachedNormalCones([1, 2, 3], compute),
    { message: /^cull:/ }
  );
});

test('cachedNormalCones: compute 가 유효한 객체를 돌리면 캐시함', () => {
  const h = { octree: { leafCount: 1 }, levels: [{ normals: new Float32Array(), leafStart: new Uint32Array() }] };
  let calls = 0;
  const compute = () => { calls++; return { valid: true }; };

  const c1 = cachedNormalCones(h, compute);
  assert.equal(calls, 1);
  const c2 = cachedNormalCones(h, compute);
  assert.equal(calls, 1);
  assert.equal(c1, c2);
});
