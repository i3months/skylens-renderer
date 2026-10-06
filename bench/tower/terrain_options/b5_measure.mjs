// [cloud] 합성 DEM 측정. T15.10b-B5(F-470 ③): 상한표를 조이는 안의 바이트·SSIM. b1_measure.mjs 의 measureDem 을 그대로 쓴다
// (같은 직렬화 정의·같은 SSIM 절차·같은 수직 이동 규칙). 판정 기준은 새로 만들지 않는다: SSIM 0.95(contracts/controlview
// TERRAIN_SSIM_MIN)와 초기 15 MB(bench/tower_assets INITIAL_LIMIT_BYTES)에 대한 통과 여부만 낸다. 두 값은 낮추지 않는다.
//
// 상한표(m):
//   i   [0, 0.5, 1, 1]      결정 0057 이전의 절대표(b1 안 (i) 과 같은 값). 서버 실효 상한은 셀에 따라 더 작으므로(1 m 셀 0.25 m) 서버와 같다는 뜻이 아니다
//   v1  [0, 0.25, 0.5, 0.5] F-470 이 예로 든 'LOD1 0.25 m' 에 LOD2·3 을 현행의 절반으로(측정 전에 정함)
//   v2  [0, 0.25, 0.25, 0.25] LOD1~3 모두 0.25 m. b1 출력에서 lowNoise 의 간격 2 최대 오차가 0.2960~0.2991 m 인 것을 보고
//       그 아래로 정한 값이다(SSIM 결과를 보고 고른 값이 아님). 이 표에서 lowNoise 는 LOD1~3 이 원본 간격이 된다.
//
// DEM 집합:
//   lowNoise:s    (s = 1..12) b1 과 같은 1024 m·1 m 셀·256 타일, smooth + ±0.15 m 화소 잡음.
//   lowNoise2m:s  (s = 1..12) 같은 식·같은 잡음 진폭, 셀만 2 m(513×513 표본, 256 타일). 셀 크기 효과를 가르는 대조군(F-470 ②).
//   noiseBig:s    (s = 1..12) lod_bytes.mjs noiseBigDem(s). 바이트용(SSIM 도 함께 낸다).
//   hill:s/n      ssim_views 24 장면(makeHillDem 시드 1..12 × 잡음 {0, 0.015}, 2 m 셀, 4×4 타일 = 16 타일).
//                 바이트는 그 16 타일 합이다(1024 m DEM 의 256 타일 합과 견주지 않는다).
//
// 실행: node bench/tower/terrain_options/b5_measure.mjs [--json 경로] [--only lowNoise:1,hill:1/0.015,...]
//   표를 표준출력에 찍는다. 통과/실패로 던지지 않는다(측정 스크립트). 단, 모든 DEM 에서 b1 의 서버 대조(check:
//   서버 실효 상한 terrainLodMaxErrorM(·, cellM)으로 구한 사본 간격·타일 높이 대 서버 terrainLodStride·buildTerrainTile)가
//   항상 돌고, 어긋나면 measureDem 이 던진다. SSIM·오차는 반올림하지 않고 내림해 찍는다(0.9500 으로 보이는 0.94996 방지).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { noiseBigDem } from '../lod_bytes.mjs';
import { INITIAL_LIMIT_BYTES } from '../../tower_assets/index.mjs';
import { TERRAIN_SSIM_MIN } from '../../../contracts/controlview/terrain.mjs';
import { makeHillDem, towerViewpoints } from '../../../client/tower/terrain/fixtures.mjs';
import { measureDem, lowNoiseDem, floorFixed } from './b1_measure.mjs';

export const B5_OPTIONS = Object.freeze({
  i: Object.freeze([0, 0.5, 1, 1]),
  v1: Object.freeze([0, 0.25, 0.5, 0.5]),
  v2: Object.freeze([0, 0.25, 0.25, 0.25]),
});

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

function demSet() {
  const out = [];
  for (const s of SEEDS) out.push({ group: 'lowNoise', name: `lowNoise:${s}`, make: () => lowNoiseDem(s, 1) });
  for (const s of SEEDS) out.push({ group: 'lowNoise2m', name: `lowNoise2m:${s}`, make: () => lowNoiseDem(s, 2) });
  for (const s of SEEDS) out.push({ group: 'noiseBig', name: `noiseBig:${s}`, make: () => noiseBigDem(s) });
  for (const n of [0, 0.015]) for (const s of SEEDS) out.push({ group: 'hill', name: `hill:${s}/${n}`, make: () => makeHillDem({ seed: s, noiseRatio: n }) });
  return out;
}

// 그룹별 셀 크기(m). 결과 객체에 cellM 이 없으면(이전 json) 이 표로 채운다.
const GROUP_CELL_M = { lowNoise: 1, lowNoise2m: 2, noiseBig: 1, hill: 2 };
const cellMOf = (r) => r.cellM ?? GROUP_CELL_M[r.group] ?? 1;

/** --only 값 검증. 빈 값·알 수 없는 이름이면 throw, 정상이면 이름 배열을 돌려준다. */
export function parseOnly(arg, names = demSet().map((d) => d.name)) {
  if (arg === null || arg === undefined) return null;
  if (typeof arg !== 'string' || arg.trim() === '') throw new Error('--only 값이 비어 있다');
  const list = arg.split(',').map((x) => x.trim());
  if (list.some((x) => x === '')) throw new Error(`--only 에 빈 이름이 있다: "${arg}"`);
  const known = new Set(names);
  const bad = list.filter((x) => !known.has(x));
  if (bad.length) throw new Error(`--only 알 수 없는 이름: ${bad.join(', ')}`);
  return list;
}

export function measureB5({ only = null } = {}) {
  const cams = towerViewpoints();
  const results = [];
  for (const d of demSet().filter((x) => !only || only.includes(x.name))) {
    // 서버 대조는 모든 그룹(lowNoise2m·hill 포함)에서 항상 켠다. 대조 타일 좌표는 DEM 격자에서 구한다.
    const r = measureDem(d, cams, { check: true, optionTable: B5_OPTIONS });
    r.group = d.group;
    r.cellM = GROUP_CELL_M[d.group] ?? 1;
    results.push(r);
    console.error(`[b5] ${d.name} ${r.ms} ms`);
  }
  return { note: '[cloud] 합성 DEM 측정. b1_measure measureDem 절차.', options: B5_OPTIONS, ssimMin: TERRAIN_SSIM_MIN, initialLimitBytes: INITIAL_LIMIT_BYTES, results };
}

const fmtB = (n) => n.toLocaleString('en-US');

/** 그룹 × 안 요약: LOD 별 간격(집합), LOD1~3 최소 SSIM, 0.95 미만 조건 수, LOD3 바이트(최대·합). */
export function summarize(all) {
  const groups = [...new Set(all.results.map((r) => r.group))];
  const rows = [];
  for (const g of groups) {
    const rs = all.results.filter((r) => r.group === g);
    for (const opt of Object.keys(all.options)) {
      const strides = [0, 1, 2, 3].map((l) => [...new Set(rs.map((r) => r.options[opt].levels[l].stride))].sort((a, b) => a - b).join('/'));
      let fail = 0, n = 0, min = Infinity, lod0Min = Infinity;
      for (const r of rs) {
        const ls = r.options[opt].levels;
        lod0Min = Math.min(lod0Min, ls[0].ssimMin8);
        for (const l of ls.slice(1)) { n++; if (l.ssimMin8 < all.ssimMin) fail++; min = Math.min(min, l.ssimMin8); }
      }
      const l3Mesh = rs.map((r) => r.options[opt].levels[3].meshRawBytes);
      const l3Height = rs.map((r) => r.options[opt].levels[3].heightOnlyRawBytes);
      rows.push({
        group: g, opt, cellM: cellMOf(rs[0]), scenes: rs.length, strides, lod0SsimMin: lod0Min, lod1to3SsimMin: min, fail, conditions: n,
        lod3MeshMax: Math.max(...l3Mesh), lod3MeshSum: l3Mesh.reduce((a, b) => a + b, 0),
        lod3HeightMax: Math.max(...l3Height), lod3HeightSum: l3Height.reduce((a, b) => a + b, 0),
        lod1MeshMax: Math.max(...rs.map((r) => r.options[opt].levels[1].meshRawBytes)),
      });
    }
  }
  return rows;
}

export function formatB5(all) {
  const lines = [`안 ${Object.entries(all.options).map(([k, v]) => `${k} ${JSON.stringify(v)}`).join('  ')} | SSIM 기준 ${all.ssimMin}, 초기 상한 ${fmtB(all.initialLimitBytes)} B(raw)`];
  lines.push('그룹 | 안 | 장면 | cellM(m) | 간격(셀) LOD0..3 | LOD0 SSIM 최소 | LOD1~3 SSIM 최소 | 0.95 미만/조건 | LOD1 메시 최대 B | LOD3 메시 최대 B | LOD3 메시 합 B | LOD3 높이만 최대 B | LOD3 높이만 합 B');
  for (const r of summarize(all)) {
    lines.push(`${r.group} | ${r.opt} | ${r.scenes} | ${r.cellM} | ${r.strides.join(',')} | ${floorFixed(r.lod0SsimMin, 4)} | ${floorFixed(r.lod1to3SsimMin, 4)} | ${r.fail}/${r.conditions} | ${fmtB(r.lod1MeshMax)} | ${fmtB(r.lod3MeshMax)} | ${fmtB(r.lod3MeshSum)} | ${fmtB(r.lod3HeightMax)} | ${fmtB(r.lod3HeightSum)}`);
  }
  lines.push('');
  lines.push('장면별 LOD1~3 최소 SSIM(안 i / v1 / v2), @뒤 숫자 = 간격(셀), 실제 간격 m = 간격 × cellM:');
  for (const r of all.results) {
    const cell = (o) => r.options[o].levels.slice(1).map((l) => `${floorFixed(l.ssimMin8, 4)}@${l.stride}`).join(' ');
    lines.push(`  ${r.dem.padEnd(16)} i ${cell('i')} | v1 ${cell('v1')} | v2 ${cell('v2')} | cellM ${cellMOf(r)} m | 간격 2셀 최대오차 ${r.options.i.levels[1].stride === 2 ? r.options.i.levels[1].maxErrorM.toFixed(6) : '-'}`);
  }
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const onlyArg = get('--only');
  // 빈 값·오타는 parseOnly 가 던져 비영 종료한다. --only 가 값 없이 끝나면 null 이 아니라 빈 값으로 본다.
  const only = args.includes('--only') ? parseOnly(onlyArg ?? '') : null;
  const all = measureB5({ only });
  console.log(formatB5(all));
  const jsonPath = get('--json');
  if (jsonPath) writeFileSync(jsonPath, JSON.stringify(all, null, 2) + '\n');
}
