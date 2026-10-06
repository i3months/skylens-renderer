import { validateResult } from '../../contracts/load/index.mjs';

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

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

  return rows.join('\n');
}
