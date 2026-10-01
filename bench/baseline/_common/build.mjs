// skylens 트리를 복사본에서 프로덕션 빌드해 dist 디렉터리를 만든다.
// 원본 트리(skylensDir)는 절대 수정하지 않는다(npm ci·vite 산출물은 모두 workDir 안).
import { spawn } from 'node:child_process';
import { cp, mkdir, rm, stat, copyFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

const SKIP = new Set(['.git', 'node_modules']);
const TAIL = 2000;

function tail(s) {
  return s.length > TAIL ? '…' + s.slice(-TAIL) : s;
}

// 셸 명령 실행. 종료코드가 0 이 아니면 단계·표준에러 끝부분을 담아 throw.
function sh(stage, cmd, cwd, log) {
  return new Promise((res, rej) => {
    log?.(`[build] ${stage}: ${cmd}`);
    const p = spawn(cmd, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => rej(Object.assign(new Error(`빌드 단계 실패(${stage}): ${e.message}`), { stage })));
    p.on('close', (code) => {
      if (code === 0) return res({ out, err });
      rej(Object.assign(
        new Error(`빌드 단계 실패(${stage}, 종료코드 ${code}): ${cmd}\n--- stderr 끝부분 ---\n${tail(err || out)}`),
        { stage, code },
      ));
    });
  });
}

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
 * @returns {Promise<string>} dist 절대경로
 */
export async function buildDist({ skylensDir, workDir, log, installCmd, buildCmd = 'npx vite build' }) {
  const src = resolve(skylensDir);
  const work = resolve(workDir);
  if (work === src || work.startsWith(src + sep)) {
    throw new Error(`workDir 는 skylensDir 밖이어야 한다: ${work}`);
  }
  if (!(await stat(src).catch(() => null))?.isDirectory()) {
    throw new Error(`skylensDir 가 디렉터리가 아님: ${src}`);
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
      await sh('install', installCmd, work, log);
    } else {
      try {
        await sh('npm ci', 'npm ci --no-audit --no-fund', work, log);
      } catch (e) {
        log?.(`[build] npm ci 실패, npm install 로 재시도: ${e.message.split('\n')[0]}`);
        await sh('install', 'npm install --no-audit --no-fund', work, log);
      }
    }
  }

  // tsc 는 생략: package.json 의 build 는 `tsc && vite build` 이지만 tsc 는 타입 검사일 뿐
  // 번들 내용에 영향이 없고(vite 는 자체적으로 TS 를 트랜스파일), 타입 오류는 측정 대상이 아니다.
  await sh('build', buildCmd, work, log);

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
