// 관제탑 드레이프 정합 시험(T15.2): 기복 있는 지형 · 비스듬한 시점. 기준 = contracts/controlview DRAPE_ALIGN_MAX_PX(1 px).
// 장면: client/tower/terrain/fixtures.mjs 의 합성 DEM(시드 1..6) → server mesh_lod LOD 0 타일 → 지형 층.
// 위성 영상: 같은 장면 범위(ENU [-128,128]²)를 0.5 m/화소 512×512 로 덮는 좌표 식별 무늬.
//   R = x 방향 삼각파 그라디언트(주기 32 m, 기울기 약 16 단계/m), G = y 방향 같은 그라디언트, B = 8 m 간격 격자선.
//   삼각파는 이어져 있으므로(톱니와 달리 끊김 없음) 접힘선 근처만 빼면 색 → 좌표 관계가 선형이다.
//   server/terrain/drape buildDrapeTile 로 밉 0 타일 16 개(128×128 화소, 영상 화소와 1:1)를 만든다.
// 시점: fixtures.towerViewpoints() 8곳(160×90, 낮은 시점은 눈 높이 17 m 로 올림, 지형 위 비스듬한 시선 포함).
// 기준 영상: 지형 층 depth 로 화소 중심 광선–지형 교점 ENU (x, y) 를 이 파일 안의 독립 역투영으로 구하고,
//   영상 원본에서 직접 이중선형 표본한 색(반올림 없음). 드레이프 층 구현(unproject·sample·store)과 코드를 공유하지 않는다.
// 정합 오차(서브픽셀 화면 이동 측정):
//   결과 색 ≈ I(P(p + s)) 모형(I = 원본 영상 이중선형, P(q) = 화면 위치 q 에 보이는 지형 점)으로 화면 이동 s = (du, dv) px 를
//   가우스–뉴턴 최소제곱으로 푼다. P(p + s) ≈ P + J·s + ½·sᵀH s 이고 J = ∂(x, y)/∂(u, v), H(2차)는 주점을 ±0.5 px·대각으로 옮긴
//   카메라로 지형을 다시 그려 얻은 지형 위 점의 차분이다(화소 크기 변화·경사·시선 방향·원근 굽음을 다 담는다).
//   잔차는 화면 화소 단위로 정규화해 각 화소의 화면 이동을 같은 무게로 평균한다. 가림 경계(1 px 둘레가 한 면으로 이어지지 않는 화소)는 뺀다.
//   정합 오차 = |s| 이므로 화면 균일 이동은 시점·지형과 무관하게 그 크기 그대로 재진다
//   (측정기 자체 검증: 화면 균일 (0.5, 0.5) px → 0.707 ± 0.05, 48 시점 전부. 예전 지면 δ 하나 모형은 이것을 0.62~1.35 px 로 쟀다).
//   s 는 시점 전체 하나와 드레이프 타일별 하나씩 푼다(타일 단위 어긋남도 잡는다). 시점의 정합 오차 = 묶음 |s| 최대값.
//   참고로 지면 δ(m) 하나 모형(결과 ≈ I(P + δ))도 풀어 globalShift 로 남긴다(영상 이동의 되찾기 확인용, 정합 오차에는 쓰지 않는다).
// unprojectRef 는 제품 역투영과 같은 식을 이 파일에 다시 적은 것이므로, contracts/raster 투영(server/raster_ref/project)으로
//   되돌려 원 화소 중심·깊이와 1e-6 이내인지 따로 검산한다.
// 정상 경로는 정합 오차 ≤ 1 px 에 더해 전체 화면 이동 s 의 성분마다 |du|, |dv| ≤ GOOD_AXIS_MAX_PX 를 단언한다
//   (반 화소 어긋남은 묶음 최대 errPx 가 0.5~0.8 px 라 1 px 단언만으로는 통과하므로, F-406 ⑥).
// 음성: 무늬를 동쪽으로 옮긴 영상으로 만든 타일. 옮김 양은 시점마다 "화면 1.5 화소"가 되도록 정한다
//   (측정기와 같은 화면 모형으로 지면 1 m 동쪽 이동을 선형 최소제곱한 |s| = pxPerM 로 나눈 값).
//   이것은 모든 시점에서 1 px 초과로 잡혀야 한다. 구성값 단언은 크기 1.5 가 아니라, 그 음성 측정의 표본 집합에서 지면 이동
//   (−옮김, 0) 을 같은 화면 모형으로 옮긴 벡터 expectScreen 과 측정한 전체 s 벡터의 차로 한다.
//   진단(시드 11 aerial_overview 가 전체 2.105 px 로 나온 원인): 옮김 2.336 m 가 FOLD_MARGIN_M(1.5 m) 보다 크고, 지면 균일 옮김은
//   화면 균일 이동이 아니라서(먼 화소일수록 J·s 가 크다) 화소마다 평가 점 P + J·s 가 원천 점 P − 옮김 에서 벗어난다. 그래서 P 가
//   접힘선에서 1.5 m 넘게 떨어진 화소라도 풀이의 평가 점이 접힘선 0.05 m 안에 들어간다. 이중선형 재구성의 꼭짓점은 평평해
//   그 점의 중앙 차분 기울기가 0 에 가깝고(0.052/m, 보통 약 16/m), 화면 정규화 잔차(잔차 ÷ 기울기)가 −88 px 로 튄다(중앙값 0.23).
//   가우스–뉴턴은 반복 0~18 동안 −1.50~−1.51 사이를 오가며 1e-5 수렴에 이르지 못하다가 반복 19(마지막)에서 이 화소 하나로
//   −1.512 → −2.104 로 뛰었고 그 값이 결과가 됐다. 측정 모형이 아니라 풀이의 수치 발산이므로 허용을 넓히지 않고 두 가지로 고친다.
//   (가) solveScreen 은 반복마다 평가 점이 접힘선에서 EVAL_FOLD_MARGIN_M 안인 채널을 뺀다(정상 경로는 s ≈ 0 이라 걸리지 않는다: 시드 1..6 정상 측정 기록이 그대로다).
//   (나) 음성 측정은 원천 점 P − 옮김 도 접힘선에서 FOLD_MARGIN_M 넘게 떨어지고 P 와 같은 삼각파 비탈에 있는 채널만 쓴다
//   (measureView 의 srcShift; 비탈을 넘는 화소는 결과 색이 반사되어 모형 I(P + J·s) 가 맞지 않는다. top_down 은 옮김이 약 3.0 m
//   = 2·FOLD_MARGIN_M 이라 거리 조건만으로는 접힘선을 사이에 둔 화소가 남을 수 있어 같은 비탈 조건을 함께 건다).
//   (나) 만으로는 시드 12 aerial_oblique_ne 에서 같은 발산이 났고(전체 2.143 px), (가) 만으로도 시드 11 은 1.502 px 가 된다.
//   (나) 는 발산 방지가 아니라 모형이 성립하지 않는 화소를 빼는 것이라 함께 둔다.
//   구성 벡터와의 차는 시드 1..18 에서 최대 0.095 px(가깝고 낮은 시점의 2차 항 몫, 구성은 J 선형 환산)로 SCR_BUILD_TOL 안이다.
//   참고로 고정 1.5 영상 화소(0.75 m) 어긋남도 잰다. 높고 먼 시점은 화면 한 화소가 지면 0.75 m 보다 넓어 화면 이동이 1 px 미만일 수
//   있으므로, 시점 이름 목록 대신 예상 화면 이동(pxPerM·0.75)이 CATCH_EXPECT_MIN_PX 를 넘는 시점에서만 1 px 초과를 단언한다.
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
// contracts/raster RASTER_API.project 가 가리키는 투영 구현. unprojectRef 왕복 검산에만 쓴다.
import { project as projectContract } from '../../../server/raster_ref/project/index.mjs';

// ---- 미리 정한 수치(측정에 맞춰 바꾸지 않는다) ----
// DRAPE_SEEDS 환경변수로 시드 범위 지정: '7-12' 또는 '7,8,9' 형식. 없으면 기본 [1..6]
function parseSeedsEnv() {
  const env = process.env.DRAPE_SEEDS;
  if (!env) return [1, 2, 3, 4, 5, 6];

  const seeds = [];
  const parts = env.split(',');

  for (const part of parts) {
    if (part.includes('-')) {
      const [start, end] = part.split('-').map(s => parseInt(s.trim(), 10));
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1) {
        throw new Error(`Invalid DRAPE_SEEDS range: "${part}" (must be valid integers >= 1)`);
      }
      if (start > end) {
        throw new Error(`Invalid DRAPE_SEEDS range: "${part}" (start > end)`);
      }
      for (let i = start; i <= end; i++) seeds.push(i);
    } else {
      const num = parseInt(part.trim(), 10);
      if (!Number.isInteger(num) || num < 1) {
        throw new Error(`Invalid DRAPE_SEEDS value: "${part}" (must be integer >= 1)`);
      }
      seeds.push(num);
    }
  }

  if (seeds.length === 0) {
    throw new Error('DRAPE_SEEDS parsed to empty list');
  }

  return seeds;
}
const SEEDS = parseSeedsEnv();
const IMG_PX_M = 0.5; // 영상 화소 크기(m)
const IMG_MIN = -128, IMG_MAX = 128; // 영상 범위(ENU, 지형 DEM 과 같다)
const TRI_HALF_M = 16; // 삼각파 반주기(0 → 255 까지 16 m)
const GRID_M = 8; // 격자 간격
const GRID_HALF_W_M = 0.5; // 격자선 반폭
const SHIFT_SCREEN_PX = 1.5; // 음성 시험 어긋남(화면 화소, 시점마다 지면 거리로 환산)
const SHIFT_IMG_PX = 1.5; // 참고 음성 시험 어긋남(영상 화소)
const FOLD_MARGIN_M = 1.5; // 삼각파 접힘선에서 이만큼 안쪽은 그 채널을 풀이에 쓰지 않는다
const EDGE_MARGIN_M = 1; // 영상 바깥 경계 근처(기준 표본이 고정되는 곳)는 뺀다
const GROUP_MIN_PX = 20; // 타일 묶음 풀이에 필요한 최소 화소 수
const COLOR_MAE_MAX = 2; // 정상 경로 R·G 평균 절대 차 상한(접힘·격자와 무관한 채널, 반올림·이음 고정 몫)
// 풀이의 평가 점이 접힘선에서 이만큼 안에 들면 그 반복에서 그 채널을 쓰지 않는다: 이중선형 재구성은 접힘선을 걸친 영상 한 화소
// (0.5 m) 안에서 꼭짓점이 평평해져 중앙 차분(±0.05 m) 기울기가 0 으로 가고, 화면 정규화 잔차(잔차 ÷ 기울기)가 발산한다.
const EVAL_FOLD_MARGIN_M = IMG_PX_M + 0.05;
const JAC_H_PX = 0.5; // 화면 야코비안 J 중앙 차분 간격(px, 주점 이동량)
const JAC_CONSIST = 0.25; // 앞·뒤 한쪽 차분이 이 비율 넘게 다르면(가림 경계·끊김) 그 화소는 뺀다
const SELF_UNIFORM_PX = 0.5; // 측정기 자체 검증: 화면 균일 이동(u, v 각각)
const SELF_UNIFORM_TOL = 0.05; // 그 측정값 |s| 허용(0.5·√2 ± 이 값)
const SCR_BUILD_TOL = 0.15; // 화면 1.5 px 음성의 전체 s 벡터가 구성 벡터 expectScreen 과 다를 수 있는 폭(1.5 px 의 10%, 2차 항 몫)
const GOOD_AXIS_MAX_PX = 0.25; // 정상 경로 전체 화면 이동 성분 상한(px). 정상 구현 측정 최대 |성분| 0.0049 px(시드 1..18 의 144 시점), 반 화소 변이는 약 0.5
const ROUNDTRIP_TOL = 1e-6; // unprojectRef → project 왕복 허용(px, 깊이는 m)
// 0.75 m 어긋남에서 예상 화면 이동(pxPerM·0.75)이 이 값을 넘는 시점은 반드시 1 px 초과로 잡혀야 한다.
// 문턱 1 px 에 1 px 여유: 예상값은 J 만 쓴 선형 환산이고 측정은 2차 항·삼각파 비선형을 담아 서로 몇 % 다르다.
// 예상값이 (1, 2] px 인 시점(tower_mid 1.25~1.57 등)은 단언하지 않는다.
const CATCH_EXPECT_MIN_PX = 2;

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
/** 삼각파 비탈 구간 번호(접힘선 사이 같은 구간이면 같다). */
function slopeIdx(v, p) { return Math.floor((v + p) / TRI_HALF_M); }
/** 접힘선(삼각파 꼭짓점)까지 거리(m). */
function foldDist(v, p) { const t = (v + p) / TRI_HALF_M; return Math.abs(t - Math.round(t)) * TRI_HALF_M; }

/** 영상 원본(행 우선, 위=북). 화소 (c, r) 중심 = (minX + (c+0.5)·s, maxY − (r+0.5)·s). */
// contentShiftX 는 bounds 는 그대로 두고 무늬 자체를 동쪽으로 contentShiftX m 옮겨 그린다(영상 화소의 정수배가 아닌 이동도
// 서버 박스 재표본을 거치지 않고 정확히 그 양만큼 옮겨진다. R·G 삼각파는 접힘선 밖에서 선형이라 이중선형 재구성도 그대로 옮겨진다).
function makeImage(seed, shiftX = 0, contentShiftX = 0) {
  const n = Math.round((IMG_MAX - IMG_MIN) / IMG_PX_M);
  const ph = phases(seed);
  const rgb = new Uint8Array(n * n * 3);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const v = patternAt(ph, IMG_MIN + (c + 0.5) * IMG_PX_M - contentShiftX, IMG_MAX - (r + 0.5) * IMG_PX_M);
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

/** 카메라 주점을 옮긴 사본: 화소 (i, j) 칸 중심 광선이 원래 화면 (i + 0.5 + eu, j + 0.5 + ev) 광선이 된다. */
function shiftedCam(cam, eu, ev) { return { ...cam, K: { ...cam.K, cx: cam.K.cx - eu, cy: cam.K.cy - ev } }; }

/**
 * 시점의 기하(결과와 무관): 화소마다 지형 점 P, 화면 야코비안 J = ∂(x, y)/∂(u, v)(지형 위)와 2차 미분 H.
 * 주점을 ±JAC_H_PX 옮겨 지형을 다시 그리고 같은 화소의 지형 점을 중앙 차분한다. 앞·뒤 차분이 어긋나거나(가림 경계)
 * 대각 (+h, −h) 점이 선형 모형에서 크게 벗어나거나, 1 px 둘레 8 이웃이 2차 모형으로 이어지지 않는 화소(가림 경계)는 null(측정에서 뺀다).
 */
function viewGeometry(cam, terrain, tr) {
  const h = JAC_H_PX;
  const offs = [[h, 0], [-h, 0], [0, h], [0, -h], [h, -h]].map(([eu, ev]) => { const c = shiftedCam(cam, eu, ev); return { c, r: terrain.render(c) }; });
  const geo = new Array(cam.width * cam.height).fill(null);
  for (let j = 0; j < cam.height; j++) {
    for (let i = 0; i < cam.width; i++) {
      const p = j * cam.width + i;
      if (!(tr.depth[p] > 0) || offs.some((o) => !(o.r.depth[p] > 0))) continue;
      const P = unprojectRef(cam, i, j, tr.depth[p]);
      const [up, um, vp, vm, diag] = offs.map((o) => unprojectRef(o.c, i, j, o.r.depth[p]));
      // 앞 차분 f 와 뒤 차분 g(지면 x, y)가 크게 다르면 가림 경계·끊김이다.
      let ok = true;
      for (const [plus, minus] of [[up, um], [vp, vm]]) {
        const f = [plus[0] - P[0], plus[1] - P[1]], g = [P[0] - minus[0], P[1] - minus[1]];
        if (Math.hypot(f[0] - g[0], f[1] - g[1]) > JAC_CONSIST * (Math.hypot(f[0], f[1]) + Math.hypot(g[0], g[1]))) ok = false;
      }
      if (!ok) continue;
      const J = [(up[0] - um[0]) / (2 * h), (vp[0] - vm[0]) / (2 * h), (up[1] - um[1]) / (2 * h), (vp[1] - vm[1]) / (2 * h)];
      // 대각(+h, −h) 점도 선형 모형 P + J·(h, −h) 에서 크게 벗어나면 안 된다(축 방향 검사가 못 보는 가림·끊김).
      const lin = [P[0] + (J[0] - J[1]) * h, P[1] + (J[2] - J[3]) * h];
      const dd = [diag[0] - lin[0], diag[1] - lin[1]];
      if (Math.hypot(dd[0], dd[1]) > JAC_CONSIST * Math.hypot(diag[0] - P[0], diag[1] - P[1])) continue;
      // 2차 항(원근 때문에 비스듬한 먼 화소는 0.5 px 안에서도 굽음이 크다): H = [x_uu, x_uv, x_vv, y_uu, y_uv, y_vv].
      // P(h,−h) = P + J·(h,−h) + ½(uu − 2·uv + vv)·h² 에서 uv 를 푼다.
      const H = [0, 1].flatMap((k) => {
        const uu = (up[k] - 2 * P[k] + um[k]) / (h * h), vv = (vp[k] - 2 * P[k] + vm[k]) / (h * h);
        const uv = (uu + vv - (2 * dd[k]) / (h * h)) / 2;
        return [uu, uv, vv];
      });
      // 1 px 둘레 8 이웃(원래 render)도 2차 모형으로 이어져야 한다: 가림 경계(실루엣) 1 px 안의 화소를 방향 없이 뺀다.
      let cont = true;
      for (let b = -1; b <= 1 && cont; b++) {
        for (let a = -1; a <= 1 && cont; a++) {
          if (a === 0 && b === 0) continue;
          const ii = i + a, jj = j + b;
          if (ii < 0 || jj < 0 || ii >= cam.width || jj >= cam.height) { cont = false; break; }
          const dn = tr.depth[jj * cam.width + ii];
          if (!(dn > 0)) { cont = false; break; }
          const N = unprojectRef(cam, ii, jj, dn);
          const qx = P[0] + J[0] * a + J[1] * b + 0.5 * (H[0] * a * a + 2 * H[1] * a * b + H[2] * b * b);
          const qy = P[1] + J[2] * a + J[3] * b + 0.5 * (H[3] * a * a + 2 * H[4] * a * b + H[5] * b * b);
          if (Math.hypot(N[0] - qx, N[1] - qy) > JAC_CONSIST * Math.hypot(N[0] - P[0], N[1] - P[1])) cont = false;
        }
      }
      if (!cont) continue;
      geo[p] = { P, J, H };
    }
  }
  return geo;
}

/**
 * 표본 목록에서 결과 ≈ I(P + J·s + ½·sᵀH s) 의 화면 이동 s = (du, dv) px 를 푼다(가우스–뉴턴, R·G 두 채널이 두 미지수에 함께 기여).
 * R 은 x 만, G 는 y 만의 함수이므로 R 의 야코비안 = ∂R/∂x·(J₀₀, J₀₁), G 의 것 = ∂G/∂y·(J₁₀, J₁₁).
 * 잔차는 화면 화소 단위로 정규화한다(채널 잔차 ÷ |∂색/∂s|). 그렇지 않으면 한 화소가 지면 여러 m 인 먼 화소가 풀이를 휘어잡아
 * 화면 이동이 아니라 지면 이동을 재게 된다. 정규화하면 각 화소의 화면 이동을 같은 무게로 평균한 값이 된다.
 */
function solveScreen(img, samples, init = [0, 0]) {
  let [du, dv] = init;
  const h = 0.05;
  for (let it = 0; it < 20; it++) {
    let a00 = 0, a01 = 0, a11 = 0, b0 = 0, b1 = 0;
    const add = (g, j0, j1, r) => {
      const n2 = g * g * (j0 * j0 + j1 * j1);
      if (!(n2 > 0)) return;
      const ju = g * j0, jv = g * j1;
      a00 += (ju * ju) / n2; a01 += (ju * jv) / n2; a11 += (jv * jv) / n2; b0 += (ju * r) / n2; b1 += (jv * r) / n2;
    };
    for (const s of samples) {
      const J = s.J, H = s.H;
      // 지형 점 P(p + s) ≈ P + J·s + ½·sᵀH s, 그 s 미분 = J + H·s
      const x = s.P[0] + J[0] * du + J[1] * dv + 0.5 * (H[0] * du * du + 2 * H[1] * du * dv + H[2] * dv * dv);
      const y = s.P[1] + J[2] * du + J[3] * dv + 0.5 * (H[3] * du * du + 2 * H[4] * du * dv + H[5] * dv * dv);
      const f = sampleImage(img, x, y);
      // 평가 점이 접힘선 근처면 기울기가 0 에 가까워 정규화가 발산한다(머리 주석 진단). 그 반복에서 그 채널을 뺀다.
      const okR = s.useR && foldDist(x, img.ph.px) > EVAL_FOLD_MARGIN_M;
      const okG = s.useG && foldDist(y, img.ph.py) > EVAL_FOLD_MARGIN_M;
      if (okR) add((sampleImage(img, x + h, y)[0] - sampleImage(img, x - h, y)[0]) / (2 * h), J[0] + H[0] * du + H[1] * dv, J[1] + H[1] * du + H[2] * dv, s.c[0] - f[0]);
      if (okG) add((sampleImage(img, x, y + h)[1] - sampleImage(img, x, y - h)[1]) / (2 * h), J[2] + H[3] * du + H[4] * dv, J[3] + H[4] * du + H[5] * dv, s.c[1] - f[1]);
    }
    const det = a00 * a11 - a01 * a01;
    if (!(Math.abs(det) > 0)) break;
    const su = (a11 * b0 - a01 * b1) / det, sv = (a00 * b1 - a01 * b0) / det;
    du += su; dv += sv;
    if (Math.abs(su) < 1e-5 && Math.abs(sv) < 1e-5) break;
  }
  return [du, dv];
}

/**
 * 지면 이동 δ(m) 를 측정기와 같은 화면 모형으로 옮긴 s(px). solveScreen 과 같은 정규화의 선형 최소제곱:
 * 채널마다 (J 행·s − δ 성분) / |J 행| 의 제곱합을 최소로 한다. 음성 시험의 "화면 1.5 px" 환산(pxPerM = |s(1 m 동쪽)|)에 쓴다.
 */
function groundToScreen(samples, d) {
  let a00 = 0, a01 = 0, a11 = 0, b0 = 0, b1 = 0;
  for (const s of samples) {
    const J = s.J;
    for (const [use, j0, j1, dk] of [[s.useR, J[0], J[1], d[0]], [s.useG, J[2], J[3], d[1]]]) {
      const n2 = j0 * j0 + j1 * j1;
      if (!use || !(n2 > 0)) continue;
      a00 += (j0 * j0) / n2; a01 += (j0 * j1) / n2; a11 += (j1 * j1) / n2; b0 += (j0 * dk) / n2; b1 += (j1 * dk) / n2;
    }
  }
  const det = a00 * a11 - a01 * a01;
  return [(a11 * b0 - a01 * b1) / det, (a00 * b1 - a01 * b0) / det];
}

/**
 * 한 시점의 정합 측정. 결과 = 드레이프 층 출력, 기준 = 지형 depth → ENU → 원본 이중선형.
 * srcShift(m, 음성 시험만): 구성상 결과 ≈ I(P + srcShift) 일 때. 원천 점 P + srcShift 도 접힘선에서 FOLD_MARGIN_M 넘게
 * 떨어지고 P 와 같은 비탈에 있는 채널만 쓰고(머리 주석의 시드 11 진단), 그 표본 집합에서 srcShift 를 화면으로 옮긴 expectScreen 을 함께 돌려준다.
 * @returns {{ errPx, globalPx, globalScreen, globalShift, groups, mae, n, pxPerM, expectScreen }}
 */
function measureView(cam, geo, result, img, srcShift = null) {
  const all = [];
  const groups = new Map();
  let maeSum = 0, maeN = 0;
  for (let p = 0; p < geo.length; p++) {
    const gp = geo[p];
    if (!gp) continue;
    const { P, J, H } = gp;
    if (P[0] < IMG_MIN + EDGE_MARGIN_M || P[0] > IMG_MAX - EDGE_MARGIN_M || P[1] < IMG_MIN + EDGE_MARGIN_M || P[1] > IMG_MAX - EDGE_MARGIN_M) continue;
    const c = [result.color[3 * p], result.color[3 * p + 1], result.color[3 * p + 2]];
    const srcOk = (v, d, ph) => !srcShift || (foldDist(v + d, ph) > FOLD_MARGIN_M && slopeIdx(v + d, ph) === slopeIdx(v, ph));
    const useR = foldDist(P[0], img.ph.px) > FOLD_MARGIN_M && srcOk(P[0], srcShift?.[0], img.ph.px);
    const useG = foldDist(P[1], img.ph.py) > FOLD_MARGIN_M && srcOk(P[1], srcShift?.[1], img.ph.py);
    const ref = sampleImage(img, P[0], P[1]);
    if (useR) { maeSum += Math.abs(c[0] - ref[0]); maeN++; }
    if (useG) { maeSum += Math.abs(c[1] - ref[1]); maeN++; }
    if (!useR && !useG) continue;
    const s = { P, J, H, c, useR, useG };
    all.push(s);
    const k = tileKey(P[0], P[1]);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  assert.ok(all.length > 500, `${cam.name}: 측정 화소가 너무 적다(${all.length})`);
  const globalShift = solveShift(img, all);
  const globalScreen = solveScreen(img, all);
  const globalPx = Math.hypot(globalScreen[0], globalScreen[1]);
  let errPx = globalPx;
  const per = [];
  for (const [k, list] of groups) {
    if (list.length < GROUP_MIN_PX) continue;
    const ss = solveScreen(img, list, globalScreen);
    const px = Math.hypot(ss[0], ss[1]);
    per.push({ k, n: list.length, px, s: ss });
    errPx = Math.max(errPx, px);
  }
  // 지면 1 m 동쪽 이동이 측정기 화면 모형에서 몇 px 인지. 음성 시험의 옮김 양 환산에 쓴다.
  const e = groundToScreen(all, [1, 0]);
  const pxPerM = Math.hypot(e[0], e[1]);
  const expectScreen = srcShift ? groundToScreen(all, srcShift) : null;
  return { errPx, globalPx, globalScreen, globalShift, groups: per, mae: maeN ? maeSum / maeN : 0, n: all.length, pxPerM, expectScreen };
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

describe(`드레이프 정합: 기복 지형 · 비스듬한 8시점(시드 ${SEEDS.join(',')})`, () => {
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
        const geo = viewGeometry(cam, terrain, tr);
        const out = good.apply(cam, tr);
        const outBad = bad.apply(cam, tr);
        const m = measureView(cam, geo, out, img);
        // 화면 1.5 화소 어긋남: 이 시점에서 측정기 화면 모형의 pxPerM 로 지면 거리로 환산해 무늬를 동쪽으로 옮긴다.
        // bounds 를 소수 화소만큼 옮기면 서버 박스 재표본이 실제 이동을 바꾸므로(시드 5 street_level: 0.213 m 요청 → 0.188 m)
        // 무늬 내용을 옮겨 그린 영상(bounds 그대로)을 쓴다. 그래야 전체 |s| 가 구성상 1.5 px 이다.
        const scrShiftM = SHIFT_SCREEN_PX / m.pxPerM;
        const scrImg = makeImage(seed, 0, scrShiftM);
        const scrLayer = createDrapeLayer({ shade: false });
        assert.equal(scrLayer.accept(0, drapeTilesFor(scrImg)), 'first');
        const outScr = scrLayer.apply(cam, tr);
        // 측정기 자체 검증용 가짜 결과: 화면 균일 (0.5, 0.5) px 이동. 화소 p 의 색 = 화면 p + (0.5, 0.5) 에 보이는 지형 점의 원본 색.
        // 주점을 옮긴 카메라로 지형을 다시 그려 그 지형 점을 얻는다(드레이프 층을 거치지 않는다).
        const camU = shiftedCam(cam, SELF_UNIFORM_PX, SELF_UNIFORM_PX);
        const trU = terrain.render(camU);
        const fakeU = { color: new Uint8Array(tr.color.length) };
        for (let p = 0; p < tr.depth.length; p++) {
          if (!(trU.depth[p] > 0)) continue;
          const Q = unprojectRef(camU, p % cam.width, Math.floor(p / cam.width), trU.depth[p]);
          const c = sampleImage(img, Q[0], Q[1]);
          fakeU.color[3 * p] = Math.round(c[0]); fakeU.color[3 * p + 1] = Math.round(c[1]); fakeU.color[3 * p + 2] = Math.round(c[2]);
        }
        return {
          cam, tr, geo, before0, out, outBad, m, mBad: measureView(cam, geo, outBad, img), scrShiftM,
          mScr: measureView(cam, geo, outScr, img, [-scrShiftM, 0]), mUni: measureView(cam, geo, fakeU, img),
        };
      });
      scenes.push({ seed, views });
    }
    const lines = [];
    for (const s of scenes) {
      for (const v of s.views) {
        const worst = v.m.groups.reduce((a, g) => (g.px > a.px ? g : a), { px: 0, k: '-' });
        lines.push(`  시드 ${s.seed} ${v.cam.name.padEnd(18)} 화소 ${String(v.m.n).padStart(5)}`
          + ` | 정상 오차 ${v.m.errPx.toFixed(4)} px (전체 s=(${v.m.globalScreen.map((q) => q.toFixed(4)).join(', ')}) px, δ=(${v.m.globalShift.map((q) => q.toFixed(4)).join(', ')}) m,`
          + ` 최악 타일 ${worst.k} ${worst.px.toFixed(4)} px, 묶음 ${v.m.groups.length}, R·G 평균차 ${v.m.mae.toFixed(3)})`
          + ` | 균일 0.707px ${v.mUni.errPx.toFixed(3)} px (전체 ${v.mUni.globalPx.toFixed(3)} px)`
          + ` | 화면 1.5px 어긋남(${v.scrShiftM.toFixed(3)} m) ${v.mScr.errPx.toFixed(3)} px (전체 ${v.mScr.globalPx.toFixed(3)} px, s−구성 ${Math.hypot(v.mScr.globalScreen[0] - v.mScr.expectScreen[0], v.mScr.globalScreen[1] - v.mScr.expectScreen[1]).toFixed(3)} px)`
          + ` | 영상 1.5화소 어긋남(예상 ${(v.m.pxPerM * SHIFT_IMG_PX * IMG_PX_M).toFixed(3)} px) ${v.mBad.errPx.toFixed(3)} px (전체 ${v.mBad.globalPx.toFixed(3)} px, δx=${v.mBad.globalShift[0].toFixed(3)} m)`);
      }
    }
    const all = scenes.flatMap((s) => s.views);
    const goodMax = Math.max(...all.map((v) => v.m.errPx));
    const uniMin = Math.min(...all.map((v) => v.mUni.errPx)), uniMax = Math.max(...all.map((v) => v.mUni.errPx));
    const scrMin = Math.min(...all.map((v) => v.mScr.errPx));
    const scrG = all.map((v) => v.mScr.globalPx);
    const badMin = Math.min(...all.map((v) => v.mBad.errPx));
    console.log(`[align_oblique] 기준 ${DRAPE_ALIGN_MAX_PX} px. 정상 최대 ${goodMax.toFixed(4)} px, 균일 0.707px 측정 ${uniMin.toFixed(3)}~${uniMax.toFixed(3)} px,`
      + ` 화면 1.5px 어긋남 최소 ${scrMin.toFixed(3)} px(전체 ${Math.min(...scrG).toFixed(3)}~${Math.max(...scrG).toFixed(3)} px), 영상 1.5화소 어긋남 최소 ${badMin.toFixed(3)} px\n${lines.join('\n')}`);
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
      const m = measureView(v.cam, v.geo, fake, img);
      assert.ok(Math.abs(m.globalShift[0] - shiftM) < 0.02 && Math.abs(m.globalShift[1] + shiftM / 2) < 0.02,
        `δ 되찾기 ${m.globalShift} 대 (${shiftM}, ${-shiftM / 2})`);
      if (shiftM === 0) assert.ok(m.errPx < 0.05, `이동 0 인데 ${m.errPx} px`);
    }
  });

  test(`측정기 자체 검증: 화면 균일 (${SELF_UNIFORM_PX}, ${SELF_UNIFORM_PX}) px 이동은 48 시점 모두 ${(SELF_UNIFORM_PX * Math.SQRT2).toFixed(3)} ± ${SELF_UNIFORM_TOL} px 로 잰다`, () => {
    const want = SELF_UNIFORM_PX * Math.SQRT2;
    let n = 0;
    for (const s of scenes) {
      for (const v of s.views) {
        n++;
        const [du, dv] = v.mUni.globalScreen;
        assert.ok(Math.abs(v.mUni.globalPx - want) <= SELF_UNIFORM_TOL, `시드 ${s.seed} ${v.cam.name}: 전체 ${v.mUni.globalPx.toFixed(4)} px (s=${du.toFixed(4)}, ${dv.toFixed(4)})`);
        assert.ok(Math.abs(v.mUni.errPx - want) <= SELF_UNIFORM_TOL, `시드 ${s.seed} ${v.cam.name}: 정합 오차(묶음 최대) ${v.mUni.errPx.toFixed(4)} px`);
        // 방향도 맞아야 한다(화소 p 에 화면 p + (0.5, 0.5) 의 색 → s = (+0.5, +0.5)).
        assert.ok(Math.abs(du - SELF_UNIFORM_PX) <= SELF_UNIFORM_TOL && Math.abs(dv - SELF_UNIFORM_PX) <= SELF_UNIFORM_TOL, `시드 ${s.seed} ${v.cam.name}: s=(${du}, ${dv})`);
      }
    }
    assert.equal(n, SEEDS.length * 8);
  });

  test('unprojectRef 는 contracts/raster 투영(project)과 왕복한다: ENU 를 다시 투영하면 원 화소 중심·깊이와 1e-6 이내', () => {
    let n = 0;
    for (const s of scenes) {
      for (const v of s.views) {
        for (let p = 0; p < v.tr.depth.length; p += 37) {
          const d = v.tr.depth[p];
          if (!(d > 0)) continue;
          const i = p % v.cam.width, j = Math.floor(p / v.cam.width);
          const q = projectContract(v.cam, unprojectRef(v.cam, i, j, d));
          assert.ok(Math.abs(q.u - (i + 0.5)) <= ROUNDTRIP_TOL && Math.abs(q.v - (j + 0.5)) <= ROUNDTRIP_TOL && Math.abs(q.d - d) <= ROUNDTRIP_TOL,
            `시드 ${s.seed} ${v.cam.name} (${i}, ${j}): 왕복 (${q.u}, ${q.v}, ${q.d}) 대 (${i + 0.5}, ${j + 0.5}, ${d})`);
          n++;
        }
      }
    }
    assert.ok(n > 1000, `왕복 검산 화소 ${n}`);
  });

  test(`정상 타일: 8시점 × 시드 ${SEEDS.join(',')} 모두 정합 오차 ≤ ${DRAPE_ALIGN_MAX_PX} px`, () => {
    assert.equal(DRAPE_ALIGN_MAX_PX, 1);
    for (const s of scenes) {
      for (const v of s.views) {
        assert.ok(v.m.errPx <= DRAPE_ALIGN_MAX_PX, `시드 ${s.seed} ${v.cam.name}: 정합 오차 ${v.m.errPx.toFixed(4)} px > ${DRAPE_ALIGN_MAX_PX}`);
        assert.ok(v.m.mae <= COLOR_MAE_MAX, `시드 ${s.seed} ${v.cam.name}: R·G 평균 절대 차 ${v.m.mae.toFixed(3)} > ${COLOR_MAE_MAX}`);
      }
    }
  });

  test(`정상 타일: 전체 화면 이동 s 의 성분마다 |du|, |dv| ≤ ${GOOD_AXIS_MAX_PX} px (반 화소 어긋남을 잡는다)`, () => {
    // 시점마다 모아 몇 시점이 넘었는지 한 번에 보인다(다른 단언에 가려지지 않게 따로 둔다).
    const over = [];
    for (const s of scenes) {
      for (const v of s.views) {
        const [du, dv] = v.m.globalScreen;
        if (!(Math.abs(du) <= GOOD_AXIS_MAX_PX && Math.abs(dv) <= GOOD_AXIS_MAX_PX)) over.push(`시드 ${s.seed} ${v.cam.name} s=(${du.toFixed(3)}, ${dv.toFixed(3)})`);
      }
    }
    assert.deepEqual(over, [], `전체 화면 이동 성분 > ${GOOD_AXIS_MAX_PX} px: ${over.length}/${SEEDS.length * 8} 시점: ${over.join('; ')}`);
  });

  test(`음성: 영상을 화면 ${SHIFT_SCREEN_PX} 화소만큼 어긋나게 만든 타일은 모든 시점에서 ${DRAPE_ALIGN_MAX_PX} px 초과로 잡힌다`, () => {
    for (const s of scenes) {
      for (const v of s.views) {
        assert.ok(v.mScr.errPx > DRAPE_ALIGN_MAX_PX, `시드 ${s.seed} ${v.cam.name}: 어긋남 ${v.mScr.errPx.toFixed(3)} px 을 못 잡음`);
        // 구성 벡터: 같은 표본 집합에서 지면 (−옮김, 0) 을 측정기 화면 모형(J 선형)으로 옮긴 것. 크기는 구성상 ≈ 1.5 px.
        const [eu, ev] = v.mScr.expectScreen;
        const [gu, gv] = v.mScr.globalScreen;
        const diff = Math.hypot(gu - eu, gv - ev);
        assert.ok(diff <= SCR_BUILD_TOL, `시드 ${s.seed} ${v.cam.name}: 전체 s=(${gu.toFixed(3)}, ${gv.toFixed(3)}) 대 구성 (${eu.toFixed(3)}, ${ev.toFixed(3)}), 차 ${diff.toFixed(3)} px`);
        assert.ok(Math.abs(v.mScr.globalShift[0] + v.scrShiftM) < 0.1 * v.scrShiftM + 0.02, `δx ${v.mScr.globalShift[0]} 대 ${-v.scrShiftM}`);
      }
    }
  });

  test(`참고 음성: 영상을 ${SHIFT_IMG_PX} 영상 화소(0.75 m) 어긋나게 만든 타일은 δx ≈ −0.75 m 로 되찾고, 예상 화면 이동 > ${CATCH_EXPECT_MIN_PX} px 인 시점에서는 ${DRAPE_ALIGN_MAX_PX} px 초과다`, (t) => {
    for (const s of scenes) {
      // 예상 화면 이동(pxPerM × 0.75 m)이 문턱보다 충분히 큰 시점만 초과를 단언한다(이름 목록을 고정하지 않는다).
      const big = s.views.filter((v) => v.m.pxPerM * SHIFT_IMG_PX * IMG_PX_M > CATCH_EXPECT_MIN_PX);
      const skipped = s.views.length - big.length;
      if (t.diagnostic) {
        t.diagnostic(`시드 ${s.seed}: 예상 화면 이동 ≤ ${CATCH_EXPECT_MIN_PX} px 로 단언을 건너뛴 시점 ${skipped}/${s.views.length}`);
      } else {
        console.log(`[seed ${s.seed}] skipped assertion count: ${skipped}/${s.views.length}`);
      }
      // 공허한 통과 방지: 시드마다 적어도 한 시점(낮은 눈 높이 시점은 예상 2.3 px 이상)은 단언 대상이어야 한다.
      assert.ok(big.length >= 1, `시드 ${s.seed}: 예상 화면 이동 > ${CATCH_EXPECT_MIN_PX} px 인 시점이 없다`);
      for (const v of big) {
        assert.ok(v.mBad.errPx > DRAPE_ALIGN_MAX_PX,
          `시드 ${s.seed} ${v.cam.name}: 예상 ${(v.m.pxPerM * SHIFT_IMG_PX * IMG_PX_M).toFixed(3)} px 인 어긋남을 ${v.mBad.errPx.toFixed(3)} px 로 못 잡음`);
      }
      for (const v of s.views) {
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
