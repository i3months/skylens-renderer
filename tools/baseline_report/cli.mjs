#!/usr/bin/env node
// 사용법:
//   node tools/baseline_report/cli.mjs [--summary summary.json] a.json b.json
//   node tools/baseline_report/cli.mjs --status summary.json   (하위 작업별 충족/미달 표)
import { toReport, toStatusTable } from './report.mjs';

const args = process.argv.slice(2);
let status = null;
let summary;
const files = [];
try {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--status' || args[i] === '--summary') {
      const flag = args[i];
      const v = args[++i];
      if (!v) throw new Error(`${flag} 에 summary.json 경로가 필요하다`);
      if (flag === '--status') status = v;
      else summary = v;
    } else files.push(args[i]);
  }
  if (status !== null) {
    process.stdout.write(toStatusTable(status));
  } else {
    const { text, warnings } = toReport(files, { summary });
    for (const w of warnings) process.stderr.write(`${w}\n`);
    process.stdout.write(text);
  }
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
}
