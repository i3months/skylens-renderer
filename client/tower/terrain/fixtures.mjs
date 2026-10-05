// 관제탑 지형 시험용 합성 DEM·시점 도우미(T15.1-A6). 시험 전용이며 제품 코드가 가져오지 않는다.
// 좌표: GeoAnchor 기준 ENU(x 동, y 북, z 위), 1 unit = 1 m. 카메라는 contracts/raster 규약(X_c = R·X_w + t, OpenCV 축, 월드 = ENU).
//
// 서명:
//   makeHillDem({ tilesX=4, tilesY=4, tileMinX=-2, tileMinY=-2, cellM=2, seed=1, amplitudeM=10, noiseRatio=0.015 }={}) -> Dem (contracts/tower_assets)
//     타일 번호 tileMinX..tileMinX+tilesX-1 × tileMinY..tileMinY+tilesY-1 을 덮는다(타일 한 변 64 m).
//     기본이면 ENU x,y ∈ [-128,128), 타일 16 개(4×4), 타일당 32 셀.
//     DEM 원점 규약(server/terrain/mesh_lod checkDem·tileOrigin): (originX, originY) = 왼쪽 아래 셀 "중심" 이자
//     타일 경계 표본점이다. originX = tileMinX·64, originY = tileMinY·64, width = tilesX·(64/cellM)+1, height 도 같다
//     (타일 경계 표본을 이웃과 공유하므로 마지막 타일 오른쪽·위 가장자리 표본까지 포함한다).
//     높이 = 시드로 뽑은 파라미터의 사인 합(부드러운 언덕) + 작은 잡음(±0.015·amplitudeM). 범위는 0 이상, 약 1.265·amplitudeM 이하.
//   towerViewpoints() -> Camera[8]  (각 항목에 name 속성이 붙는다)
//     fixtures/viewpoints/synthetic.json 의 8시점(GL 씬 규약 x 동·y 위·z −북)을 ENU 월드의 contracts/raster 카메라로 바꾼다.
//     해상도는 160×90 으로 바꾼다. 씬 = M·ENU (M: (e,n,u) -> (e,u,-n)) 이므로 R_enu = R_scene·M, t 는 그대로.
//     눈 높이 올림: 원본 시점 중 street_level(1.7 m), low_close_box(3 m), edge_far(6 m) 는 눈이 makeHillDem 기본 지형
//     (최고 약 1.265·10 = 12.7 m) 안에 묻힌다. 그래서 눈 높이(씬 y = ENU z)가 TOWER_EYE_MIN_U_M = 17 m
//     (기본 지형 상한 15 m + 2 m) 미만이면 17 m 로 올린다. 목표점(target)은 그대로 둔다. 올린 시점은 EYE_RAISED 에 이름으로 남는다.
//
// 가정: 이 파일은 계약(contracts/)과 tools/render_views 의 viewpointToCamera 만 쓴다.

import { readFileSync } from 'node:fs';
import { TERRAIN_TILE_SIZE_M } from '../../../contracts/tower_assets/index.mjs';
import { assertCamera } from '../../../contracts/raster/index.mjs';
import { viewpointToCamera } from '../../../tools/render_views/index.mjs';

export const TOWER_EYE_MIN_U_M = 17;
export const TOWER_VIEW_WIDTH = 160;
export const TOWER_VIEW_HEIGHT = 90;
/** 눈 높이를 올린 시점의 이름 → { from, to } (m). towerViewpoints() 가 호출될 때 채워진다. */
export const EYE_RAISED = {};

/** 직접 작성한 32비트 결정적 난수(0 이상 1 미만). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeHillDem({ tilesX = 4, tilesY = 4, tileMinX = -2, tileMinY = -2, cellM = 2, seed = 1, amplitudeM = 10, noiseRatio = 0.015 } = {}) {
  const n0 = Math.round(TERRAIN_TILE_SIZE_M / cellM);
  const width = tilesX * n0 + 1;
  const height = tilesY * n0 + 1;
  const originX = tileMinX * TERRAIN_TILE_SIZE_M;
  const originY = tileMinY * TERRAIN_TILE_SIZE_M;
  const rnd = mulberry32(seed);
  const waves = [];
  let sumA = 0;
  for (let k = 0; k < 4; k++) {
    const wl = 40 + rnd() * 120; // 파장 40..160 m
    const ang = rnd() * Math.PI * 2;
    const a = 0.5 + rnd() * 0.5;
    waves.push({ kx: (Math.cos(ang) * 2 * Math.PI) / wl, ky: (Math.sin(ang) * 2 * Math.PI) / wl, ph: rnd() * Math.PI * 2, a });
    sumA += a;
  }
  const noise = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const heights = new Float32Array(width * height);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const x = originX + i * cellM;
      const y = originY + j * cellM;
      let s = 0;
      for (const w of waves) s += w.a * Math.sin(w.kx * x + w.ky * y + w.ph);
      const hill = amplitudeM * (0.75 + 0.5 * (s / sumA)); // 0.25..1.25 · amplitudeM
      const jitter = (noise() * 2 - 1) * noiseRatio * amplitudeM;
      heights[j * width + i] = Math.max(0, hill + jitter);
    }
  }
  return { originX, originY, cellM, width, height, heights };
}

// 씬 = M·ENU, M = [[1,0,0],[0,0,1],[0,-1,0]] (행 우선).
const M = [1, 0, 0, 0, 0, 1, 0, -1, 0];

function mul3(A, B) {
  const C = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  return C;
}

export function towerViewpoints() {
  const url = new URL('../../../fixtures/viewpoints/synthetic.json', import.meta.url);
  const spec = JSON.parse(readFileSync(url, 'utf8'));
  for (const k of Object.keys(EYE_RAISED)) delete EYE_RAISED[k];
  return spec.viewpoints.map((vp) => {
    const eye = [...vp.eye];
    if (eye[1] < TOWER_EYE_MIN_U_M) {
      EYE_RAISED[vp.name] = { from: eye[1], to: TOWER_EYE_MIN_U_M };
      eye[1] = TOWER_EYE_MIN_U_M;
    }
    const sceneCam = viewpointToCamera({ ...vp, eye, width: TOWER_VIEW_WIDTH, height: TOWER_VIEW_HEIGHT });
    const cam = { width: sceneCam.width, height: sceneCam.height, K: { ...sceneCam.K }, R: mul3(sceneCam.R, M), t: [...sceneCam.t] };
    assertCamera(cam);
    cam.name = vp.name;
    return cam;
  });
}
