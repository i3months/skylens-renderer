#!/usr/bin/env node
// 사용법: node cli.mjs --skylens-dir <경로> --out <경로> --commit <해시> [--only a,b] [--skip c]
// 하나라도 실패하면 종료코드 1, 잘못된 인자는 2.
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { runAll } from './index.mjs';

const list = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined);

try {
  const { values } = parseArgs({
    options: {
      'skylens-dir': { type: 'string' },
      out: { type: 'string' },
      commit: { type: 'string' },
      only: { type: 'string' },
      skip: { type: 'string' },
      // 테스트용: 모듈 폴더 위치 재정의
      'modules-dir': { type: 'string' },
    },
  });
  if (!values['skylens-dir'] || !values.out || !values.commit) {
    throw new Error('--skylens-dir, --out, --commit 은 필수다');
  }
  const { summary, exitCode } = await runAll({
    skylensDir: resolve(values['skylens-dir']),
    outDir: resolve(values.out),
    commit: values.commit,
    only: list(values.only),
    skip: list(values.skip),
    ...(values['modules-dir'] ? { modulesDir: resolve(values['modules-dir']) } : {}),
  });
  console.log(`성공 ${summary.ok.length}, 실패 ${summary.failed.length}, 건너뜀 ${summary.skipped.length}, 레코드 ${summary.totalRecords}`);
  for (const f of summary.failed) console.error(`실패: ${f.module} (${f.stage}) ${f.error}`);
  process.exitCode = exitCode;
} catch (e) {
  console.error(e.message);
  process.exitCode = 2;
}
