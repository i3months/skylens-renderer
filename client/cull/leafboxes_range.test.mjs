// leafBoxesOf 의 leafIndex 범위 검사(k >= leafCount): 'cull:' 오류를 던진다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { leafBoxesOf } from './index.mjs';

const good = () => ({
  leafCount: 3,
  leafIndex: new Int32Array([0, 1, 2]),
  boxMin: new Float32Array(9),
  boxMax: new Float32Array(9),
});

test('leafBoxesOf: leafIndex[node] >= leafCount -> cull: 오류', () => {
  const bad = good();
  bad.leafIndex[1] = 5; // leafCount = 3 인데 5 를 가리킴
  assert.throws(
    () => leafBoxesOf(bad),
    /cull:.*leafIndex\[1\].*5.*leafCount\(3\)/,
    'leafIndex 범위 검사 오류를 던지지 않음'
  );
});

test('leafBoxesOf: 양성 대조 - 유효한 범위 내 leafIndex 는 통과', () => {
  const oct = good();
  assert.doesNotThrow(() => leafBoxesOf(oct));
  assert.equal(leafBoxesOf(oct).boxMin.length, 9);
});

test('leafBoxesOf: 여러 노드가 있을 때 범위 초과 검사', () => {
  const oct = good();
  oct.leafIndex = new Int32Array([0, -1, 1, 2]); // -1 은 skip (리프가 아님), 2 는 유효
  oct.boxMin = new Float32Array(12);
  oct.boxMax = new Float32Array(12);
  assert.doesNotThrow(() => leafBoxesOf(oct)); // 유효함

  // 이제 범위 초과
  oct.leafIndex[2] = 10; // leafCount = 3 인데 10 을 가리킴
  assert.throws(
    () => leafBoxesOf(oct),
    /cull:.*leafIndex\[2\].*10.*leafCount\(3\)/
  );
});
