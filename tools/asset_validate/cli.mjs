#!/usr/bin/env node
// 명령줄: node tools/asset_validate/cli.mjs <파일.skla>... — 위반이 있으면 목록을 출력하고 종료코드 1.
import { readFileSync } from 'node:fs';
import { validateAsset } from './index.mjs';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: cli.mjs <file.skla>...');
  process.exit(2);
}
let bad = 0;
for (const f of files) {
  let violations;
  try {
    violations = validateAsset(new Uint8Array(readFileSync(f)));
  } catch (e) {
    violations = [{ code: 'io', message: e.message }];
  }
  if (violations.length === 0) console.log(`${f}: ok`);
  else {
    bad++;
    for (const v of violations) console.log(`${f}: ${v.code}: ${v.message}`);
  }
}
process.exit(bad ? 1 : 0);
