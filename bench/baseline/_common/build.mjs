// skylens 트리를 복사본에서 프로덕션 빌드해 dist 디렉터리를 만든다.
// 원본 트리(skylensDir)는 절대 수정하지 않는다(npm ci·vite 산출물은 모두 workDir 안).
import { spawn } from 'node:child_process';
import { cp, mkdir, rm, stat, copyFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

const SKIP = new Set(['.git', 'node_modules']);
const TAIL = 2000;

function tail(s) {
  return s.length > TAIL ? '…' + s.slice(-TAIL) : s;
}

/** 단계별 기본 타임아웃(ms). */
export const DEFAULT_STEP_TIMEOUT_MS = 15 * 60 * 1000;

/** 프로세스 그룹 전체를 죽인다. 그룹 kill 이 안 되면 자식 하나라도 죽인다. */
export function killGroup(p) {
  try { process.kill(-p.pid, 'SIGKILL'); } catch { try { p.kill('SIGKILL'); } catch { /* 이미 종료 */ } }
}

// 살아 있는 자식 그룹 추적. SIGINT/SIGTERM/SIGHUP 을 받으면 모두 죽이고 원래 시그널 동작을 그대로 이어 간다.
const active = new Set();
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
function onSignal(sig) {
  for (const p of active) killGroup(p);
  active.clear();
  untrackSignals();
  process.kill(process.pid, sig);
}
function trackSignals() { for (const s of SIGNALS) if (!process.listeners(s).includes(onSignal)) process.on(s, onSignal); }
function untrackSignals() { for (const s of SIGNALS) process.removeListener(s, onSignal); }

/** 자식(detached 로 띄운 것)을 추적 대상에 넣는다. 반환 함수로 추적을 해제한다. */
export function trackChild(p) {
  active.add(p);
  trackSignals();
  return () => {
    active.delete(p);
    if (!active.size) untrackSignals();
  };
}

// 셸 명령 실행. 종료코드가 0 이 아니면 단계·표준에러 끝부분을 담아 throw.
// 자식은 별도 프로세스 그룹으로 띄워 타임아웃 시 그룹 전체를 죽인다(stage 'timeout', failedStage 에 원래 단계).
function sh(stage, cmd, cwd, log, timeoutMs) {
  return new Promise((res, rej) => {
    log?.(`[build] ${stage}: ${cmd}`);
    const p = spawn(cmd, { cwd, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let done = false;
    let timer;
    const untrack = trackChild(p);
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killGroup(p); // 성공이든 실패든 남은 백그라운드 자식을 정리한다
      untrack();
      fn(v);
    };
    timer = setTimeout(() => {
      killGroup(p);
      finish(rej, Object.assign(
        new Error(`빌드 단계 타임아웃(${stage}, ${timeoutMs}ms 초과): ${cmd}\n--- stderr 끝부분 ---\n${tail(err || out)}`),
        { stage: 'timeout', failedStage: stage },
      ));
    }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => {
      killGroup(p);
      finish(rej, Object.assign(new Error(`빌드 단계 실패(${stage}): ${e.message}`), { stage }));
    });
    p.on('close', (code) => {
      if (code === 0) return finish(res, { out, err });
      killGroup(p); // 남은 손자 프로세스 정리
      finish(rej, Object.assign(
        new Error(`빌드 단계 실패(${stage}, 종료코드 ${code}): ${cmd}\n--- stderr 끝부분 ---\n${tail(err || out)}`),
        { stage, code },
      ));
    });
  });
}

// 심볼릭 링크를 풀어 절대경로를 만든다. 아직 없는 경로는 존재하는 가장 가까운 상위를 풀고 나머지를 붙인다.
async function realResolve(p) {
  const abs = resolve(p);
  try { return await realpath(abs); } catch { /* 없음 */ }
  const parent = dirname(abs);
  if (parent === abs) return abs;
  return join(await realResolve(parent), basename(abs));
}

const contains = (a, b) => b === a || b.startsWith(a.endsWith(sep) ? a : a + sep);

async function isFile(p) {
  try { return (await stat(p)).isFile(); } catch { return false; }
}

/**
 * @param {object} o
 * @param {string} o.skylensDir 원본 트리(읽기 전용)
 * @param {string} o.workDir 복사·빌드 작업 디렉터리(비워서 새로 만든다)
 * @param {(m:string)=>void} [o.log]
 * @param {string|null} [o.installCmd] 기본: `npm ci` 실패 시 `npm install`. null 이면 생략(테스트용)
 * @param {string} [o.buildCmd] 기본 `npx vite build`
 * @param {number} [o.stepTimeoutMs] 설치·빌드 단계별 타임아웃. 초과 시 stage 'timeout' 으로 throw
 * @returns {Promise<string>} dist 절대경로
 */
export async function buildDist({ skylensDir, workDir, log, installCmd, buildCmd = 'npx vite build', stepTimeoutMs = DEFAULT_STEP_TIMEOUT_MS }) {
  const src = resolve(skylensDir);
  const work = resolve(workDir);
  if (!(await stat(src).catch(() => null))?.isDirectory()) {
    throw new Error(`skylensDir 가 디렉터리가 아님: ${src}`);
  }
  // 심볼릭 링크까지 푼 경로로 양방향 포함을 검사한다. work 는 비우므로 원본이 지워지면 안 된다.
  const realSrc = await realResolve(src);
  const realWork = await realResolve(work);
  if (contains(realSrc, realWork) || contains(realWork, realSrc)) {
    throw new Error(`workDir 와 skylensDir 는 서로 포함하면 안 된다: ${realWork} <-> ${realSrc}`);
  }
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  // .git·node_modules 는 제외. 원본에 남은 dist 도 오래된 산출물이므로 제외한다.
  await cp(src, work, {
    recursive: true,
    filter: (s) => {
      const rel = s.slice(src.length + 1).split(sep);
      return !SKIP.has(rel[0]) && rel[0] !== 'dist' && !rel.includes('node_modules');
    },
  });
  log?.(`[build] 복사 완료: ${src} -> ${work}`);

  if (installCmd !== null) {
    if (installCmd) {
      await sh('install', installCmd, work, log, stepTimeoutMs);
    } else {
      try {
        await sh('npm ci', 'npm ci --no-audit --no-fund', work, log, stepTimeoutMs);
      } catch (e) {
        if (e.stage === 'timeout') throw e;
        log?.(`[build] npm ci 실패, npm install 로 재시도: ${e.message.split('\n')[0]}`);
        await sh('install', 'npm install --no-audit --no-fund', work, log, stepTimeoutMs);
      }
    }
  }

  // tsc 는 생략: package.json 의 build 는 `tsc && vite build` 이지만 tsc 는 타입 검사일 뿐
  // 번들 내용에 영향이 없고(vite 는 자체적으로 TS 를 트랜스파일), 타입 오류는 측정 대상이 아니다.
  await sh('build', buildCmd, work, log, stepTimeoutMs);

  const dist = join(work, 'dist');
  const index = join(dist, 'index.html');
  if (!(await isFile(index))) {
    // 다중 페이지 빌드는 입력 경로를 유지한다(예: dist/res/static/index.html).
    // 에셋 URL 은 절대경로(/assets/…)라 dist 루트로 복사해도 동작한다.
    const alt = join(dist, 'res', 'static', 'index.html');
    if (await isFile(alt)) await copyFile(alt, index);
  }
  if (!(await isFile(index))) {
    throw new Error(`빌드 단계 실패(verify): ${index} 가 없다`);
  }
  log?.(`[build] 완료: ${dist}`);
  return dist;
}
