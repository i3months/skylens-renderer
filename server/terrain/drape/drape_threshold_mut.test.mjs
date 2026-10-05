// F-391 ⑥: 재적합 이상치 경로의 두 문턱(index.mjs, OUTLIER_PX = 0.5)을 지키는 시험.
// 기존 시험은 문턱 변이를 다 잡지 못했다.
//   (a) farOwn 문턱(`자기 최소–예측 ≥ OUTLIER_PX`)을 0.6 으로 올린 변이: drape_farown*.test.mjs 6/6 통과(양성 최소 거리 0.656).
//   (b) 잔차 문턱(`residual(b, fit.at) ≥ OUTLIER_PX`)을 2×OUTLIER_PX(1.0)로 올린 변이: drape 전체 59개 통과.
// (a) 자기 최소–예측 거리가 0.5~0.6 인 farOwn 양성: 창 안 잔차 < 0.5 라 잔차 경로로는 들지 못하고 farOwn 으로만 든다.
//     문턱이 0.6 이면 진입하지 못해 정합 블록으로 남는다.
// (b) 창 안 잔차 ≥ 0.5(잔차 경로로 진입)이면서 자기 최소–예측 < 0.5(farOwn 거짓): 잔차 경로로만 든다. 문턱이 1.0 이면 창 안 잔차가
//     ±0.5 px 창(축마다)이라 hypot ≤ 0.707 이어서 이 경로가 아예 꺼지고, 블록은 정합 블록으로 남는다.
// 두 경로는 겹치지 않는다: 잔차 ≥ 0.5 이면서 farOwn 거짓인 블록이 실제로 있다(아래 (b), 이동 0 잡음 입력).
// 입력은 시험 안의 probeBlock 으로 블록마다 (창 안 잔차, 거리)를 재며 스캔해 찾았다(index.mjs 는 고치지 않음).
//   (a) 사인 LOW 영상(lowContrastImage), 블록 x 32..40·y 40..48 m 만 g+e, 나머지 g 만큼 동쪽(drape_farown.test.mjs 와 같은 식):
//       g/e 11조합 × 사인 1.5·2·3 DN × 잡음 ±1·±2·±3 DN × 시드 12 중 창 안 잔차 < 0.5·거리 0.5~0.6·local/불확정인 블록 (64,32).
//       시드 = 6000011 + k·7919 + round((g·17 + e·31)·1000). 창 안 잔차가 0.5 에 float 오차 내로 붙은 사례는 뺐다.
//   (b) 이동 0, 저대비 영역 × 무늬 × 잡음 ±2..5 DN × 시드 10(7000011 + k·7919) 중 창 안 잔차 ≥ 0.5·거리 < 0.5·local/불확정인 블록.
//       약 1100개 잔차 ≥ 0.5 블록 중 4개(잡음 ±5 DN)뿐이다. 아래는 창 안 잔차가 0.5 에서 가장 떨어진 사례.
// F-393 ⑦·⑫ 보강(T15.R3-S2): 사례 보강과 변이 확인. 변이는 index.mjs 를 고치지 않고 임시 폴더 사본에서 했다(문턱 한 줄씩 바꿈).
//   원본: 이 파일 6/6·drape_farown 4/4·drape_farown_neg 2/2·drape.test 37/37 통과.
//   변이 farOwn 문턱 0.6 : 이 파일 3 실패(farOwn 양성 3건 전부). 변이 잔차 문턱 1.0 : 이 파일 3 실패(잔차 3건 전부).
//   변이 잔차 문턱 0.4 : 이 파일은 6/6 통과(양성 시험은 이 변이를 잡지 못한다) — 음성 시험 drape_farown_neg 가 2/2 실패해 잡는다.
//   변이 farOwn 문턱 0.52 : 이 파일 6/6 통과(생존). 거리 0.5~0.52 사례를 찾지 못해서다 — 가장 가까운 사례의 거리가 0.5202 라 0.521 이상만 잡는다.
//   거리 0.5~0.52 탐색: 사인 1.5·2·3 DN × g −0.75..0.125(e 는 g+e −1.25~−1.5 또는 −0.9·−1) × 잡음 ±1..3 DN × 시드 30~70(기점 8000011·9000011·9500011·9700011)
//   약 6000회에서 조건(창 안 잔차 < 0.499·거리 0.5~0.7·local/불확정) 블록은 g ≈ −0.5 부근에서만 나왔고 거리 0.5~0.52 는 0.5202 한 건뿐이었다.
//   A 사례는 (진폭, g) 가 서로 다른 셋(1.5/−0.515625, 2/−0.5, 3/−0.5)으로 바꿨고, 잔차 사례는 창 안 잔차 0.5201 인 둘(s4D·s6E, 단언 하한은 0.51)을 더했다.
// 도우미(makeImage·boxMean·warpedTile·HASH·TEX_A·LOW·lowContrastImage·probeBlock)는 drape_farown.test.mjs 에서 그대로 복사했다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TERRAIN_TILE_SIZE_M, tileBounds } from '../../../contracts/tower_assets/index.mjs';
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
  // R·G 채널 ±1 DN 해시 무늬.
  hash1: (x, y, c, r) => [128 + (HASH(c, r) % 3) - 1, 60 + (HASH(r, c) % 3) - 1, 60],
  // 균일 바탕에 R +6 DN 점(밀도 1/32, 위치는 해시 상위 비트 — 하위 비트는 주기 8 무늬).
  dots6: (x, y, c, r) => [(HASH(c, r) >>> 16) % 32 === 0 ? 134 : 128, 60, 60],
  // F-353: R = x 경사 0.15 DN/px + x 36·44 m 의 4.7 DN 세로 경계 둘(블록 안 4.7→9.4 DN), G = y 경사 0.12→0.24 DN/px.
  // y 로 1 px 옮긴 비용 상승은 1/12 이하(수정 전: 블록 제외), 4 px 에서는 뚜렷하다.
  edgeGrad: (x, y, c, r) => [
    Math.round(100 + 0.15 * (c - 180) + (x >= 36 ? 4.7 : 0) + (x >= 44 ? 4.7 : 0)),
    Math.round(60 + 0.12 * (r - 152) + (0.12 * (r - 152) ** 2) / 64), 60,
  ],
  // F-353: 위의 R 만, G 는 균일 → y 축은 어느 거리에서도 평평(한 축만 평평한 블록).
  edgeOnly: (x, y, c, r) => [Math.round(100 + 0.15 * (c - 180) + (x >= 36 ? 4.7 : 0) + (x >= 44 ? 4.7 : 0)), 60, 60],
};
/** 타일 격자와 맞물린 0.5 m/px 영상: x 26..46, y 36..52 m 는 저대비 무늬 low, 그 밖은 영상 A 무늬(잡음 0). */
function lowContrastImage(low) {
  return makeImage({ minX: -64, minY: -64, maxX: 128, maxY: 128 }, 384, 384, (x, y, c, r) => (
    x >= 26 && x < 46 && y >= 36 && y < 52 ? low(x, y, c, r) : TEX_A(x, y, c, r)));
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


/** 0.5 m/px 영상: 저대비 영역 [x0,x1)×[y0,y1)(m) 은 low, 그 밖은 영상 A 무늬(잡음 0). */
function regionImage(low, [x0, x1, y0, y1]) {
  return makeImage({ minX: -64, minY: -64, maxX: 128, maxY: 128 }, 384, 384, (x, y, c, r) => (
    x >= x0 && x < x1 && y >= y0 && y < y1 ? low(x, y, c, r) : TEX_A(x, y, c, r)));
}

// (a) farOwn 문턱: 창 안 잔차 < 0.5, 자기 최소–예측 거리 0.5~0.6 → farOwn 으로만 든다(문턱 0.6 이면 놓친다).
// 세 사례는 (진폭, g) 가 모두 다르다. 전제(창 안 잔차 < 0.499·거리 0.5~0.6)가 깨지면 시험이 실패하니 그때는 사례를 다시 탐색한다.
// 사례별 마진(탐색 때 잰 값): 창 안 잔차는 0.5 아래, 거리는 0.5 위.
//   1.5 DN g −0.515625: 창 안 잔차 0.4941(0.0059 아래), 거리 0.5202(0.0202 위) — 가장 얇은 쪽은 거리, 변이 farOwn 0.521 이상을 잡는다.
//   2 DN g −0.5: 창 안 잔차 0.4780(0.022 아래), 거리 0.5344(0.0344 위).
//   3 DN g −0.5 e −1: 창 안 잔차 0.4375(0.0625 아래), 거리 0.5564(0.0564 위).
// 한계: 거리 0.5~0.52 사례는 찾지 못했다(위 머리 주석의 탐색 요약). 문턱을 0.52 로 올린 변이(거리 0.5202 ≥ 0.52)는 이 시험이 잡지 못한다 —
// '0.521 이상으로 올린 변이만 잡는다'. 0.5~0.52 에 드는 사례를 찾으면 그 사례로 이 한계를 줄인다.
const A_CASES = [
  // [사인 진폭 DN, g, e, 잡음 ±DN, seed]
  [1.5, -0.515625, -0.9, 1, 9745500],
  [2, -0.5, -0.9, 1, 6011125],
  [3, -0.5, -1, 1, 9007930],
  // seed 5995287 (STATUS 이월 입력 재현): 창 안 잔차 0.4375(0.0625 아래), 거리 0.5826(0.0826 위) — 마진이 가장 넉넉한 사례.
  [2, -0.515625, -0.9, 1, 5995287],
];
for (const [amp, g, e, noise, seed] of A_CASES) {
  test(`F-391 ⑥ farOwn 문턱: 사인 ${amp} DN g ${g} e ${e} ±${noise} DN seed ${seed} — 창 안 잔차 < 0.5·자기 최소–예측 0.5~0.6 px 블록 (64,32) 는 local 또는 불확정`, () => {
    // farOwn 문턱을 0.6 으로 올린 변이에서는 이 블록이 정합 블록으로 남는다.
    const img = lowContrastImage(LOW.sine(amp));
    const warp = (p) => ({ x: p.x + (p.x >= 32 && p.x < 40 && p.y >= 40 && p.y < 48 ? g + e : g) * 0.5, y: p.y });
    const tile = warpedTile(img, 0, 0, 0, warp, { noise, seed });
    const m = measureDrapeAlignment(img, tile);
    assert.equal(m.status, 'measured');
    const b = m.blocks.find((q) => q.i0 === 64 && q.j0 === 32);
    assert.ok(b, '블록 (64,32) 없음');
    assert.equal(b.axes, 'xy');
    const p = probeBlock(img, tile, m, 64, 32);
    assert.ok(p.wr < 0.499, `전제가 깨졌다 — 사례를 다시 탐색한다. 창 안 잔차 ${p.wr}`);
    assert.ok(p.dist >= 0.5 && p.dist < 0.6, `전제가 깨졌다 — 사례를 다시 탐색한다. 자기 최소 (${p.own.dx}, ${p.own.dy}) 예측 (${p.pred}) 거리 ${p.dist}`);
    assert.ok(b.local || b.undecided, `블록 (64,32) local ${b.local} undecided ${b.undecided} dx ${b.dx}`);
  });
}

// (b) 잔차 문턱: 창 안 잔차 ≥ 0.5, 자기 최소–예측 < 0.5(farOwn 거짓) → 잔차 경로로만 든다(문턱 1.0 이면 놓친다).
// 처음 사례(s3C)는 창 안 잔차가 0.5 위 0.004 뿐이라 단언 ≥ 0.501 이 약했다. 새 사례는 창 안 잔차 ≥ 0.51 을 단언한다(실측 0.5201 이라 float 오차에 쓰는 여유 0.0001 이 아니라 0.0101 의 마진을 둔다, F-397 ⑧).
// 새 사례 마진(탐색 때 잰 값): 창 안 잔차 0.5201(0.5 위 0.0201), 자기 최소–예측 거리 0.4954·0.4951(0.5 아래 0.005).
// 탐색: 이동 0, 저대비 영역 [16,48]×[8,56] m, 사인 1.5·2·3·4·6·10 DN × 잡음 ±4..8 DN × 시드 40~160(기점 7100011·7300011·7600011 + k·7919)
// 중 local/불확정이면서 창 안 잔차 ≥ 0.52·거리 < 0.5 인 블록은 위 두 건뿐이었다(약 4000회 측정, 거리 < 0.485 는 0건).
// 한계: 두 사례 모두 거리가 0.5 아래 0.005 라, 예측이 0.005 px 움직이면 farOwn 이 켜져 전제가 깨진다 — 그때는 사례를 다시 탐색한다.
const B_CASES = [
  // [이름, 저대비 무늬, 영역, 잡음 ±DN, seed, 블록 i0, j0, 창 안 잔차 하한]
  ['s3C', LOW.sine(3), [16, 48, 8, 56], 5, 7047525, 48, 16, 0.5 + 1e-3],
  ['s4D', LOW.sine(4), [16, 48, 8, 56], 5, 7474229, 32, 32, 0.51],
  ['s6E', LOW.sine(6), [16, 48, 8, 56], 6, 7339606, 64, 64, 0.51],
];
for (const [name, low, region, noise, seed, i0, j0, wrMin] of B_CASES) {
  test(`F-391 ⑥ 잔차 문턱: ${name} ±${noise} DN seed ${seed} 이동 0 — 창 안 잔차 ≥ ${wrMin.toFixed(3)}·farOwn 거짓인 블록 (${i0},${j0}) 은 local 또는 불확정`, () => {
    // 잔차 문턱을 1.0 으로 올린 변이에서는 이 블록이 어느 경로로도 들지 못해 정합 블록으로 남는다.
    const img = regionImage(low, region);
    const tile = warpedTile(img, 0, 0, 0, (p) => p, { noise, seed });
    const m = measureDrapeAlignment(img, tile);
    assert.equal(m.status, 'measured');
    const b = m.blocks.find((q) => q.i0 === i0 && q.j0 === j0);
    assert.ok(b, `블록 (${i0},${j0}) 없음`);
    assert.equal(b.axes, 'xy');
    const p = probeBlock(img, tile, m, i0, j0);
    assert.ok(p.wr >= wrMin && p.wr < 1, `전제가 깨졌다 — 사례를 다시 탐색한다. 창 안 잔차 ${p.wr}`);
    assert.ok(p.dist < 0.5 - 1e-3, `전제가 깨졌다 — 사례를 다시 탐색한다. 자기 최소 (${p.own.dx}, ${p.own.dy}) 예측 (${p.pred}) 거리 ${p.dist}`);
    // 이동 0 입력이라 이 블록은 local(거짓 local, F-363)이 아니라 불확정이어야 한다 — 짝 검정·PAIRED_K 가 퇴행해 local 이 되면 실패(F-393 ⑬).
    assert.equal(b.undecided, true, `블록 (${i0},${j0}) pairedT ${b.pairedT}`);
    assert.equal(b.local, false, `블록 (${i0},${j0}) 이동 0 인데 local pairedT ${b.pairedT}`);
  });
}
