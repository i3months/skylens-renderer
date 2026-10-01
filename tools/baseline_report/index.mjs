// Renders measurement records (contracts/metrics) as a Markdown table.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertRecords, parse } from '../../contracts/metrics/index.mjs';

const HEADER = ['item', 'unit', 'value', 'median', 'samples', 'device', 'method'];

const num = (x) => String(Number(x.toFixed(2)));

/** Human-readable [number, unit] for a value; B scales to KB/MB (1024-based). */
function human(value, unit) {
  if (unit === 'B') {
    const a = Math.abs(value);
    if (a >= 1024 ** 2) return [num(value / 1024 ** 2), 'MB'];
    if (a >= 1024) return [num(value / 1024), 'KB'];
  }
  return [num(value), unit];
}

function cell(v, unit, shownUnit) {
  const [h] = human(v, unit);
  return shownUnit === unit ? num(v) : `${h} (${num(v)} ${unit})`;
}

function median(s) {
  const a = [...s].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function toMarkdown(records) {
  assertRecords(records);
  const sorted = [...records].sort(
    (a, b) => cmp(a.metric, b.metric) || cmp(a.device, b.device) || cmp(a.method, b.method) || cmp(a.unit, b.unit) || a.value - b.value,
  );
  const rows = sorted.map((r) => {
    const [, shown] = human(r.value, r.unit);
    const hasS = Array.isArray(r.samples) && r.samples.length > 0;
    return [
      r.metric,
      shown,
      cell(r.value, r.unit, shown),
      hasS ? cell(median(r.samples), r.unit, shown) : '-',
      hasS ? String(r.samples.length) : '-',
      r.device,
      r.method,
    ].map(esc);
  });
  const line = (c) => `| ${c.join(' | ')} |`;
  return [line(HEADER), line(HEADER.map(() => '---')), ...rows.map(line)].join('\n') + '\n';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: node tools/baseline_report/index.mjs <records.json...>');
    process.exit(2);
  }
  try {
    process.stdout.write(toMarkdown(files.flatMap((f) => parse(readFileSync(f, 'utf8')))));
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}
