// run_all 의 summary.json 을 쓰는 보고 기능: 미달 절, summary 누락 경고, 하위 작업별 충족/미달 표.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { toTable } from './index.mjs';

const SUMMARY_KEYS = ['ok', 'failed', 'skipped'];
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** summary.json(run_all 산출) 을 읽어 모양을 검사한다. 오류에 파일명을 넣는다. */
export function loadSummary(input) {
  let s = input;
  let name = 'summary';
  if (typeof input === 'string') {
    name = input;
    try {
      s = JSON.parse(readFileSync(input, 'utf8'));
    } catch (e) {
      throw new Error(`${name}: ${e.message}`);
    }
  }
  if (s === null || typeof s !== 'object' || Array.isArray(s)) throw new Error(`${name}: summary must be an object`);
  for (const k of SUMMARY_KEYS) if (!Array.isArray(s[k])) throw new Error(`${name}: ${k} must be an array`);
  s.failed.forEach((f, i) => {
    if (!f || typeof f.module !== 'string') throw new Error(`${name}: failed[${i}] needs module`);
  });
  s.ok.forEach((o, i) => {
    if (!o || typeof o.module !== 'string') throw new Error(`${name}: ok[${i}] needs module`);
  });
  s.skipped.forEach((m, i) => {
    if (typeof m !== 'string') throw new Error(`${name}: skipped[${i}] must be a string`);
  });
  return s;
}

/** 하위 작업(모듈)별 충족/미달 표. 입력은 summary.json 경로 또는 객체. */
export function toStatusTable(summaryInput) {
  const s = loadSummary(summaryInput);
  const rows = [
    ...s.ok.map((o) => [o.module, '충족', String(o.records ?? ''), '']),
    ...s.failed.map((f) => [f.module, '미달', '', `${f.stage ?? ''}: ${f.error ?? ''}`]),
    ...s.skipped.map((m) => [m, '건너뜀', '', '']),
  ].sort((a, b) => cmp(a[0], b[0]));
  const head = '| 하위 작업 | 상태 | 레코드 | 비고 |\n| --- | --- | --- | --- |';
  const body = rows.map((r) => `| ${r.map(cell).join(' | ')} |`).join('\n');
  const total = `충족 ${s.ok.length}, 미달 ${s.failed.length}, 건너뜀 ${s.skipped.length}`;
  return `${head}\n${body}${body ? '\n' : ''}\n${total}\n`;
}

function failedSection(s) {
  if (s.failed.length === 0) return '';
  const rows = s.failed.map((f) => `| ${[f.module, f.stage ?? '', f.error ?? ''].map(cell).join(' | ')} |`);
  return `## 미달·측정 불가\n\n| 모듈 | 단계 | 오류 |\n| --- | --- | --- |\n${rows.join('\n')}\n\n`;
}

/**
 * 보고서 전체. opts.summary: summary.json 경로 또는 객체(있으면 미달 절을 맨 위에 둔다).
 * summary 가 없고 입력 중 records.json 옆에 summary.json 도 없으면 경고를 맨 위에 둔다.
 * 반환: { text, warnings }
 */
export function toReport(inputs, opts = {}) {
  const warnings = [];
  let summary = opts.summary;
  if (summary === undefined) {
    for (const item of inputs) {
      if (typeof item !== 'string' || basename(item) !== 'records.json') continue;
      const sib = join(dirname(item), 'summary.json');
      if (existsSync(sib)) summary = summary ?? sib;
      else warnings.push(`경고: ${item} 옆에 summary.json 이 없다. 실패·측정 불가 모듈을 알 수 없으니 이 표를 전부 충족으로 읽지 말 것.`);
    }
  }
  let text = '';
  if (warnings.length) text += warnings.map((w) => `> ${w}`).join('\n') + '\n\n';
  if (summary !== undefined) text += failedSection(loadSummary(summary));
  text += toTable(inputs);
  return { text, warnings };
}
