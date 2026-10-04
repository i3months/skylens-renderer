// 건물 LOD 시드 일괄 검사: 밀집 합성 장면(denseCity) 시드 범위 × 8시점에서 원본과 LOD 를 렌더해
// 건물 영역 블록 SSIM 과 면 수 감소율을 잰다. 하나라도 SSIM < BUILDING_LOD_MIN_SSIM 이거나 감소율 ≤ 0 이면 종료 코드 1.
//
// 사용: node tools/lod_seed_sweep.mjs [첫시드-끝시드 | 끝시드 | 시드,시드,...]
//   인자가 없으면 환경 변수 LOD_SWEEP_SEEDS(같은 형식), 그것도 없으면 1-300.
//   LOD_SWEEP_VIEWS=이름,이름 으로 시점을 고를 수 있다. LOD_SWEEP_VERBOSE=1 이면 시드마다 한 줄씩 찍는다.
import { BUILDING_LOD_MIN_SSIM } from '../contracts/tower_assets/index.mjs';
import { denseCity, VIEWS, lodForView, triCount, render, blockSsim } from '../server/buildings/lod/scene.mjs';

export function parseSeeds(spec) {
  const s = String(spec).trim();
  if (/^\d+-\d+$/.test(s)) {
    const [a, b] = s.split('-').map(Number);
    if (b < a) throw new Error(`시드 범위가 거꾸로다: ${s}`);
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  }
  if (/^\d+$/.test(s)) return Array.from({ length: Number(s) }, (_, i) => i + 1);
  if (/^\d+(,\d+)*$/.test(s)) return s.split(',').map(Number);
  throw new Error(`시드 형식을 알 수 없다: ${s} (예: 1-300, 40, 3,83,180)`);
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

function main() {
  const seeds = parseSeeds(process.argv[2] ?? process.env.LOD_SWEEP_SEEDS ?? '1-300');
  const pick = process.env.LOD_SWEEP_VIEWS ? new Set(process.env.LOD_SWEEP_VIEWS.split(',')) : null;
  const views = pick ? VIEWS.filter((v) => pick.has(v.name)) : VIEWS;
  if (!views.length) throw new Error('고른 시점이 없다');
  const verbose = process.env.LOD_SWEEP_VERBOSE === '1';
  const perView = new Map(views.map((v) => [v.name, { min: Infinity, seed: 0, redMin: Infinity, redMax: -Infinity }]));
  const failures = [];
  let worst = { ssim: Infinity };
  const t0 = Date.now();
  for (const seed of seeds) {
    const rows = sweepSeed(seed, views);
    let seedMin = Infinity;
    for (const r of rows) {
      const pv = perView.get(r.view);
      if (r.ssim < pv.min) { pv.min = r.ssim; pv.seed = seed; }
      pv.redMin = Math.min(pv.redMin, r.reduction); pv.redMax = Math.max(pv.redMax, r.reduction);
      seedMin = Math.min(seedMin, r.ssim);
      if (r.ssim < worst.ssim) worst = { ...r, seed };
      if (!(r.ssim >= BUILDING_LOD_MIN_SSIM) || !(r.reduction > 0) || r.blocks === 0) failures.push({ seed, ...r });
    }
    if (verbose) {
      const w = rows.reduce((a, b) => (b.ssim < a.ssim ? b : a));
      console.log(`seed ${seed}: min SSIM ${seedMin.toFixed(4)} (${w.view}), reduction ${(Math.min(...rows.map((r) => r.reduction)) * 100).toFixed(1)}..${(Math.max(...rows.map((r) => r.reduction)) * 100).toFixed(1)}%`);
    }
  }
  console.log(`seeds ${seeds.length} (${seeds[0]}..${seeds[seeds.length - 1]}), views ${views.length}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  for (const [name, pv] of perView) {
    console.log(`${name.padEnd(11)} min SSIM ${pv.min.toFixed(4)} (seed ${pv.seed}), reduction ${(pv.redMin * 100).toFixed(1)}..${(pv.redMax * 100).toFixed(1)}%`);
  }
  console.log(`overall min SSIM ${worst.ssim.toFixed(4)} (seed ${worst.seed} ${worst.view}, tris ${worst.origTris} -> ${worst.lodTris})`);
  for (const f of failures) {
    console.log(`FAIL seed ${f.seed} ${f.view}: SSIM ${f.ssim.toFixed(4)}, reduction ${(f.reduction * 100).toFixed(1)}%, blocks ${f.blocks}`);
  }
  process.exitCode = failures.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
