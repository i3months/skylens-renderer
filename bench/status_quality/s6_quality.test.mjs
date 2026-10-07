// T13.HQ: S6 송출 구성(원본 점 전부, 무손실 codec 1, 솎기·구간 바이트 예산 없음)의 현황판 8시점 SSIM 단언.
// 사람 결정(대역폭 상한 없음, 화질 우선)에 따라 문턱은 SPEC 현황판 수치 0.95 이고, 시드 1..6 모두에 건다.
// 문턱은 이 파일 안의 숫자 리터럴이며 측정값에 맞춰 바꾸지 않는다. 구간 바이트는 출력만 한다(문턱 없음).
// 측정 경로: flat_boxes 시드 1..6·구간당 250만 점(SPEC 규모)·320x180·8시점, 최고 수준(원본 점 전부)을
//   컬링+LOD 선택 → 64 m 타일 조각 → codec 1 → 클라이언트 복호 → CPU 참조 래스터러(WebGL 제외).
// 시드마다 별도 자식 프로세스(tune_cli.mjs)로 병렬 측정한다. `node --test bench/status_quality/s6_quality.test.mjs`
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';

const CLI = fileURLToPath(new URL('./tune_cli.mjs', import.meta.url));
const SEEDS = [1, 2, 3, 4, 5, 6];

// 동시 실행 수를 코어 수로 제한해 시드별 측정을 병렬로 돌린다.
function runSeed(seed) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [CLI, '2500000', String(seed)], { maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`시드 ${seed}: ${err.message}\n${stderr}`));
      else resolve(JSON.parse(stdout.trim().split('\n').pop()));
    });
  });
}
async function runAll(seeds, limit) {
  const out = new Map();
  const queue = [...seeds];
  await Promise.all(Array.from({ length: Math.min(limit, seeds.length) }, async () => {
    while (queue.length > 0) { const s = queue.shift(); out.set(s, await runSeed(s)); }
  }));
  return out;
}
const results = await runAll(SEEDS, Math.max(1, availableParallelism()));

for (const seed of SEEDS) {
  test(`flat_boxes 시드 ${seed}: 원본 점 전부(250만 점) 송출, 8시점 최소 SSIM ≥ 0.95`, (t) => {
    const r = results.get(seed);
    t.diagnostic(`구간 ${r.bytes} B (수준별 ${r.levelBytes.join('/')} B, 출력 전용), 수준별 점 ${r.levelPoints.join('/')}, 최소 SSIM ${r.ssimMin}, 평균 ${r.ssimMean}`);
    assert.deepEqual(r.levelPoints, [312500, 625000, 1250000, 2500000]);
    assert.equal(r.ssims.length, 8);
    assert.ok(r.ssimMin >= 0.95, `시드 ${seed} 최소 SSIM ${r.ssimMin} (시점별 ${r.ssims.join(', ')})`);
  });
}
