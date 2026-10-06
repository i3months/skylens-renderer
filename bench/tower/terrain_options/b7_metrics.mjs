// [cloud] 합성 DEM 측정. T15.10e(F-488): 결정 0057 이 인용한 '형태 근거의 한계' 지표 측정과 lowNoise012 반폭 인자 변형을
// 재현하는 커밋된 스크립트. 0057 은 수치만 있고 표·명령·스크립트가 없었다(F-488). 정의는 여기서 새로 정하지 않고 기존 b1·b6 의 것을 쓴다:
//   - 간격·최대 높이 오차 e: b1_lod lodStrides(DEM 하나·LOD 하나에 전역 간격 하나, e = 그 간격의 타일 최대 표면 오차).
//   - SSIM: b1_measure measureDem 절차(ssim_views 와 같은 160×90·8시점·가운데 4×4 타일 창, 같은 수직 이동 규칙).
//   - 집단: hill(2 m 셀, ssim_views makeHillDem, 24 장면 = 시드 1~12 × 잡음비 0·0.015), lowNoise(1 m 셀 ±0.15 m, 시드 1~12).
//     두 집단 모두 현행 절대표 [0, 0.5, 1, 1](TERRAIN_LOD_MAX_ERROR_M)로 쟀다(0057 의 'A 현행' 대조, 규칙 이전의 간격).
//   - lowNoise012 변형: b6 noiseHalfDem(시드, 반폭) 으로 ±0.10·±0.11·±0.12 m, 시드 1~12, 결정 0057 규칙 상한(ruleBounds)으로 쟀다.
// 0057 이 '정점 법선 각 오차' 의 정의를 적지 않았으므로 아래 정의는 이 스크립트가 고른 것이다(원 수치에 맞추려고 고르지 않았고,
// 맞지 않으면 비교 표에 차이를 그대로 보인다):
//   창 = SSIM 과 같은 가운데 4×4 타일(ENU x, y ∈ [-128, 128], 표본 경계 포함). 창 안 LOD0 메시(간격 1)와 LOD k 메시(간격 s > 1)를 각각 만들고
//   ref_trace weldedVertexNormals 와 같은 정의(정점에 모인 삼각형 법선의 면적 가중 합을 단위화)로 정점 법선을 구한다.
//   LOD k 법선은 LOD0 정점 위치마다 그 위치를 덮는 LOD k 삼각형 안에서 세 정점 법선을 무게중심 보간해 단위화한다(음영이 보는 장 그대로).
//   LOD0 정점 법선과의 각도(도)를 창 안 모든 LOD0 정점에서 모아 평균·RMS·최대로 낸다. 조건 = (장면, LOD) 중 간격 > 1 인 것
//   (간격 1 은 LOD0 과 같아 각이 0 이라 집단 최소를 0 으로 끌어내리므로 뺀다). 같은 장면에서 간격이 같은 LOD 는 같은 조건 하나로 센다.
//   e/cellM 은 같은 조건의 최대 높이 오차 e 를 DEM 셀 크기로 나눈 값이다.
// 실행: node bench/tower/terrain_options/b7_metrics.mjs [--json 경로]
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TERRAIN_LOD_COUNT, TERRAIN_LOD_MAX_ERROR_M } from '../../../contracts/tower_assets/index.mjs';
import { TERRAIN_SSIM_MIN } from '../../../contracts/controlview/terrain.mjs';
import { makeHillDem, towerViewpoints } from '../../../client/tower/terrain/fixtures.mjs';
import { lodStrides } from './b1_lod.mjs';
import { measureDem, lowNoiseDem } from './b1_measure.mjs';
import { noiseHalfDem, measureRuleDem, B6_SEEDS } from './b6_rule.mjs';

/** lowNoise012 반폭 인자 변형(m). 0057 의 ±0.10·±0.11·±0.12. */
export const B7_HALVES_M = Object.freeze([0.10, 0.11, 0.12]);
/** 법선 각 창: SSIM 과 같은 가운데 4×4 타일(타일 번호 −2..1). */
export const B7_WINDOW = Object.freeze({ tileMin: -2, tileMax: 1 });
const TILE_M = 64;

/** 창 안 간격 stride 격자의 정점 법선(면적 가중, 단위). 대각선 (i,j)–(i+1,j+1) 규약(b1_lod strideError 와 같음). */
function gridNormals(dem, stride, i0, j0, nCells) {
  const m = nCells + 1; // 거친 격자 한 변의 정점 수
  const acc = new Float64Array(m * m * 3);
  const z = (ci, cj) => dem.heights[(j0 + cj * stride) * dem.width + i0 + ci * stride];
  const step = stride * dem.cellM;
  const addTri = (a, b, c, ia, ib, ic) => {
    // 좌표: (ci, cj, z). xy 반시계 순서라 법선 z > 0.
    const e1x = (b[0] - a[0]) * step, e1y = (b[1] - a[1]) * step, e1z = b[2] - a[2];
    const e2x = (c[0] - a[0]) * step, e2y = (c[1] - a[1]) * step, e2z = c[2] - a[2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    for (const k of [ia, ib, ic]) { acc[3 * k] += nx; acc[3 * k + 1] += ny; acc[3 * k + 2] += nz; }
  };
  for (let cj = 0; cj < nCells; cj++) {
    for (let ci = 0; ci < nCells; ci++) {
      const p00 = [ci, cj, z(ci, cj)], p10 = [ci + 1, cj, z(ci + 1, cj)], p11 = [ci + 1, cj + 1, z(ci + 1, cj + 1)], p01 = [ci, cj + 1, z(ci, cj + 1)];
      const k00 = cj * m + ci, k10 = cj * m + ci + 1, k11 = (cj + 1) * m + ci + 1, k01 = (cj + 1) * m + ci;
      addTri(p00, p10, p11, k00, k10, k11);
      addTri(p00, p11, p01, k00, k11, k01);
    }
  }
  for (let k = 0; k < m * m; k++) {
    const len = Math.hypot(acc[3 * k], acc[3 * k + 1], acc[3 * k + 2]);
    if (len > 0) { acc[3 * k] /= len; acc[3 * k + 1] /= len; acc[3 * k + 2] /= len; } else acc[3 * k + 2] = 1;
  }
  return acc;
}

/**
 * 창 안에서 간격 stride 메시의 보간 정점 법선과 LOD0 정점 법선의 각도(도) 평균·RMS·최대.
 * @param {{originX:number, originY:number, cellM:number, width:number, height:number, heights:Float32Array}} dem
 * @param {number} stride 1 이상 정수. 창 한 변의 표본 칸 수가 stride 의 배수여야 한다.
 */
export function normalAngleErrors(dem, stride, { tileMin, tileMax } = B7_WINDOW) {
  if (!Number.isInteger(stride) || stride < 1) throw new RangeError(`stride 는 1 이상 정수: ${stride}`);
  const nFine = Math.round(((tileMax - tileMin + 1) * TILE_M) / dem.cellM);
  const i0 = Math.round((tileMin * TILE_M - dem.originX) / dem.cellM), j0 = Math.round((tileMin * TILE_M - dem.originY) / dem.cellM);
  if (i0 < 0 || j0 < 0 || i0 + nFine > dem.width - 1 || j0 + nFine > dem.height - 1) throw new RangeError('창이 DEM 밖');
  if (nFine % stride !== 0) throw new RangeError(`창 칸 수 ${nFine} 이 stride ${stride} 의 배수가 아니다`);
  const nC = nFine / stride;
  const fine = gridNormals(dem, 1, i0, j0, nFine);
  const coarse = stride === 1 ? fine : gridNormals(dem, stride, i0, j0, nC);
  const mF = nFine + 1, mC = nC + 1;
  let sum = 0, sum2 = 0, max = 0, n = 0;
  for (let j = 0; j <= nFine; j++) {
    const cj = Math.min(Math.floor(j / stride), nC - 1), fy = (j - cj * stride) / stride;
    for (let i = 0; i <= nFine; i++) {
      const ci = Math.min(Math.floor(i / stride), nC - 1), fx = (i - ci * stride) / stride;
      // fx >= fy 면 삼각형 (00,10,11), 아니면 (00,01,11).
      const a = cj * mC + ci, d = (cj + 1) * mC + ci + 1;
      const lower = fx >= fy;
      const b = lower ? cj * mC + ci + 1 : (cj + 1) * mC + ci;
      const wa = lower ? 1 - fx : 1 - fy, wb = lower ? fx - fy : fy - fx, wd = lower ? fy : fx;
      const nx = wa * coarse[3 * a] + wb * coarse[3 * b] + wd * coarse[3 * d];
      const ny = wa * coarse[3 * a + 1] + wb * coarse[3 * b + 1] + wd * coarse[3 * d + 1];
      const nz = wa * coarse[3 * a + 2] + wb * coarse[3 * b + 2] + wd * coarse[3 * d + 2];
      const len = Math.hypot(nx, ny, nz);
      const q = (j * mF + i) * 3;
      const dot = Math.max(-1, Math.min(1, (nx * fine[q] + ny * fine[q + 1] + nz * fine[q + 2]) / len));
      const deg = (Math.acos(dot) * 180) / Math.PI;
      sum += deg; sum2 += deg * deg; if (deg > max) max = deg; n++;
    }
  }
  return { meanDeg: sum / n, rmsDeg: Math.sqrt(sum2 / n), maxDeg: max, n };
}

/** 장면 하나를 table(상한표)로 재서 조건(간격 > 1 인 LOD)별 e/cellM·법선 각·SSIM 을 낸다. 같은 간격 LOD 는 dup 표시. */
export function measureMetricScene(entry, cams, table, window = B7_WINDOW) {
  const dem = entry.make();
  const { strides, maxErrorM } = lodStrides(dem, table);
  const m = measureDem({ name: entry.name, make: () => dem }, cams, { check: false, optionTable: { t: table } });
  const levels = m.options.t.levels;
  const conditions = [];
  const seen = new Map();
  for (let lod = 1; lod < TERRAIN_LOD_COUNT; lod++) {
    const s = strides[lod];
    if (s === 1) continue;
    const dup = seen.has(s);
    if (!dup) seen.set(s, normalAngleErrors(dem, s, window));
    const ang = seen.get(s);
    conditions.push({
      scene: entry.name, lod, stride: s, cellM: dem.cellM, maxErrorM: maxErrorM[lod], eOverCell: maxErrorM[lod] / dem.cellM,
      meanDeg: ang.meanDeg, rmsDeg: ang.rmsDeg, maxDeg: ang.maxDeg, ssimMin8: levels[lod].ssimMin8, dup,
    });
  }
  return { scene: entry.name, strides, conditions };
}

const minMax = (xs) => ({ min: Math.min(...xs), max: Math.max(...xs) });
/** dup 조건은 뺀다(같은 간격 = 같은 메시). */
export function summarize(conds) {
  const cs = conds.filter((c) => !c.dup);
  if (!cs.length) return { n: 0 };
  return {
    n: cs.length,
    eOverCell: minMax(cs.map((c) => c.eOverCell)), meanDeg: minMax(cs.map((c) => c.meanDeg)),
    rmsDeg: minMax(cs.map((c) => c.rmsDeg)), maxDeg: minMax(cs.map((c) => c.maxDeg)), ssimMin8: minMax(cs.map((c) => c.ssimMin8)),
  };
}

export function hillScenes(seeds = B6_SEEDS) {
  const out = [];
  for (const n of [0, 0.015]) for (const s of seeds) out.push({ name: `hill:${s}/${n}`, make: () => makeHillDem({ seed: s, noiseRatio: n }) });
  return out;
}
export const lowNoiseScenes = (seeds = B6_SEEDS) => seeds.map((s) => ({ name: `lowNoise:${s}`, make: () => lowNoiseDem(s, 1) }));

/** 집단별 지표(현행 절대표). 집단 = hill, lowNoise 전체, lowNoise 중 SSIM 미달 조건, lowNoise 중 통과 조건. */
export function measureGroups({ hill = hillScenes(), low = lowNoiseScenes(), table = TERRAIN_LOD_MAX_ERROR_M, log = () => {} } = {}) {
  const cams = towerViewpoints();
  const run = (scenes) => scenes.map((e) => { const r = measureMetricScene(e, cams, table); log(`[b7] ${e.name}`); return r; });
  const hr = run(hill), lr = run(low);
  const hc = hr.flatMap((x) => x.conditions), lc = lr.flatMap((x) => x.conditions);
  const failing = (cs) => cs.filter((c) => c.ssimMin8 < TERRAIN_SSIM_MIN && !c.dup).length;
  const groups = {
    hill: { scenes: hr.length, ...summarize(hc), failing: failing(hc) },
    lowNoise: { scenes: lr.length, ...summarize(lc), failing: failing(lc) },
    lowNoiseFail: { scenes: lr.length, ...summarize(lc.filter((c) => c.ssimMin8 < TERRAIN_SSIM_MIN)) },
    lowNoisePass: { scenes: lr.length, ...summarize(lc.filter((c) => c.ssimMin8 >= TERRAIN_SSIM_MIN)) },
  };
  return { table: [...table], groups, scenes: { hill: hr, lowNoise: lr } };
}

/** lowNoise012 반폭 인자 변형(결정 0057 규칙 상한): 간격·최소 SSIM·미달/조건·최악 e. */
export function measureHalves({ halves = B7_HALVES_M, seeds = B6_SEEDS, log = () => {} } = {}) {
  const cams = towerViewpoints();
  return halves.map((half) => {
    const rs = seeds.map((s) => {
      const r = measureRuleDem({ name: `noise${half}:${s}`, group: 'lowNoise012', make: () => noiseHalfDem(s, half, 1) }, cams, { withBaseline: false });
      log(`[b7] ±${half} seed ${s}`);
      return r;
    });
    const strides = [0, 1, 2, 3].map((l) => [...new Set(rs.map((x) => x.options.rule.levels[l].stride))].sort((a, b) => a - b).join('/'));
    let n = 0, fail = 0, min = Infinity, worstE = 0;
    for (const x of rs) {
      for (const l of x.options.rule.levels.slice(1)) {
        n++;
        if (l.ssimMin8 < TERRAIN_SSIM_MIN) fail++;
        min = Math.min(min, l.ssimMin8);
        worstE = Math.max(worstE, l.maxErrorM);
      }
    }
    return { halfM: half, scenes: rs.length, bounds: [...rs[0].options.rule.bounds], strides, minSsim: min, fail, conditions: n, worstEM: worstE, worstEOverCell: worstE / rs[0].cellM };
  });
}

/** 0057 이 인용한 수치(비교용). dec = 0057 이 적은 소수 자릿수. */
export const CITED_0057 = Object.freeze([
  { key: 'hill e/cellM 최대', get: (g) => g.hill.eOverCell.max, cited: 0.404, dec: 3 },
  { key: 'lowNoise e/cellM 최대', get: (g) => g.lowNoise.eOverCell.max, cited: 0.296, dec: 3 },
  { key: '평균 각 실패 집단 최소', get: (g) => g.lowNoiseFail.meanDeg.min, cited: 3.57, dec: 2 },
  { key: '평균 각 통과 집단 최대', get: (g) => g.hill.meanDeg.max, cited: 3.92, dec: 2 },
  { key: 'RMS 각 실패 집단 최소', get: (g) => g.lowNoiseFail.rmsDeg.min, cited: 4.03, dec: 2 },
  { key: 'RMS 각 통과 집단 최대', get: (g) => g.hill.rmsDeg.max, cited: 4.31, dec: 2 },
  { key: '최대 각 실패 집단 최소', get: (g) => g.lowNoiseFail.maxDeg.min, cited: 11.42, dec: 2 },
  { key: '최대 각 통과 집단 최대', get: (g) => g.hill.maxDeg.max, cited: 15.07, dec: 2 },
]);
export const CITED_HALVES = Object.freeze({ 0.1: 0.9737, 0.11: 0.9690, 0.12: 0.9643 });
export const CITED_LOWNOISE_SSIM = 0.9467;

const rnd = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
export function compareCited(res) {
  const rows = CITED_0057.map((c) => {
    let actual;
    try { actual = c.get(res.groups); } catch { actual = NaN; } // 집단이 비면(작은 입력) 값이 없다
    if (typeof actual !== 'number') actual = NaN;
    return { key: c.key, cited: c.cited, actual, diff: actual - c.cited, match: Number.isFinite(actual) && rnd(actual, c.dec) === c.cited };
  });
  for (const h of res.halves) {
    const cited = CITED_HALVES[h.halfM];
    if (cited === undefined) continue;
    rows.push({ key: `±${h.halfM.toFixed(2)} m 최소 SSIM`, cited, actual: h.minSsim, diff: h.minSsim - cited, match: rnd(h.minSsim, 4) === cited });
  }
  const lowMin = res.groups.lowNoise.ssimMin8.min;
  rows.push({ key: 'lowNoise(±0.15, 현행표) 최소 SSIM', cited: CITED_LOWNOISE_SSIM, actual: lowMin, diff: lowMin - CITED_LOWNOISE_SSIM, match: rnd(lowMin, 4) === CITED_LOWNOISE_SSIM });
  return rows;
}

const fx = (x, d) => x.toFixed(d);
export function formatB7(res) {
  const L = [];
  L.push(`SSIM 기준 ${TERRAIN_SSIM_MIN}. 집단 지표는 현행 절대표 [${res.table.join(', ')}], 조건 = 장면 × LOD1~3 중 간격 > 1 (같은 간격은 1 조건).`);
  L.push('');
  L.push('집단 | 장면 | 조건 | e/cellM 최소~최대 | 평균 각(°) 최소~최대 | RMS 각(°) 최소~최대 | 최대 각(°) 최소~최대 | SSIM 최소~최대 | SSIM 미달 조건');
  const names = { hill: 'hill(2 m 셀)', lowNoise: 'lowNoise(1 m 셀 ±0.15, 전체)', lowNoiseFail: 'lowNoise 중 SSIM 미달 조건', lowNoisePass: 'lowNoise 중 통과 조건' };
  for (const [k, g] of Object.entries(res.groups)) {
    if (!g.n) { L.push(`${names[k]} | ${g.scenes} | 0 | - | - | - | - | - | -`); continue; }
    const mm = (o, d) => `${fx(o.min, d)}~${fx(o.max, d)}`;
    L.push(`${names[k]} | ${g.scenes} | ${g.n} | ${mm(g.eOverCell, 3)} | ${mm(g.meanDeg, 2)} | ${mm(g.rmsDeg, 2)} | ${mm(g.maxDeg, 2)} | ${mm(g.ssimMin8, 4)} | ${g.failing ?? '-'}`);
  }
  L.push('');
  L.push('lowNoise012 반폭 인자 변형(결정 0057 규칙 상한, 시드 1~12, LOD1~3 = 36 조건)');
  L.push('반폭 | 상한표 | 간격 LOD0..3 | 최소 SSIM | 0.95 미만/조건 | 최악 e (m) | 최악 e/cellM');
  for (const h of res.halves) L.push(`±${fx(h.halfM, 2)} m | [${h.bounds.join(', ')}] | ${h.strides.join(',')} | ${fx(h.minSsim, 4)} | ${h.fail}/${h.conditions} | ${fx(h.worstEM, 4)} | ${fx(h.worstEOverCell, 4)}`);
  L.push('');
  L.push('0057 인용 수치와 재현 여부(0057 이 적은 자릿수로 반올림해 비교)');
  L.push('항목 | 0057 | 실측 | 차이 | 재현');
  for (const c of compareCited(res)) L.push(`${c.key} | ${c.cited} | ${fx(c.actual, 4)} | ${c.diff >= 0 ? '+' : ''}${fx(c.diff, 4)} | ${c.match ? '예' : '아니오'}`);
  return L.join('\n');
}

/** 인자 검사: 알려진 플래그는 --json 하나. 값 없음·모르는 토큰은 던진다. */
export function parseArgs(argv) {
  let json = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') {
      const v = argv[++i];
      if (v === undefined || v === '' || v.startsWith('--')) throw new Error('--json 값이 없다');
      json = v;
    } else throw new Error(`알 수 없는 인자: ${a}`);
  }
  return { json };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json } = parseArgs(process.argv.slice(2));
  const log = (s) => console.error(s);
  const res = measureGroups({ log });
  res.halves = measureHalves({ log });
  console.log(formatB7(res));
  if (json) writeFileSync(json, JSON.stringify(res, null, 2) + '\n');
}
