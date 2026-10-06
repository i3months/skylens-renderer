// [cloud] 합성 DEM 측정. T15.10d(F-474, 결정 0057): 셀 크기 비례 기울기 항을 넣은 LOD 오차 상한 규칙
//   상한(lod, cellM) = min(TERRAIN_LOD_MAX_ERROR_M[lod], TERRAIN_LOD_MAX_SLOPE_ERROR · cellM)   (contracts terrainLodMaxErrorM)
// 을 b1_measure measureDem 절차(같은 직렬화 정의·같은 SSIM 절차·같은 수직 이동 규칙)로 잰다. 판정 기준은 새로 만들지 않는다:
// SSIM 0.95(contracts/controlview TERRAIN_SSIM_MIN)·초기 15 MB(bench/tower_assets INITIAL_LIMIT_BYTES). 두 값은 낮추지 않는다.
//
// 안:
//   i     [0, 0.5, 1, 1]           현행 절대표(대조용, 셀 크기 무관)
//   rule  terrainLodMaxErrorM(·, cellM)   결정 0057 규칙(DEM 셀 크기마다 상한표가 달라진다)
// 규칙 쪽 간격은 서버 terrainLodStride 와, 타일 높이는 서버 buildTerrainTile 과 DEM 마다 대조한다(다르면 던진다, F-481).
// b1_measure 의 checkAgainstServer 는 내보내지 않으므로 같은 절차(LOD 마다 타일 3개 높이 바이트 비교)를 여기 둔다.
//
// DEM 집합(b5 와 같은 정의): lowNoise:s(1 m 셀) · lowNoise2m:s(2 m 셀) · noiseBig:s · hill:s/n(ssim_views 24 장면), s = 1..12 전부.
// 더해 lowNoise012:s(1 m 셀, ±0.12 m 화소 잡음, F-474 다시 엶): 1 m 셀에서 간격 2..8 의 최대 오차 e 가 0.237~0.240 m 로
//   e/cellM 이 규칙 기울기 상수 0.25 바로 아래라 규칙이 실제로 솎아낸다(간격 1,2,4,8). 잡음 크기는 미리 정한 범위
//   ±0.10~0.12 m 중 0.25 에 가장 가까운 위 끝을 SSIM 측정 전에 골랐고, 시드는 1..12 전부다.
// 주의(F-480): 1 m 셀 lowNoise·noiseBig 은 규칙 간격이 1,1,1,1 이라 LOD1~3 = LOD0, SSIM 1.0000 은 자명(항등)이다.
// 실행: node bench/tower/terrain_options/b6_rule.mjs [--only lowNoise:1,...] [--groups lowNoise,lowNoise012,...] [--json 경로]
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TERRAIN_LOD_COUNT, TERRAIN_LOD_MAX_ERROR_M, terrainLodMaxErrorM } from '../../../contracts/tower_assets/index.mjs';
import { TERRAIN_SSIM_MIN } from '../../../contracts/controlview/terrain.mjs';
import { terrainLodStride, buildTerrainTile } from '../../../server/terrain/mesh_lod/index.mjs';
import { INITIAL_LIMIT_BYTES } from '../../tower_assets/index.mjs';
import { noiseBigDem } from '../lod_bytes.mjs';
import { makeHillDem, towerViewpoints } from '../../../client/tower/terrain/fixtures.mjs';
import { measureDem, lowNoiseDem, checkCellM } from './b1_measure.mjs';
import { buildTileWithStride } from './b1_lod.mjs';
import { parseOnly } from './b5_measure.mjs';

export const B6_SEEDS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
export const B6_GROUPS = Object.freeze(['lowNoise', 'lowNoise012', 'lowNoise2m', 'noiseBig', 'hill']);
/** lowNoise012 의 화소 잡음 반폭(m). 미리 정한 범위 0.10~0.12 의 위 끝(SSIM 측정 전에 고정). */
export const LOW_NOISE_012_HALF_M = 0.12;
const SPAN_M = 1024;

/** lod_bytes.mjs·b1_measure.mjs 의 hashNoise 와 같은 식(둘 다 내보내지 않아 옮김). ∈ [−0.5, 0.5]. */
function hashNoise(i, j, seed = 0) {
  let x = ((i + seed * 31) * 73856093) ^ (j * 19349663);
  x = Math.imul(x ^ (x >>> 13), 0x5bd1e995);
  x ^= x >>> 15;
  return ((x >>> 0) % 1001) / 1000 - 0.5;
}

/**
 * b1_measure lowNoiseDem 과 같은 격자·같은 매끈한 면에 잡음 반폭만 halfM 으로 바꾼 DEM.
 * halfM = 0.15 이면 lowNoiseDem(seed, cellM) 과 바이트가 같다(시험에서 대조).
 */
export function noiseHalfDem(seed, halfM, cellM = 1) {
  checkCellM(cellM);
  if (!(Number.isFinite(halfM) && halfM >= 0)) throw new Error(`halfM 은 0 이상 유한수: ${halfM}`);
  const side = SPAN_M / cellM + 1;
  const heights = new Float32Array(side * side);
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const x = i * cellM - SPAN_M / 2, y = j * cellM - SPAN_M / 2;
      heights[j * side + i] = 20 + 25 * Math.sin(x / 300) * Math.cos(y / 400) + 2 * halfM * hashNoise(i, j, seed);
    }
  }
  return { originX: -SPAN_M / 2, originY: -SPAN_M / 2, cellM, width: side, height: side, heights };
}

/** 결정 0057 규칙의 상한표(DEM 셀 크기별). */
export function ruleBounds(cellM) {
  return Object.freeze([0, 1, 2, 3].map((l) => terrainLodMaxErrorM(l, cellM)));
}

export function b6DemSet(groups = B6_GROUPS) {
  const out = [];
  const want = new Set(groups);
  const unknown = [...want].filter((g) => !B6_GROUPS.includes(g));
  if (unknown.length) throw new Error(`알 수 없는 그룹: ${unknown.join(', ')} (가능: ${B6_GROUPS.join(', ')})`);
  if (want.has('lowNoise')) for (const s of B6_SEEDS) out.push({ group: 'lowNoise', name: `lowNoise:${s}`, make: () => lowNoiseDem(s, 1) });
  if (want.has('lowNoise012')) for (const s of B6_SEEDS) out.push({ group: 'lowNoise012', name: `lowNoise012:${s}`, make: () => noiseHalfDem(s, LOW_NOISE_012_HALF_M, 1) });
  if (want.has('lowNoise2m')) for (const s of B6_SEEDS) out.push({ group: 'lowNoise2m', name: `lowNoise2m:${s}`, make: () => lowNoiseDem(s, 2) });
  if (want.has('noiseBig')) for (const s of B6_SEEDS) out.push({ group: 'noiseBig', name: `noiseBig:${s}`, make: () => noiseBigDem(s) });
  if (want.has('hill')) for (const n of [0, 0.015]) for (const s of B6_SEEDS) out.push({ group: 'hill', name: `hill:${s}/${n}`, make: () => makeHillDem({ seed: s, noiseRatio: n }) });
  return out;
}

/** --groups 값 검사. 빈 값·빈 이름·모르는 그룹은 던진다. null/undefined 면 undefined(전체). */
export function parseGroups(arg) {
  if (arg === null || arg === undefined) return undefined;
  if (typeof arg !== 'string' || arg.trim() === '') throw new Error('--groups 값이 비어 있다');
  const list = arg.split(',').map((x) => x.trim());
  if (list.some((x) => x === '')) throw new Error(`--groups 에 빈 이름이 있다: "${arg}"`);
  const bad = list.filter((x) => !B6_GROUPS.includes(x));
  if (bad.length) throw new Error(`--groups 알 수 없는 그룹: ${bad.join(', ')}`);
  return list;
}

/** --only 검사: b5 parseOnly 를 b6 이름 목록(그룹 선택 반영)으로 재사용한다. */
export function parseB6Only(arg, groups) {
  return parseOnly(arg, b6DemSet(groups).map((d) => d.name));
}

/**
 * 사본 간격 strides 로 만든 타일 높이가 서버 buildTerrainTile 과 바이트 단위로 같은지 LOD 마다 타일 3개(왼쪽 아래 모서리·가운데·오른쪽 위 모서리)에서 대조한다.
 * 다르면 던진다. 대조한 타일 수를 돌려준다(시험이 대조가 실제로 돌았는지 단언). build 는 시험의 변이 주입용.
 */
export function checkTilesAgainstServer(dem, strides, build = buildTileWithStride) {
  const n0 = checkCellM(dem.cellM);
  const tx0 = Math.round(dem.originX / 64), ty0 = Math.round(dem.originY / 64);
  const ntx = (dem.width - 1) / n0, nty = (dem.height - 1) / n0;
  const picks = [[tx0, ty0], [tx0 + Math.floor(ntx / 2), ty0 + Math.floor(nty / 2)], [tx0 + ntx - 1, ty0 + nty - 1]];
  let n = 0;
  for (let lod = 0; lod < TERRAIN_LOD_COUNT; lod++) {
    for (const [tx, ty] of picks) {
      const a = buildTerrainTile(dem, tx, ty, lod), b = build(dem, tx, ty, lod, strides[lod]);
      if (a.cells !== b.cells || a.heights.length !== b.heights.length || !a.heights.every((v, k) => v === b.heights[k])) {
        throw new Error(`사본 타일 높이 불일치 LOD ${lod} (${tx},${ty}): 사본 cells ${b.cells} 서버 ${a.cells}`);
      }
      n++;
    }
  }
  return n;
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
  r.serverTilesChecked = checkTilesAgainstServer(dem, r.options.rule.levels.map((l) => l.stride));
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
  lines.push('간격이 1,1,1,1 인 행은 LOD1~3 = LOD0 이라 SSIM 1.0000 이 자명(항등)하다(1 m 셀 lowNoise·noiseBig, F-480).');
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
      const ident = strides.every((x) => x === '1') ? ' (항등)' : '';
      lines.push(`${g} | ${opt} | ${rs.length} | [${rs[0].options[opt].bounds.join(', ')}] | ${strides.join(',')}${ident} | ${lod0.toFixed(4)} | ${min.toFixed(4)} | ${fail}/${n} | ${fmtB(Math.max(...m3))} | ${fmtB(sum(m3))} | ${fmtB(Math.max(...h3))} | ${fmtB(sum(h3))}`);
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
  // 빈 값·오타는 던져 비영 종료한다(F-484 ②). 플래그가 값 없이 끝나면 빈 값으로 본다.
  const groups = args.includes('--groups') ? parseGroups(get('--groups') ?? '') : undefined;
  const only = args.includes('--only') ? parseB6Only(get('--only') ?? '', groups) : null;
  const all = measureB6({ only, groups });
  console.log(formatB6(all));
  const jsonPath = get('--json');
  if (jsonPath) writeFileSync(jsonPath, JSON.stringify(all, null, 2) + '\n');
}
