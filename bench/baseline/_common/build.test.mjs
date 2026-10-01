import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readdir, readFile, stat, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { buildDist } from './build.mjs';

// 트리 해시(.git·node_modules 제외): 경로와 내용 모두 포함.
async function hashTree(dir) {
  const h = createHash('sha256');
  async function walk(d) {
    for (const e of (await readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) { h.update('D:' + p + '\n'); await walk(p); }
      else { h.update('F:' + p + '\n'); h.update(await readFile(p)); }
    }
  }
  await walk(dir);
  return h.digest('hex');
}

async function mockTree() {
  const root = await mkdtemp(join(tmpdir(), 'bd-mock-'));
  const src = join(root, 'src');
  await mkdir(join(src, 'node_modules', 'x'), { recursive: true });
  await mkdir(join(src, '.git'), { recursive: true });
  await writeFile(join(src, 'package.json'), '{"name":"m","private":true}');
  await writeFile(join(src, 'index.html'), '<!doctype html><title>m</title>');
  await writeFile(join(src, 'node_modules', 'x', 'a.js'), '1');
  await writeFile(join(src, '.git', 'HEAD'), 'ref');
  return { root, src, work: join(root, 'work') };
}

// 모의 빌드 명령: index.html 을 dist 로 복사
const COPY_CMD = `node -e "const f=require('fs');f.mkdirSync('dist');f.copyFileSync('index.html','dist/index.html')"`;

test('복사본에서 빌드하고 dist 경로를 반환, 원본은 변하지 않음, .git·node_modules 제외', async () => {
  const { src, work } = await mockTree();
  const before = await hashTree(src);
  const logs = [];
  const dist = await buildDist({ skylensDir: src, workDir: work, log: (m) => logs.push(m), installCmd: null, buildCmd: COPY_CMD });
  assert.equal(dist, join(work, 'dist'));
  assert.match(await readFile(join(dist, 'index.html'), 'utf8'), /<title>m<\/title>/);
  await assert.rejects(access(join(work, 'node_modules')));
  await assert.rejects(access(join(work, '.git')));
  assert.equal(await hashTree(src), before);
  await assert.rejects(access(join(src, 'dist')));
  assert.ok(logs.length > 0);
});

test('빌드 명령 실패 시 단계와 stderr 끝부분을 담아 throw', async () => {
  const { src, work } = await mockTree();
  await assert.rejects(
    buildDist({ skylensDir: src, workDir: work, installCmd: null, buildCmd: `node -e "console.error('boom-xyz');process.exit(3)"` }),
    (e) => e.stage === 'build' && /종료코드 3/.test(e.message) && /boom-xyz/.test(e.message),
  );
});

test('install 단계 실패는 install 단계로 보고', async () => {
  const { src, work } = await mockTree();
  await assert.rejects(
    buildDist({ skylensDir: src, workDir: work, installCmd: `node -e "console.error('no-net');process.exit(1)"`, buildCmd: COPY_CMD }),
    (e) => e.stage === 'install' && /no-net/.test(e.message),
  );
});

test('dist/index.html 이 없으면 verify 오류', async () => {
  const { src, work } = await mockTree();
  await assert.rejects(
    buildDist({ skylensDir: src, workDir: work, installCmd: null, buildCmd: `node -e "require('fs').mkdirSync('dist')"` }),
    /verify.*index\.html/,
  );
});

test('다중 페이지 산출물(dist/res/static/index.html)은 dist 루트로 복사', async () => {
  const { src, work } = await mockTree();
  const cmd = `node -e "const f=require('fs');f.mkdirSync('dist/res/static',{recursive:true});f.copyFileSync('index.html','dist/res/static/index.html')"`;
  const dist = await buildDist({ skylensDir: src, workDir: work, installCmd: null, buildCmd: cmd });
  assert.ok((await stat(join(dist, 'index.html'))).isFile());
});

test('workDir 가 원본 안이면 거부', async () => {
  const { src } = await mockTree();
  await assert.rejects(buildDist({ skylensDir: src, workDir: join(src, 'w'), installCmd: null, buildCmd: COPY_CMD }), /포함하면 안/);
});

test('존재하지 않는 skylensDir 는 거부', async () => {
  await assert.rejects(buildDist({ skylensDir: '/nonexistent-xyz', workDir: join(tmpdir(), 'bd-x'), installCmd: null }), /디렉터리가 아님/);
});

test('workDir 가 원본을 포함하면 거부하고 원본 파일을 보존', async () => {
  const { root, src } = await mockTree();
  await assert.rejects(buildDist({ skylensDir: src, workDir: root, installCmd: null, buildCmd: COPY_CMD }), /포함하면 안/);
  assert.equal(await readFile(join(src, 'index.html'), 'utf8'), '<!doctype html><title>m</title>');
});

test('workDir 가 원본과 같거나 심볼릭 링크로 원본을 가리켜도 거부, 원본 보존', async () => {
  const { root, src } = await mockTree();
  await assert.rejects(buildDist({ skylensDir: src, workDir: src, installCmd: null, buildCmd: COPY_CMD }), /포함하면 안/);
  const link = join(root, 'link');
  await symlink(src, link);
  await assert.rejects(buildDist({ skylensDir: src, workDir: join(link, 'w'), installCmd: null, buildCmd: COPY_CMD }), /포함하면 안/);
  await assert.rejects(buildDist({ skylensDir: link, workDir: src, installCmd: null, buildCmd: COPY_CMD }), /포함하면 안/);
  assert.ok((await stat(join(src, 'index.html'))).isFile());
});

test('build 단계 타임아웃: stage timeout 으로 throw, sleep 프로세스 그룹 정리', async () => {
  const { src, work } = await mockTree();
  const t0 = Date.now();
  await assert.rejects(
    buildDist({ skylensDir: src, workDir: work, installCmd: null, buildCmd: 'sleep 30 & sleep 31; echo x', stepTimeoutMs: 400 }),
    (e) => e.stage === 'timeout' && e.failedStage === 'build',
  );
  assert.ok(Date.now() - t0 < 10000);
  // 종료된 자식이 init 에 의해 회수될 때까지 잠시 기다린다.
  let left = '';
  for (let i = 0; i < 40; i++) {
    left = spawnSync('pgrep', ['-x', 'sleep']).stdout.toString().trim();
    if (!left) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(left, '');
});

test('install 단계 타임아웃도 timeout', async () => {
  const { src, work } = await mockTree();
  await assert.rejects(
    buildDist({ skylensDir: src, workDir: work, installCmd: 'sleep 31', buildCmd: COPY_CMD, stepTimeoutMs: 300 }),
    (e) => e.stage === 'timeout' && e.failedStage === 'install',
  );
});

// 실제 트리 빌드: SKYLENS_BUILD=1 일 때만 (네트워크·수 분 소요)
test('실제 skylens 트리 빌드', { skip: process.env.SKYLENS_BUILD !== '1', timeout: 600000 }, async () => {
  const src = process.env.SKYLENS_DIR || '/tmp/skylens';
  const work = await mkdtemp(join(tmpdir(), 'bd-real-'));
  const before = await hashTree(src);
  const t0 = Date.now();
  const dist = await buildDist({ skylensDir: src, workDir: join(work, 'w'), log: console.log });
  console.log(`빌드 소요: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  assert.ok((await stat(join(dist, 'index.html'))).size > 0);
  assert.ok((await readdir(join(dist, 'assets'))).length > 0);
  assert.equal(await hashTree(src), before);
});
