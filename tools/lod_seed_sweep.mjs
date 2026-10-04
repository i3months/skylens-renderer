// 건물 LOD 시드 일괄 검사: 밀집 합성 장면(denseCity) 시드 범위 × 8시점에서 원본과 LOD 를 렌더해
// 건물 영역 블록 SSIM 과 면 수 감소율을 잰다. 다음 중 하나면 종료 코드 1:
//   - 시드·시점 하나라도 SSIM < BUILDING_LOD_MIN_SSIM(건물 블록 0 포함) 이거나 면 수가 늘었다.
//   - 먼 시점(scene.mjs FAR_VIEW_MIN_REDUCTION)의 시드 합계 감소율이 하한 미만이다(F-332: LOD 를 꺼도 SSIM 은 1.0 이라 SSIM 만으론 못 잡는다).
//   - 시드가 0개이거나 시점이 0개이거나 인자 형식이 틀렸다(한 줄 오류 메시지).
// 가까운·중간 시점의 감소율 0(합칠 수 있는 이웃이 없는 시점, 주로 S-near)은 실패가 아니라 개수만 알린다.
//
// 사용: node tools/lod_seed_sweep.mjs [첫시드-끝시드 | 끝시드 | 시드,시드,...]
//   인자가 없으면 환경 변수 LOD_SWEEP_SEEDS(같은 형식), 그것도 없으면 1-300.
//   LOD_SWEEP_VIEWS=이름,이름 으로 시점을 고를 수 있다. LOD_SWEEP_VERBOSE=1 이면 시드마다 한 줄씩 찍는다.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { BUILDING_LOD_MIN_SSIM } from '../contracts/tower_assets/index.mjs';
import { denseCity, VIEWS, FAR_VIEW_MIN_REDUCTION, lodForView, triCount, render, blockSsim } from '../server/buildings/lod/scene.mjs';

// 시드 목록 인자를 파싱한다. 형식: "a-b"(범위), "n"(1..n), "a,b,c"(쉼표 사이 공백 허용). 중복은 처음 나온 순서로 하나만 남긴다.
// 시드는 1 이상 정수. 0 이나 빈 목록은 오류(아무것도 재지 않고 통과하는 일을 막는다).
export function parseSeeds(spec) {
  const s = String(spec).trim();
  let seeds;
  let m;
  if ((m = /^(\d+)\s*-\s*(\d+)$/.exec(s))) {
    const a = Number(m[1]), b = Number(m[2]);
    if (b < a) throw new Error(`시드 범위가 거꾸로다: ${s}`);
    seeds = Array.from({ length: b - a + 1 }, (_, i) => a + i);
  } else if (/^\d+$/.test(s)) {
    seeds = Array.from({ length: Number(s) }, (_, i) => i + 1);
  } else if (/^\d+(\s*,\s*\d+)*$/.test(s)) {
    seeds = s.split(',').map((x) => Number(x.trim()));
  } else {
    throw new Error(`시드 형식을 알 수 없다: ${s} (예: 1-300, 40, 3,83,180)`);
  }
  seeds = [...new Set(seeds)];
  if (!seeds.length || seeds.some((x) => x < 1 || !Number.isSafeInteger(x))) throw new Error(`시드는 1 이상 정수여야 하고 하나 이상이어야 한다: ${s}`);
  return seeds;
}

/** 한 시드 장면의 시점별 결과: { view, ssim(건물 영역), blocks, origTris, lodTris, reduction }. */
export function sweepSeed(seed, views = VIEWS) {
  const city = denseCity(seed);
  const orig = city.map((b) => b.mesh);
  const origTris = triCount(orig);
  return views.map((view) => {
    const lod = lodForView(city, view.eye).map((g) => g.mesh);
    const lodTris = triCount(lod);
    const s = blockSsim(render(orig, view), render(lod, view));
    return { view: view.name, ssim: s.buildingMean, blocks: s.buildingBlocks, origTris, lodTris, reduction: 1 - lodTris / origTris };
  });
}

function run() {
  const seeds = parseSeeds(process.argv[2] ?? process.env.LOD_SWEEP_SEEDS ?? '1-300');
  const pick = process.env.LOD_SWEEP_VIEWS ? new Set(process.env.LOD_SWEEP_VIEWS.split(',')) : null;
  const views = pick ? VIEWS.filter((v) => pick.has(v.name)) : VIEWS;
  if (!views.length) throw new Error(`고른 시점이 없다: ${process.env.LOD_SWEEP_VIEWS}`);
  const verbose = process.env.LOD_SWEEP_VERBOSE === '1';
  const perView = new Map(views.map((v) => [v.name, { min: Infinity, seed: 0, redMin: Infinity, redMax: -Infinity, orig: 0, lod: 0 }]));
  const failures = [];
  const noReduction = [];
  let worst = { ssim: Infinity };
  const t0 = Date.now();
  for (const seed of seeds) {
    const rows = sweepSeed(seed, views);
    let seedMin = Infinity;
    for (const r of rows) {
      const pv = perView.get(r.view);
      if (r.ssim < pv.min) { pv.min = r.ssim; pv.seed = seed; }
      pv.orig += r.origTris; pv.lod += r.lodTris;
      pv.redMin = Math.min(pv.redMin, r.reduction); pv.redMax = Math.max(pv.redMax, r.reduction);
      seedMin = Math.min(seedMin, r.ssim);
      if (r.ssim < worst.ssim) worst = { ...r, seed };
      if (!(r.ssim >= BUILDING_LOD_MIN_SSIM) || r.reduction < 0 || r.blocks === 0) failures.push({ seed, ...r });
      else if (r.reduction === 0) noReduction.push(`${seed} ${r.view}`);
    }
    if (verbose) {
      const w = rows.reduce((a, b) => (b.ssim < a.ssim ? b : a));
      console.log(`seed ${seed}: min SSIM ${seedMin.toFixed(4)} (${w.view}), reduction ${(Math.min(...rows.map((r) => r.reduction)) * 100).toFixed(1)}..${(Math.max(...rows.map((r) => r.reduction)) * 100).toFixed(1)}%`);
    }
  }
  console.log(`seeds ${seeds.length} (${seeds[0]}..${seeds[seeds.length - 1]}), views ${views.length}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  for (const [name, pv] of perView) {
    const total = 1 - pv.lod / pv.orig, floor = FAR_VIEW_MIN_REDUCTION[name];
    console.log(`${name.padEnd(11)} min SSIM ${pv.min.toFixed(4)} (seed ${pv.seed}), reduction ${(pv.redMin * 100).toFixed(1)}..${(pv.redMax * 100).toFixed(1)}%, seed-sum ${(total * 100).toFixed(1)}%${floor === undefined ? '' : ` (floor ${(floor * 100).toFixed(1)}%)`}`);
    if (floor !== undefined && !(total >= floor)) failures.push({ text: `FAIL ${name}: seed-sum reduction ${(total * 100).toFixed(2)}% < floor ${(floor * 100).toFixed(1)}% (${pv.orig} -> ${pv.lod} tris)` });
  }
  console.log(`overall min SSIM ${worst.ssim.toFixed(4)} (seed ${worst.seed} ${worst.view}, tris ${worst.origTris} -> ${worst.lodTris})`);
  if (noReduction.length) console.log(`no reduction (not a failure) in ${noReduction.length} seed-views: ${noReduction.join(', ')}`);
  for (const f of failures) {
    console.log(f.text ?? `FAIL seed ${f.seed} ${f.view}: SSIM ${f.ssim.toFixed(4)}, reduction ${(f.reduction * 100).toFixed(1)}%, blocks ${f.blocks}`);
  }
  return failures.length ? 1 : 0;
}

function main() {
  try {
    process.exitCode = run();
  } catch (e) {
    console.error(`lod_seed_sweep: ${e.message}`);
    process.exitCode = 1;
  }
}

// 공백·한글 경로나 심볼릭 링크로 실행해도 main 이 돈다(import.meta.url 은 실경로의 file URL).
let isMain = false;
try { isMain = !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { isMain = false; }
if (isMain) main();
