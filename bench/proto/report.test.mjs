// 보고서 생성 시험(T11.11).
// `node --test bench/proto/report.test.mjs` 로 실행한다.

import test from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateReport, syntheticSceneReport } from './report.mjs';

test('generateReport - 기본 형식', () => {
  const data = [
    { segmentId: 0, bytes: 1_000_000, phase: 'segment' },  // 1 MB
  ];

  const report = generateReport(data);
  const lines = report.split('\n');

  // 헤더
  assert.equal(lines[0], '구간\t바이트\t예산%', '헤더 행 확인');

  // 데이터 행
  assert.match(lines[1], /^0\t/, '구간 ID 0 으로 시작');
  assert.match(lines[1], /1000000/, '바이트 1000000');
  assert.match(lines[1], /33\.33/, '예산 약 33%');
});

test('generateReport - 여러 구간', () => {
  const data = [
    { segmentId: 1, bytes: 2_000_000, phase: 'segment' },
    { segmentId: 0, bytes: 1_000_000, phase: 'segment' },
    { segmentId: 2, bytes: 500_000, phase: 'segment' }
  ];

  const report = generateReport(data);
  const lines = report.split('\n');

  // 구간이 오름차순으로 정렬됨
  assert.equal(lines[1].split('\t')[0], '0', '첫 구간이 0');
  assert.equal(lines[2].split('\t')[0], '1', '두 번째 구간이 1');
  assert.equal(lines[3].split('\t')[0], '2', '세 번째 구간이 2');
});

test('generateReport - 예산 비율 계산', () => {
  const BUDGET = 3_000_000;

  const data = [
    // 50% 사용
    { segmentId: 0, bytes: BUDGET / 2, phase: 'segment' },
  ];

  const report = generateReport(data);
  assert.match(report, /50\.00/, '50% 예산 사용');
});

test('generateReport - 정확히 100% 사용', () => {
  const BUDGET = 3_000_000;

  const data = [
    { segmentId: 0, bytes: BUDGET, phase: 'segment' },
  ];

  const report = generateReport(data);
  assert.match(report, /100\.00/, '100% 예산 사용');
});

test('generateReport - initial 단계는 무시', () => {
  const data = [
    { segmentId: 0, bytes: 1_000_000, phase: 'initial' },
    { segmentId: 0, bytes: 2_000_000, phase: 'segment' },
  ];

  const report = generateReport(data);
  const lines = report.split('\n');

  // segment 만 표에 나타남
  assert.match(lines[1], /2000000/, '2,000,000 B 만 표에 나타남');
});

test('generateReport - 합성 데이터 검증', () => {
  const data = [
    { segmentId: 0, bytes: 1_000_000, phase: 'segment' },
    { segmentId: 0, bytes: 500_000, phase: 'segment' },
    { segmentId: 1, bytes: 1_500_000, phase: 'segment' },
    { segmentId: 2, bytes: 2_000_000, phase: 'segment' },
  ];

  const lines = generateReport(data).split('\n');
  assert.equal(lines.length, 4, '헤더 + 3 구간 = 4줄');
  assert.equal(lines[1], '0\t1500000\t50.00%');
  assert.equal(lines[2], '1\t1500000\t50.00%');
  assert.equal(lines[3], '2\t2000000\t66.67%');
});

test('report.mjs - import 때 main() 이 돌지 않는다', () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import ${JSON.stringify(new URL('./report.mjs', import.meta.url).href)}; console.log('IMPORTED');`], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'IMPORTED\n', 'import 만으로는 표가 출력되면 안 된다');
});

test('report.mjs - 직접 실행하면 합성 장면 표를 출력하고 시험과 같은 수치다', () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('./report.mjs', import.meta.url))], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, syntheticSceneReport() + '\n');
});
