// [cloud] 합성 DEM 측정. T15.10b-B2: F-458 비교안 (iii) C1 면 법선 오차 상한 7.5° 를 지형 LOD 간격 선택 규칙으로 쓴 변형의 바이트·SSIM.
// 변형 규칙은 b2_mesh_lod.mjs(서버 mesh_lod 를 복사해 간격 판정만 바꾼 것). 서버 코드·계약은 바꾸지 않는다.
//
// 비교하는 규칙(같은 DEM 집합·같은 절차):
//   (i)    현 높이 상한 [0, 0.5, 1, 1] m            — 서버와 같은 규칙의 복사본(서버 terrainLodStride 와 간격이 같은지 단언)
//   (ii)   옛 높이 상한 [0, 0.5, 1, 2] m            — 참고(C1 이 대체하려던 기준선)
//   (iii)a 면 법선 7.5° 만(LOD 1~3, 높이 상한 없음)  — '높이 상한 대신'
//   (iii)b 옛 높이 [0,0.5,1,2] m + 면 법선 7.5°(LOD 1~3) — '함께'
//   (iii)c 옛 높이 [0,0.5,1,2] m + 면 법선 7.5°(LOD 3 만)
//   (iii)v·(iii)vc 위 a·c 와 같되 법선 오차를 보조 정의(보간 정점 법선 대 원본 정점 법선, DEM 표본점)로 잰 것.
//   C1 원래 지표 정의(커밋 84113df1)는 이 저장소에 없어 재현하지 못했다. 두 정의 모두 상한 7.5° 는 미리 정한 값 그대로다.
// 미리 정한 값(측정에 맞춰 바꾸지 않음): 법선 상한 7.5°(결정 0046 C1 행), SSIM 기준 0.95(contracts TERRAIN_SSIM_MIN), 초기 상한 15 MB
//   (bench/tower_assets INITIAL_LIMIT_BYTES), 시드 1~12, 잡음 {0, 0.015}, 160×90 8시점. 판정은 값만 보고하고 문턱으로 던지지 않는다.
//
// DEM 집합:
//   - smooth: bench/tower/lod_bytes 의 완만 DEM(1024 m, 1 m 셀)
//   - noiseBig/s: lod_bytes noiseBigDem(s), s = 1..12(1024 m, 1 m 셀, ±1 m 화소 잡음 — 잡음 진폭이 높이 상한 규모)
//   - hill/s/r: client/tower/terrain/fixtures makeHillDem({seed:s, noiseRatio:r}), s = 1..12, r ∈ {0, 0.015}
//     (256 m, 2 m 셀, ssim_views 의 24 장면. r = 0.015 는 ±0.15 m 로 잡음 진폭이 높이 상한보다 작은 장면)
// 바이트(raw, lod_bytes 와 같은 직렬화): 메시 형식 = 조각 프레임 머리 38 B + 메시 머리 16 B + f32 xyz + u32 인덱스,
//   높이만 형식 = 조각 프레임 머리 + 16 B + f32 cells². 1024 m DEM 은 256 타일 합, hill 은 16 타일 합. gzip 은 재지 않는다(ws 무압축).
// SSIM: ssim_views 2부와 같은 절차 — 타일 [-2,2)² 16장을 createTerrainLayer 로 그리고, 같은 DEM 의 LOD 0 메시를 ref_trace(정점 법선)·서버 램버트로
//   그린 기준 영상과 8시점 SSIM(3 채널)을 잰 뒤 최솟값. 1024 m DEM 도 간격은 256 타일 전체로 정하고, SSIM 은 가운데 16 타일만 본다.
// 실행: node bench/tower/terrain_options/b2_measure.mjs [--json]
import { fileURLToPath } from 'node:url';
import { createLodRule } from './b2_mesh_lod.mjs';
import { smoothDem, noiseBigDem } from '../lod_bytes.mjs';
import { terrainLodStride, terrainTileToMesh } from '../../../server/terrain/mesh_lod/index.mjs';
import { PIECE_FRAME_OVERHEAD_BYTES } from '../../../server/scheduler/initial/index.mjs';
import { TERRAIN_LOD_COUNT, TERRAIN_LOD_MAX_ERROR_M } from '../../../contracts/tower_assets/index.mjs';
import { TERRAIN_SSIM_MIN, TERRAIN_DEFAULTS } from '../../../contracts/controlview/terrain.mjs';
import { INITIAL_LIMIT_BYTES } from '../../tower_assets/index.mjs';
import { makeHillDem, towerViewpoints } from '../../../client/tower/terrain/fixtures.mjs';
import { createTerrainLayer } from '../../../client/tower/terrain/index.mjs';
import { createTracer } from '../../../client/tower/terrain/ref_trace.mjs';
import { lambert as serverLambert } from '../../../server/raster_ref/shade/index.mjs';
import { ssim } from '../../../server/metrics/ssim/index.mjs';

// ---- 미리 정한 값 ----
export const NORMAL_CAP_DEG = 7.5; // 결정 0046 C1 행
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const HILL_NOISES = [0, 0.015];
const MESH_HEADER_BYTES = 16;
const VTX = { normals: 'vertex' };

export const RULES = [
  { key: 'i', name: '(i) 높이 [0,0.5,1,1]', heightCapsM: [0, 0.5, 1, 1] },
  { key: 'ii', name: '(ii) 높이 [0,0.5,1,2]', heightCapsM: [0, 0.5, 1, 2] },
  { key: 'iiia', name: '(iii)a 법선 7.5° 만', normalCapDeg: [null, NORMAL_CAP_DEG, NORMAL_CAP_DEG, NORMAL_CAP_DEG] },
  { key: 'iiib', name: '(iii)b 높이(ii)+법선 L1~3', heightCapsM: [0, 0.5, 1, 2], normalCapDeg: [null, NORMAL_CAP_DEG, NORMAL_CAP_DEG, NORMAL_CAP_DEG] },
  { key: 'iiic', name: '(iii)c 높이(ii)+법선 L3', heightCapsM: [0, 0.5, 1, 2], normalCapDeg: [null, null, null, NORMAL_CAP_DEG] },
  // 보조 정의(보간 정점 법선 오차, b2_mesh_lod 머리 주석). 상한 값은 같다.
  { key: 'iiiv', name: '(iii)v 정점법선 7.5° 만', vertexNormalCapDeg: [null, NORMAL_CAP_DEG, NORMAL_CAP_DEG, NORMAL_CAP_DEG] },
  { key: 'iiivc', name: '(iii)vc 높이(ii)+정점법선 L3', heightCapsM: [0, 0.5, 1, 2], vertexNormalCapDeg: [null, null, null, NORMAL_CAP_DEG] },
];

/** 측정할 DEM 목록. tiles = 바이트를 합할 타일 [tx, ty] 목록. */
export function demSet() {
  const out = [];
  const big = (key, group, dem) => {
    const tiles = [];
    for (let ty = -8; ty < 8; ty++) for (let tx = -8; tx < 8; tx++) tiles.push([tx, ty]);
    out.push({ key, group, dem, tiles });
  };
  big('smooth', 'smooth', smoothDem());
  for (const s of SEEDS) big(`noiseBig/${s}`, 'noiseBig', noiseBigDem(s));
  for (const r of HILL_NOISES) {
    for (const s of SEEDS) {
      const tiles = [];
      for (let ty = -2; ty < 2; ty++) for (let tx = -2; tx < 2; tx++) tiles.push([tx, ty]);
      out.push({ key: `hill/${s}/${r}`, group: r === 0 ? 'hill0' : 'hill0.015', dem: makeHillDem({ seed: s, noiseRatio: r }), tiles });
    }
  }
  return out;
}

const SSIM_TILES = (() => {
  const t = [];
  for (let ty = -2; ty < 2; ty++) for (let tx = -2; tx < 2; tx++) t.push([tx, ty]);
  return t;
})();

function concatMeshes(meshes) {
  let nv = 0, nt = 0;
  for (const m of meshes) { nv += m.positions.length; nt += m.indices.length; }
  const positions = new Float32Array(nv), indices = new Uint32Array(nt), tileOfTriangle = new Int32Array(nt / 3);
  let vo = 0, io = 0, to = 0;
  meshes.forEach((m, n) => {
    positions.set(m.positions, vo);
    for (let k = 0; k < m.indices.length; k++) indices[io + k] = m.indices[k] + vo / 3;
    tileOfTriangle.fill(n, to, to + m.indices.length / 3);
    vo += m.positions.length; io += m.indices.length; to += m.indices.length / 3;
  });
  return { positions, indices, tileOfTriangle };
}

const shadeRef = (normal) => serverLambert(normal, TERRAIN_DEFAULTS.lightDirEnu, TERRAIN_DEFAULTS.baseRgb, { ambient: TERRAIN_DEFAULTS.ambient });

/** 간격 하나의 바이트(타일 목록 합). 간격이 같으면 규칙이 달라도 같으므로 (DEM, 간격) 으로 캐시한다. */
function bytesAt(entry, rule, lod, memo) {
  const stride = rule.lodStride(entry.dem, lod);
  const k = `${entry.key}|${stride}`;
  if (memo.has(k)) return memo.get(k);
  let mesh = 0, heightOnly = 0, cells = 0;
  for (const [tx, ty] of entry.tiles) {
    const tile = rule.buildTile(entry.dem, tx, ty, lod);
    const m = terrainTileToMesh(tile);
    cells = tile.cells;
    mesh += PIECE_FRAME_OVERHEAD_BYTES + MESH_HEADER_BYTES + m.positions.byteLength + m.indices.byteLength;
    heightOnly += PIECE_FRAME_OVERHEAD_BYTES + MESH_HEADER_BYTES + tile.heights.byteLength;
  }
  const v = { stride, cells, mesh, heightOnly };
  memo.set(k, v);
  return v;
}

/** 8시점 최소 SSIM. (DEM, 간격) 캐시. */
function ssimAt(entry, rule, lod, ctx) {
  const stride = rule.lodStride(entry.dem, lod);
  const k = `${entry.key}|${stride}`;
  if (ctx.ssimMemo.has(k)) return ctx.ssimMemo.get(k);
  const tiles = SSIM_TILES.map(([tx, ty]) => rule.buildTile(entry.dem, tx, ty, lod));
  const layer = createTerrainLayer();
  layer.accept(lod, tiles);
  const views = ctx.cams.map((c, v) => {
    const out = layer.render(c);
    return ssim(out.color, entry.refs[v].color, out.width, out.height, 3);
  });
  const v = { min: Math.min(...views), views };
  ctx.ssimMemo.set(k, v);
  return v;
}

function statsAt(entry, rule, stride, memo) {
  const k = `${entry.key}|${stride}`;
  if (!memo.has(k)) memo.set(k, stride === 1 ? { maxHeightErrM: 0, maxNormalErrDeg: 0, maxVertexNormalErrDeg: 0 } : rule.strideStats(entry.dem, stride));
  return memo.get(k);
}

export function measureAll({ log = () => {} } = {}) {
  const rules = RULES.map((r) => ({ ...r, ...createLodRule(r) }));
  const dems = demSet();
  const cams = towerViewpoints();
  const ctx = { cams, ssimMemo: new Map() };
  const bytesMemo = new Map(), statsMemo = new Map();
  const results = [];
  const serverMismatch = [];
  for (const entry of dems) {
    const t0 = Date.now();
    // 기준 영상: 같은 DEM 의 LOD 0(간격 1, 원본) 메시, 정점 법선 추적.
    const lod0 = SSIM_TILES.map(([tx, ty]) => rules[0].buildTile(entry.dem, tx, ty, 0));
    const tracer = createTracer(concatMeshes(lod0.map((tl) => terrainTileToMesh(tl))), VTX);
    entry.refs = cams.map((c) => tracer(c, shadeRef));
    // (i) 복사본이 서버 규칙과 같은 간격을 내는지(복사가 맞는지) 확인한다.
    for (let lod = 0; lod < TERRAIN_LOD_COUNT; lod++) {
      const a = rules[0].lodStride(entry.dem, lod), b = terrainLodStride(entry.dem, lod);
      if (a !== b) serverMismatch.push(`${entry.key} LOD${lod}: 복사본 ${a} 대 서버 ${b}`);
    }
    const perRule = {};
    for (const rule of rules) {
      const levels = [];
      for (let lod = 0; lod < TERRAIN_LOD_COUNT; lod++) {
        const b = bytesAt(entry, rule, lod, bytesMemo);
        const s = ssimAt(entry, rule, lod, ctx);
        levels.push({ lod, stride: b.stride, cellM: b.stride * entry.dem.cellM, cells: b.cells, meshBytes: b.mesh, heightOnlyBytes: b.heightOnly, ssimMin: s.min });
      }
      // LOD3 여백: 고른 간격과 그 두 배(거부된 간격 또는 명목 상한 위)의 최대 높이·법선 오차.
      const s3 = levels[3].stride;
      const chosen = statsAt(entry, rule, s3, statsMemo);
      // 명목 LOD3 간격(8 셀)보다 작게 물러났으면 한 단계 거친 간격(거부된 간격)의 오차도 낸다.
      const coarser = s3 < 8 ? statsAt(entry, rule, s3 * 2, statsMemo) : null;
      perRule[rule.key] = { levels, lod3Chosen: chosen, lod3Rejected: coarser, lod3FellBackToOriginal: s3 === 1 };
    }
    results.push({ key: entry.key, group: entry.group, tileCount: entry.tiles.length, cellM: entry.dem.cellM, perRule });
    log(`${entry.key} ${Date.now() - t0} ms`);
  }
  return {
    normalCapDeg: NORMAL_CAP_DEG,
    serverHeightCapsM: [...TERRAIN_LOD_MAX_ERROR_M],
    ssimMin: TERRAIN_SSIM_MIN,
    initialLimitBytes: INITIAL_LIMIT_BYTES,
    rules: RULES.map(({ key, name, heightCapsM = null, normalCapDeg = null, vertexNormalCapDeg = null }) => ({ key, name, heightCapsM, normalCapDeg, vertexNormalCapDeg })),
    serverMismatch,
    results,
  };
}

// ---- 표 출력 ----
const MB = (b) => (b / 1e6).toFixed(3);
const KB = (b) => (b / 1e3).toFixed(1);
const errs = (e) => `${e.maxHeightErrM.toFixed(3)} m ${e.maxNormalErrDeg.toFixed(2)}° ${e.maxVertexNormalErrDeg.toFixed(2)}°`;

function formatReport(r) {
  const lines = [];
  const p = (s) => lines.push(s);
  p(`[b2] 면 법선 상한 ${r.normalCapDeg}° 변형 비교 — SSIM 기준 ${r.ssimMin}, 초기 상한 ${r.initialLimitBytes} B (raw)`);
  p(`[b2] (i) 복사본 대 서버 terrainLodStride 간격 불일치: ${r.serverMismatch.length === 0 ? '없음' : r.serverMismatch.join('; ')}`);
  for (const rule of r.rules) {
    p('');
    p(`=== ${rule.name}  높이 상한 ${JSON.stringify(rule.heightCapsM)} m, 면 법선 상한 ${JSON.stringify(rule.normalCapDeg)}°, 정점 법선 상한 ${JSON.stringify(rule.vertexNormalCapDeg)}° ===`);
    p('DEM            타일 | 간격(m) L0/L1/L2/L3 | 메시 raw L0 / L1 / L2 / L3                 | 높이만 raw L0 / L1 / L2 / L3             | 8시점 최소 SSIM L0 / L1 / L2 / L3 | L3 최대 오차 높이·면법선·정점법선 (거부된 한 단계 거친 간격) | 표시');
    for (const d of r.results) {
      const x = d.perRule[rule.key];
      const L = x.levels;
      const big = d.tileCount === 256;
      const fmtB = big ? MB : KB;
      const unit = big ? 'MB' : 'kB';
      const flags = [];
      if (x.lod3FellBackToOriginal) flags.push('L3=원본');
      if (L[3].stride === L[2].stride) flags.push('L3=L2');
      if (big && L[3].meshBytes > r.initialLimitBytes) flags.push('L3메시>15MB');
      if (big && L[3].heightOnlyBytes > r.initialLimitBytes) flags.push('L3높이만>15MB');
      const below = L.slice(1).map((l, i) => (l.ssimMin < r.ssimMin ? `L${i + 1}<0.95` : null)).filter(Boolean);
      flags.push(...below);
      p(`${d.key.padEnd(15)}${String(d.tileCount).padStart(4)} | ${L.map((l) => String(l.cellM)).join('/').padEnd(19)} | ${L.map((l) => fmtB(l.meshBytes)).join(' / ')} ${unit}`.padEnd(97)
        + ` | ${L.map((l) => fmtB(l.heightOnlyBytes)).join(' / ')} ${unit}`.padEnd(43)
        + ` | ${L.map((l) => l.ssimMin.toFixed(4)).join(' / ')}`
        + ` | ${errs(x.lod3Chosen)}`
        + (x.lod3Rejected ? ` (거부 ${2 * L[3].cellM} m: ${errs(x.lod3Rejected)})` : '')
        + ` | ${flags.join(' ')}`);
    }
  }
  // 요약: 묶음별 LOD3 합계 바이트·최소 SSIM, (ii) 대비 LOD3 비용(결정 0046 비용 열과 같은 정의: hill 24 장면 LOD3 메시 바이트 합 비).
  p('');
  p('=== 요약(LOD3) ===');
  const groups = [['smooth', ['smooth']], ['noiseBig 1~12', ['noiseBig']], ['hill 24 장면', ['hill0', 'hill0.015']], ['hill 잡음 0.015(잡음 < 상한)', ['hill0.015']]];
  p('규칙                          | 묶음                          | L3 메시 raw 합     | L3 높이만 raw 합   | L3 원본 물러남 | L1/L2/L3 최소 SSIM          | L3 메시 비용 (ii) 대비 | (i) 대비');
  for (const rule of r.rules) {
    for (const [gname, gs] of groups) {
      const ds = r.results.filter((d) => gs.includes(d.group));
      const sum = (key, rk) => ds.reduce((a, d) => a + d.perRule[rk].levels[3][key], 0);
      const mesh = sum('meshBytes', rule.key), ho = sum('heightOnlyBytes', rule.key);
      const fell = ds.filter((d) => d.perRule[rule.key].lod3FellBackToOriginal).length;
      const mins = [1, 2, 3].map((l) => Math.min(...ds.map((d) => d.perRule[rule.key].levels[l].ssimMin)));
      p(`${rule.name.padEnd(30)}| ${gname.padEnd(30)}| ${String(mesh).padStart(12)} B | ${String(ho).padStart(12)} B | ${String(fell).padStart(2)}/${String(ds.length).padEnd(11)}| ${mins.map((v) => v.toFixed(4)).join(' / ').padEnd(28)}| ${(mesh / sum('meshBytes', 'ii')).toFixed(3).padStart(22)} | ${(mesh / sum('meshBytes', 'i')).toFixed(3)}`);
    }
  }
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const t0 = Date.now();
  const report = measureAll({ log: (s) => process.stderr.write(`[b2] ${s}\n`) });
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else console.log(formatReport(report));
  process.stderr.write(`[b2] 합계 ${Date.now() - t0} ms\n`);
}

export { formatReport };
