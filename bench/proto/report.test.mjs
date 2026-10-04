// 보고서 생성 시험(T11.11).
// `node --test bench/proto/report.test.mjs` 로 실행한다.

import test from 'node:test';
import assert from 'node:assert';
import { generateReport } from './report.mjs';

test('generateReport - 기본 형식', () => {
  const data = [
    { segmentId: 0, bytes: 1024 * 1024, phase: 'segment' },  // 1 MiB
  ];

  const report = generateReport(data);
  const lines = report.split('\n');

  // 헤더
  assert.equal(lines[0], '구간\t바이트\t예산%', '헤더 행 확인');

  // 데이터 행
  assert.match(lines[1], /^0\t/, '구간 ID 0 으로 시작');
  assert.match(lines[1], /1048576/, '바이트 1048576');
  assert.match(lines[1], /33\.33/, '예산 약 33%');
});

test('generateReport - 여러 구간', () => {
  const data = [
    { segmentId: 1, bytes: 2 * 1024 * 1024, phase: 'segment' },  // 2 MiB
    { segmentId: 0, bytes: 1 * 1024 * 1024, phase: 'segment' },  // 1 MiB
    { segmentId: 2, bytes: 512 * 1024, phase: 'segment' },       // 512 KiB
  ];

  const report = generateReport(data);
  const lines = report.split('\n');

  // 구간이 오름차순으로 정렬됨
  assert.equal(lines[1].split('\t')[0], '0', '첫 구간이 0');
  assert.equal(lines[2].split('\t')[0], '1', '두 번째 구간이 1');
  assert.equal(lines[3].split('\t')[0], '2', '세 번째 구간이 2');
});

test('generateReport - 예산 비율 계산', () => {
  const BUDGET = 3 * 1024 * 1024;

  const data = [
    // 50% 사용
    { segmentId: 0, bytes: BUDGET / 2, phase: 'segment' },
  ];

  const report = generateReport(data);
  assert.match(report, /50\.00/, '50% 예산 사용');
});

test('generateReport - 정확히 100% 사용', () => {
  const BUDGET = 3 * 1024 * 1024;

  const data = [
    { segmentId: 0, bytes: BUDGET, phase: 'segment' },
  ];

  const report = generateReport(data);
  assert.match(report, /100\.00/, '100% 예산 사용');
});

test('generateReport - initial 단계는 무시', () => {
  const data = [
    { segmentId: 0, bytes: 1 * 1024 * 1024, phase: 'initial' },
    { segmentId: 0, bytes: 2 * 1024 * 1024, phase: 'segment' },
  ];

  const report = generateReport(data);
  const lines = report.split('\n');

  // segment 만 표에 나타남
  assert.match(lines[1], /2097152/, '2 MiB 만 표에 나타남');
});

test('generateReport - 합성 데이터 검증', () => {
  const data = [
    { segmentId: 0, bytes: 1024 * 1024, phase: 'segment' },       // 1 MiB = 1048576
    { segmentId: 0, bytes: 512 * 1024, phase: 'segment' },        // 512 KiB = 524288
    { segmentId: 1, bytes: 1536 * 1024, phase: 'segment' },       // 1.5 MiB = 1572864
    { segmentId: 2, bytes: 2 * 1024 * 1024, phase: 'segment' },   // 2 MiB = 2097152
  ];

  const report = generateReport(data);
  const lines = report.split('\n');

  assert.equal(lines.length, 4, '헤더 + 3 구간 = 4줄');

  const seg0 = lines[1];
  assert.equal(seg0.split('\t')[0], '0', '구간 0');
  assert.equal(seg0.split('\t')[1], String(1536 * 1024), '구간 0: 1.5 MiB');

  const seg1 = lines[2];
  assert.equal(seg1.split('\t')[0], '1', '구간 1');
  assert.equal(seg1.split('\t')[1], String(1536 * 1024), '구간 1: 1.5 MiB');

  const seg2 = lines[3];
  assert.equal(seg2.split('\t')[0], '2', '구간 2');
  assert.equal(seg2.split('\t')[1], String(2 * 1024 * 1024), '구간 2: 2 MiB');
});
