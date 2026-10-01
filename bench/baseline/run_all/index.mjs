// 베이스라인 측정 모듈 8개를 순차 실행하고 결과를 하나의 records.json 으로 모은다.
// 모듈 계약은 contracts/metrics/index.mjs 하단 'Bench module contract' 주석을 따른다.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { serialize } from '../../../contracts/metrics/index.mjs';
import { buildDist as defaultBuildDist, killGroup, trackChild } from '../_common/build.mjs';

/** dist(빌드된 skylens)가 필요한 모듈. inputs.distDir 가 없으면 복사본에서 한 번 빌드해 넘긴다. */
export const DIST_MODULES = ['bundle_status', 'bundle_tower', 'first_frame', 'heap'];

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

/** 모듈 하나(import 포함)의 기본 타임아웃(ms). */
export const DEFAULT_MODULE_TIMEOUT_MS = 30 * 60 * 1000;

/** 모듈 폴더들이 있는 기본 위치 (bench/baseline). */
const STARTUP_CAP_MS = 30 * 1000;
const WORKER = join(dirname(fileURLToPath(import.meta.url)), 'worker.mjs');
const DEFAULT_MODULES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function errText(e) {
  return e instanceof Error ? e.message : String(e);
}

function checkNames(label, names) {
  for (const n of names) {
    if (!MODULES.includes(n)) throw new Error(`${label}: unknown module ${n}`);
  }
}

// 모듈 하나를 별도 프로세스 그룹의 자식 프로세스(worker.mjs)에서 실행한다.
// 타임아웃·종료 시 그룹 전체를 죽이므로 늦게 도는 모듈이 outDir 에 더는 쓰지 못한다.
function runModule({ modulesDir, name, skylensDir, outDir, commit, inputs, timeoutMs }) {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [WORKER], { detached: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const untrack = trackChild(p);
    let msg = null;
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killGroup(p);
      untrack();
      fn(v);
    };
    // 프로세스 기동 시간은 모듈 시간에 넣지 않는다: worker 가 ready 를 보내면 그때부터 timeoutMs 를 잰다.
    let timer;
    const arm = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        finish(rej, Object.assign(new Error(`모듈 타임아웃(${timeoutMs}ms 초과)`), { stage: 'timeout' }));
      }, ms);
    };
    arm(STARTUP_CAP_MS + timeoutMs);
    p.on('message', (m) => {
      if (m?.ready) return arm(timeoutMs);
      msg = m;
    });
    p.on('error', (e) => finish(rej, Object.assign(new Error(`모듈 프로세스 실패: ${e.message}`), { stage: 'import' })));
    p.on('close', (code, sig) => {
      if (msg?.ok) return finish(res, msg.list);
      if (msg) return finish(rej, Object.assign(new Error(msg.error), { stage: msg.stage }));
      finish(rej, Object.assign(new Error(`모듈 프로세스가 결과 없이 종료됨(code ${code}, signal ${sig})`), { stage: 'run' }));
    });
    p.send({ modulesDir, name, args: { skylensDir, outDir, commit, inputs } });
  });
}

/**
 * 모듈을 순차 실행한다. 모듈 하나가 import 실패·예외·잘못된 레코드를 내도
 * 그 모듈만 failed 로 기록하고 나머지는 계속 실행한다.
 *
 * @param {object} o
 * @param {string} o.skylensDir skylens develop 체크아웃 (읽기 전용)
 * @param {string} o.outDir 산출물 루트. 모듈별로 outDir/<모듈명>/ 을 쓰게 한다
 * @param {string} o.commit skylens 커밋 해시
 * @param {object} [o.inputs] 외부 입력 (contracts/inputs). 그대로 각 모듈 run 에 전달한다. 없으면 {}
 * @param {string[]} [o.only] 지정하면 이 모듈만 실행
 * @param {string[]} [o.skip] 이 모듈은 건너뜀
 * @param {string} [o.modulesDir] <모듈명>/index.mjs 를 찾을 폴더 (테스트에서 가짜 모듈 주입용)
 * @param {number} [o.moduleTimeoutMs] 모듈별 타임아웃. 초과 시 그 모듈만 failed(stage 'timeout')
 * @param {string[]} [o.modules] 모듈 이름 목록 재정의 (테스트용, 기본 MODULES)
 * @returns {Promise<{summary: object, records: object[], exitCode: number}>} exitCode: 실패 있음 1, 실행 대상 0개 2, 그 외 0
 */
export async function runAll({ skylensDir, outDir, commit, inputs = {}, only, skip, modulesDir = DEFAULT_MODULES_DIR, modules = MODULES, buildDist = defaultBuildDist, moduleTimeoutMs = DEFAULT_MODULE_TIMEOUT_MS } = {}) {
  if (!outDir) throw new Error('outDir 이 필요하다');
  if (Array.isArray(only) && only.length === 0) throw new Error('only 에 모듈 이름이 없다');
  // 이름 검증은 기본 MODULES 를 쓸 때만 한다 (재정의 시에는 재정의한 목록 기준).
  const known = new Set(modules);
  for (const [label, names] of [['only', only], ['skip', skip]]) {
    for (const n of names ?? []) if (!known.has(n)) throw new Error(`${label}: unknown module ${n}`);
  }
  const onlySet = only ? new Set(only) : null;
  const skipSet = new Set(skip ?? []);

  await mkdir(outDir, { recursive: true });
  const records = [];
  const ok = [];
  const failed = [];
  const skipped = [];

  // dist 가 필요한 모듈이 하나라도 실행 대상이면 빌드한다. 빌드가 실패하면 그 모듈들만 failed.
  let buildError = null;
  let buildStage = 'build';
  const wantsDist = modules.some((n) => DIST_MODULES.includes(n) && !(onlySet && !onlySet.has(n)) && !skipSet.has(n));
  if (wantsDist && !inputs.distDir) {
    try {
      inputs = { ...inputs, distDir: await buildDist({ skylensDir, workDir: join(outDir, '_build') }) };
    } catch (e) {
      buildError = errText(e);
      buildStage = e?.stage === 'timeout' ? 'timeout' : 'build';
    }
  }

  for (const name of modules) {
    if ((onlySet && !onlySet.has(name)) || skipSet.has(name)) {
      skipped.push(name);
      continue;
    }
    if (buildError && DIST_MODULES.includes(name)) {
      failed.push({ module: name, stage: buildStage, error: buildError });
      continue;
    }
    try {
      const list = await runModule({ modulesDir, name, skylensDir, outDir: join(outDir, name), commit, inputs, timeoutMs: moduleTimeoutMs });
      records.push(...list);
      ok.push({ module: name, records: list.length });
    } catch (e) {
      failed.push({ module: name, stage: e.stage ?? 'run', error: errText(e) });
    }
  }

  const summary = { ok, failed, skipped, totalRecords: records.length };
  // 실패한 모듈의 레코드는 넣지 않는다. 같은 입력이면 바이트 동일하게 직렬화된다.
  await writeFile(join(outDir, 'records.json'), serialize(records));
  await writeFile(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return { summary, records, exitCode: failed.length ? 1 : ok.length ? 0 : 2 };
}
