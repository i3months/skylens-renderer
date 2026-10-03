// 대규모 장면 생성 테스트(T05.5)

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { generate } from './index.mjs';
import { resultHash, assertSceneResult, FORMAT_POINT27, FORMAT_GAUSS56 } from '../../../contracts/scenes/index.mjs';

test('large 장면: 100k 빠른 테스트 - 속성 확인', (t) => {
  const count = 100000;
  const seed = 42;

  // 생성
  const r1 = generate({ seed, count });
  const r2 = generate({ seed, count });

  // 기본 구조 검사
  assertSceneResult(r1, { scene: 'large', count });
  assert.equal(r1.scene, 'large', 'scene name');
  assert.equal(r1.seed, seed, 'seed 보존');
  assert.equal(r1.count, count, 'count 정확함');

  // 형식 1: 같은 seed → 같은 해시
  const hash1 = resultHash(r1);
  const hash2 = resultHash(r2);
  assert.equal(hash1, hash2, '같은 seed → 같은 해시');

  // 형식 2: 가우시안 변환 후에도 유효
  const r3 = generate({ seed, count, format: FORMAT_GAUSS56 });
  assertSceneResult(r3, { scene: 'large', count });
  assert.equal(r3.format, FORMAT_GAUSS56, 'format 2 유지');

  // truth 확인
  assert(r1.truth.bounds, 'bounds 있음');
  assert.deepEqual(r1.truth.bounds.min, [-250, 0, -250], 'bounds.min');
  assert.deepEqual(r1.truth.bounds.max, [250, 0, 250], 'bounds.max');
  assert.equal(r1.truth.areaM2, 250000, 'areaM2 = 500*500');
});

test('large 장면: 250만 점 정확성 테스트', { skip: !process.env.SKYLENS_LARGE }, (t) => {
  const count = 2500000;
  const seed = 12345;

  // 생성
  const r1 = generate({ seed, count });
  const r2 = generate({ seed, count });

  // 구조 검사
  assertSceneResult(r1, { scene: 'large', count });

  // 같은 seed → 같은 해시
  const hash1 = resultHash(r1);
  const hash2 = resultHash(r2);
  assert.equal(hash1, hash2, '250만 점: 같은 seed → 같은 해시');

  // 형식 2도 통과
  const r3 = generate({ seed, count, format: FORMAT_GAUSS56 });
  assertSceneResult(r3, { scene: 'large', count });
});
