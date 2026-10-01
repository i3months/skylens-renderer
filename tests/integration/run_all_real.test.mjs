// run_all 을 modulesDir 없이(실제 8개 모듈) 합성 입력으로 CLI 를 통해 돌리는 통합 테스트.
// 입력은 run_all CLI 의 플래그(--points, --ws-recording, --tower-recording, --dist-dir, --anchor-*)와
// skylens 기본 자산 배치(<skylensDir>/res/static/demo/segments)로만 준다. 모듈이 읽는 inputs 키 이름이
// 바뀌면 해당 모듈이 입력 누락으로 실패해 이 테스트가 깨진다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { MODULES } from '../../bench/baseline/run_all/index.mjs';
import { unavailableReason } from '../../bench/baseline/_common/browser.mjs';
import { STEP_LEVEL } from '../../contracts/inputs/index.mjs';
import { encodeSplatPly, syntheticScene } from '../../bench/baseline/ref_images/testing.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'bench', 'baseline', 'run_all', 'cli.mjs');
const VIEWPOINTS = JSON.parse(await readFile(join(ROOT, 'fixtures', 'viewpoints', 'viewpoints.json'), 'utf8'));
const COMMIT = 'abc1234';
const BROWSER_MODULES = ['first_frame', 'heap'];

// 브라우저 모듈은 chromium 을 찾을 수 있을 때만 포함한다(탐색 경로는 browser.mjs 가 환경 변수로 결정).
const browserReason = await unavailableReason();
if (browserReason) console.log(`# 브라우저 모듈(${BROWSER_MODULES.join(', ')}) 제외 사유: ${browserReason}`);

// 기준값: 합성 입력에서 성공해야 하는 모듈 수.
const EXPECTED_OK = browserReason ? 6 : 8;
const EXPECTED_SKIPPED = browserReason ? BROWSER_MODULES : [];

// 입력 키 누락·키 이름 불일치를 나타내는 오류 문구.
const INPUT_KEY_ERROR = /input missing|inputs\.\w+|distDir|pointsPath|wsRecording|towerRecording|anchor/i;

let root;
let outDir;
let baseArgs;
let result;

function ply(n, scale) {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push({ p: [i * scale, 0, -i], rgb: [i % 256, 100, 50] });
  return encodeSplatPly(pts);
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'run_all_real-'));
  const skylensDir = join(root, 'skylens');
  const dist = join(root, 'dist');
  const segDir = join(skylensDir, 'res', 'static', 'demo', 'segments');
  await mkdir(segDir, { recursive: true });
  await mkdir(join(dist, 'res', 'static'), { recursive: true });
  await mkdir(join(dist, 'assets'), { recursive: true });

  // 자산: 구간 2개 x 4수준 (점 수는 수준마다 4배씩)
  const steps = Object.keys(STEP_LEVEL).map(Number);
  for (const seg of [1, 2]) {
    for (const step of steps) {
      const n = 8 * 4 ** STEP_LEVEL[step];
      await writeFile(join(segDir, `seg${seg}_step${String(step).padStart(5, '0')}.ply`), ply(n, seg));
    }
  }

  // 점군(ref_images): 앵커 좌표계 장면에 걸치는 합성 점군
  await writeFile(join(root, 'points.ply'), encodeSplatPly(syntheticScene()));

  // ws 녹화: 첫 프레임 + 구간 2개 x 4수준
  const ws = [{ t_ms: 0, dir: 'tx', bytes: 100, kind: 'hello' }, { t_ms: 100, dir: 'rx', bytes: 300, kind: 'first_frame' }];
  let t = 200;
  for (const level of [0, 1, 2, 3]) {
    for (const segment of [5, 9]) ws.push({ t_ms: (t += 350), dir: 'rx', bytes: 1000 * 4 ** level, kind: 'points', segment, level });
  }
  await writeFile(join(root, 'ws.jsonl'), ws.map((f) => JSON.stringify(f)).join('\n') + '\n');

  // 관제탑 녹화
  const feat = (id) => ({ type: 'Feature', id, properties: {}, geometry: null });
  const tower = [
    { url: 'b1', kind: 'building', status: 200, bytes: 5000, body: { type: 'FeatureCollection', features: [feat('a'), feat('b')] } },
    { url: 'b2', kind: 'building', status: 200, bytes: 3000, body: { type: 'FeatureCollection', features: [feat('b'), feat('c')] } },
    { url: 'd1', kind: 'dem', status: 200, bytes: 20000 },
    { url: 'i1', kind: 'imagery', status: 200, bytes: 70000 },
    { url: 'o1', kind: 'other', status: 200, bytes: 400 },
  ];
  await writeFile(join(root, 'tower.jsonl'), tower.map((e) => JSON.stringify(e)).join('\n') + '\n');

  // 미니 dist: 두 진입 HTML 이 공유 청크를 정적 import 한다. 상황판은 캔버스에 그린다(브라우저 모듈용).
  await writeFile(join(dist, 'res', 'static', 'status.html'),
    '<!doctype html><html><body><canvas id="view2" width="200" height="200"></canvas><script type="module" src="/assets/status.js"></script></body></html>\n');
  await writeFile(join(dist, 'res', 'static', 'control.html'),
    '<!doctype html><html><body><script type="module" src="/assets/control.js"></script></body></html>\n');
  await writeFile(join(dist, 'assets', 'shared.js'), 'export const shared = "x".repeat(2000);\n');
  await writeFile(join(dist, 'assets', 'control.js'), 'import { shared } from "./shared.js";\nwindow.__control = shared.length;\n');
  await writeFile(join(dist, 'assets', 'status.js'),
    'import { shared } from "./shared.js";\nconst g = document.getElementById("view2").getContext("2d");\ng.fillStyle = "#000";\ng.fillRect(0, 0, 200, 200);\ng.fillStyle = "#fff";\ng.fillRect(0, 0, 120, 120);\nwindow.__status = shared.length;\n');

  outDir = join(root, 'out');
  const a = VIEWPOINTS.anchor;
  const args = [
    CLI, '--skylens-dir', skylensDir, '--out', outDir, '--commit', COMMIT,
    '--points', join(root, 'points.ply'),
    '--ws-recording', join(root, 'ws.jsonl'),
    '--tower-recording', join(root, 'tower.jsonl'),
    '--dist-dir', dist,
    '--anchor-lat', String(a.lat), '--anchor-lon', String(a.lon), '--anchor-alt', String(a.alt),
  ];
  baseArgs = [...args];
  if (browserReason) args.push('--skip', BROWSER_MODULES.join(','));
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 300000 });
  const summary = JSON.parse(await readFile(join(outDir, 'summary.json'), 'utf8'));
  const records = JSON.parse(await readFile(join(outDir, 'records.json'), 'utf8'));
  result = { r, summary, records };
});

after(() => root && rm(root, { recursive: true, force: true }));

test('실제 8개 모듈 이름이 모두 summary 에 하나의 상태로 나타난다', () => {
  assert.equal(MODULES.length, 8);
  const { summary } = result;
  const seen = [...summary.ok.map((m) => m.module), ...summary.failed.map((m) => m.module), ...summary.skipped];
  assert.deepEqual([...seen].sort(), [...MODULES].sort());
  assert.deepEqual(summary.skipped, EXPECTED_SKIPPED);
});

test('실패한 모듈이 있어도 그 이유는 입력 키 누락·불일치가 아니다', () => {
  for (const f of result.summary.failed) {
    assert.doesNotMatch(f.error, INPUT_KEY_ERROR, `${f.module} (${f.stage}): ${f.error}`);
    assert.equal(f.stage, 'run', `${f.module}: ${f.error}`);
  }
});

test(`합성 입력에서 성공한 모듈 수는 ${EXPECTED_OK}개`, () => {
  const { summary, r } = result;
  assert.equal(summary.ok.length, EXPECTED_OK, `${JSON.stringify(summary.failed)}\n${r.stderr}`);
  assert.equal(r.status, 0, r.stderr);
});

test('성공한 모듈의 레코드가 records.json 에 모듈 이름 접두로 존재한다', () => {
  const { summary, records } = result;
  for (const { module: name, records: n } of summary.ok) {
    assert.ok(n > 0, name);
    assert.ok(records.some((x) => x.metric.startsWith(`${name}.`)), `${name} 레코드 없음`);
  }
  const names = new Set(records.map((x) => x.metric.split('.')[0]));
  for (const name of MODULES.filter((m) => !EXPECTED_SKIPPED.includes(m))) assert.ok(names.has(name), name);
});

test('합성 입력의 알려진 값이 레코드에 반영된다', () => {
  const val = (m) => result.records.find((x) => x.metric === m)?.value;
  // tower: 건물 id a,b,c 중복 제거 -> 3, 총 요청 5
  assert.equal(val('tower_bytes.building_count'), 3);
  assert.equal(val('tower_bytes.request_count'), 5);
  assert.equal(val('tower_bytes.total_bytes'), 98400);
  // ws: 첫 프레임까지 100 + 300
  assert.equal(val('ws_bytes.initial'), 400);
  assert.equal(val('ws_bytes.frames'), 10);
  // 자산: 점 수 합 (8+32+128+512) x 2 구간
  assert.equal(val('asset_bytes.points_total'), 1360);
  // dist: 진입 폐포 파일 존재
  assert.ok(val('bundle_status.gzip_bytes') > 0);
  assert.ok(val('bundle_tower.gzip_bytes') > 0);
  // ref_images: 시점마다 찍힌 픽셀 지표
  for (const vp of VIEWPOINTS.viewpoints) assert.ok(val(`ref_images.drawn_pixels.v${vp.id}`) > 0, `v${vp.id}`);
});

test('선택 입력 entryPath 키 이름이 바뀌면 브라우저 모듈이 이를 알아채지 못해 이 테스트가 깨진다', { skip: browserReason || false }, async () => {
  // 존재하지 않는 진입 경로를 CLI 로 주면 모듈은 그 경로를 문제 삼으며 실패해야 한다.
  // 모듈이 다른 키 이름을 읽으면 기본 상황판으로 조용히 성공해 아래 단언이 깨진다.
  const missing = '/res/static/no_such_entry.html';
  const out2 = join(root, 'out-entry');
  const r = spawnSync(process.execPath, [...baseArgs.map((x) => (x === outDir ? out2 : x)), '--only', BROWSER_MODULES.join(','), '--entry-path', missing], { encoding: 'utf8', timeout: 120000 });
  const summary = JSON.parse(await readFile(join(out2, 'summary.json'), 'utf8'));
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(summary.failed.map((f) => f.module).sort(), [...BROWSER_MODULES].sort(), JSON.stringify(summary));
  for (const f of summary.failed) assert.ok(f.error.includes(missing), `${f.module}: ${f.error}`);
});
