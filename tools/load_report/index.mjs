import { validateResult } from '../../contracts/load/index.mjs';
import { checkServerSamples } from '../../bench/load/server_stats/index.mjs';

const cell = (s) => String(s)
  .replace(/\\/g, '\\\\')         // Escape every backslash first
  .replace(/\|/g, '\\|')          // Escape pipes
  .replace(/\r\n|\r|\n/g, ' ');  // Replace line breaks with spaces

const nonEmpty = (v) => (typeof v === 'string' && v !== '' ? v : null);

// The `source:` line comes from the records' method only. Any record with method 'sim' (the harness
// label for simulated runs) makes it 'simulated'. Otherwise the first record's method is used; a
// different non-empty method on another record (mixed) or an unusable first method gives 'unknown'.
// Server samples never feed this line, so a sample cannot hide a simulated run.
function methodSource(records) {
  if (records.some((r) => r?.method === 'sim')) return 'simulated';
  const first = nonEmpty(records[0]?.method);
  if (first === null) return 'unknown';
  if (records.some((r) => nonEmpty(r?.method) !== null && r.method !== first)) return 'unknown';
  return first;
}

function sourceLine(source) {
  if (source === 'simulated') return 'source: simulated, S5/S8 verdict [local]';
  if (source === 'unknown') return 'source: unknown, S5/S8 verdict origin unknown';
  return `source: ${source}, S5/S8 verdict measured on ${source}`;
}

// Separate cpu/rss line, only when server samples were supplied (opts wins over result). Samples that
// fail checkServerSamples against the scenario's durationS (count, and timing for a real clock), or have
// no usable source, give 'unknown' with no 'measured on'. Mixed sources fail checkServerSamples.
function cpuRssLine(result, opts, source) {
  const samples = opts.serverSamples ?? result.serverSamples;
  if (samples === undefined || samples === null) return null;
  if (Array.isArray(samples) && samples.length === 0) return null;
  if (checkServerSamples(samples, { durationS: result.scenario.durationS }).length > 0) return 'cpu/rss source: unknown';
  const src = nonEmpty(samples[0]?.source);
  if (src === null) return 'cpu/rss source: unknown';
  const label = cell(src);
  if (label === 'unknown') return 'cpu/rss source: unknown';
  if (source === 'simulated') return `cpu/rss source: ${label}`;
  return `cpu/rss source: ${label}, measured on ${label}`;
}

export function loadReport(result, opts) {
  if (result === null || typeof result !== 'object') throw new Error('loadReport: result must be an object');
  if (opts === null || typeof opts !== 'object') opts = {};
  // serverSamples is report-only input; the result contract does not list it, so validate without it.
  const { serverSamples: _ignored, ...contractResult } = result;
  const errors = validateResult(contractResult);
  if (errors.length > 0) {
    throw new Error(errors.join('; '));
  }

  const rows = [];
  rows.push('| metric | value | unit | device | method |');
  rows.push('| --- | --- | --- | --- | --- |');

  for (const record of result.records) {
    const value = String(record.value);
    rows.push(`| ${[record.metric, value, record.unit, record.device, record.method].map(cell).join(' | ')} |`);
  }

  const totalBytes = result.perClient.reduce((sum, client) => sum + client.bytes, 0);
  const clientsCount = result.scenario.clients;
  rows.push(`\nclients: ${clientsCount}, total bytes: ${totalBytes}`);

  const source = cell(methodSource(result.records));
  rows.push(sourceLine(source));
  const cpuLine = cpuRssLine(result, opts, source);
  if (cpuLine !== null) rows.push(cpuLine);
  if (result.scenario.kind === 'slow_link') {
    rows.push('S5 threshold-excluded scenario');
  }

  return rows.join('\n');
}
