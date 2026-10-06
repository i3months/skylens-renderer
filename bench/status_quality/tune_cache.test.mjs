// tune.mjs 기준 렌더 캐시 상한 시험: 시드·점 수를 바꿔 가며 재도 보관 장면 수가 SCENE_CACHE_MAX 를 넘지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateThinner, sceneCacheKeys, SCENE_CACHE_MAX } from './tune.mjs';

test('장면 캐시는 최근 SCENE_CACHE_MAX 개만 보관한다', async () => {
  assert.equal(SCENE_CACHE_MAX, 2);
  const run = (sceneSeed, count) => evaluateThinner({ count, sceneSeed });
  await run(1, 5000);
  await run(2, 5000);
  await run(3, 5000);
  assert.ok(sceneCacheKeys().length <= SCENE_CACHE_MAX, `보관 ${sceneCacheKeys().join(',')}`);
  assert.deepEqual(sceneCacheKeys(), ['2:5000', '3:5000']);
  await run(2, 5000); // 적중하면 최근 쪽으로 옮겨진다
  await run(4, 5000);
  assert.deepEqual(sceneCacheKeys(), ['2:5000', '4:5000']);
});

test('상한이 있어도 같은 입력의 결과 수치는 같다', async () => {
  const a = await evaluateThinner({ count: 5000, sceneSeed: 1 });
  await evaluateThinner({ count: 5000, sceneSeed: 2 });
  await evaluateThinner({ count: 5000, sceneSeed: 3 });
  const b = await evaluateThinner({ count: 5000, sceneSeed: 1 }); // 쫓겨난 뒤 다시 만든 장면
  assert.deepEqual(b, a);
});
