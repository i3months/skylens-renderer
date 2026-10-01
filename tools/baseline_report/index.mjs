// 기준선 측정 레코드를 SPEC §4 '현재(T01 측정)' 열 형식의 마크다운 표로 바꾼다.
import { readFileSync } from 'node:fs';
import { assertRecords, parse } from '../../contracts/metrics/index.mjs';

const HEADER = '| metric | 값 | 단위 | 기기 | 방법 | 커밋 |\n| --- | --- | --- | --- | --- | --- |';
const EMPTY_NOTE = '측정 전: 측정된 항목이 없다.';

/** 정수는 천 단위 쉼표, 소수는 최대 3자리(끝의 0 은 생략). */
export function formatNumber(n) {
  const s = n.toLocaleString('en-US', { maximumFractionDigits: 3 });
  return s === '-0' ? '0' : s;
}

// 표 셀 안의 파이프와 줄바꿈이 열 구분을 깨지 않게 한다.
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

// 로케일에 기대지 않는 코드 단위 비교.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** 입력 항목이 문자열이면 JSON 파일 경로로 읽고, 아니면 레코드로 본다. */
function load(input) {
  const out = [];
  for (const item of input) {
    if (typeof item === 'string') out.push(...parse(readFileSync(item, 'utf8')));
    else out.push(item);
  }
  return out;
}

/** records: 레코드 배열 또는 JSON 파일 경로 배열. 스키마 위반이면 던진다. */
export function toTable(records) {
  if (!Array.isArray(records)) throw new Error('records must be an array');
  const list = assertRecords(load(records));
  if (list.length === 0) return `${HEADER}\n\n${EMPTY_NOTE}\n`;
  const sorted = [...list].sort(
    (a, b) =>
      cmp(a.metric, b.metric) ||
      cmp(a.device, b.device) ||
      cmp(a.method, b.method) ||
      cmp(a.commit, b.commit) ||
      a.value - b.value,
  );
  const rows = sorted.map((r) => {
    const value = formatNumber(r.value) + (r.samples ? ` (n=${r.samples.length})` : '');
    return `| ${[r.metric, value, r.unit, r.device, r.method, r.commit].map(cell).join(' | ')} |`;
  });
  return `${HEADER}\n${rows.join('\n')}\n`;
}
