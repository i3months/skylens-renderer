// 드레이프 정합 시험(T15.2, SPEC S9 합성 근사): 연직(nadir) 카메라에서 드레이프 결과가 이상적 투영 기준과 ≤ DRAPE_ALIGN_MAX_PX 안에 맞는지 잰다.
// 구성:
//  - 지형: 높이 0 의 평평한 타일 4개((-1,-1),(0,-1),(-1,0),(0,0)) → ENU [-64, 64]² 평면 z = 0.
//  - 합성 위성 영상: ENU [-72, 72]², 0.125 m/px(1152²). 타일 격자(64 m)와 화소 격자가 맞물려 밉 0 타일 = 영상 잘라 내기(박스 필터가 항등)다.
//    R = x 의 선형 그라디언트, G = y 의 선형 그라디언트(전역 위치 식별), B = 비주기 값 잡음(격자 1.6 m, 고주파),
//    5 m 간격·0.5 m 폭 격자선에서 R·G 를 절반으로(날카로운 경계). 영상이 지형보다 넓어 이동시킨 영상도 타일을 다 덮는다.
//  - 드레이프 타일: (0,-1) 은 일부러 보내지 않는다(그 구역은 지형 색 그대로여야 한다).
//  - 기준 영상: 화소 중심 광선과 평면 z = 0 의 교점 ENU 를 직접 계산하고 영상 원본을 이중선형 표본(타일·역투영 코드를 거치지 않음).
//  - 정합 측정: 결과 ≈ g·기준(i + dx, j + dy) 의 최소 제곱 (dx, dy, g). 정수 이동 전역 탐색 → 가우스-뉴턴 서브픽셀 정밀화.
//    기준은 해석 함수라(임의 소수 화소 위치에서 광선–평면 교점을 다시 계산) 기준 영상을 다시 보간하지 않는다.
//  - 음성 시험: 영상 bounds 를 0.5 m·2 m 옮겨 만든 타일을 먹이면 측정 이동량이 1 px 를 넘어야 한다(측정 도구가 이동을 본다는 증거).
// 허용 1 px(DRAPE_ALIGN_MAX_PX)은 계약값 그대로 쓰고 바꾸지 않는다. 측정 수치는 출력한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DRAPE_ALIGN_MAX_PX } from '../../../contracts/controlview/drape.mjs';
import { createTerrainLayer } from '../terrain/index.mjs';
import { mulberry32 } from '../terrain/fixtures.mjs';
import { buildDrapeTile } from '../../../server/terrain/drape/index.mjs';
import { createDrapeLayer } from './index.mjs';

// ---- 합성 영상 ----
const IMG_MIN = -72;
const IMG_MAX = 72;
const IMG_PX_M = 0.125;
const IMG_N = Math.round((IMG_MAX - IMG_MIN) / IMG_PX_M); // 1152
const NOISE_CELL_M = 1.6;
const GRID_M = 5;
const GRID_LINE_M = 0.5;

/** 비주기 값 잡음 격자(결정적). */
function makeNoiseLattice(seed) {
  const n = Math.ceil((IMG_MAX - IMG_MIN) / NOISE_CELL_M) + 2;
  const rnd = mulberry32(seed);
  const v = new Float64Array(n * n);
  for (let k = 0; k < v.length; k++) v[k] = rnd();
  return { n, v };
}
const smooth = (t) => t * t * (3 - 2 * t);

/** 합성 위성 영상(영상 행 0 = 북). bounds 는 원래 위치. */
function makeSatImage() {
  const lat = makeNoiseLattice(7);
  const rgb = new Uint8Array(IMG_N * IMG_N * 3);
  for (let r = 0; r < IMG_N; r++) {
    const y = IMG_MAX - (r + 0.5) * IMG_PX_M;
    for (let c = 0; c < IMG_N; c++) {
      const x = IMG_MIN + (c + 0.5) * IMG_PX_M;
      // 값 잡음(smoothstep 보간)
      const gx = (x - IMG_MIN) / NOISE_CELL_M;
      const gy = (y - IMG_MIN) / NOISE_CELL_M;
      const ix = Math.floor(gx), iy = Math.floor(gy);
      const fx = smooth(gx - ix), fy = smooth(gy - iy);
      const L = (a, b) => lat.v[b * lat.n + a];
      const nz = (L(ix, iy) * (1 - fx) + L(ix + 1, iy) * fx) * (1 - fy) + (L(ix, iy + 1) * (1 - fx) + L(ix + 1, iy + 1) * fx) * fy;
      let R = 20 + (215 * (x - IMG_MIN)) / (IMG_MAX - IMG_MIN);
      let G = 20 + (215 * (y - IMG_MIN)) / (IMG_MAX - IMG_MIN);
      const B = 20 + 215 * nz;
      const mx = ((x % GRID_M) + GRID_M) % GRID_M;
      const my = ((y % GRID_M) + GRID_M) % GRID_M;
      if (mx < GRID_LINE_M || my < GRID_LINE_M) { R *= 0.5; G *= 0.5; }
      const o = (r * IMG_N + c) * 3;
      rgb[o] = Math.round(R); rgb[o + 1] = Math.round(G); rgb[o + 2] = Math.round(B);
    }
  }
  return { width: IMG_N, height: IMG_N, rgb, bounds: { minX: IMG_MIN, minY: IMG_MIN, maxX: IMG_MAX, maxY: IMG_MAX } };
}

const IMAGE = makeSatImage();

/** 영상 원본 이중선형 표본(화소 중심 규약, 가장자리 고정). 반환은 실수 [r,g,b]. */
function sampleImage(img, x, y, out) {
  const b = img.bounds;
  const sx = (b.maxX - b.minX) / img.width;
  const sy = (b.maxY - b.minY) / img.height;
  const u = (x - b.minX) / sx - 0.5;
  const v = (b.maxY - y) / sy - 0.5;
  const i0 = Math.floor(u), j0 = Math.floor(v);
  const fx = u - i0, fy = v - j0;
  const W = img.width, H = img.height;
  const ci = (i) => (i < 0 ? 0 : i > W - 1 ? W - 1 : i);
  const cj = (j) => (j < 0 ? 0 : j > H - 1 ? H - 1 : j);
  const a = ci(i0), a1 = ci(i0 + 1), c = cj(j0), c1 = cj(j0 + 1);
  const p00 = (c * W + a) * 3, p10 = (c * W + a1) * 3, p01 = (c1 * W + a) * 3, p11 = (c1 * W + a1) * 3;
  const s = img.rgb;
  for (let k = 0; k < 3; k++) {
    out[k] = (s[p00 + k] * (1 - fx) + s[p10 + k] * fx) * (1 - fy) + (s[p01 + k] * (1 - fx) + s[p11 + k] * fx) * fy;
  }
  return out;
}

// ---- 장면 ----
/** 연직 카메라: 영상 오른쪽 = 동, 아래 = 남. 지면 화소 크기 gsdM 이 되도록 f 를 정한다. */
function nadirCamera(w, h, camX, camY, H, gsdM) {
  const f = H / gsdM;
  return { width: w, height: h, K: { fx: f, fy: f, cx: w / 2, cy: h / 2 }, R: [1, 0, 0, 0, -1, 0, 0, 0, -1], t: [-camX, camY, H] };
}

/** 이상적 투영: 화소 좌표 (u, v)(연속값, 칸 중심 = 정수 + 0.5) 광선과 평면 z = 0 의 교점 ENU. 일반 카메라 식을 그대로 쓴다. */
function rayPlaneEnu(cam, u, v) {
  const { K, R, t } = cam;
  const dc = [(u - K.cx) / K.fx, (v - K.cy) / K.fy, 1];
  // 월드 방향 = Rᵀ·dc, 카메라 중심 C = −Rᵀ·t
  const d = [0, 1, 2].map((k) => R[k] * dc[0] + R[3 + k] * dc[1] + R[6 + k] * dc[2]);
  const C = [0, 1, 2].map((k) => -(R[k] * t[0] + R[3 + k] * t[1] + R[6 + k] * t[2]));
  const s = -C[2] / d[2];
  return { x: C[0] + s * d[0], y: C[1] + s * d[1] };
}

const TERRAIN_TILES = [[-1, -1], [0, -1], [-1, 0], [0, 0]].map(([tx, ty]) => ({ tx, ty, lod: 0, cells: 2, heights: new Float32Array(4) }));
const MISSING = { tx: 0, ty: -1 }; // 드레이프를 보내지 않는 타일
const DRAPE_TXY = [[-1, -1], [-1, 0], [0, 0]];

/** 영상 bounds 를 (ox, oy) m 옮긴 사본(내용이 동쪽 ox, 북쪽 oy 로 이동). */
const shifted = (ox, oy) => ({ ...IMAGE, bounds: { minX: IMG_MIN + ox, minY: IMG_MIN + oy, maxX: IMG_MAX + ox, maxY: IMG_MAX + oy } });
const drapeTiles = (img) => DRAPE_TXY.map(([tx, ty]) => buildDrapeTile(img, tx, ty, 0));

function renderScene(cam, img, shade) {
  const terrain = createTerrainLayer();
  terrain.accept(0, TERRAIN_TILES);
  const t = terrain.render(cam);
  const drape = createDrapeLayer({ shade });
  assert.equal(drape.accept(0, drapeTiles(img)), 'first');
  const out = drape.apply(cam, t);
  return { terrain: t, out };
}

/** 측정에 쓸 화소: 이상적 ENU 가 드레이프 타일 안이고 빠진 타일에서 3 m(최대 음성 이동 2 m + 여유) 이상 떨어진 곳. */
function measurePixels(cam) {
  const list = [];
  for (let j = 0; j < cam.height; j++) {
    for (let i = 0; i < cam.width; i++) {
      const { x, y } = rayPlaneEnu(cam, i + 0.5, j + 0.5);
      if (Math.abs(x) > 60 || Math.abs(y) > 60) continue;
      if (x > -3 && y < 3) continue; // 빠진 타일 (0,-1) = x∈[0,64], y∈[-64,0] 과 그 둘레
      list.push(j * cam.width + i);
    }
  }
  return list;
}

/**
 * 결과 영상 대비 기준의 최소 제곱 이동량. 결과(i, j) ≈ g·ref(i + 0.5 + dx, j + 0.5 + dy) 인 (dx, dy) 를 px 로 찾는다.
 * 1) 정수 이동 ±searchPx 전역 탐색(표본 화소 약 4000 개, 각 이동마다 g 는 닫힌 꼴) 2) 전 화소 가우스-뉴턴(dx, dy, g) 정밀화.
 */
function measureShift(cam, out, pixels, searchPx) {
  const W = cam.width;
  const tmp = [0, 0, 0];
  const refAt = (p, dx, dy, o) => {
    const i = p % W, j = (p - i) / W;
    const { x, y } = rayPlaneEnu(cam, i + 0.5 + dx, j + 0.5 + dy);
    return sampleImage(IMAGE, x, y, o);
  };
  const stride = Math.max(1, Math.floor(pixels.length / 4000));
  const sub = pixels.filter((_, k) => k % stride === 0);
  let best = { dx: 0, dy: 0, e: Infinity };
  for (let dy = -searchPx; dy <= searchPx; dy++) {
    for (let dx = -searchPx; dx <= searchPx; dx++) {
      let sab = 0, sbb = 0, saa = 0;
      for (const p of sub) {
        refAt(p, dx, dy, tmp);
        for (let k = 0; k < 3; k++) { const a = out.color[p * 3 + k]; sab += a * tmp[k]; sbb += tmp[k] * tmp[k]; saa += a * a; }
      }
      const e = saa - (sab * sab) / sbb; // g = sab/sbb 일 때 남는 제곱합
      if (e < best.e) best = { dx, dy, e };
    }
  }
  let dx = best.dx, dy = best.dy, g = 1;
  const h = 0.05;
  const f0 = [0, 0, 0], fxp = [0, 0, 0], fxm = [0, 0, 0], fyp = [0, 0, 0], fym = [0, 0, 0];
  for (let it = 0; it < 30; it++) {
    // 정규 방정식 JᵀJ·δ = Jᵀr, 미지수 (dx, dy, g)
    const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const bv = [0, 0, 0];
    for (const p of pixels) {
      refAt(p, dx, dy, f0); refAt(p, dx + h, dy, fxp); refAt(p, dx - h, dy, fxm); refAt(p, dx, dy + h, fyp); refAt(p, dx, dy - h, fym);
      for (let k = 0; k < 3; k++) {
        const J = [g * (fxp[k] - fxm[k]) / (2 * h), g * (fyp[k] - fym[k]) / (2 * h), f0[k]];
        const r = out.color[p * 3 + k] - g * f0[k];
        for (let a = 0; a < 3; a++) { bv[a] += J[a] * r; for (let c = 0; c < 3; c++) A[a * 3 + c] += J[a] * J[c]; }
      }
    }
    const d = solve3(A, bv);
    // 한 번에 너무 멀리 뛰지 않게 제한
    const lim = 0.5;
    const sx = Math.max(-lim, Math.min(lim, d[0])), sy = Math.max(-lim, Math.min(lim, d[1]));
    dx += sx; dy += sy; g += d[2];
    if (Math.abs(sx) < 1e-4 && Math.abs(sy) < 1e-4) break;
  }
  // 정합 뒤 잔차(평균 절대 오차, 0..255)
  let sad = 0, n = 0;
  for (const p of pixels) {
    refAt(p, dx, dy, f0);
    for (let k = 0; k < 3; k++) { sad += Math.abs(out.color[p * 3 + k] - g * f0[k]); n++; }
  }
  return { dx, dy, g, px: Math.hypot(dx, dy), mae: sad / n, coarse: [best.dx, best.dy] };
}

function solve3(A, b) {
  const det = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  const D = det(A);
  const col = (c) => { const m = A.slice(); for (let r = 0; r < 3; r++) m[r * 3 + c] = b[r]; return m; };
  return [det(col(0)) / D, det(col(1)) / D, det(col(2)) / D];
}

const fmt = (m) => `dx=${m.dx.toFixed(4)} dy=${m.dy.toFixed(4)} |d|=${m.px.toFixed(4)} px, g=${m.g.toFixed(4)}, 잔차 MAE=${m.mae.toFixed(3)} (정수 탐색 ${m.coarse.join(',')})`;

// 지면 화소 크기: 160×90 은 0.4 m/px(0.5 m = 1.25 px), 640×360 은 0.1 m/px. 둘 다 시야 64 m × 36 m, 중심 (−4, 2) 로 네 타일이 다 보인다.
const VIEWS = [
  { name: '160x90', cam: nadirCamera(160, 90, -4, 2, 100, 0.4) },
  { name: '640x360', cam: nadirCamera(640, 360, -4, 2, 100, 0.1) },
];
const searchFor = (cam) => Math.ceil(2.5 / (100 / cam.K.fx)) + 2;

for (const { name, cam } of VIEWS) {
  const pixels = measurePixels(cam);
  const gsd = 100 / cam.K.fx;

  test(`${name} 연직: 드레이프 정합 ≤ ${DRAPE_ALIGN_MAX_PX} px (음영 끔)`, () => {
    assert.ok(pixels.length > 1000, `측정 화소가 너무 적다: ${pixels.length}`);
    const { terrain, out } = renderScene(cam, IMAGE, false);
    // depth·index 는 그대로, terrain 은 바꾸지 않는다
    assert.deepEqual(out.depth, terrain.depth);
    assert.deepEqual(out.index, terrain.index);
    const m = measureShift(cam, out, pixels, searchFor(cam));
    console.log(`[정합 ${name} 음영 끔] ${fmt(m)} (허용 ${DRAPE_ALIGN_MAX_PX} px, 화소 ${pixels.length})`);
    assert.ok(m.px <= DRAPE_ALIGN_MAX_PX, `정합 오차 ${m.px} px > ${DRAPE_ALIGN_MAX_PX}`);
    assert.ok(Math.abs(m.g - 1) < 0.02, `음영 끔인데 이득 ${m.g}`);
    assert.ok(m.mae < 3, `정합 뒤 잔차가 크다: ${m.mae}`);
  });

  test(`${name} 연직: 드레이프 정합 ≤ ${DRAPE_ALIGN_MAX_PX} px (기본 음영, 이득 맞춤)`, () => {
    const { out } = renderScene(cam, IMAGE, true);
    const m = measureShift(cam, out, pixels, searchFor(cam));
    console.log(`[정합 ${name} 기본 음영] ${fmt(m)}`);
    assert.ok(m.px <= DRAPE_ALIGN_MAX_PX, `정합 오차 ${m.px} px > ${DRAPE_ALIGN_MAX_PX}`);
    assert.ok(m.g > 0.5 && m.g < 1.4, `이득 ${m.g}`);
  });

  for (const [ox, oy] of [[0.5, 0], [0, 2]]) {
    test(`${name} 음성: 영상을 (${ox}, ${oy}) m 옮긴 타일이면 측정 이동량 > ${DRAPE_ALIGN_MAX_PX} px`, () => {
      const { out } = renderScene(cam, shifted(ox, oy), false);
      const m = measureShift(cam, out, pixels, searchFor(cam));
      // 내용이 동쪽 ox 로 가면 화소의 색은 기준에서 서쪽(−ox/gsd px) 위치 색, 북쪽 oy 로 가면 영상 아래(+oy/gsd px) 위치 색이다.
      const ex = -ox / gsd, ey = oy / gsd;
      console.log(`[음성 ${name} (${ox},${oy}) m] ${fmt(m)} 기대 (${ex.toFixed(3)}, ${ey.toFixed(3)})`);
      assert.ok(m.px > DRAPE_ALIGN_MAX_PX, `옮긴 타일인데 측정 이동량 ${m.px} px ≤ ${DRAPE_ALIGN_MAX_PX}`);
      assert.ok(Math.abs(m.dx - ex) < 0.25 && Math.abs(m.dy - ey) < 0.25, `측정 (${m.dx}, ${m.dy}) 이 기대 (${ex}, ${ey}) 와 다르다`);
    });
  }

  test(`${name} 타일이 없는 구역은 지형 색 그대로(드레이프가 메우지 않음)`, () => {
    const { terrain, out } = renderScene(cam, IMAGE, false);
    let n = 0, changed = 0, drapedElsewhere = 0;
    for (let j = 0; j < cam.height; j++) {
      for (let i = 0; i < cam.width; i++) {
        const p = j * cam.width + i;
        if (!(terrain.depth[p] > 0)) continue;
        const { x, y } = rayPlaneEnu(cam, i + 0.5, j + 0.5);
        const same = out.color[3 * p] === terrain.color[3 * p] && out.color[3 * p + 1] === terrain.color[3 * p + 1] && out.color[3 * p + 2] === terrain.color[3 * p + 2];
        // 빠진 타일 (0,-1) 안쪽(경계에서 1 m 이상)
        if (x > MISSING.tx * 64 + 1 && x < (MISSING.tx + 1) * 64 - 1 && y > MISSING.ty * 64 + 1 && y < (MISSING.ty + 1) * 64 - 1) {
          n++;
          if (!same) changed++;
        } else if (!same) drapedElsewhere++;
      }
    }
    assert.ok(n > 100, `빠진 타일 구역 화소가 너무 적다: ${n}`);
    assert.equal(changed, 0, `빠진 타일 구역에서 ${changed}/${n} 화소가 바뀌었다`);
    assert.ok(drapedElsewhere > 1000, '드레이프가 입혀진 화소가 거의 없다');
  });
}
