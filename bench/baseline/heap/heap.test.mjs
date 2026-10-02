import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { assertRecords } from '../../../contracts/metrics/index.mjs';
import { median, run, processTreeRss, processTreeMemory, parsePss, memoryMethodText, systemPageSize } from './index.mjs';
import { unavailableReason, DEVICE } from '../_common/browser.mjs';

// 테스트가 만든 임시 디렉터리는 파일 끝에서 모두 지운다(실행마다 tmp 에 쌓이지 않게).
const made = [];
const track = (d) => { made.push(d); return d; };
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

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
const HOLD = '<!doctype html><canvas id=status-view width=100 height=100></canvas><script>window.keep=new Float32Array(26214400).fill(1.5);const g=document.getElementById("status-view").getContext("2d");g.fillStyle="#000";g.fillRect(0,0,100,100);g.fillStyle="#fff";g.fillRect(0,0,50,50)</script>';
const BLANK = HOLD.replace('new Float32Array(26214400).fill(1.5)', '[]');

async function measure(html) {
  const dist = track(await mkdtemp(join(tmpdir(), 'heap-')));
  await mkdir(join(dist, 'res/static'), { recursive: true });
  await writeFile(join(dist, 'res/static/status.html'), html);
  const recs = await run({ commit: 'abcdef1', inputs: { distDir: dist }, runs: 5, timeoutMs: 15000 });
  assertRecords(recs);
  return Object.fromEntries(recs.map((r) => [r.metric, r]));
}

test('브라우저: 100 MiB Float32Array 픽스처는 빈 페이지 대비 프로세스 트리 PSS 합이 90 MiB 이상 늘고, JS 힙은 힙 밖이라 작다', { skip: reason ?? false }, async () => {
  // 두 픽스처를 동시에 재서 같은 시점의 시스템 상태(다른 chromium 이 공유 페이지를 나눠 갖는 정도)를 맞춘다.
  const [hold, blank] = await Promise.all([measure(HOLD), measure(BLANK)]);
  assert.deepEqual(Object.keys(hold).sort(), ['heap.js_used', 'heap.process_pss']);
  // 메모리 합은 공유 페이지 중복을 피하려 PSS 를 쓰고, 그 사용 여부가 method 에 기록된다(smaps_rollup 을 읽을 수 없으면 RSS 폴백이 기록된다).
  const pssReadable = existsSync(`/proc/${process.pid}/smaps_rollup`);
  assert.match(hold['heap.process_pss'].method, pssReadable ? /PSS 사용.*smaps_rollup/ : /PSS 미사용.*RSS/);
  assert.equal(hold['heap.js_used'].unit, 'B');
  assert.equal(hold['heap.js_used'].device, DEVICE);
  assert.equal(hold['heap.js_used'].samples.length, 5);
  // 빈 페이지도 브라우저 기저 메모리가 수백 MiB 라 절대값은 무의미하다. 같은 브라우저의 빈 페이지 대비 증가분으로 판정한다.
  // 페이지 메모리는 렌더러 자식 프로세스에 있으므로 루트 프로세스만 세면 증가분이 거의 0 이 되어 실패한다.
  // PSS 합 절대값은 같은 머신의 다른 chromium 이 도는 정도에 따라 약 80 MiB 씩 수준이 바뀔 수 있어(공유 라이브러리 페이지를 나눠 셈; 80 MiB 는 이전 노트의 미검증 추정치이지 측정값이 아니다) 시점이 다른 두 측정을 비교하면 흔들릴 수 있다.
  // 그래서 위에서 두 측정을 동시에 돌리고, 워밍업 1회를 버린 보고값(중앙값)끼리 뺀다.
  const delta = hold['heap.process_pss'].value - blank['heap.process_pss'].value; // 워밍업을 버린 보고값(중앙값)끼리 비교
  // 문턱 근거: 픽스처는 정확히 100 MiB 를 상주시키므로 이론 증가분은 100 MiB 이고, 측정 증가분은 RSS 합 기준 실측 98.5~107.0 MiB, PSS 합 기준 반복 12회에서 약 99~106 MiB 였다(과거 실측 수치이며 집계 방식은 기록돼 있지 않다. 실제 판정은 아래 delta, 곧 보고값(중앙값)의 차이다). 문턱 90 MiB 와의 여유는 약 9~17 MiB 다.
  // 90 MiB 는 100 MiB 의 90%로, 빈 페이지 대비 렌더러 기저 메모리 편차(수 MiB)와 중앙값 잡음을 흡수하되
  // 상주가 빠지면(증가분 약 0) 확실히 실패하는 값이다. 측정값에 맞춰 낮추지 않는다.
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
  // 합산(tree)이 Pss 이므로 루트도 Pss 로 맞춘다(파일 페이지 공유로 Pss < RSS).
  const rootOnly = parsePss(readFileSync(`/proc/${proc.pid}/smaps_rollup`, 'utf8')) ?? Number(readFileSync(`/proc/${proc.pid}/statm`, 'utf8').split(' ')[1]) * systemPageSize();
  const tree = processTreeRss(tag);
  assert.ok(rootOnly < 60 * MIB, `root ${rootOnly}`);
  assert.ok(tree - rootOnly >= 100 * MIB, `tree ${tree} root ${rootOnly}`);
});

test('run: entryPath 파일이 dist 에 없으면 throw', async () => {
  const dist = track(await mkdtemp(join(tmpdir(), 'heap-')));
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

test('run: 선택 입력 키 이름이 틀리면(entrypath, canvas_selector) 기본값으로 가지 않고 거부', async () => {
  await assert.rejects(() => run({ commit: 'abcdef1', inputs: { distDir: '/x', entrypath: '/a.html' } }), /알 수 없는 inputs 키 'entrypath'/);
  await assert.rejects(() => run({ commit: 'abcdef1', inputs: { distDir: '/x', canvas_selector: '#a' } }), /canvasSelector/);
});

test('parsePss: smaps_rollup 의 Pss(kB)를 바이트로, 없으면 null', () => {
  assert.equal(parsePss('Rss:   2000 kB\nPss:   1234 kB\nPss_Anon: 99 kB\n'), 1234 * 1024);
  assert.equal(parsePss('Rss: 2000 kB\n'), null);
  assert.equal(parsePss(''), null);
});

test('memoryMethodText: PSS 사용·폴백·혼합을 구분해 기록', () => {
  assert.match(memoryMethodText({ pssProcs: 4, rssProcs: 0 }), /^PSS 사용/);
  assert.match(memoryMethodText({ pssProcs: 0, rssProcs: 3 }), /^PSS 미사용.*RSS/);
  assert.match(memoryMethodText({ pssProcs: 2, rssProcs: 1 }), /^경고: PSS·RSS 방식이 섞임/);
  assert.equal(memoryMethodText({ pssProcs: 0, rssProcs: 0 }), null); // 센 프로세스가 0개면 기록 생략 신호
});

// 가짜 /proc: 태그를 명령행에 가진 루트(pid 100)와 자식(pid 101). readable 이 true 면 statm 이 있고, false 면 smaps_rollup·statm 둘 다 없다(읽을 수 없는 프로세스).
async function fakeProc(tag, readable) {
  const root = track(await mkdtemp(join(tmpdir(), 'proc-')));
  for (const [pid, ppid] of [['100', '1'], ['101', '100']]) {
    await mkdir(join(root, pid));
    await writeFile(join(root, pid, 'stat'), `${pid} (chromium) S ${ppid} 0 0 0`);
    await writeFile(join(root, pid, 'cmdline'), `chromium\0${tag}\0`);
    if (readable) await writeFile(join(root, pid, 'statm'), '100 50 10 0 0 0 0');
  }
  return root;
}

test('processTreeMemory: smaps·statm 을 읽을 수 없는 프로세스만 있으면 0 B 값이 아니라 null', async () => {
  const tag = `--no-read-${randomUUID()}`;
  assert.equal(processTreeMemory(tag, { procRoot: await fakeProc(tag, false) }), null);
  // 대조: 같은 구조에서 statm 이 읽히면 RSS 폴백으로 센다(위 null 이 구조 오류 때문이 아님).
  const m = processTreeMemory(tag, { procRoot: await fakeProc(tag, true) });
  assert.deepEqual(m, { bytes: 2 * 50 * systemPageSize(), pssProcs: 0, rssProcs: 2 });
  assert.equal(processTreeMemory(`--no-such-tag-${randomUUID()}`, { procRoot: await fakeProc(tag, true) }), null);
});

// 브라우저 없이 run 의 기록 구성만 본다: 브라우저 실행·1회 측정은 주입하고 메모리 읽기는 가짜 /proc 으로 한다.
async function runWithProc(readable) {
  const dist = track(await mkdtemp(join(tmpdir(), 'heap-')));
  await mkdir(join(dist, 'res/static'), { recursive: true });
  await writeFile(join(dist, 'res/static/status.html'), '<p>x</p>');
  const deps = {
    launch: async () => ({ close: async () => {} }),
    measureOnce: async (_b, _u, tag, _t, _s, readMemory) => ({ js: 1234, mem: readMemory(tag) }),
    readMemory: (tag) => { const procRoot = track(mkdtempSync(join(tmpdir(), 'proc-'))); for (const [pid, ppid] of [['100', '1']]) { mkdirSync(join(procRoot, pid)); writeFileSync(join(procRoot, pid, 'stat'), `${pid} (c) S ${ppid} 0`); writeFileSync(join(procRoot, pid, 'cmdline'), tag); if (readable) writeFileSync(join(procRoot, pid, 'statm'), '100 50 10'); } return processTreeMemory(tag, { procRoot }); },
  };
  return run({ commit: 'abcdef1', inputs: { distDir: dist }, runs: 3, deps });
}

test('run: 센 프로세스가 0개면 heap.process_pss 기록 없이 js_used 만 낸다', async () => {
  const recs = await runWithProc(false);
  assert.deepEqual(recs.map((r) => r.metric), ['heap.js_used']);
  assert.equal(recs.some((r) => r.metric === 'heap.process_pss'), false);
});

test('run: 대조 — 읽을 수 있는 프로세스가 있으면 heap.process_pss 가 기록된다', async () => {
  const recs = await runWithProc(true);
  assert.deepEqual(recs.map((r) => r.metric), ['heap.js_used', 'heap.process_pss']);
  assert.equal(recs[1].value, 50 * systemPageSize());
});

test('systemPageSize: 양의 2의 거듭제곱(getconf PAGESIZE)', () => {
  const n = systemPageSize();
  assert.ok(Number.isInteger(n) && n >= 4096 && (n & (n - 1)) === 0, `page ${n}`);
});

test('processTreeMemory: smaps 를 읽을 수 없고 statm 이 깨졌으면(1 abc) NaN 을 합산하지 않고 null', () => {
  const tag = `--tag-${randomUUID()}`;
  const procRoot = track(mkdtempSync(join(tmpdir(), 'proc-garbled-')));
  mkdirSync(join(procRoot, '100'));
  writeFileSync(join(procRoot, '100', 'stat'), '100 (c) S 1 0');
  writeFileSync(join(procRoot, '100', 'cmdline'), tag);
  writeFileSync(join(procRoot, '100', 'statm'), '1 abc');
  const m = processTreeMemory(tag, { procRoot });
  assert.equal(m, null);
});

test('processTreeMemory: statm 이 음수(1 -5)면 −20480 B 를 만들지 않고 그 프로세스를 제외 → null', () => {
  const tag = `--tag-${randomUUID()}`;
  const procRoot = track(mkdtempSync(join(tmpdir(), 'proc-negative-')));
  mkdirSync(join(procRoot, '100'));
  writeFileSync(join(procRoot, '100', 'stat'), '100 (c) S 1 0');
  writeFileSync(join(procRoot, '100', 'cmdline'), tag);
  writeFileSync(join(procRoot, '100', 'statm'), '1 -5');
  assert.equal(processTreeMemory(tag, { procRoot }), null);
});

test('processTreeMemory: 정상 statm 프로세스 하나 + 깨진 하나 → 깨진 쪽만 건너뛰고 rssProcs 1·bytes 유한', () => {
  const tag = `--tag-${randomUUID()}`;
  const procRoot = track(mkdtempSync(join(tmpdir(), 'proc-mixed-')));
  for (const [pid, ppid, statm] of [['100', '1', '100 50 10'], ['101', '100', '1 abc']]) {
    mkdirSync(join(procRoot, pid));
    writeFileSync(join(procRoot, pid, 'stat'), `${pid} (c) S ${ppid} 0`);
    writeFileSync(join(procRoot, pid, 'cmdline'), pid === '100' ? tag : 'child');
    writeFileSync(join(procRoot, pid, 'statm'), statm);
  }
  const m = processTreeMemory(tag, { procRoot });
  assert.equal(m.rssProcs, 1);
  assert.equal(m.pssProcs, 0);
  assert.equal(m.bytes, 50 * systemPageSize());
});

test('processTreeMemory: statm 이 연속 공백(100  5)이어도 trim·split(/\\s+/)로 올바르게 파싱', () => {
  const tag = `--tag-${randomUUID()}`;
  const procRoot = track(mkdtempSync(join(tmpdir(), 'proc-double-space-')));
  mkdirSync(join(procRoot, '100'));
  writeFileSync(join(procRoot, '100', 'stat'), '100 (c) S 1 0');
  writeFileSync(join(procRoot, '100', 'cmdline'), tag);
  writeFileSync(join(procRoot, '100', 'statm'), '100  5');
  const m = processTreeMemory(tag, { procRoot });
  assert.deepEqual(m, { bytes: 5 * systemPageSize(), pssProcs: 0, rssProcs: 1 });
});

test('processTreeMemory: statm 이 앞공백을 가지면( 100 5) trim 으로 처리해 올바르게 파싱', () => {
  const tag = `--tag-${randomUUID()}`;
  const procRoot = track(mkdtempSync(join(tmpdir(), 'proc-leading-space-')));
  mkdirSync(join(procRoot, '100'));
  writeFileSync(join(procRoot, '100', 'stat'), '100 (c) S 1 0');
  writeFileSync(join(procRoot, '100', 'cmdline'), tag);
  writeFileSync(join(procRoot, '100', 'statm'), ' 100 5');
  const m = processTreeMemory(tag, { procRoot });
  assert.deepEqual(m, { bytes: 5 * systemPageSize(), pssProcs: 0, rssProcs: 1 });
});

test('processTreeMemory: statm 두 번째 필드가 과학 표기법(1 1e3)이면 정규식 검사로 제외', () => {
  const tag = `--tag-${randomUUID()}`;
  const procRoot = track(mkdtempSync(join(tmpdir(), 'proc-scientific-')));
  mkdirSync(join(procRoot, '100'));
  writeFileSync(join(procRoot, '100', 'stat'), '100 (c) S 1 0');
  writeFileSync(join(procRoot, '100', 'cmdline'), tag);
  writeFileSync(join(procRoot, '100', 'statm'), '1 1e3');
  const m = processTreeMemory(tag, { procRoot });
  assert.equal(m, null);
});

test('processTreeMemory: statm 두 번째 필드가 16진수(1 0x10)이면 정규식 검사로 제외', () => {
  const tag = `--tag-${randomUUID()}`;
  const procRoot = track(mkdtempSync(join(tmpdir(), 'proc-hex-')));
  mkdirSync(join(procRoot, '100'));
  writeFileSync(join(procRoot, '100', 'stat'), '100 (c) S 1 0');
  writeFileSync(join(procRoot, '100', 'cmdline'), tag);
  writeFileSync(join(procRoot, '100', 'statm'), '1 0x10');
  const m = processTreeMemory(tag, { procRoot });
  assert.equal(m, null);
});

test('processTreeMemory: statm 두 번째 필드가 소수(1 5.5)이면 정규식 검사로 제외', () => {
  const tag = `--tag-${randomUUID()}`;
  const procRoot = track(mkdtempSync(join(tmpdir(), 'proc-decimal-')));
  mkdirSync(join(procRoot, '100'));
  writeFileSync(join(procRoot, '100', 'stat'), '100 (c) S 1 0');
  writeFileSync(join(procRoot, '100', 'cmdline'), tag);
  writeFileSync(join(procRoot, '100', 'statm'), '1 5.5');
  const m = processTreeMemory(tag, { procRoot });
  assert.equal(m, null);
});

test('processTreeMemory: statm 두 번째 필드가 양수 기호(1 +5)이면 정규식 검사로 제외', () => {
  const tag = `--tag-${randomUUID()}`;
  const procRoot = track(mkdtempSync(join(tmpdir(), 'proc-positive-sign-')));
  mkdirSync(join(procRoot, '100'));
  writeFileSync(join(procRoot, '100', 'stat'), '100 (c) S 1 0');
  writeFileSync(join(procRoot, '100', 'cmdline'), tag);
  writeFileSync(join(procRoot, '100', 'statm'), '1 +5');
  const m = processTreeMemory(tag, { procRoot });
  assert.equal(m, null);
});

test('processTreeMemory: statm 두 번째 필드가 매우 크면(900000000000000000) unsafe 정수라 제외', () => {
  const tag = `--tag-${randomUUID()}`;
  const procRoot = track(mkdtempSync(join(tmpdir(), 'proc-large-')));
  mkdirSync(join(procRoot, '100'));
  writeFileSync(join(procRoot, '100', 'stat'), '100 (c) S 1 0');
  writeFileSync(join(procRoot, '100', 'cmdline'), tag);
  writeFileSync(join(procRoot, '100', 'statm'), '1 900000000000000000');
  const m = processTreeMemory(tag, { procRoot });
  assert.equal(m, null);
});

test('processTreeMemory: 정상 statm + 음수 statm 혼합 → 음수는 제외, 정상만 센다', () => {
  const tag = `--tag-${randomUUID()}`;
  const procRoot = track(mkdtempSync(join(tmpdir(), 'proc-mixed-normal-negative-')));
  for (const [pid, ppid, statm] of [['100', '1', '100 50 10'], ['101', '100', '1 -5']]) {
    mkdirSync(join(procRoot, pid));
    writeFileSync(join(procRoot, pid, 'stat'), `${pid} (c) S ${ppid} 0`);
    writeFileSync(join(procRoot, pid, 'cmdline'), pid === '100' ? tag : 'child');
    writeFileSync(join(procRoot, pid, 'statm'), statm);
  }
  const m = processTreeMemory(tag, { procRoot });
  assert.equal(m.rssProcs, 1, 'only normal process counted');
  assert.equal(m.bytes, 50 * systemPageSize(), 'bytes from normal process only');
});

test('processTreeMemory: 정상 + 0 RSS 혼합 → 0 RSS 도 유효해서 세어진다', () => {
  const tag = `--tag-${randomUUID()}`;
  const procRoot = track(mkdtempSync(join(tmpdir(), 'proc-normal-zero-')));
  for (const [pid, ppid, statm] of [['100', '1', '100 50 10'], ['101', '100', '1 0']]) {
    mkdirSync(join(procRoot, pid));
    writeFileSync(join(procRoot, pid, 'stat'), `${pid} (c) S ${ppid} 0`);
    writeFileSync(join(procRoot, pid, 'cmdline'), pid === '100' ? tag : 'child');
    writeFileSync(join(procRoot, pid, 'statm'), statm);
  }
  const m = processTreeMemory(tag, { procRoot });
  assert.equal(m.rssProcs, 2, 'both processes counted including zero RSS');
  assert.equal(m.bytes, 50 * systemPageSize(), 'bytes = 50 (from first) + 0 (from second)');
});

test('processTreeMemory: 합산 뒤 unsafe 정수면(두 개 매우 큰 RSS) null 반환', () => {
  const tag = `--tag-${randomUUID()}`;
  const procRoot = track(mkdtempSync(join(tmpdir(), 'proc-sum-unsafe-')));
  const page = systemPageSize();
  const rssValue = '2000000000000';
  for (const [pid, ppid] of [['100', '1'], ['101', '100']]) {
    mkdirSync(join(procRoot, pid));
    writeFileSync(join(procRoot, pid, 'stat'), `${pid} (c) S ${ppid} 0`);
    writeFileSync(join(procRoot, pid, 'cmdline'), tag);
    writeFileSync(join(procRoot, pid, 'statm'), `1 ${rssValue}`);
  }
  const m = processTreeMemory(tag, { procRoot });
  const singleRss = Number(rssValue) * page;
  const totalRss = 2 * singleRss;
  assert.ok(Number.isSafeInteger(singleRss), `single RSS ${singleRss} should be safe`);
  assert.ok(!Number.isSafeInteger(totalRss), `total RSS ${totalRss} should be unsafe`);
  assert.equal(m, null, 'should return null when sum overflows');
});

test('processTreeMemory: 정상 RSS + unsafe RSS(대조: continue 이면 정상 RSS만 세어진다)', () => {
  const tag = `--tag-${randomUUID()}`;
  const procRoot = track(mkdtempSync(join(tmpdir(), 'proc-mixed-normal-unsafe-')));
  for (const [pid, ppid, statm] of [['100', '1', '100 50 10'], ['101', '100', '1 900000000000000000']]) {
    mkdirSync(join(procRoot, pid));
    writeFileSync(join(procRoot, pid, 'stat'), `${pid} (c) S ${ppid} 0`);
    writeFileSync(join(procRoot, pid, 'cmdline'), pid === '100' ? tag : 'child');
    writeFileSync(join(procRoot, pid, 'statm'), statm);
  }
  const m = processTreeMemory(tag, { procRoot });
  assert.equal(m.rssProcs, 1, 'only normal process counted (unsafe skipped by continue)');
  assert.equal(m.bytes, 50 * systemPageSize(), 'bytes from normal process only');
});

test('processTreeMemory: 정상 + unsafe RSS + 0 RSS 혼합 → unsafe는 제외, 정상·0은 세어진다', () => {
  const tag = `--tag-${randomUUID()}`;
  const procRoot = track(mkdtempSync(join(tmpdir(), 'proc-mixed-normal-unsafe-zero-')));
  for (const [pid, ppid, statm] of [['100', '1', '100 50 10'], ['101', '100', '1 900000000000000000'], ['102', '100', '1 0']]) {
    mkdirSync(join(procRoot, pid));
    writeFileSync(join(procRoot, pid, 'stat'), `${pid} (c) S ${ppid} 0`);
    writeFileSync(join(procRoot, pid, 'cmdline'), pid === '100' ? tag : 'child');
    writeFileSync(join(procRoot, pid, 'statm'), statm);
  }
  const m = processTreeMemory(tag, { procRoot });
  assert.equal(m.rssProcs, 2, 'normal process and zero RSS counted, unsafe skipped');
  assert.equal(m.bytes, 50 * systemPageSize(), 'bytes = 50 (normal) + 0 (zero)');
});
