import { validateResult } from '../../contracts/load/index.mjs';

const cell = (s) => String(s)
  .replace(/\\/g, '\\\\')         // Escape every backslash first
  .replace(/\|/g, '\\|')          // Escape pipes
  .replace(/\r\n|\r|\n/g, ' ');  // Replace line breaks with spaces

const nonEmpty = (v) => (typeof v === 'string' && v !== '' ? v : null);

// Source label precedence: server samples (embedded or via opts) > first record's method > 'unknown'.
// Record method 'sim' is the harness label for simulated runs and maps to source 'simulated'.
// The '[local]' verdict wording is only true for the simulated source; any other source says
// where the verdict was measured instead.
function sourceLine(result, opts) {
  const samples = opts?.serverSamples ?? result.serverSamples;
  const fromSamples = nonEmpty(samples?.[0]?.source);
  const fromMethod = nonEmpty(result.records?.[0]?.method);
  // Sanitized like table cells so a method with line breaks cannot add report lines.
  const source = cell(fromSamples ?? (fromMethod === 'sim' ? 'simulated' : fromMethod) ?? 'unknown');
  if (source === 'simulated') return 'source: simulated, S5/S8 verdict [local]';
  if (source === 'unknown') return 'source: unknown, S5/S8 verdict origin unknown';
  return `source: ${source}, S5/S8 verdict measured on ${source}`;
}

export function loadReport(result, opts = {}) {
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

  rows.push(sourceLine(result, opts));
  if (result.scenario.kind === 'slow_link') {
    rows.push('S5 threshold-excluded scenario');
  }

  return rows.join('\n');
}
