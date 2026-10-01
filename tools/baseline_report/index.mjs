// 기준선 측정 레코드를 마크다운 표로 바꾼다. 소프트웨어 렌더 기기 레코드는 본 표에서 빼 참고값 절로 분리한다.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { assertRecords, parse } from '../../contracts/metrics/index.mjs';

const HEADER = '| metric | 값 | 단위 | 기기 | 방법 | 커밋 |\n| --- | --- | --- | --- | --- | --- |';
const REF_TITLE = '## 참고값(클라우드)';
const SOFTWARE_DEVICE = /swiftshader|software|llvmpipe|softpipe|swrast/i;
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

/**
 * 표에 찍을 단위. 계약 UNITS 에 분산 단위가 없어 옛 first_frame 이 분산을 'ratio' 로 냈다.
 * 그런 레코드(metric 에 variance 포함 + unit ratio)는 실제 단위인 ms² 로 표시한다.
 * first_frame.stdev 처럼 표준편차는 ms 그대로 나온다.
 */
export function displayUnit(r) {
  if (r.unit === 'ratio' && /variance/.test(r.metric)) return 'ms²';
  return r.unit;
}

/** 입력 항목이 문자열이면 JSON 파일 경로로 읽고, 아니면 레코드로 본다. */
function load(input) {
  const out = [];
  for (const item of input) {
    if (typeof item === 'string') out.push(...parse(readFileSync(item, 'utf8')));
    else out.push(item);
  }
  return out;
}

/** 소프트웨어 렌더(swiftshader 등) 기기에서 잰 레코드인가. */
export const isSoftwareDevice = (r) => SOFTWARE_DEVICE.test(r.device);

function rowsOf(list) {
  const sorted = [...list].sort(
    (a, b) =>
      cmp(a.metric, b.metric) ||
      cmp(a.device, b.device) ||
      cmp(a.method, b.method) ||
      cmp(a.commit, b.commit) ||
      a.value - b.value,
  );
  return sorted
    .map((r) => {
      const value = formatNumber(r.value) + (r.samples ? ` (n=${r.samples.length})` : '');
      return `| ${[r.metric, value, displayUnit(r), r.device, r.method, r.commit].map(cell).join(' | ')} |`;
    })
    .join('\n');
}

/**
 * records: 레코드 배열 또는 JSON 파일 경로 배열. 스키마 위반이면 던진다.
 * 소프트웨어 렌더 기기 레코드는 본 표가 아니라 뒤의 '참고값(클라우드)' 절에 둔다.
 */
export function toTable(records) {
  if (!Array.isArray(records)) throw new Error('records must be an array');
  const list = assertRecords(load(records));
  const main = list.filter((r) => !isSoftwareDevice(r));
  const ref = list.filter(isSoftwareDevice);
  let out = main.length === 0 ? `${HEADER}\n\n${EMPTY_NOTE}\n` : `${HEADER}\n${rowsOf(main)}\n`;
  if (ref.length) out += `\n${REF_TITLE}\n\n${HEADER}\n${rowsOf(ref)}\n`;
  return out;
}
