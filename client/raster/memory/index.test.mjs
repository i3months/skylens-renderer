// 메모리 집계 테스트. node --test 로 실행.
// 집계값이 실제 버퍼 합과 같음을 보장한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryMeter } from './index.mjs';

test('기본 add/total', () => {
  const meter = createMemoryMeter();
  meter.add('key1', 100);
  meter.add('key2', 200);
  meter.add('key3', 300);
  assert.equal(meter.total(), 600);
});

test('중복 add는 교체', () => {
  const meter = createMemoryMeter();
  meter.add('key1', 100);
  assert.equal(meter.total(), 100);
  meter.add('key1', 150);
  assert.equal(meter.total(), 150);
  meter.add('key1', 50);
  assert.equal(meter.total(), 50);
});

test('없는 key remove는 무시', () => {
  const meter = createMemoryMeter();
  meter.add('key1', 100);
  meter.remove('nonexistent');
  assert.equal(meter.total(), 100);
  meter.remove('key1');
  assert.equal(meter.total(), 0);
  meter.remove('key1');
  assert.equal(meter.total(), 0);
});

test('byKey는 정확한 분포 반환', () => {
  const meter = createMemoryMeter();
  meter.add('7.2.1.-2.0.0', 1024);
  meter.add('7.2.2.0.0.1', 2048);
  meter.add('7.3.0.1.1.0', 512);

  const dist = meter.byKey();
  assert.equal(dist['7.2.1.-2.0.0'], 1024);
  assert.equal(dist['7.2.2.0.0.1'], 2048);
  assert.equal(dist['7.3.0.1.1.0'], 512);
  assert.equal(Object.keys(dist).length, 3);
});

test('reset는 모든 항목 초기화', () => {
  const meter = createMemoryMeter();
  meter.add('key1', 100);
  meter.add('key2', 200);
  assert.equal(meter.total(), 300);

  meter.reset();
  assert.equal(meter.total(), 0);
  assert.deepEqual(meter.byKey(), {});

  // reset 후 다시 사용 가능
  meter.add('key3', 50);
  assert.equal(meter.total(), 50);
});

test('복합 연산: add/remove/total 일관성', () => {
  const meter = createMemoryMeter();

  // 시나리오 1: 단계적 추가와 제거
  meter.add('a', 100);
  meter.add('b', 200);
  meter.add('c', 300);
  assert.equal(meter.total(), 600);

  meter.remove('b');
  assert.equal(meter.total(), 400);

  // 시나리오 2: 교체와 제거
  meter.add('a', 150); // 100 → 150
  assert.equal(meter.total(), 450);

  meter.remove('c');
  meter.remove('a');
  assert.equal(meter.total(), 0);
  assert.deepEqual(meter.byKey(), {});
});

test('대규모 무작위 연산 대비 참조 모델 검증', () => {
  const meter = createMemoryMeter();
  const reference = new Map(); // 참조 구현

  // 의사난수생성기 (시드 고정으로 재현성 보장)
  let seed = 42;
  const pseudoRandom = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const keyCandidates = [
    '7.2.1.-2.0.0', '7.2.2.0.0.1', '7.3.0.1.1.0',
    '8.1.0.0.0.0', '8.2.1.-1.0.0', '8.3.2.1.1.0',
    '9.0.1.2.0.0', '9.1.0.-2.0.0'
  ];

  // 무작위 연산 100개
  for (let i = 0; i < 100; i++) {
    const op = pseudoRandom();
    const keyIdx = Math.floor(pseudoRandom() * keyCandidates.length);
    const key = keyCandidates[keyIdx];

    if (op < 0.6) {
      // add (60%)
      const bytes = Math.floor(pseudoRandom() * 10000) + 1;
      meter.add(key, bytes);
      reference.set(key, bytes);
    } else if (op < 0.95) {
      // remove (35%)
      meter.remove(key);
      reference.delete(key);
    } else {
      // reset (5%)
      meter.reset();
      reference.clear();
    }
  }

  // 참조 모델과 검증
  const expectedTotal = Array.from(reference.values()).reduce((a, b) => a + b, 0);
  assert.equal(meter.total(), expectedTotal,
    `집계값 ${meter.total()} != 참조값 ${expectedTotal}`);

  // byKey도 검증
  const meterDist = meter.byKey();
  for (const [key, bytes] of reference) {
    assert.equal(meterDist[key], bytes,
      `key ${key}: 미터값 ${meterDist[key]} != 참조값 ${bytes}`);
  }

  // 키 개수 일치
  assert.equal(Object.keys(meterDist).length, reference.size);
});

test('실제 조각 키 형식 테스트', () => {
  const meter = createMemoryMeter();

  // contracts/client_raster/index.mjs §3 형식: segmentId.level.tileX.tileY.lod.chunkIndex
  const keys = [
    '0.0.0.0.0.0',
    '1.1.1.1.1.1',
    '100.5.-10.20.2.0',
    '2147483647.30.32767.-32768.0.65535' // 극단값
  ];

  const bytes = [1024, 2048, 512, 256];

  for (let i = 0; i < keys.length; i++) {
    meter.add(keys[i], bytes[i]);
  }

  const expectedTotal = bytes.reduce((a, b) => a + b, 0);
  assert.equal(meter.total(), expectedTotal);

  const dist = meter.byKey();
  for (let i = 0; i < keys.length; i++) {
    assert.equal(dist[keys[i]], bytes[i]);
  }
});

test('0 바이트 허용, 음수·NaN·무한·소수는 거부하고 기존 값을 건드리지 않음', () => {
  const meter = createMemoryMeter();

  // 0 바이트 (메모리 해제로 이미 제거된 경우)
  meter.add('key1', 0);
  assert.equal(meter.total(), 0);

  // byKey에 0도 포함
  assert.deepEqual(meter.byKey(), { key1: 0 });

  meter.add('key2', 100);
  for (const bad of [-50, -1, NaN, Infinity, -Infinity, 1.5, '7', null, undefined]) {
    assert.throws(() => meter.add('key3', bad), (e) => e.code === 'memory', String(bad));
    assert.throws(() => meter.add('key2', bad), (e) => e.code === 'memory', String(bad));
  }
  assert.equal(meter.total(), 100);
  assert.deepEqual(meter.byKey(), { key1: 0, key2: 100 });

  // 같은 key 를 다시 넣으면 삽입 순서가 최신으로 간다
  meter.add('key1', 5);
  assert.deepEqual(Object.keys(meter.byKey()), ['key2', 'key1']);
});

test('동일 키의 여러 전송 시나리오', () => {
  const meter = createMemoryMeter();

  // 조각이 여러 번 전송되면 최신 바이트로 갱신
  // 예: 같은 key가 재전송되거나 부분 업데이트
  meter.add('piece:7.2.1.-2.0.0', 1024);
  assert.equal(meter.total(), 1024);

  meter.add('piece:7.2.1.-2.0.0', 2048);
  assert.equal(meter.total(), 2048);

  meter.add('piece:7.2.1.-2.0.0', 512);
  assert.equal(meter.total(), 512);
});
