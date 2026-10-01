import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { toTable } from './index.mjs';
import { toReport, toStatusTable } from './report.mjs';

const A = { metric: 'frame.p95', value: 16, unit: 'ms', device: 'pixel7', method: 'raf-60s', commit: 'abc1234' };
const SUMMARY = {
  ok: [{ module: 'asset_bytes', records: 3 }, { module: 'bundle_status', records: 2 }],
  failed: [{ module: 'first_frame', stage: 'run', error: 'chromium 없음' }],
  skipped: ['heap'],
  totalRecords: 5,
};

test('분산 단위: ratio 로 찍히지 않고 stdev 는 ms', () => {
  const old = { metric: 'first_frame.variance_sq', value: 4, unit: 'ratio', device: 'd', method: 'm', commit: 'abc1234' };
  const sd = { metric: 'first_frame.stdev', value: 2, unit: 'ms', device: 'd', method: 'm', commit: 'abc1234' };
  const t = toTable([old, sd]);
  assert.ok(t.includes('| first_frame.stdev | 2 | ms | d | m | abc1234 |'));
  assert.ok(t.includes('| first_frame.variance_sq | 4 | ms² | d | m | abc1234 |'));
  assert.ok(!t.includes('ratio'));
  // 진짜 비율 지표는 ratio 유지
  assert.ok(toTable([{ ...old, metric: 'ref_images.coverage.v1' }]).includes('| ratio |'));
});

test('미달 절이 표 맨 위에 온다', () => {
  const { text } = toReport([A], { summary: SUMMARY });
  assert.ok(
    text.startsWith(
      '## 미달·측정 불가\n\n| 모듈 | 단계 | 오류 |\n| --- | --- | --- |\n| first_frame | run | chromium 없음 |\n\n| metric | 값 |',
    ),
  );
  assert.ok(toReport([A], { summary: { ...SUMMARY, failed: [] } }).text.startsWith('| metric |'));
});

test('records.json 만 있고 summary.json 이 없으면 경고', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bl-warn-'));
  const rec = join(dir, 'records.json');
  writeFileSync(rec, JSON.stringify([A]));
  const r = toReport([rec]);
  assert.equal(r.warnings.length, 1);
  assert.ok(r.text.startsWith(`> 경고: ${rec} 옆에 summary.json 이 없다.`));
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(SUMMARY));
  const r2 = toReport([rec]);
  assert.equal(r2.warnings.length, 0);
  assert.ok(r2.text.startsWith('## 미달·측정 불가'));
});

test('--status 표', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bl-status-'));
  const f = join(dir, 'summary.json');
  writeFileSync(f, JSON.stringify(SUMMARY));
  const expected = [
    '| 하위 작업 | 상태 | 레코드 | 비고 |',
    '| --- | --- | --- | --- |',
    '| asset_bytes | 충족 | 3 |  |',
    '| bundle_status | 충족 | 2 |  |',
    '| first_frame | 미달 |  | run: chromium 없음 |',
    '| heap | 건너뜀 |  |  |',
    '',
    '충족 2, 미달 1, 건너뜀 1',
    '',
  ].join('\n');
  assert.equal(toStatusTable(f), expected);
  const cli = new URL('./cli.mjs', import.meta.url).pathname;
  assert.equal(execFileSync('node', [cli, '--status', f], { encoding: 'utf8' }), expected);
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, JSON.stringify({ ok: [] }));
  assert.throws(() => toStatusTable(bad), (e) => e.message === `${bad}: failed must be an array`);
  assert.throws(() => toStatusTable(join(dir, 'none.json')), /none\.json/);
});
