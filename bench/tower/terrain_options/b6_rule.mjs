// [cloud] 합성 DEM 측정. T15.10d(F-474, 결정 0057): 셀 크기 비례 기울기 항을 넣은 LOD 오차 상한 규칙
//   상한(lod, cellM) = min(TERRAIN_LOD_MAX_ERROR_M[lod], TERRAIN_LOD_MAX_SLOPE_ERROR · cellM)   (contracts terrainLodMaxErrorM)
// 을 b1_measure measureDem 절차(같은 직렬화 정의·같은 SSIM 절차·같은 수직 이동 규칙)로 잰다. 판정 기준은 새로 만들지 않는다:
// SSIM 0.95(contracts/controlview TERRAIN_SSIM_MIN)·초기 15 MB(bench/tower_assets INITIAL_LIMIT_BYTES). 두 값은 낮추지 않는다.
//
// 안:
//   i     [0, 0.5, 1, 1]           현행 절대표(대조용, 셀 크기 무관)
//   rule  terrainLodMaxErrorM(·, cellM)   결정 0057 규칙(DEM 셀 크기마다 상한표가 달라진다)
// 규칙 쪽 간격은 서버 terrainLodStride 와 같은지 DEM 마다 대조한다(다르면 던진다).
//
// DEM 집합(b5 와 같은 정의): lowNoise:s(1 m 셀) · lowNoise2m:s(2 m 셀) · noiseBig:s · hill:s/n(ssim_views 24 장면), s = 1..12 전부.
// 실행: node bench/tower/terrain_options/b6_rule.mjs [--only lowNoise:1,...] [--json 경로]
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TERRAIN_LOD_COUNT, TERRAIN_LOD_MAX_ERROR_M, terrainLodMaxErrorM } from '../../../contracts/tower_assets/index.mjs';
import { TERRAIN_SSIM_MIN } from '../../../contracts/controlview/terrain.mjs';
import { terrainLodStride } from '../../../server/terrain/mesh_lod/index.mjs';
import { INITIAL_LIMIT_BYTES } from '../../tower_assets/index.mjs';
import { noiseBigDem } from '../lod_bytes.mjs';
import { makeHillDem, towerViewpoints } from '../../../client/tower/terrain/fixtures.mjs';
import { measureDem, lowNoiseDem } from './b1_measure.mjs';

export const B6_SEEDS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

/** 결정 0057 규칙의 상한표(DEM 셀 크기별). */
export function ruleBounds(cellM) {
  return Object.freeze([0, 1, 2, 3].map((l) => terrainLodMaxErrorM(l, cellM)));
}

export function b6DemSet(groups = ['lowNoise', 'lowNoise2m', 'noiseBig', 'hill']) {
  const out = [];
  const want = new Set(groups);
  if (want.has('lowNoise')) for (const s of B6_SEEDS) out.push({ group: 'lowNoise', name: `lowNoise:${s}`, make: () => lowNoiseDem(s, 1) });
  if (want.has('lowNoise2m')) for (const s of B6_SEEDS) out.push({ group: 'lowNoise2m', name: `lowNoise2m:${s}`, make: () => lowNoiseDem(s, 2) });
  if (want.has('noiseBig')) for (const s of B6_SEEDS) out.push({ group: 'noiseBig', name: `noiseBig:${s}`, make: () => noiseBigDem(s) });
  if (want.has('hill')) for (const n of [0, 0.015]) for (const s of B6_SEEDS) out.push({ group: 'hill', name: `hill:${s}/${n}`, make: () => makeHillDem({ seed: s, noiseRatio: n }) });
  return out;
}

/**
 * DEM 하나를 현행 절대표(i, 선택)와 규칙(rule)으로 잰다. withBaseline=false 면 규칙만(시험용으로 빠르다).
 * 규칙 간격이 서버 terrainLodStride 와 다르면 던진다.
 */
export function measureRuleDem(entry, cams, { withBaseline = true } = {}) {
  const dem = entry.make();
  const table = { rule: ruleBounds(dem.cellM) };
  if (withBaseline) table.i = TERRAIN_LOD_MAX_ERROR_M;
  // measureDem 은 make() 를 다시 부르므로 같은 DEM 을 돌려주는 항목으로 감싼다.
  const r = measureDem({ name: entry.name, make: () => dem }, cams, { check: false, optionTable: table });
  for (let lod = 0; lod < TERRAIN_LOD_COUNT; lod++) {
    const s = terrainLodStride(dem, lod);
    if (s !== r.options.rule.levels[lod].stride) throw new Error(`${entry.name} LOD ${lod}: 규칙 사본 간격 ${r.options.rule.levels[lod].stride} 서버 ${s}`);
  }
  r.group = entry.group;
  r.cellM = dem.cellM;
  return r;
}

export function measureB6({ only = null, groups } = {}) {
  const cams = towerViewpoints();
  const results = [];
  for (const d of b6DemSet(groups).filter((x) => !only || only.includes(x.name))) {
    const r = measureRuleDem(d, cams);
    results.push(r);
    console.error(`[b6] ${d.name} ${r.ms} ms`);
  }
  return { note: '[cloud] 합성 DEM 측정. b1_measure measureDem 절차.', ssimMin: TERRAIN_SSIM_MIN, initialLimitBytes: INITIAL_LIMIT_BYTES, results };
}

const fmtB = (n) => n.toLocaleString('en-US');

export function formatB6(all) {
  const lines = [`SSIM 기준 ${all.ssimMin}, 초기 상한 ${fmtB(all.initialLimitBytes)} B(raw). 안 i = [${TERRAIN_LOD_MAX_ERROR_M.join(', ')}], rule = min(i, 0.25·cellM)`];
  lines.push('그룹 | 안 | 장면 | 상한표 | 간격 LOD0..3 | LOD0 SSIM 최소 | LOD1~3 SSIM 최소 | 0.95 미만/조건 | LOD3 메시 최대 B | LOD3 메시 합 B | LOD3 높이만 최대 B | LOD3 높이만 합 B');
  const groups = [...new Set(all.results.map((r) => r.group))];
  for (const g of groups) {
    const rs = all.results.filter((r) => r.group === g);
    for (const opt of ['i', 'rule']) {
      if (!rs[0].options[opt]) continue;
      const strides = [0, 1, 2, 3].map((l) => [...new Set(rs.map((r) => r.options[opt].levels[l].stride))].sort((a, b) => a - b).join('/'));
      let fail = 0, n = 0, min = Infinity, lod0 = Infinity;
      for (const r of rs) {
        const ls = r.options[opt].levels;
        lod0 = Math.min(lod0, ls[0].ssimMin8);
        for (const l of ls.slice(1)) { n++; if (l.ssimMin8 < all.ssimMin) fail++; min = Math.min(min, l.ssimMin8); }
      }
      const m3 = rs.map((r) => r.options[opt].levels[3].meshRawBytes), h3 = rs.map((r) => r.options[opt].levels[3].heightOnlyRawBytes);
      const sum = (a) => a.reduce((x, y) => x + y, 0);
      lines.push(`${g} | ${opt} | ${rs.length} | [${rs[0].options[opt].bounds.join(', ')}] | ${strides.join(',')} | ${lod0.toFixed(4)} | ${min.toFixed(4)} | ${fail}/${n} | ${fmtB(Math.max(...m3))} | ${fmtB(sum(m3))} | ${fmtB(Math.max(...h3))} | ${fmtB(sum(h3))}`);
    }
  }
  lines.push('');
  lines.push('장면별 LOD1~3 최소 SSIM@간격(rule / i):');
  for (const r of all.results) {
    const cell = (o) => (r.options[o] ? r.options[o].levels.slice(1).map((l) => `${l.ssimMin8.toFixed(4)}@${l.stride}`).join(' ') : '-');
    lines.push(`  ${r.dem.padEnd(16)} rule ${cell('rule')} | i ${cell('i')}`);
  }
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const onlyArg = get('--only');
  const groupsArg = get('--groups');
  const all = measureB6({ only: onlyArg ? onlyArg.split(',') : null, groups: groupsArg ? groupsArg.split(',') : undefined });
  console.log(formatB6(all));
  const jsonPath = get('--json');
  if (jsonPath) writeFileSync(jsonPath, JSON.stringify(all, null, 2) + '\n');
}
