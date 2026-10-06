// [cloud] T15.10b-B3: F-458 비교안 (iv) LOD3 정점 수 상한 / 타일별 간격 — LOD0~3 raw 바이트와 8시점 최소 SSIM.
// 실행: node bench/tower/terrain_options/b3_measure.mjs   (표를 표준 출력에 낸다, 문턱으로 던지지 않는다)
//
// 미리 정한 것(측정 결과를 보고 바꾸지 않음)
// - 기준: SSIM ≥ 0.95(contracts/controlview TERRAIN_SSIM_MIN), 초기 ≤ 15,000,000 B(bench/tower_assets INITIAL_LIMIT_BYTES). 낮추지 않는다.
// - 예산 정의: raw 웹소켓 바이트(압축 없음, 서버 ws 에 permessage-deflate 없음). 지형 몫 = 15 MB − 건물 − 드레이프 밉2 − WELCOME 프레임
//   (건물·드레이프는 bench/tower_assets measureTowerAssets 를 이 실행에서 다시 잰 값).
// - 정점 상한 후보: ① 예산 유도 N_budget = 1 m DEM 256 타일을 메시 형식으로 보냈을 때 지형 몫에 들어가는 가장 큰 c²(c = 64/s+1, s 는 2 의 거듭제곱).
//   ② 289(17², 1 m DEM 에서 4 m 간격 = 명목 LOD2) ③ 81(9², 1 m DEM 명목 LOD3 8 m 간격 = LOD3 에서 오차 상한을 사실상 끔).
// - 타일별 간격 변형 2종(봉합 없음 / 가는 쪽 변 맞춤)은 b3_lod.mjs 머리 주석.
// - DEM 집합: 바이트는 bench/tower/lod_bytes.mjs 의 완만 DEM 과 noiseBig 시드 1~12(1024 m, 1 m 셀, 64 m 타일 256장).
//   SSIM 은 같은 DEM 의 가운데 4×4 타일(tx, ty ∈ [−2, 1], ENU ±128 m)을 ssim_views 절차(160×90, 8시점, LOD0 기준 영상)로 잰다.
//   보충: ssim_views 의 24 장면(makeHillDem 시드 1~12 × 잡음 {0, 0.015}, 4×4 타일, 2 m 셀) — 0.95 가 정해진 장면이라 함께 잰다.
// - 완만 DEM 은 가운데 높이가 약 9.7~30.3 m 라 눈 높이 17 m 시점이 지형 안에 묻힌다. SSIM 에서만 높이를 상수만큼 내려
//   가운데 4×4 타일 최고점을 15 m(towerViewpoints 가 가정한 지형 상한)로 맞춘다. 간격 선택은 상수 이동에 불변이어야 하며, 실제로 같은지 대조해 출력한다.
// 한계: 합성 DEM 이다(실제 DEM T14L 은 [local] 미측정). 시야 선택 없음(256 타일 전부). 스커트안은 재지 않았다.
import { fileURLToPath } from 'node:url';
import { TERRAIN_LOD_MAX_ERROR_M } from '../../../contracts/tower_assets/index.mjs';
import { TERRAIN_SSIM_MIN } from '../../../contracts/controlview/terrain.mjs';
import { terrainLodStride, buildTerrainTile } from '../../../server/terrain/mesh_lod/index.mjs';
import { WELCOME_FRAME_BYTES } from '../../../server/scheduler/initial/index.mjs';
import { INITIAL_LIMIT_BYTES, measureTowerAssets } from '../../tower_assets/index.mjs';
import { smoothDem, noiseBigDem, measureLodBytes } from '../lod_bytes.mjs';
import { makeHillDem, towerViewpoints } from '../../../client/tower/terrain/fixtures.mjs';
import { createTerrainLayer } from '../../../client/tower/terrain/index.mjs';
import { buildLayerMesh } from '../../../client/tower/terrain/mesh.mjs';
import {
  demTiles, globalStrideCopy, makeVariants, buildVariantTiles, tileError, crackStats, meshTileBytes, heightTileBytes,
} from './b3_lod.mjs';
import { buildMixedLayerMesh, renderMixed, referenceImages, ssimViews } from './b3_render.mjs';

const LODS = [0, 1, 2, 3];
const CROP = [];
for (let ty = -2; ty < 2; ty++) for (let tx = -2; tx < 2; tx++) CROP.push(`${tx},${ty}`);
const VIEW_TERRAIN_TOP_M = 15; // towerViewpoints 의 TOWER_EYE_MIN_U_M(17) = 지형 상한 15 + 2 의 가정

function silent(fn) {
  const log = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = log; }
}

/** 예산과 예산 유도 정점 상한. */
function budget() {
  const a = silent(() => measureTowerAssets());
  const buildings = a.breakdown.buildings, drape = a.breakdown.drape;
  const terrainBudget = INITIAL_LIMIT_BYTES - buildings - drape - WELCOME_FRAME_BYTES;
  // 1 m DEM(n0 = 64) 256 타일, 메시 형식으로 들어가는 가장 큰 c
  let capC = 0;
  for (let s = 1; s <= 64; s *= 2) {
    const c = 64 / s + 1;
    if (256 * meshTileBytes(c) <= terrainBudget) { capC = c; break; }
  }
  return { buildings, drape, welcome: WELCOME_FRAME_BYTES, terrainBudget, budgetCapVertices: capC * capC };
}

function shifted(dem, dz) {
  const h = new Float32Array(dem.heights.length);
  for (let k = 0; k < h.length; k++) h[k] = dem.heights[k] - dz;
  return { ...dem, heights: h };
}

/** 가운데 4×4 타일(DEM 표본) 최고점. */
function cropMax(dem, ctx) {
  let m = -Infinity;
  for (const k of CROP) {
    const tl = ctx.byKey.get(k);
    for (let j = 0; j <= ctx.n0; j++) for (let i = 0; i <= ctx.n0; i++) m = Math.max(m, dem.heights[(tl.j0 + j) * dem.width + tl.i0 + i]);
  }
  return m;
}

// 변형 간격 캐시: 같은 strides 함수(perTile·perTileSnap 공유)를 DEM·LOD 마다 한 번만 계산한다.
function cachedVariants(variants) {
  return variants.map((v) => {
    const cache = new WeakMap();
    const fn = v.strides;
    return {
      ...v,
      strides: (dem, ctx, lod) => {
        let e = cache.get(dem.heights);
        if (!e) { e = new Map(); cache.set(dem.heights, e); }
        if (!e.has(lod)) e.set(lod, fn(dem, ctx, lod));
        return e.get(lod);
      },
    };
  });
}

/** 한 DEM 의 모든 변형 × LOD: 바이트·오차·균열(타일 전부). */
function measureBytes(dem, variants) {
  const ctx = demTiles(dem);
  const out = {};
  for (const v of variants) {
    const levels = [];
    for (const lod of LODS) {
      const { tiles, strideMap } = buildVariantTiles(dem, ctx, v, lod);
      let mesh = 0, height = 0, maxErr = 0, overLimit = 0;
      const strideSet = new Set(strideMap.values());
      for (const t of tiles) {
        mesh += meshTileBytes(t.cells);
        height += heightTileBytes(t.cells);
        if (lod > 0) {
          const e = tileError(dem, ctx, t);
          if (e > maxErr) maxErr = e;
          if (e > TERRAIN_LOD_MAX_ERROR_M[lod]) overLimit++; // 서버와 같은 비교(> 상한)
        }
      }
      const cracks = lod > 0 ? crackStats(dem, ctx, tiles) : null;
      levels.push({ lod, mesh, height, maxErr, overLimit, strides: [...strideSet].sort((a, b) => a - b), cracks, tiles: tiles.length });
    }
    out[v.name] = levels;
  }
  return { ctx, out };
}

/** 한 DEM 의 가운데 4×4 타일 SSIM(변형 × LOD 1~3 의 8시점 최소, LOD0 은 한 번). */
function measureSsim(dem, variants, cams, keys = CROP) {
  const ctx = demTiles(dem);
  const lod0 = keys.map((k) => { const [tx, ty] = k.split(',').map(Number); return buildTerrainTile(dem, tx, ty, 0); });
  const refs = referenceImages(cams, lod0);
  const lod0Min = Math.min(...ssimViews(cams, renderMixed(cams, lod0), refs));
  const res = { lod0Min };
  for (const v of variants) {
    res[v.name] = [1, 2, 3].map((lod) => {
      const { tiles } = buildVariantTiles(dem, ctx, v, lod, keys);
      return Math.min(...ssimViews(cams, renderMixed(cams, tiles), refs));
    });
  }
  return res;
}

const mb = (b) => (b / 1e6).toFixed(3);
const f4 = (x) => x.toFixed(4);
const flag = (s) => (s < TERRAIN_SSIM_MIN ? `${f4(s)}*` : f4(s));

export function runAll() {
  const t0 = Date.now();
  const B = budget();
  const variants = cachedVariants(makeVariants({ budgetCapVertices: B.budgetCapVertices }));
  const cams = towerViewpoints();
  const checks = [];

  // ---- 바이트용 DEM ----
  const dems = [{ name: 'smooth', dem: smoothDem() }];
  for (let s = 1; s <= 12; s++) dems.push({ name: `noiseBig${s}`, dem: noiseBigDem(s) });

  // 대조 1: 제품 규칙 사본 = 서버 terrainLodStride
  for (const { name, dem } of dems.slice(0, 2)) {
    for (const lod of LODS) {
      const a = terrainLodStride(dem, lod), b = globalStrideCopy(dem, lod);
      checks.push([`전역 간격 사본 = 서버 (${name} LOD${lod})`, a === b, `${a} / ${b}`]);
    }
  }

  const rows = [];
  for (const d of dems) {
    const { ctx, out } = measureBytes(d.dem, variants);
    let dz = 0, ssimDem = d.dem;
    if (d.name === 'smooth') {
      dz = cropMax(d.dem, ctx) - VIEW_TERRAIN_TOP_M;
      ssimDem = shifted(d.dem, dz);
      const ctxS = demTiles(ssimDem);
      for (const v of variants) {
        for (const lod of LODS) {
          const a = [...v.strides(d.dem, ctx, lod).values()].join(',');
          const b = [...v.strides(ssimDem, ctxS, lod).values()].join(',');
          if (a !== b) checks.push([`완만 DEM 높이 이동 후 간격 불변 (${v.name} LOD${lod})`, false, '다름']);
        }
      }
      checks.push([`완만 DEM SSIM 용 높이 이동 ${dz.toFixed(3)} m 뒤 모든 변형·LOD 간격 불변`, !checks.some((c) => c[0].startsWith('완만 DEM 높이 이동') && !c[1]), '']);
    }
    const ss = measureSsim(ssimDem, variants, cams);
    rows.push({ name: d.name, bytes: out, ssim: ss, dz });
    if (d.name === 'smooth') {
      // 대조 2: 바이트 계산 = lod_bytes.mjs 직렬화 길이(baseline)
      const lb = measureLodBytes(d.dem);
      const ok = LODS.every((l) => lb.levels[l].rawBytes === out.baseline[l].mesh && lb.levels[l].heightOnlyBytes === out.baseline[l].height);
      checks.push(['바이트 식 = lod_bytes.mjs measureLodBytes(완만, raw·높이만)', ok, lb.levels.map((l) => l.rawBytes).join('/')]);
      // 대조 3: 혼합 메시 사본 = 제품 buildLayerMesh(cells 같은 묶음), 렌더 = createTerrainLayer
      const lod3 = CROP.map((k) => { const [tx, ty] = k.split(',').map(Number); return buildTerrainTile(ssimDem, tx, ty, 3); });
      const a = buildLayerMesh(lod3), b = buildMixedLayerMesh(lod3);
      const same = ['positions', 'indices', 'normals', 'tileOfTriangle'].every((f) => a[f].length === b[f].length && a[f].every((x, i) => Object.is(x, b[f][i])));
      checks.push(['buildMixedLayerMesh 사본 = 제품 buildLayerMesh(완만 LOD3 가운데 16 타일, 비트)', same, '']);
      const layer = createTerrainLayer();
      layer.accept(3, lod3);
      const imgsA = cams.map((c) => layer.render(c)), imgsB = renderMixed(cams, lod3);
      const px = imgsA.every((im, v) => im.color.every((x, i) => x === imgsB[v].color[i]));
      checks.push(['renderMixed = createTerrainLayer.render(완만 LOD3, 8시점 화소)', px, '']);
    }
  }

  // ---- 보충: ssim_views 24 장면 ----
  const hill = [];
  for (const noise of [0, 0.015]) {
    for (let seed = 1; seed <= 12; seed++) {
      const dem = makeHillDem({ seed, noiseRatio: noise });
      const { out } = measureBytes(dem, variants);
      const ss = measureSsim(dem, variants, cams);
      hill.push({ name: `hill${seed}/${noise}`, bytes: out, ssim: ss });
    }
  }
  return { B, variants, rows, hill, checks, ms: Date.now() - t0 };
}

function printAll(r) {
  const { B, variants, rows, hill, checks } = r;
  const P = (s = '') => console.log(s);
  P('# T15.10b-B3 LOD3 정점 수 상한 / 타일별 간격 — [cloud] 합성 DEM');
  P();
  P(`예산(raw ws 바이트): 초기 상한 ${INITIAL_LIMIT_BYTES} − 건물 ${B.buildings} − 드레이프 밉2 ${B.drape} − WELCOME ${B.welcome} = 지형 몫 ${B.terrainBudget} B`);
  P(`예산 유도 정점 상한 N_budget = ${B.budgetCapVertices} (1 m DEM 256 타일 메시 형식 ${256 * meshTileBytes(Math.sqrt(B.budgetCapVertices))} B ≤ 지형 몫)`);
  P(`오차 상한(계약) LOD0~3 = [${TERRAIN_LOD_MAX_ERROR_M.join(', ')}] m, SSIM 기준 ${TERRAIN_SSIM_MIN}(낮추지 않음). '*' = 0.95 미만.`);
  P();
  P('## 변형');
  for (const v of variants) P(`- ${v.name}: ${v.label}`);
  P();
  P('## 대조(측정 도구 자체 검사)');
  for (const [n, ok, d] of checks) P(`- [${ok ? 'OK' : 'FAIL'}] ${n}${d ? ` (${d})` : ''}`);
  P();
  P('## 표 1. LOD0~3 raw 바이트(256 타일), 메시 형식 / 높이만 형식, 초기 합계 판정(건물+드레이프+WELCOME+지형 LOD3)');
  P('| DEM | 변형 | 메시 LOD0 | LOD1 | LOD2 | LOD3 (MB) | 높이만 LOD0 | LOD1 | LOD2 | LOD3 (B) | LOD3 간격(셀) | 초기 메시 | 초기 높이만 |');
  P('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  const base = B.buildings + B.drape + B.welcome;
  for (const row of rows) {
    for (const v of variants) {
      const L = row.bytes[v.name];
      const im = base + L[3].mesh, ih = base + L[3].height;
      P(`| ${row.name} | ${v.name} | ${L.map((l) => mb(l.mesh)).join(' | ')} | ${L.map((l) => l.height).join(' | ')} | ${L[3].strides.join('·')} | ${im} ${im <= INITIAL_LIMIT_BYTES ? 'PASS' : 'FAIL'} | ${ih} ${ih <= INITIAL_LIMIT_BYTES ? 'PASS' : 'FAIL'} |`);
    }
  }
  P();
  P('## 표 2. 품질: 가운데 4×4 타일 8시점 최소 SSIM(LOD1·2·3), 최대 높이 오차, 같은 LOD 이웃 균열(256 타일)');
  P('균열 = 간격이 다른 이웃 변 수 / 틈 > 0.1 mm 변 수 / 전체 이웃 변 수, 최대 틈(m), 틈 구간 길이 합(m). LOD1~3 각각, 틈 없으면 0.');
  P('| DEM | 변형 | LOD0 SSIM | SSIM LOD1 | LOD2 | LOD3 | 최대오차 LOD1/2/3 (m) | 상한 초과 타일 LOD1/2/3 | 균열 LOD1 | LOD2 | LOD3 |');
  P('|---|---|---|---|---|---|---|---|---|---|---|');
  const crk = (c) => (c.crackEdges === 0 && c.mismatchedEdges === 0 ? '0' : `${c.mismatchedEdges}/${c.crackEdges}/${c.edges} 최대 ${c.maxGapM.toFixed(3)} 길이 ${c.crackLengthM}`);
  for (const row of [...rows, ...hill]) {
    for (const v of variants) {
      const L = row.bytes[v.name];
      const s = row.ssim[v.name];
      P(`| ${row.name} | ${v.name} | ${f4(row.ssim.lod0Min)} | ${s.map(flag).join(' | ')} | ${L.slice(1).map((l) => l.maxErr.toFixed(3)).join('/')} | ${L.slice(1).map((l) => `${l.overLimit}`).join('/')} of ${L[1].tiles} | ${L.slice(1).map((l) => crk(l.cracks)).join(' | ')} |`);
    }
  }
  P();
  P('## 표 3. 요약(변형별)');
  P('noiseBig = 시드 1~12 의 최댓값(바이트·오차·틈)·최솟값(SSIM). hill24 = ssim_views 24 장면(4×4 타일 = 16 타일 바이트 합, 24 장면 합).');
  P('| 변형 | 완만 LOD3 메시 B | 완만 LOD3 높이만 B | 완만 SSIM L1/L2/L3 | noiseBig LOD3 메시 B(최대) | 높이만 B(최대) | 초기 메시 최대 | noiseBig SSIM L1/L2/L3(최소) | noiseBig LOD3 오차 최대 m | hill24 LOD3 메시 합 B | hill24 SSIM L1/L2/L3 최소 | 0.95 미만 조건 수(전체) | LOD1~3 최대 틈 m(전체) | LOD1~3 상한 초과 타일(전체) |');
  P('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const v of variants) {
    const sm = rows[0];
    const nb = rows.slice(1);
    const nbMesh = Math.max(...nb.map((r2) => r2.bytes[v.name][3].mesh));
    const nbH = Math.max(...nb.map((r2) => r2.bytes[v.name][3].height));
    const nbS = [0, 1, 2].map((i) => Math.min(...nb.map((r2) => r2.ssim[v.name][i])));
    const nbE = Math.max(...nb.map((r2) => r2.bytes[v.name][3].maxErr));
    const hS = [0, 1, 2].map((i) => Math.min(...hill.map((r2) => r2.ssim[v.name][i])));
    const hB = hill.reduce((a, r2) => a + r2.bytes[v.name][3].mesh, 0);
    const all = [...rows, ...hill];
    const below = all.reduce((a, r2) => a + r2.ssim[v.name].filter((x) => x < TERRAIN_SSIM_MIN).length, 0);
    const gap = Math.max(...all.flatMap((r2) => r2.bytes[v.name].slice(1).map((l) => l.cracks.maxGapM)));
    const over = all.reduce((a, r2) => a + r2.bytes[v.name].slice(1).reduce((b, l) => b + l.overLimit, 0), 0);
    const tilesAll = all.reduce((a, r2) => a + 3 * r2.bytes[v.name][1].tiles, 0);
    P(`| ${v.name} | ${sm.bytes[v.name][3].mesh} | ${sm.bytes[v.name][3].height} | ${sm.ssim[v.name].map(flag).join('/')} | ${nbMesh} | ${nbH} | ${base + nbMesh} ${base + nbMesh <= INITIAL_LIMIT_BYTES ? 'PASS' : 'FAIL'} | ${nbS.map(flag).join('/')} | ${nbE.toFixed(3)} | ${hB} | ${hS.map(flag).join('/')} | ${below} / ${all.length * 3} | ${gap.toFixed(4)} | ${over} / ${tilesAll} |`);
  }
  P();
  P(`실행 시간 ${(r.ms / 1000).toFixed(1)} s`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  printAll(runAll());
}
