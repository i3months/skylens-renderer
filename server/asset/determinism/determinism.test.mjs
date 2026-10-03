import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDeterminism } from './index.mjs';
import { packChunk } from '../pack/index.mjs';
import { ANCHOR } from '../../../fixtures/asset_golden/generate.mjs';
import { FORMAT_POINT27, FORMAT_GAUSS56, SH_C0, AssetFormatError } from '../../../contracts/asset/index.mjs';

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

// times 0·1 은 비교할 쌍이 없어 거부(packFn 은 호출되지 않는다)
for (const t of [0, 1]) {
  test(`determinism_times_${t}: times=${t} → AssetFormatError, packFn 호출 0`, () => {
    let calls = 0;
    assert.throws(() => checkDeterminism(testInput, t, () => { calls++; return new Uint8Array(1); }), AssetFormatError);
    assert.equal(calls, 0);
  });
}

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

// 골든 입력: generate.mjs 입력 규칙(사이드카 inputRule)과 같은 원본 필드
function point27Input() {
  const n = 32;
  const NORMALS = [[0, 0, 1], [0.6, 0, 0.8], [0, -0.6, -0.8], [0.36, 0.48, 0.8]];
  const positions = new Float32Array(3 * n);
  const normals = new Float32Array(3 * n);
  const colors = new Uint8Array(3 * n);
  for (let i = 0; i < n; i++) {
    positions.set([64 + (i % 8) * 0.5, -128 + Math.floor(i / 8) * 0.75, 1 + i * 0.0625], 3 * i);
    normals.set(NORMALS[i % 4], 3 * i);
    colors.set([i * 8, 255 - i * 8, (i * 37) % 256], 3 * i);
  }
  return { format: FORMAT_POINT27, segmentId: 7, level: 2, lod: 0, chunkIndex: 0, anchor: ANCHOR, fields: { positions, normals, colors } };
}
function gauss56Input() {
  const n = 21;
  const positions = new Float32Array(3 * n);
  const fdc = new Float32Array(3 * n);
  const opacity = new Float32Array(n);
  const scales = new Float32Array(3 * n);
  const rotations = new Float32Array(4 * n);
  for (let i = 0; i < n; i++) {
    positions.set([10 + (i % 7), 20 + Math.floor(i / 7) * 2, -2 + i * 0.25], 3 * i);
    const target = [i * 12, 128, 255 - i * 12];
    for (let k = 0; k < 3; k++) fdc[3 * i + k] = (target[k] / 255 - 0.5) / SH_C0;
    opacity[i] = (i - 10) * 0.5;
    scales.set([-6 + i * 0.25, -3.5, -2 - i * 0.125], 3 * i);
    const half = (i * 7.5 * Math.PI) / 180;
    rotations.set([Math.cos(half), 0, 0, Math.sin(half)], 4 * i);
  }
  return { format: FORMAT_GAUSS56, segmentId: 7, level: 3, lod: 1, chunkIndex: 2, anchor: ANCHOR, fields: { positions, fdc, opacity, scales, rotations } };
}

// 실제 packChunk, packFn 생략(기본값 경로)
test('determinism_real_pack_point27: packFn 생략 → identical true', () => {
  assert.deepEqual(checkDeterminism(point27Input()), { identical: true, firstDiffOffset: null });
  assert.deepEqual(checkDeterminism(point27Input(), 5), { identical: true, firstDiffOffset: null });
});

test('determinism_real_pack_gauss56: packFn 생략 → identical true', () => {
  assert.deepEqual(checkDeterminism(gauss56Input()), { identical: true, firstDiffOffset: null });
});

test('determinism_default_is_packChunk: 명시한 packChunk 와 결과 같음', () => {
  const withExplicit = checkDeterminism(point27Input(), 2, packChunk);
  const withDefault = checkDeterminism(point27Input());
  assert.deepEqual(withExplicit, withDefault);
  assert.equal(withDefault.identical, true);
});

// times 검증
test('determinism_bad_times: NaN·1.5·Infinity·음수·비숫자 → 즉시 던짐', () => {
  let calls = 0;
  const counting = () => { calls++; return new Uint8Array(1); };
  for (const bad of [NaN, 1.5, Infinity, -Infinity, -1, '2', null]) {
    assert.throws(() => checkDeterminism(testInput, bad, counting), /times/);
  }
  assert.equal(calls, 0);
});

// offset 정확값 0
test('determinism_offset_zero: 첫 바이트부터 다르면 offset 0', () => {
  let n = 0;
  const fake = () => new Uint8Array([n++ === 0 ? 1 : 2, 9, 9]);
  assert.deepEqual(checkDeterminism(testInput, 2, fake), { identical: false, firstDiffOffset: 0 });
});

// 3회째에만 다른 경우
test('determinism_third_call_only: 3회째만 다르면 그 바이트 위치', () => {
  let n = 0;
  const fake = () => {
    const b = new Uint8Array([1, 2, 3, 4]);
    if (++n === 3) b[2] = 99;
    return b;
  };
  assert.deepEqual(checkDeterminism(testInput, 3, fake), { identical: false, firstDiffOffset: 2 });
  // times=2 였다면 못 잡는다
  n = 0;
  assert.deepEqual(checkDeterminism(testInput, 2, fake), { identical: true, firstDiffOffset: null });
});
