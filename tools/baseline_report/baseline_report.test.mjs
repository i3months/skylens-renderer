import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { toTable } from './index.mjs';

const A = { metric: 'frame.p95', value: 16.6667, unit: 'ms', device: 'pixel7', method: 'raf-60s', commit: 'abc1234', samples: [16, 17, 16.5] };
const B = { metric: 'bundle.status.gzip', value: 1234567, unit: 'B', device: 'ci', method: 'gzip-9', commit: 'abc1234' };
const C = { metric: 'frame.p95', value: 33, unit: 'ms', device: 'iphone12', method: 'raf-60s', commit: 'abc1234' };

const EXPECTED = [
  '| metric | 값 | 단위 | 기기 | 방법 | 커밋 |',
  '| --- | --- | --- | --- | --- | --- |',
  '| bundle.status.gzip | 1,234,567 | B | ci | gzip-9 | abc1234 |',
  '| frame.p95 | 33 | ms | iphone12 | raf-60s | abc1234 |',
  '| frame.p95 | 16.667 (n=3) | ms | pixel7 | raf-60s | abc1234 |',
  '',
].join('\n');

test('baseline_report_table', () => {
  // 알려진 레코드 3개를 기대 문자열 전체와 비교
  assert.equal(toTable([A, B, C]), EXPECTED);

  // 정렬 결정성: 입력 순서를 섞어도 같은 출력
  for (const p of [[C, B, A], [B, A, C], [A, C, B], [C, A, B]]) assert.equal(toTable(p), EXPECTED);

  // 스키마 위반 거부
  assert.throws(() => toTable([A, { ...B, unit: 'kg' }]), /record 1/);
  assert.throws(() => toTable([{ metric: 'x' }]), /missing/);
  assert.throws(() => toTable([{ ...A, extra: 1 }]), /unknown field/);

  // 측정 전: 헤더만 + 안내 한 줄
  assert.equal(
    toTable([]),
    '| metric | 값 | 단위 | 기기 | 방법 | 커밋 |\n| --- | --- | --- | --- | --- | --- |\n\n측정 전: 측정된 항목이 없다.\n',
  );

  // 파일 경로 입력과 CLI
  const dir = mkdtempSync(join(tmpdir(), 'bl-report-'));
  const f1 = join(dir, 'a.json');
  const f2 = join(dir, 'b.json');
  writeFileSync(f1, JSON.stringify([A, C]));
  writeFileSync(f2, JSON.stringify([B]));
  assert.equal(toTable([f2, f1]), EXPECTED);
  const cli = new URL('./cli.mjs', import.meta.url).pathname;
  assert.equal(execFileSync('node', [cli, f1, f2], { encoding: 'utf8' }), EXPECTED);
});
