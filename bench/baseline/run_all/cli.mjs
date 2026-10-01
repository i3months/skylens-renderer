#!/usr/bin/env node
// 사용법: node cli.mjs --skylens-dir <경로> --out <경로> --commit <해시> [--only a,b] [--skip c]
//   [--points <ply>] [--ws-recording <jsonl>] [--tower-recording <jsonl>] [--dist-dir <dir>]
//   [--anchor-lat <n> --anchor-lon <n> --anchor-alt <n>]  (앵커는 셋 다 함께)
// 하나라도 실패하면 종료코드 1, 잘못된 인자나 실행 대상이 0개(전부 건너뜀)면 2.
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { runAll } from './index.mjs';

const list = (s, label) => {
  if (s === undefined) return undefined;
  const items = s.split(',').map((x) => x.trim()).filter(Boolean);
  if (!items.length) throw new Error(`--${label} 에 모듈 이름이 없다`);
  return items;
};

try {
  // 음수 값(`--anchor-lon -127.2`)을 parseArgs 가 옵션으로 오해하지 않게 `=` 형태로 합친다.
  const argv = process.argv.slice(2).reduce((a, t) => {
    if (/^-\d/.test(t) && /^--anchor-(lat|lon|alt)$/.test(a[a.length - 1] ?? '')) a.push(`${a.pop()}=${t}`);
    else a.push(t);
    return a;
  }, []);
  const { values } = parseArgs({
    args: argv,
    options: {
      'skylens-dir': { type: 'string' },
      out: { type: 'string' },
      commit: { type: 'string' },
      only: { type: 'string' },
      skip: { type: 'string' },
      points: { type: 'string' },
      'ws-recording': { type: 'string' },
      'tower-recording': { type: 'string' },
      'dist-dir': { type: 'string' },
      'entry-path': { type: 'string' },
      'anchor-lat': { type: 'string' },
      'anchor-lon': { type: 'string' },
      'anchor-alt': { type: 'string' },
      // 테스트용: 모듈 폴더 위치 재정의
      'modules-dir': { type: 'string' },
    },
  });
  if (!values['skylens-dir'] || !values.out || !values.commit) {
    throw new Error('--skylens-dir, --out, --commit 은 필수다');
  }
  // 주어진 입력만 inputs 에 담는다. 없는 입력은 키 자체를 두지 않아 모듈이 직접 실패하게 한다.
  const inputs = {};
  const paths = [['points', 'pointsPath'], ['ws-recording', 'wsRecording'], ['tower-recording', 'towerRecording'], ['dist-dir', 'distDir']];
  for (const [opt, key] of paths) if (values[opt]) inputs[key] = resolve(values[opt]);
  if (values['entry-path']) inputs.entryPath = values['entry-path'];
  const an = ['anchor-lat', 'anchor-lon', 'anchor-alt'].map((k) => values[k]);
  if (an.some((v) => v !== undefined)) {
    if (an.some((v) => v === undefined)) throw new Error('--anchor-lat, --anchor-lon, --anchor-alt 는 셋 다 함께 줘야 한다');
    const [lat, lon, alt] = an.map(Number);
    if (an.some((v) => v.trim() === '') || ![lat, lon, alt].every(Number.isFinite)) throw new Error('앵커 값은 유한한 숫자여야 한다');
    inputs.anchor = { lat, lon, alt };
  }
  const { summary, exitCode } = await runAll({
    skylensDir: resolve(values['skylens-dir']),
    outDir: resolve(values.out),
    commit: values.commit,
    inputs,
    only: list(values.only, 'only'),
    skip: list(values.skip, 'skip'),
    ...(values['modules-dir'] ? { modulesDir: resolve(values['modules-dir']) } : {}),
  });
  console.log(`성공 ${summary.ok.length}, 실패 ${summary.failed.length}, 건너뜀 ${summary.skipped.length}, 레코드 ${summary.totalRecords}`);
  for (const f of summary.failed) console.error(`실패: ${f.module} (${f.stage}) ${f.error}`);
  process.exitCode = exitCode;
  // 타임아웃으로 버린 모듈이 이벤트 루프를 붙잡고 있어도 끝나도록 한다.
  if (summary.failed.some((f) => f.stage === 'timeout')) process.exit(exitCode);
} catch (e) {
  console.error(e.message);
  process.exitCode = 2;
}
