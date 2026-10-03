import test from 'node:test';
import assert from 'node:assert/strict';
import { CULL_API, CULL_STAGES, assertLeafMask, andMasks, chunksOfMask } from './index.mjs';

test('CULL_API 는 10 개 모듈을 가리키고 모두 server/ client/ bench/ 아래', () => {
  assert.equal(Object.keys(CULL_API).length, 10);
  for (const v of Object.values(CULL_API)) assert.match(v.module, /^(server\/cull|client\/cull|bench\/cull)\//);
  assert.deepEqual([...CULL_STAGES], ['frustum', 'backface', 'occlusion', 'distance']);
});

test('assertLeafMask: 길이·값 위반은 cull: 오류', () => {
  assertLeafMask(new Uint8Array([0, 1, 1]), 3);
  assert.throws(() => assertLeafMask(new Uint8Array(2), 3), /^Error: cull:/);
  assert.throws(() => assertLeafMask(new Uint8Array([0, 2, 1]), 3), /^Error: cull:/);
  assert.throws(() => assertLeafMask([0, 1, 1], 3), /^Error: cull:/);
});

test('andMasks: 각 마스크의 0 위치가 다를 때 AND 결과 확인 (첫 마스크 생략 변이 탐지)', () => {
  // 첫 마스크가 위치 0 에서 0 인 경우
  const m1 = andMasks([new Uint8Array([0, 1, 1, 1]), new Uint8Array([1, 1, 1, 1])], 4);
  assert.deepEqual([...m1], [0, 1, 1, 1]);

  // 첫 마스크가 위치 1 에서 0 인 경우
  const m2 = andMasks([new Uint8Array([1, 0, 1, 1]), new Uint8Array([1, 1, 1, 1])], 4);
  assert.deepEqual([...m2], [1, 0, 1, 1]);

  // 첫 마스크가 위치 2 에서 0 인 경우
  const m3 = andMasks([new Uint8Array([1, 1, 0, 1]), new Uint8Array([1, 1, 1, 1])], 4);
  assert.deepEqual([...m3], [1, 1, 0, 1]);

  // 첫 마스크가 위치 3 에서 0 인 경우
  const m4 = andMasks([new Uint8Array([1, 1, 1, 0]), new Uint8Array([1, 1, 1, 1])], 4);
  assert.deepEqual([...m4], [1, 1, 1, 0]);
});

test('andMasks·chunksOfMask', () => {
  const m = andMasks([new Uint8Array([1, 1, 0, 1]), new Uint8Array([1, 0, 0, 1])], 4);
  assert.deepEqual([...m], [1, 0, 0, 1]);
  assert.deepEqual([...chunksOfMask(m)], [0, 3]);
  assert.equal(chunksOfMask(new Uint8Array(3)).length, 0);
});

test('andMasks: 3 개 마스크의 AND 결과 (두 번째·세 번째 마스크의 0 위치 다름)', () => {
  // 두 번째 마스크가 위치 0 에서 0 인 경우
  const m1 = andMasks([new Uint8Array([1, 1, 0, 1]), new Uint8Array([0, 1, 1, 1]), new Uint8Array([1, 1, 1, 1])], 4);
  assert.deepEqual([...m1], [0, 1, 0, 1]);

  // 세 번째 마스크가 위치 1 에서 0 인 경우
  const m2 = andMasks([new Uint8Array([1, 1, 0, 1]), new Uint8Array([1, 0, 0, 1]), new Uint8Array([1, 0, 1, 1])], 4);
  assert.deepEqual([...m2], [1, 0, 0, 1]);

  // 원래 테스트
  const m3 = andMasks([new Uint8Array([1, 1, 0, 1]), new Uint8Array([1, 0, 0, 1]), new Uint8Array([0, 1, 0, 1])], 4);
  assert.deepEqual([...m3], [0, 0, 0, 1]);
});

test('andMasks: 두 번째 마스크가 Uint8Array 아니면 throws', () => {
  assert.throws(() => andMasks([new Uint8Array([1, 1, 0, 1]), [1, 0, 0, 1]], 4), /^Error: cull:/);
});

test('andMasks: 다른 길이는 오류', () => {
  assert.throws(() => andMasks([new Uint8Array([1, 1, 0, 1])], 3), /^Error: cull:/);
  assert.throws(() => andMasks([new Uint8Array([1, 1])], 4), /^Error: cull:/);
  assert.throws(() => andMasks([new Uint8Array([1, 1, 0, 1]), new Uint8Array([1, 0, 0])], 4), /^Error: cull:/);
});

test('andMasks: 값 2 는 오류', () => {
  assert.throws(() => andMasks([new Uint8Array([0, 2, 1])], 3), /^Error: cull:/);
  assert.throws(() => andMasks([new Uint8Array([1, 1, 0, 1]), new Uint8Array([0, 2, 1, 0])], 4), /^Error: cull:/);
});

test('andMasks: 빈 목록은 모두 1', () => {
  const m = andMasks([], 3);
  assert.deepEqual([...m], [1, 1, 1]);
});

test('CULL_API: fn 문자열의 함수명이 실제 export 와 일치', async () => {
  for (const [key, entry] of Object.entries(CULL_API)) {
    const modulePath = `../../${entry.module}`;
    const mod = await import(modulePath);

    // fn 문자열에서 함수명 추출
    const fnString = entry.fn;
    const functionNames = new Set();

    // 세미콜론으로 분리된 각 함수 서명의 첫 번째 단어 추출
    const parts = fnString.split(';').map(s => s.trim());

    for (const part of parts) {
      if (!part) continue;
      // 각 부분의 첫 번째 단어를 추출 (공백이나 ( 까지)
      const match = part.match(/^([a-zA-Z_]\w*)\s*\(/);
      if (match) {
        const fnName = match[1];
        // 반환 타입이나 일반적인 키워드 스킵
        if (!['void', 'boolean', 'number', 'string', 'object', 'true', 'false'].includes(fnName)) {
          functionNames.add(fnName);
        }
      }
    }

    assert(functionNames.size > 0, `${key}: fn 문자열에서 함수명을 추출할 수 없음: ${fnString}`);

    for (const fnName of functionNames) {
      assert(typeof mod[fnName] === 'function',
        `${key}: 모듈 ${entry.module} 에서 '${fnName}' 을 export 하지 않음`);
    }
  }
});
