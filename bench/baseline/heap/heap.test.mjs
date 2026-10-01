import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { assertRecords } from '../../../contracts/metrics/index.mjs';
import { median, run, processTreeRss } from './index.mjs';
import { unavailableReason, DEVICE } from '../_common/browser.mjs';

test('median: 기준 숫자', () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([7]), 7);
  assert.equal(median([9, 1, 5, 100, 2]), 5);
  const input = [3, 1, 2];
  median(input);
  assert.deepEqual(input, [3, 1, 2]); // 입력 불변
  assert.throws(() => median([]));
});

test('run: inputs.distDir 없으면 throw', async () => {
  await assert.rejects(() => run({ commit: 'abcdef1', inputs: {} }), /input missing: distDir/);
});

const reason = await unavailableReason();
if (reason) console.log(`# 브라우저 테스트 skip 사유: ${reason}`);

const MIB = 1024 * 1024;
// 100 MiB Float32Array(26214400 개)를 채워 실제로 상주시킨 뒤 캔버스를 그려 첫 프레임을 낸다.
const HOLD = '<!doctype html><canvas id=c width=100 height=100></canvas><script>window.keep=new Float32Array(26214400).fill(1.5);const g=c.getContext("2d");g.fillStyle="#000";g.fillRect(0,0,100,100);g.fillStyle="#fff";g.fillRect(0,0,50,50)</script>';
const BLANK = HOLD.replace('new Float32Array(26214400).fill(1.5)', '[]');

async function measure(html) {
  const dist = await mkdtemp(join(tmpdir(), 'heap-'));
  await mkdir(join(dist, 'res/static'), { recursive: true });
  await writeFile(join(dist, 'res/static/status.html'), html);
  const recs = await run({ commit: 'abcdef1', inputs: { distDir: dist }, runs: 3, timeoutMs: 15000 });
  assertRecords(recs);
  return Object.fromEntries(recs.map((r) => [r.metric, r]));
}

test('브라우저: 100 MiB Float32Array 픽스처는 빈 페이지 대비 프로세스 트리 RSS 가 90 MiB 이상 늘고, JS 힙은 힙 밖이라 작다', { skip: reason ?? false }, async () => {
  const hold = await measure(HOLD);
  const blank = await measure(BLANK);
  assert.deepEqual(Object.keys(hold).sort(), ['heap.js_used', 'heap.process_rss']);
  assert.equal(hold['heap.js_used'].unit, 'B');
  assert.equal(hold['heap.js_used'].device, DEVICE);
  assert.equal(hold['heap.js_used'].samples.length, 3);
  // 빈 페이지도 브라우저 기저 메모리가 수백 MiB 라 절대값은 무의미하다. 같은 브라우저의 빈 페이지 대비 증가분으로 판정한다.
  // 페이지 메모리는 렌더러 자식 프로세스에 있으므로 루트 프로세스만 세면 증가분이 거의 0 이 되어 실패한다.
  const delta = hold['heap.process_rss'].value - blank['heap.process_rss'].value;
  assert.ok(delta >= 90 * MIB, `delta ${delta}`);
  // TypedArray 는 V8 힙 밖이므로 js_used 는 50 MiB 미만.
  assert.ok(hold['heap.js_used'].value < 50 * MIB, `js ${hold['heap.js_used'].value}`);
});

test('processTreeRss: 자손 프로세스의 메모리까지 합산한다(루트만 세면 실패)', async (t) => {
  if (process.platform !== 'linux') return t.skip('/proc 없음');
  const tag = `--tree-rss-tag=${randomUUID()}`;
  const child = 'const b=Buffer.alloc(120*1024*1024,1);console.log("ready");setInterval(()=>b[0],1000)';
  const parent = `const {spawn}=require("node:child_process");const c=spawn(process.execPath,["-e",${JSON.stringify(child)}],{stdio:["ignore","inherit","inherit"]});setInterval(()=>{},1000)`;
  const proc = spawn(process.execPath, ['-e', parent, '--', tag], { stdio: ['ignore', 'pipe', 'inherit'], detached: true });
  t.after(() => { try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* 이미 종료 */ } });
  await new Promise((resolve, reject) => { proc.once('error', reject); proc.stdout.on('data', (d) => { if (String(d).includes('ready')) resolve(); }); });
  const rootOnly = Number(readFileSync(`/proc/${proc.pid}/statm`, 'utf8').split(' ')[1]) * 4096;
  const tree = processTreeRss(tag);
  assert.ok(rootOnly < 60 * MIB, `root ${rootOnly}`);
  assert.ok(tree - rootOnly >= 100 * MIB, `tree ${tree} root ${rootOnly}`);
});

test('run: entryPath 파일이 dist 에 없으면 throw', async () => {
  const dist = await mkdtemp(join(tmpdir(), 'heap-'));
  await writeFile(join(dist, 'index.html'), '<p>landing</p>');
  await assert.rejects(() => run({ commit: 'abcdef1', inputs: { distDir: dist } }), /entryPath.*\/res\/static\/status\.html/);
});

// 실제 skylens 트리로 도는 선택적 테스트. SKYLENS_DIR 가 있을 때만 실행한다(dist 하위 디렉터리가 있으면 그것을, 없으면 SKYLENS_DIR 자체를 dist 로 쓴다).
const REAL = process.env.SKYLENS_DIR;
const realDist = REAL && existsSync(join(REAL, 'dist')) ? join(REAL, 'dist') : REAL;
test('실제 dist(SKYLENS_DIR): 상황판 js_used 가 양수이고 method 에 entryPath 가 있다', { skip: REAL ? (reason ?? false) : 'SKYLENS_DIR 없음' }, async () => {
  const recs = await run({ commit: 'abcdef1', inputs: { distDir: realDist }, runs: 2, timeoutMs: 30000 });
  assert.ok(recs[0].value > 1024 * 1024, `js ${recs[0].value}`);
  assert.match(recs[0].method, /\/res\/static\/status\.html/);
});
