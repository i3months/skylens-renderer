#!/usr/bin/env node
// 사용법: node tools/baseline_report/cli.mjs a.json b.json
import { toTable } from './index.mjs';

const files = process.argv.slice(2);
try {
  process.stdout.write(toTable(files));
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
}
