// 관제탑 드레이프 정합 시험(T15.2): 기복 있는 지형 · 비스듬한 시점. 기준 = contracts/controlview DRAPE_ALIGN_MAX_PX(1 px).
// 장면: client/tower/terrain/fixtures.mjs 의 합성 DEM(시드 1..6) → server mesh_lod LOD 0 타일 → 지형 층.
// 위성 영상: 같은 장면 범위(ENU [-128,128]²)를 0.5 m/화소 512×512 로 덮는 좌표 식별 무늬.
//   R = x 방향 삼각파 그라디언트(주기 32 m, 기울기 약 16 단계/m), G = y 방향 같은 그라디언트, B = 8 m 간격 격자선.
//   삼각파는 이어져 있으므로(톱니와 달리 끊김 없음) 접힘선 근처만 빼면 색 → 좌표 관계가 선형이다.
//   server/terrain/drape buildDrapeTile 로 밉 0 타일 16 개(128×128 화소, 영상 화소와 1:1)를 만든다.
// 시점: fixtures.towerViewpoints() 8곳(160×90, 낮은 시점은 눈 높이 17 m 로 올림, 지형 위 비스듬한 시선 포함).
// 기준 영상: 지형 층 depth 로 화소 중심 광선–지형 교점 ENU (x, y) 를 이 파일 안의 독립 역투영으로 구하고,
//   영상 원본에서 직접 이중선형 표본한 색(반올림 없음). 드레이프 층 구현(unproject·sample·store)과 코드를 공유하지 않는다.
// 정합 오차(서브픽셀 이동 측정):
//   결과 색 ≈ I(P + δ) 모형(I = 원본 영상 이중선형, P = 화소의 ENU 점)으로 δ(m)를 가우스–뉴턴 최소제곱으로 푼다.
//   δ 는 시점 전체 하나와 드레이프 타일별 하나씩 푼다(타일 단위 어긋남도 잡는다). 결과의 무늬는 지면에서 −δ 만큼 옮겨 보이므로
//   화면 이동 = |π(P − δ) − π(P)| (π = 카메라 투영, 화면 화소). 묶음마다 그 RMS 를 내고, 시점의 정합 오차 = 묶음 RMS 최대값.
// 음성: 영상 bounds 를 동쪽으로 1.5 영상 화소(0.75 m) 옮겨 만든 타일은 모든 시점에서 1 px 초과로 잡혀야 한다.
// 빈 화소: 지형 render 가 빈 화소(depth 0)인 곳은 결과도 depth 0, 색 0, index −1 그대로다.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { DRAPE_ALIGN_MAX_PX } from '../../../contracts/controlview/drape.mjs';
import { EMPTY_DEPTH, EMPTY_INDEX } from '../../../contracts/raster/index.mjs';
import { tileBounds } from '../../../contracts/tower_assets/index.mjs';
import { makeHillDem, towerViewpoints, mulberry32 } from '../terrain/fixtures.mjs';
import { createTerrainLayer } from '../terrain/index.mjs';
import { buildTerrainTile } from '../../../server/terrain/mesh_lod/index.mjs';
import { buildDrapeTile } from '../../../server/terrain/drape/index.mjs';

// ---- 미리 정한 수치(측정에 맞춰 바꾸지 않는다) ----
const SEEDS = [1, 2, 3, 4, 5, 6];
const IMG_PX_M = 0.5; // 영상 화소 크기(m)
const IMG_MIN = -128, IMG_MAX = 128; // 영상 범위(ENU, 지형 DEM 과 같다)
const TRI_HALF_M = 16; // 삼각파 반주기(0 → 255 까지 16 m)
const GRID_M = 8; // 격자 간격
const GRID_HALF_W_M = 0.5; // 격자선 반폭
const SHIFT_IMG_PX = 1.5; // 음성 시험 어긋남(영상 화소)
const FOLD_MARGIN_M = 1.5; // 삼각파 접힘선에서 이만큼 안쪽은 그 채널을 풀이에 쓰지 않는다
const EDGE_MARGIN_M = 1; // 영상 바깥 경계 근처(기준 표본이 고정되는 곳)는 뺀다
const GROUP_MIN_PX = 20; // 타일 묶음 풀이에 필요한 최소 화소 수
const COLOR_MAE_MAX = 2; // 정상 경로 R·G 평균 절대 차 상한(접힘·격자와 무관한 채널, 반올림·이음 고정 몫)

// ---- 무늬 ----
function tri(t) { const m = ((t % 2) + 2) % 2; return m <= 1 ? m : 2 - m; } // 0..1..0, 주기 2
function phases(seed) { const r = mulberry32((seed * 7919) >>> 0); return { px: r() * 32, py: r() * 32 }; }
function patternAt(ph, x, y) {
  const r = 255 * tri((x + ph.px) / TRI_HALF_M);
  const g = 255 * tri((y + ph.py) / TRI_HALF_M);
  const gx = Math.abs(x - GRID_M * Math.round(x / GRID_M));
  const gy = Math.abs(y - GRID_M * Math.round(y / GRID_M));
  const b = Math.min(gx, gy) < GRID_HALF_W_M ? 220 : 30;
  return [r, g, b];
}
/** 접힘선(삼각파 꼭짓점)까지 거리(m). */
function foldDist(v, p) { const t = (v + p) / TRI_HALF_M; return Math.abs(t - Math.round(t)) * TRI_HALF_M; }

/** 영상 원본(행 우선, 위=북). 화소 (c, r) 중심 = (minX + (c+0.5)·s, maxY − (r+0.5)·s). */
function makeImage(seed, shiftX = 0) {
  const n = Math.round((IMG_MAX - IMG_MIN) / IMG_PX_M);
  const ph = phases(seed);
  const rgb = new Uint8Array(n * n * 3);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const v = patternAt(ph, IMG_MIN + (c + 0.5) * IMG_PX_M, IMG_MAX - (r + 0.5) * IMG_PX_M);
      const o = (r * n + c) * 3;
      rgb[o] = Math.round(v[0]); rgb[o + 1] = Math.round(v[1]); rgb[o + 2] = Math.round(v[2]);
    }
  }
  // shiftX 는 bounds 만 옮긴다(내용은 같고 지면 위 위치가 동쪽으로 shiftX m 밀린 영상).
  return { width: n, height: n, rgb, bounds: { minX: IMG_MIN + shiftX, minY: IMG_MIN, maxX: IMG_MAX + shiftX, maxY: IMG_MAX }, ph };
}

/** 원본 영상(어긋나지 않은 것) 직접 이중선형 표본. 화소 중심 기준, 가장자리는 고정. 반올림하지 않는다. */
function sampleImage(img, x, y) {
  const n = img.width;
  const u = Math.min(n - 1, Math.max(0, (x - img.bounds.minX) / IMG_PX_M - 0.5));
  const v = Math.min(n - 1, Math.max(0, (img.bounds.maxY - y) / IMG_PX_M - 0.5));
  const c0 = Math.min(n - 2, Math.floor(u)), r0 = Math.min(n - 2, Math.floor(v));
  const fx = u - c0, fy = v - r0;
  const out = [0, 0, 0];
  const a = img.rgb;
  for (let k = 0; k < 3; k++) {
    const p00 = a[(r0 * n + c0) * 3 + k], p10 = a[(r0 * n + c0 + 1) * 3 + k];
    const p01 = a[((r0 + 1) * n + c0) * 3 + k], p11 = a[((r0 + 1) * n + c0 + 1) * 3 + k];
    out[k] = (p00 * (1 - fx) + p10 * fx) * (1 - fy) + (p01 * (1 - fx) + p11 * fx) * fy;
  }
  return out;
}

// ---- 카메라(드레이프 구현과 독립) ----
/** 화소 (i, j) 칸 중심과 깊이 d → ENU. X_c = d·K⁻¹[u,v,1], X_w = Rᵀ(X_c − t). */
function unprojectRef(cam, i, j, d) {
  const { K, R, t } = cam;
  const a = (d * (i + 0.5 - K.cx)) / K.fx - t[0];
  const b = (d * (j + 0.5 - K.cy)) / K.fy - t[1];
  const c = d - t[2];
  return [R[0] * a + R[3] * b + R[6] * c, R[1] * a + R[4] * b + R[7] * c, R[2] * a + R[5] * b + R[8] * c];
}
/** ENU → 화면 연속 좌표(u, v). */
function project(cam, X) {
  const { K, R, t } = cam;
  const xc = R[0] * X[0] + R[1] * X[1] + R[2] * X[2] + t[0];
  const yc = R[3] * X[0] + R[4] * X[1] + R[5] * X[2] + t[1];
  const zc = R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + t[2];
  return [K.fx * (xc / zc) + K.cx, K.fy * (yc / zc) + K.cy];
}

function tileKey(x, y) { return `${Math.floor(x / 64)},${Math.floor(y / 64)}`; }

/**
 * 표본 목록 [{P:[x,y,z], c:[r,g,b], useR, useG}] 에서 결과 ≈ I(P + δ) 의 δ 를 푼다(가우스–뉴턴, R → δx, G → δy).
 * 같은 무늬에서 R 은 x 만, G 는 y 만의 함수이므로 두 축은 따로 풀린다.
 */
function solveShift(img, samples) {
  let dx = 0, dy = 0;
  const h = 0.05;
  for (let it = 0; it < 6; it++) {
    let sxx = 0, sxr = 0, syy = 0, syr = 0;
    for (const s of samples) {
      const x = s.P[0] + dx, y = s.P[1] + dy;
      const f = sampleImage(img, x, y);
      if (s.useR) {
        const jx = (sampleImage(img, x + h, y)[0] - sampleImage(img, x - h, y)[0]) / (2 * h);
        sxx += jx * jx; sxr += jx * (s.c[0] - f[0]);
      }
      if (s.useG) {
        const jy = (sampleImage(img, x, y + h)[1] - sampleImage(img, x, y - h)[1]) / (2 * h);
        syy += jy * jy; syr += jy * (s.c[1] - f[1]);
      }
    }
    const sx = sxx > 0 ? sxr / sxx : 0, sy = syy > 0 ? syr / syy : 0;
    dx += sx; dy += sy;
    if (Math.abs(sx) < 1e-5 && Math.abs(sy) < 1e-5) break;
  }
  return [dx, dy];
}

/** 묶음의 화면 이동 RMS(px): |π(P − δ) − π(P)|. */
function screenRms(cam, samples, d) {
  let s2 = 0;
  for (const s of samples) {
    const a = project(cam, s.P);
    const b = project(cam, [s.P[0] - d[0], s.P[1] - d[1], s.P[2]]);
    s2 += (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  }
  return Math.sqrt(s2 / samples.length);
}

/**
 * 한 시점의 정합 측정. 결과 = 드레이프 층 출력, 기준 = 지형 depth → ENU → 원본 이중선형.
 * @returns {{ errPx, globalPx, globalShift, groups, mae, n }}
 */
function measureView(cam, terrain, result, img) {
  const all = [];
  const groups = new Map();
  let maeSum = 0, maeN = 0;
  for (let j = 0; j < cam.height; j++) {
    for (let i = 0; i < cam.width; i++) {
      const p = j * cam.width + i;
      const d = terrain.depth[p];
      if (!(d > 0)) continue;
      const P = unprojectRef(cam, i, j, d);
      if (P[0] < IMG_MIN + EDGE_MARGIN_M || P[0] > IMG_MAX - EDGE_MARGIN_M || P[1] < IMG_MIN + EDGE_MARGIN_M || P[1] > IMG_MAX - EDGE_MARGIN_M) continue;
      const c = [result.color[3 * p], result.color[3 * p + 1], result.color[3 * p + 2]];
      const useR = foldDist(P[0], img.ph.px) > FOLD_MARGIN_M;
      const useG = foldDist(P[1], img.ph.py) > FOLD_MARGIN_M;
      const ref = sampleImage(img, P[0], P[1]);
      if (useR) { maeSum += Math.abs(c[0] - ref[0]); maeN++; }
      if (useG) { maeSum += Math.abs(c[1] - ref[1]); maeN++; }
      if (!useR && !useG) continue;
      const s = { P, c, useR, useG };
      all.push(s);
      const k = tileKey(P[0], P[1]);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    }
  }
  assert.ok(all.length > 500, `${cam.name}: 측정 화소가 너무 적다(${all.length})`);
  const globalShift = solveShift(img, all);
  const globalPx = screenRms(cam, all, globalShift);
  let errPx = globalPx;
  const per = [];
  for (const [k, list] of groups) {
    if (list.length < GROUP_MIN_PX) continue;
    const dd = solveShift(img, list);
    const px = screenRms(cam, list, dd);
    per.push({ k, n: list.length, px, d: dd });
    errPx = Math.max(errPx, px);
  }
  return { errPx, globalPx, globalShift, groups: per, mae: maeN ? maeSum / maeN : 0, n: all.length };
}

function drapeTilesFor(image) {
  const tiles = [];
  for (let ty = -2; ty < 2; ty++) for (let tx = -2; tx < 2; tx++) tiles.push(buildDrapeTile(image, tx, ty, 0));
  return tiles;
}

function terrainTilesFor(dem) {
  const tiles = [];
  for (let ty = -2; ty < 2; ty++) for (let tx = -2; tx < 2; tx++) tiles.push(buildTerrainTile(dem, tx, ty, 0));
  return tiles;
}

describe('드레이프 정합: 기복 지형 · 비스듬한 8시점(시드 1..6)', () => {
  let createDrapeLayer;
  let cams;
  const scenes = [];

  before(async () => {
    ({ createDrapeLayer } = await import('./index.mjs'));
    cams = towerViewpoints();
    assert.equal(cams.length, 8);
    for (const seed of SEEDS) {
      const dem = makeHillDem({ seed });
      const terrain = createTerrainLayer();
      assert.equal(terrain.accept(0, terrainTilesFor(dem)), 'first');
      const img = makeImage(seed);
      const shifted = makeImage(seed, SHIFT_IMG_PX * IMG_PX_M);
      const good = createDrapeLayer({ shade: false });
      assert.equal(good.accept(0, drapeTilesFor(img)), 'first');
      const bad = createDrapeLayer({ shade: false });
      // 어긋난 영상은 동쪽 끝 열이 장면 밖으로 밀리지만 타일 16 개는 모두 영상과 겹친다.
      assert.equal(bad.accept(0, drapeTilesFor(shifted)), 'first');
      const views = cams.map((cam) => {
        const tr = terrain.render(cam);
        const before0 = { color: tr.color.slice(), depth: tr.depth.slice(), index: tr.index.slice() };
        const out = good.apply(cam, tr);
        const outBad = bad.apply(cam, tr);
        return { cam, tr, before0, out, outBad, m: measureView(cam, tr, out, img), mBad: measureView(cam, tr, outBad, img) };
      });
      scenes.push({ seed, views });
    }
    const lines = [];
    for (const s of scenes) {
      for (const v of s.views) {
        const worst = v.m.groups.reduce((a, g) => (g.px > a.px ? g : a), { px: 0, k: '-' });
        lines.push(`  시드 ${s.seed} ${v.cam.name.padEnd(18)} 화소 ${String(v.m.n).padStart(5)}`
          + ` | 정상 오차 ${v.m.errPx.toFixed(4)} px (전체 ${v.m.globalPx.toFixed(4)} px, δ=(${v.m.globalShift.map((q) => q.toFixed(4)).join(', ')}) m,`
          + ` 최악 타일 ${worst.k} ${worst.px.toFixed(4)} px, 묶음 ${v.m.groups.length}, R·G 평균차 ${v.m.mae.toFixed(3)})`
          + ` | 1.5화소 어긋남 ${v.mBad.errPx.toFixed(3)} px (전체 ${v.mBad.globalPx.toFixed(3)} px, δx=${v.mBad.globalShift[0].toFixed(3)} m)`);
      }
    }
    const goodMax = Math.max(...scenes.flatMap((s) => s.views.map((v) => v.m.errPx)));
    const badMin = Math.min(...scenes.flatMap((s) => s.views.map((v) => v.mBad.errPx)));
    console.log(`[align_oblique] 기준 ${DRAPE_ALIGN_MAX_PX} px. 정상 최대 ${goodMax.toFixed(4)} px, 어긋남 최소 ${badMin.toFixed(3)} px\n${lines.join('\n')}`);
  });

  test('측정기 자체 검증: 기준 영상을 결과로 넣으면 이동 0, 무늬 0.75 m 이동은 그대로 되찾는다', () => {
    const s = scenes[0];
    const v = s.views[1]; // 비스듬한 시점 하나
    const img = makeImage(s.seed);
    for (const shiftM of [0, 0.75, -0.3]) {
      // 결과 대신 I(P + δ) 를 반올림해 넣은 가짜 결과를 만든다(측정기만 시험).
      const fake = { color: new Uint8Array(v.tr.color.length) };
      for (let j = 0; j < v.cam.height; j++) {
        for (let i = 0; i < v.cam.width; i++) {
          const p = j * v.cam.width + i;
          if (!(v.tr.depth[p] > 0)) continue;
          const P = unprojectRef(v.cam, i, j, v.tr.depth[p]);
          const c = sampleImage(img, P[0] + shiftM, P[1] - shiftM / 2);
          fake.color[3 * p] = Math.round(c[0]); fake.color[3 * p + 1] = Math.round(c[1]); fake.color[3 * p + 2] = Math.round(c[2]);
        }
      }
      const m = measureView(v.cam, v.tr, fake, img);
      assert.ok(Math.abs(m.globalShift[0] - shiftM) < 0.02 && Math.abs(m.globalShift[1] + shiftM / 2) < 0.02,
        `δ 되찾기 ${m.globalShift} 대 (${shiftM}, ${-shiftM / 2})`);
      if (shiftM === 0) assert.ok(m.errPx < 0.05, `이동 0 인데 ${m.errPx} px`);
    }
  });

  test(`정상 타일: 8시점 × 시드 1..6 모두 정합 오차 ≤ ${DRAPE_ALIGN_MAX_PX} px`, () => {
    assert.equal(DRAPE_ALIGN_MAX_PX, 1);
    for (const s of scenes) {
      for (const v of s.views) {
        assert.ok(v.m.errPx <= DRAPE_ALIGN_MAX_PX, `시드 ${s.seed} ${v.cam.name}: 정합 오차 ${v.m.errPx.toFixed(4)} px > ${DRAPE_ALIGN_MAX_PX}`);
        assert.ok(v.m.mae <= COLOR_MAE_MAX, `시드 ${s.seed} ${v.cam.name}: R·G 평균 절대 차 ${v.m.mae.toFixed(3)} > ${COLOR_MAE_MAX}`);
      }
    }
  });

  test(`음성: 영상을 ${SHIFT_IMG_PX} 영상 화소 어긋나게 만든 타일은 모든 시점에서 ${DRAPE_ALIGN_MAX_PX} px 초과로 잡힌다`, () => {
    for (const s of scenes) {
      for (const v of s.views) {
        assert.ok(v.mBad.errPx > DRAPE_ALIGN_MAX_PX, `시드 ${s.seed} ${v.cam.name}: 어긋남 ${v.mBad.errPx.toFixed(3)} px 을 못 잡음`);
        // 되찾은 이동은 어긋남 방향·크기와 맞아야 한다(동쪽으로 0.75 m 민 영상 → 결과 ≈ I(P − 0.75 eₓ)).
        assert.ok(Math.abs(v.mBad.globalShift[0] + SHIFT_IMG_PX * IMG_PX_M) < 0.1, `δx ${v.mBad.globalShift[0]}`);
      }
    }
  });

  test('빈 화소는 그대로 빈 화소이고 depth·index 는 바뀌지 않으며 입력 terrain 은 바뀌지 않는다', () => {
    let empty = 0, filled = 0;
    for (const s of scenes) {
      for (const v of s.views) {
        assert.deepEqual(v.tr.color, v.before0.color, '입력 terrain.color 가 바뀌었다');
        assert.deepEqual(v.tr.depth, v.before0.depth);
        assert.deepEqual(v.tr.index, v.before0.index);
        assert.deepEqual(v.out.depth, v.tr.depth);
        assert.deepEqual(v.out.index, v.tr.index);
        for (let p = 0; p < v.tr.depth.length; p++) {
          if (v.tr.depth[p] === EMPTY_DEPTH) {
            empty++;
            assert.equal(v.out.depth[p], EMPTY_DEPTH);
            assert.equal(v.out.index[p], EMPTY_INDEX);
            assert.ok(v.out.color[3 * p] === 0 && v.out.color[3 * p + 1] === 0 && v.out.color[3 * p + 2] === 0, `빈 화소 ${p} 에 색이 칠해졌다`);
          } else filled++;
        }
      }
    }
    assert.ok(empty > 0 && filled > 0, `빈 ${empty}, 채움 ${filled}`);
  });

  test('격자선(B)도 기준과 같은 자리에 있다(정상: 격자 화소 판정 일치율 ≥ 0.97)', () => {
    for (const s of scenes) {
      const img = makeImage(s.seed);
      for (const v of s.views) {
        let n = 0, agree = 0;
        for (let p = 0; p < v.tr.depth.length; p++) {
          const d = v.tr.depth[p];
          if (!(d > 0)) continue;
          const P = unprojectRef(v.cam, p % v.cam.width, Math.floor(p / v.cam.width), d);
          if (Math.abs(P[0]) > IMG_MAX - EDGE_MARGIN_M || Math.abs(P[1]) > IMG_MAX - EDGE_MARGIN_M) continue;
          const ref = sampleImage(img, P[0], P[1])[2] > 125;
          const got = v.out.color[3 * p + 2] > 125;
          n++; if (ref === got) agree++;
        }
        assert.ok(agree / n >= 0.97, `시드 ${s.seed} ${v.cam.name}: 격자 일치율 ${(agree / n).toFixed(4)}`);
      }
    }
  });
});

// tileBounds 는 묶음 열쇠(tileKey)가 contracts 타일 규약과 같은지 확인하는 데만 쓴다.
test('tileKey 는 contracts tileBounds 규약과 같다', () => {
  for (const [x, y] of [[-128, -128], [-0.01, 0.01], [63.99, -64], [100, 127.9]]) {
    const [tx, ty] = tileKey(x, y).split(',').map(Number);
    const b = tileBounds(tx, ty);
    assert.ok(x >= b.minX && x < b.maxX && y >= b.minY && y < b.maxY, `${x},${y} → ${tx},${ty}`);
  }
});
