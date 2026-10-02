import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDeterminism } from './index.mjs';

// 테스트용 가짜 packChunk 함수들

/**
 * 항상 같은 바이트를 반환하는 가짜 함수
 */
function fakePackSameBytes() {
  return new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04]);
}

/**
 * 호출마다 하나의 바이트가 다른 가짜 함수
 */
function createFakePackDifferentByte() {
  let callCount = 0;
  return function fakePackDifferentByte() {
    const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04]);
    // 호출 번호에 따라 다른 위치의 바이트 변경
    bytes[callCount % bytes.length] ^= 0xFF;
    callCount++;
    return bytes;
  };
}

/**
 * 길이가 다른 바이트를 반환하는 가짜 함수
 */
function createFakePackDifferentLength() {
  let callCount = 0;
  return function fakePackDifferentLength() {
    // 첫 번째 호출: 5 바이트, 두 번째 호출: 3 바이트
    const length = callCount === 0 ? 5 : 3;
    callCount++;
    return new Uint8Array(length).fill(0x42);
  };
}

// 기본 테스트 입력 (실제 packChunk 입력 형식에 맞춘 구조)
const testInput = {
  format: 1,
  segmentId: 7,
  level: 2,
  lod: 0,
  chunkIndex: 0,
  anchor: { lat: 0, lon: 0, alt: 0 },
  fields: {
    positions: new Float32Array([0, 0, 0]),
    colors: new Uint8Array([255, 0, 0]),
    normals: new Float32Array([0, 0, 1]),
  },
};

// 같은 바이트 반환 테스트
test('determinism_same_bytes: 같은 입력으로 두 번 실행 → 바이트 동일', () => {
  const result = checkDeterminism(testInput, 2, fakePackSameBytes);
  assert.equal(result.identical, true);
  assert.equal(result.firstDiffOffset, null);
});

// 호출마다 바이트가 다른 경우
test('determinism_different_byte: 호출마다 바이트 하나가 다름 → identical false', () => {
  const fakePackFunc = createFakePackDifferentByte();
  const result = checkDeterminism(testInput, 2, fakePackFunc);
  assert.equal(result.identical, false);
  assert.equal(typeof result.firstDiffOffset, 'number');
  assert.ok(result.firstDiffOffset >= 0 && result.firstDiffOffset < 5);
});

// 길이가 다른 경우
test('determinism_different_length: 길이가 다르면 → offset은 짧은 쪽 길이', () => {
  const fakePackFunc = createFakePackDifferentLength();
  const result = checkDeterminism(testInput, 2, fakePackFunc);
  assert.equal(result.identical, false);
  assert.equal(result.firstDiffOffset, 3);
});

// times=0 처리
test('determinism_times_zero: times=0 → identical true, offset null', () => {
  const result = checkDeterminism(testInput, 0, fakePackSameBytes);
  assert.equal(result.identical, true);
  assert.equal(result.firstDiffOffset, null);
});

// times=1 처리
test('determinism_times_one: times=1 → 비교 대상 없음, identical true', () => {
  const result = checkDeterminism(testInput, 1, fakePackSameBytes);
  assert.equal(result.identical, true);
  assert.equal(result.firstDiffOffset, null);
});

// times=3 처리
test('determinism_times_three: times=3 → 세 번 모두 같으면 identical true', () => {
  const result = checkDeterminism(testInput, 3, fakePackSameBytes);
  assert.equal(result.identical, true);
  assert.equal(result.firstDiffOffset, null);
});

// times=3 이며 차이가 있는 경우
test('determinism_times_three_different: times=3 → 세 번 중 하나라도 다르면 identical false', () => {
  const fakePackFunc = createFakePackDifferentByte();
  const result = checkDeterminism(testInput, 3, fakePackFunc);
  assert.equal(result.identical, false);
  assert.equal(typeof result.firstDiffOffset, 'number');
});

// 실제 packChunk 모듈이 있을 때만 실행
test('determinism_with_real_pack: 실제 packChunk로 테스트 (pack 모듈 존재 시)', async (t) => {
  let packChunk;
  try {
    const packModule = await import('../pack/index.mjs');
    packChunk = packModule.packChunk;
  } catch (err) {
    // pack 모듈이 없으면 이 테스트는 스킵
    t.skip('packChunk module not found, skipping');
    return;
  }

  // 실제 입력으로 determinism 검사
  const result = checkDeterminism(testInput, 2, packChunk);

  // packChunk는 결정적이어야 하므로 identical이 true여야 함
  assert.equal(result.identical, true);
  assert.equal(result.firstDiffOffset, null);
});
