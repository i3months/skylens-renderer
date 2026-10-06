import { validateResult } from '../../contracts/load/index.mjs';

const cell = (s) => String(s)
  .replace(/\\/g, '\\\\')         // Escape every backslash first
  .replace(/\|/g, '\\|')          // Escape pipes
  .replace(/\r\n|\r|\n/g, ' ');  // Replace line breaks with spaces

export function loadReport(result) {
  const errors = validateResult(result);
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

  rows.push('source: simulated, S5/S8 verdict [local]');
  if (result.scenario.kind === 'slow_link') {
    rows.push('S5 문턱 제외 시나리오');
  }

  return rows.join('\n');
}
