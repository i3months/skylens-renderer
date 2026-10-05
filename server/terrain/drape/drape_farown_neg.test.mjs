// F-390 ①: farOwn(index.mjs 재적합 이상치 경로, F-359 (A)) 과발화 음성 시험.
// farOwn 은 '다듬은 자기 최소가 모형 예측에서 OUTLIER_PX 이상 떨어진' 재적합 이상치만 짝 검정 경로로 보내야 한다. 이 시험이 없으면
// farOwn 을 늘 참으로 둔 변이(const farOwn = true)에서도 drape 시험 55개가 모두 통과했다(F-390). 아래 입력은 이동 0(귀무)이고, 블록은
// 재적합 이상치이지만 ±OUTLIER_PX 창 안 잔차 < 0.5(경계에 닿지 않음)이고 자기 최소가 예측 0.5 px 안이다 — 짝 검정 경로로 갈 이유가
// 없으므로 local 도 불확정도 아닌 정합 블록이어야 한다. farOwn 이 과발화하면 이 블록은 짝 검정 경로로 들어가 반드시 local 또는
// 불확정이 된다(그 경로에는 두 결과밖에 없다).
// 두 블록 모두 창 안 잔차가 0.45 이상이라, 잔차 문턱(index.mjs `residual(b, fit.at) >= OUTLIER_PX`)을 0.45 로 낮춘 변이도 잡는다.
//
// 입력을 찾은 스캔(연구 저장소 밖 일회성 스캔, 요약): index.mjs 사본의 farOwn 판정 직후에 블록 진단(settle 결과 out, 창 안 잔차,
// 다듬은 자기 최소, 예측)을 남기게 해 이동 0 타일을 돌렸다. 영상은 0.5 m/px, 바탕은 영상 A 무늬(TEX_A), 저대비 영역
// A(x 8..56, y 16..48 m)·B(x 0..64, y 24..40 m)·C(x 16..48, y 8..56 m) × 무늬(사인 1.5·2·3 DN, hash1, edgeGrad) × 밉 0·1 ×
// 잡음 ±2·±3·±4 DN × 시드 20(5000011 + k·7919) = 1800회. 조건 'out === false, 창 안 잔차 < 0.5, 자기 최소–예측 < 0.5, 원본에서
// local·불확정 아님' 인 블록 179개 중 밉 0, 창 안 잔차 ≥ 0.45, 타일 maxMisalignPx ≤ 1 인 둘을 골랐다(같은 조건 밉 0 후보는 이 둘뿐).
// 같은 스캔의 원래 저대비 영역(lowContrastImage, x 26..46·y 36..52 m)·사인 1..3 DN·이동 0 은 800회에서 이 조건 블록이 0개였다.
//   s3B ±4 DN seed 5087120 블록 (64,48): 창 안 잔차 0.485, 자기 최소 (−0.469, 0.125), 예측 (0.005, −0.001), maxMisalignPx 0.033
//   edgeGradC ±3 DN seed 5071282 블록 (80,16): 창 안 잔차 0.469, 자기 최소 (0, 0.5), 예측 (−0.004, 0.022), maxMisalignPx 0.047
// 창 안 잔차·자기 최소는 출력 진단 필드가 없어 아래 probeBlock 이 시험 안에서 같은 탐색으로 다시 잰다(index.mjs 는 고치지 않음).
// 도우미(makeImage·boxMean·warpedTile·HASH·TEX_A·LOW)는 drape_farown.test.mjs 에서 그대로 복사했다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ALIGN_TOLERANCE_PX, TERRAIN_TILE_SIZE_M, tileBounds } from '../../../contracts/tower_assets/index.mjs';
import { measureDrapeAlignment, drapeTileSize } from './index.mjs';

/** 합성 영상: 각 픽셀 중심 ENU 로 색을 정한다. 행 0 = 북. */
function makeImage(bounds, width, height, colorAt) {
  const rgb = new Uint8Array(width * height * 3);
  const sx = (bounds.maxX - bounds.minX) / width, sy = (bounds.maxY - bounds.minY) / height;
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const [R, G, B] = colorAt(bounds.minX + (c + 0.5) * sx, bounds.maxY - (r + 0.5) * sy, c, r);
      const o = (r * width + c) * 3;
      rgb[o] = R; rgb[o + 1] = G; rgb[o + 2] = B;
    }
  }
  return { width, height, rgb, bounds };
}

/** 원본 영상의 축 정렬 박스 [x0,x1]×[y0,y1](ENU) 면적 가중 평균. 영상 밖에 걸치면 false. */
function boxMean(img, x0, x1, y0, y1, out) {
  const b = img.bounds, sx = (b.maxX - b.minX) / img.width, sy = (b.maxY - b.minY) / img.height;
  const u0 = (x0 - b.minX) / sx, u1 = (x1 - b.minX) / sx, v0 = (b.maxY - y1) / sy, v1 = (b.maxY - y0) / sy;
  if (u0 < 0 || v0 < 0 || u1 > img.width || v1 > img.height) return false;
  out.fill(0);
  let a = 0;
  for (let r = Math.floor(v0); r < Math.ceil(v1); r++) {
    const ly = Math.min(v1, r + 1) - Math.max(v0, r);
    if (ly <= 0) continue;
    for (let c = Math.floor(u0); c < Math.ceil(u1); c++) {
      const lx = Math.min(u1, c + 1) - Math.max(u0, c);
      if (lx <= 0) continue;
      const w = lx * ly, o = (r * img.width + c) * 3;
      for (let k = 0; k < 3; k++) out[k] += img.rgb[o + k] * w;
      a += w;
    }
  }
  for (let k = 0; k < 3; k++) out[k] /= a;
  return true;
}

/**
 * warp 로 내용이 틀어진 드레이프 타일(밉 크기·박스 필터는 buildDrapeTile 과 같음, 픽셀당 4×4 부분 박스로 근사).
 * keep(i, j) 가 false 인 픽셀은 영상 밖처럼 비운다(mask 0). noise > 0 이면 채널마다 결정적 ±noise 균등 잡음(seed 로 정함)을 더한다.
 * sameNoise 면 픽셀마다 잡음 하나를 세 채널에 똑같이 더한다(채널 상관 잡음, F-376).
 * coverage.bounds 는 넣지 않는다(피복 범위는 mask 로만 알 수 있다).
 */
function warpedTile(img, tx, ty, mip, warp, { keep = () => true, noise = 0, seed = 12345, sameNoise = false } = {}) {
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 2 ** 32; };
  const { width, height } = drapeTileSize(img, mip);
  const tb = tileBounds(tx, ty), pw = TERRAIN_TILE_SIZE_M / width, ph = TERRAIN_TILE_SIZE_M / height, n = 4;
  const rgb = new Uint8Array(width * height * 3), mask = new Uint8Array(width * height);
  const acc = new Float64Array(3), sum = new Float64Array(3);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      sum.fill(0);
      let ok = keep(i, j);
      for (let b = 0; b < n && ok; b++) {
        for (let a = 0; a < n && ok; a++) {
          const q = warp({ x: tb.minX + (i + (a + 0.5) / n) * pw, y: tb.maxY - (j + (b + 0.5) / n) * ph });
          ok = boxMean(img, q.x - pw / n / 2, q.x + pw / n / 2, q.y - ph / n / 2, q.y + ph / n / 2, acc);
          for (let k = 0; k < 3; k++) sum[k] += acc[k];
        }
      }
      if (!ok) continue;
      const o = j * width + i;
      mask[o] = 255;
      const e0 = sameNoise && noise ? Math.round((rnd() * 2 - 1) * noise) : 0;
      for (let k = 0; k < 3; k++) {
        const e = sameNoise ? e0 : noise ? Math.round((rnd() * 2 - 1) * noise) : 0;
        rgb[o * 3 + k] = Math.max(0, Math.min(255, Math.round(sum[k] / (n * n)) + e));
      }
    }
  }
  return { tx, ty, mip, width, height, rgb, coverage: { mask } };
}

const HASH = (c, r) => (((c * 73856093) ^ (r * 19349663)) >>> 0);
// 영상 A 와 같은 무늬(8 m 바둑판 + 사인 + 해시, 잡음 0)를 픽셀 중심 ENU·번호로.
const TEX_A = (x, y, c, r) => [
  ((Math.floor(x / 8) + Math.floor(y / 8)) & 1) ? 200 : 40, Math.round(128 + 100 * Math.sin(x * 0.07) * Math.cos(y * 0.05)), HASH(c, r) % 256,
];
// 저대비 무늬(잡음 0). c·r 은 0.5 m/px 영상 픽셀 번호(= 밉 0 타일 픽셀).
const LOW = {
  // 사인 진폭 amp DN, R 은 x 주기 48 px, G 는 y 주기 32 px.
  sine: (amp) => (x, y, c, r) => [Math.round(128 + amp * Math.sin((2 * Math.PI * c) / 48)), Math.round(60 + amp * Math.sin((2 * Math.PI * r) / 32)), 60],
  // F-353: R = x 경사 0.15 DN/px + x 36·44 m 의 4.7 DN 세로 경계 둘(블록 안 4.7→9.4 DN), G = y 경사 0.12→0.24 DN/px.
  edgeGrad: (x, y, c, r) => [
    Math.round(100 + 0.15 * (c - 180) + (x >= 36 ? 4.7 : 0) + (x >= 44 ? 4.7 : 0)),
    Math.round(60 + 0.12 * (r - 152) + (0.12 * (r - 152) ** 2) / 64), 60,
  ],
};
/** 0.5 m/px 영상: 저대비 영역 [x0,x1)×[y0,y1)(m) 은 low, 그 밖은 영상 A 무늬(잡음 0). lowContrastImage 와 영역만 다르다. */
function regionImage(low, [x0, x1, y0, y1]) {
  return makeImage({ minX: -64, minY: -64, maxX: 128, maxY: 128 }, 384, 384, (x, y, c, r) => (
    x >= x0 && x < x1 && y >= y0 && y < y1 ? low(x, y, c, r) : TEX_A(x, y, c, r)));
}

// index.mjs 의 탐색을 시험 안에서 다시 한다(블록 표본·후보 순서·엄격 개선 규칙·lim 이 같다). 비용은 index.mjs 의 누적 합 표 대신
// boxMean(같은 면적 가중 평균)으로 잰다. 전제: 완전 피복 타일, 블록 한 변 = 타일/8(밉 0 16 px·밉 1 8 px, 솎지 않음),
// 블록 첫 탐색 반경 4 px, 블록이 두 축 모두 잰 블록(axes 'xy').
const REFINE_STAGES = [[1, 0.5], [0.5, 0.25], [0.25, 0.125], [0.125, 1 / 16], [1 / 16, 1 / 32]];
/** 블록 (i0, j0) 의 다듬은 자기 최소(own)·모형 예측(pred)·예측 ±0.5 px 창 최소(win)와 창 안 잔차(wr)·자기 최소–예측 거리(dist). */
function probeBlock(img, tile, m, i0, j0) {
  const TW = tile.width, TH = tile.height, B = TW / 8;
  const tb = tileBounds(tile.tx, tile.ty), pw = TERRAIN_TILE_SIZE_M / TW, ph = TERRAIN_TILE_SIZE_M / TH;
  const acc = new Float64Array(3);
  const cost = (dx, dy) => {
    let sum = 0, n = 0;
    for (let j = j0; j < j0 + B; j++) {
      for (let i = i0; i < i0 + B; i++) {
        const x0 = tb.minX + (i + dx) * pw, y1 = tb.maxY - (j + dy) * ph;
        if (!boxMean(img, x0, x0 + pw, y1 - ph, y1, acc)) continue;
        for (let k = 0; k < 3; k++) sum += (tile.rgb[(j * TW + i) * 3 + k] - acc[k]) ** 2;
        n++;
      }
    }
    return n > 0 ? { mse: sum / (n * 3), n } : { mse: Infinity, n: 0 };
  };
  const search = (cx, cy, stages, minN, lim = Infinity) => {
    let best = { dx: cx, dy: cy, ...cost(cx, cy) };
    if (best.n < minN) best = { dx: cx, dy: cy, mse: Infinity, n: 0 };
    for (const [radius, step] of stages) {
      const ox = best.n > 0 ? best.dx : cx, oy = best.n > 0 ? best.dy : cy;
      const k = Math.round(radius / step);
      const cand = [];
      for (let a = -k; a <= k; a++) for (let b = -k; b <= k; b++) cand.push([ox + a * step, oy + b * step]);
      cand.sort((p, q) => (Math.hypot(p[0] - cx, p[1] - cy) - Math.hypot(q[0] - cx, q[1] - cy)) || (p[1] - q[1]) || (p[0] - q[0]));
      for (const [dx, dy] of cand) {
        if (Math.abs(dx - cx) > lim + 1e-9 || Math.abs(dy - cy) > lim + 1e-9) continue;
        const c = cost(dx, dy);
        if (c.n >= minN && c.mse < best.mse - 1e-9 * (1 + best.mse)) best = { dx, dy, ...c };
      }
    }
    return best;
  };
  const minN = Math.ceil(cost(m.globalDxPx, m.globalDyPx).n / 2);
  const coarse = search(m.globalDxPx, m.globalDyPx, [[4, 1], ...REFINE_STAGES.slice(0, 2)], minN);
  const own = search(coarse.dx, coarse.dy, REFINE_STAGES.slice(2), minN);
  const di = i0 + B / 2 - TW / 2, dj = j0 + B / 2 - TH / 2, f = m.affine;
  const pred = [f.ax + f.kxx * di + f.kxy * dj, f.ay + f.kyx * di + f.kyy * dj];
  const win = search(pred[0], pred[1], REFINE_STAGES, minN, 0.5);
  return {
    own, pred, win,
    wr: Math.hypot(win.dx - pred[0], win.dy - pred[1]),
    dist: Math.hypot(own.dx - pred[0], own.dy - pred[1]),
  };
}

const REGION = { B: [0, 64, 24, 40], C: [16, 48, 8, 56] };
const NEG_CASES = [
  // [이름, 저대비 무늬, 영역, 잡음 ±DN, seed, 블록 i0, j0]
  ['s3B', LOW.sine(3), REGION.B, 4, 5087120, 64, 48],
  ['edgeGradC', LOW.edgeGrad, REGION.C, 3, 5071282, 80, 16],
];
for (const [name, low, region, noise, seed, i0, j0] of NEG_CASES) {
  test(`F-390 farOwn 음성: ${name} ±${noise} DN seed ${seed} 이동 0 — 창 안 잔차 < 0.5·자기 최소가 예측 0.5 px 안인 재적합 이상치 블록 (${i0},${j0}) 은 local 도 불확정도 아님`, () => {
    // const farOwn = true 변이에서는 이 블록이 짝 검정 경로로 들어가 불확정(또는 local)이 된다.
    const img = regionImage(low, region);
    const tile = warpedTile(img, 0, 0, 0, (p) => p, { noise, seed });
    const m = measureDrapeAlignment(img, tile);
    assert.equal(m.status, 'measured');
    const b = m.blocks.find((q) => q.i0 === i0 && q.j0 === j0);
    assert.ok(b, `블록 (${i0},${j0}) 없음`);
    assert.equal(b.axes, 'xy');
    // 전제(시험 안에서 다시 잼): 창 안 잔차는 0.45 이상 0.5 미만(경계에 닿지 않음), 다듬은 자기 최소는 예측 0.5 px 안 → farOwn 은 거짓.
    const p = probeBlock(img, tile, m, i0, j0);
    assert.ok(p.wr >= 0.45 && p.wr < 0.5, `창 안 잔차 ${p.wr}`);
    assert.ok(p.dist < 0.5, `자기 최소 (${p.own.dx}, ${p.own.dy}) 예측 (${p.pred}) 거리 ${p.dist}`);
    assert.ok(!b.local && !b.undecided, `블록 (${i0},${j0}) local ${b.local} undecided ${b.undecided}`);
    // 정합 블록의 보고값은 창 최소다(재계산이 제품 탐색과 같은 값을 냄을 함께 확인).
    assert.ok(Math.abs(b.dx - p.win.dx) < 1e-9 && Math.abs(b.dy - p.win.dy) < 1e-9, `보고 (${b.dx}, ${b.dy}) 재계산 창 최소 (${p.win.dx}, ${p.win.dy})`);
    assert.ok(m.maxMisalignPx <= ALIGN_TOLERANCE_PX, `maxMisalignPx ${m.maxMisalignPx}`);
  });
}
