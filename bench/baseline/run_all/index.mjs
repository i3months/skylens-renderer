// 베이스라인 측정 모듈 8개를 순차 실행하고 결과를 하나의 records.json 으로 모은다 (T01.10).
// 모듈 계약은 contracts/metrics/index.mjs 하단 'Bench module contract' 주석을 따른다.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertRecords, serialize } from '../../../contracts/metrics/index.mjs';

/** 실행 순서를 겸하는 모듈 이름 목록. records.json 의 레코드 순서도 이 순서를 따른다. */
export const MODULES = [
  'bundle_status',
  'bundle_tower',
  'asset_bytes',
  'ws_bytes',
  'tower_bytes',
  'first_frame',
  'heap',
  'ref_images',
];

/** 모듈 폴더들이 있는 기본 위치 (bench/baseline). */
const DEFAULT_MODULES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function errText(e) {
  return e instanceof Error ? e.message : String(e);
}

function checkNames(label, names) {
  for (const n of names) {
    if (!MODULES.includes(n)) throw new Error(`${label}: unknown module ${n}`);
  }
}

/**
 * 모듈을 순차 실행한다. 모듈 하나가 import 실패·예외·잘못된 레코드를 내도
 * 그 모듈만 failed 로 기록하고 나머지는 계속 실행한다.
 *
 * @param {object} o
 * @param {string} o.skylensDir skylens develop 체크아웃 (읽기 전용)
 * @param {string} o.outDir 산출물 루트. 모듈별로 outDir/<모듈명>/ 을 쓰게 한다
 * @param {string} o.commit skylens 커밋 해시
 * @param {string[]} [o.only] 지정하면 이 모듈만 실행
 * @param {string[]} [o.skip] 이 모듈은 건너뜀
 * @param {string} [o.modulesDir] <모듈명>/index.mjs 를 찾을 폴더 (테스트에서 가짜 모듈 주입용)
 * @param {string[]} [o.modules] 모듈 이름 목록 재정의 (테스트용, 기본 MODULES)
 * @returns {Promise<{summary: object, records: object[], exitCode: number}>}
 */
export async function runAll({ skylensDir, outDir, commit, only, skip, modulesDir = DEFAULT_MODULES_DIR, modules = MODULES } = {}) {
  if (!outDir) throw new Error('outDir 이 필요하다');
  // 이름 검증은 기본 MODULES 를 쓸 때만 한다 (재정의 시에는 재정의한 목록 기준).
  const known = new Set(modules);
  for (const [label, names] of [['only', only], ['skip', skip]]) {
    for (const n of names ?? []) if (!known.has(n)) throw new Error(`${label}: unknown module ${n}`);
  }
  const onlySet = only && only.length ? new Set(only) : null;
  const skipSet = new Set(skip ?? []);

  await mkdir(outDir, { recursive: true });
  const records = [];
  const ok = [];
  const failed = [];
  const skipped = [];

  for (const name of modules) {
    if ((onlySet && !onlySet.has(name)) || skipSet.has(name)) {
      skipped.push(name);
      continue;
    }
    let mod;
    try {
      mod = await import(pathToFileURL(join(modulesDir, name, 'index.mjs')).href);
      if (typeof mod.run !== 'function') throw new Error('run 함수를 export 하지 않음');
    } catch (e) {
      failed.push({ module: name, stage: 'import', error: errText(e) });
      continue;
    }
    try {
      const moduleOut = join(outDir, name);
      await mkdir(moduleOut, { recursive: true });
      const list = await mod.run({ skylensDir, outDir: moduleOut, commit });
      if (!Array.isArray(list)) throw new Error('run 이 배열을 반환하지 않음');
      assertRecords(list);
      records.push(...list);
      ok.push({ module: name, records: list.length });
    } catch (e) {
      failed.push({ module: name, stage: 'run', error: errText(e) });
    }
  }

  const summary = { ok, failed, skipped, totalRecords: records.length };
  // 실패한 모듈의 레코드는 넣지 않는다. 같은 입력이면 바이트 동일하게 직렬화된다.
  await writeFile(join(outDir, 'records.json'), serialize(records));
  await writeFile(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return { summary, records, exitCode: failed.length ? 1 : 0 };
}
