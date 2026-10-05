// F-359 (B) 측정: 저대비 사인 블록 실제 1.5 px 국소 어긋남(양성 540회)의 거짓 정합 통과와, 이동 0(귀무 360회)의 거짓 local·거짓 불확정.
// 양성: g/e (−0.125,−1.375)·(−0.25,−1.25)·(−0.375,−1.125) × 사인 1.5·2·2.5 DN × 타일 잡음 ±1·±2 DN × 시드 30(2000003 + k·7919).
//   거짓 통과 = 'measured 이면서 maxMisalignPx ≤ ALIGN_TOLERANCE_PX'.
// 귀무: 사인 1.5·2·2.5 DN × ±2·±3 DN × 시드 60(같은 생성식), 이동 0. 거짓 local = local 블록이 있는 타일, 거짓 불확정 = 불확정 블록이 있는 타일.
// 사용: node server/terrain/drape/f359_measure.mjs [--repo <제품 저장소 루트>] [--list]
//   --repo 가 없으면 SKYLENS_RENDERER_DIR, 그것도 없으면 이 파일 기준 저장소 루트. --list 는 거짓 통과 [잡음, 진폭, g, seed] 를 출력.
// 도우미(makeImage·boxMean·warpedTile·HASH·TEX_A·sine·lowContrastImage)는 drape_noise.test.mjs 에서 그대로 복사했다.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const ai = argv.indexOf('--repo');
const repo = path.resolve(ai >= 0 ? argv[ai + 1] : process.env.SKYLENS_RENDERER_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..'));
const listFails = argv.includes('--list');
const { ALIGN_TOLERANCE_PX, TERRAIN_TILE_SIZE_M, tileBounds } = await import(pathToFileURL(path.join(repo, 'contracts/tower_assets/index.mjs')).href);
const { measureDrapeAlignment, drapeTileSize } = await import(pathToFileURL(path.join(repo, 'server/terrain/drape/index.mjs')).href);

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

const G_E = [[-0.125, -1.375], [-0.25, -1.25], [-0.375, -1.125]];
const AMPS = [1.5, 2, 2.5];
const seeds = (n) => Array.from({ length: n }, (_, i) => 2000003 + i * 7919);
const images = new Map(AMPS.map((a) => [a, lowContrastImage(LOW.sine(a))]));

const rows = [];
const fails = [];
for (const [g, e] of G_E) {
  let pass = 0;
  const warp = (p) => ({ x: p.x + (p.x >= 32 && p.x < 40 && p.y >= 40 && p.y < 48 ? g + e : g) * 0.5, y: p.y });
  for (const amp of AMPS) {
    for (const noise of [1, 2]) {
      for (const seed of seeds(30)) {
        const m = measureDrapeAlignment(images.get(amp), warpedTile(images.get(amp), 0, 0, 0, warp, { noise, seed }));
        if (m.status === 'measured' && m.maxMisalignPx <= ALIGN_TOLERANCE_PX) { pass++; fails.push([noise, amp, g, seed]); }
      }
    }
  }
  rows.push([g, e, pass]);
}
let nullLocal = 0, nullUnd = 0, nullRuns = 0;
const id = (p) => p;
for (const amp of AMPS) {
  for (const noise of [2, 3]) {
    for (const seed of seeds(60)) {
      const m = measureDrapeAlignment(images.get(amp), warpedTile(images.get(amp), 0, 0, 0, id, { noise, seed }));
      nullRuns++;
      if (m.status !== 'measured') continue;
      if (m.blocks.some((b) => b.local)) nullLocal++;
      if (m.undecidedBlocks) nullUnd++;
    }
  }
}
console.log(`repo ${repo}`);
console.log('| g / e | 거짓 정합 통과(/180) |');
console.log('|---|---|');
for (const [g, e, p] of rows) console.log(`| ${g} / ${e} | ${p} |`);
console.log(`양성 합 ${rows.reduce((s, r) => s + r[2], 0)}/540`);
console.log(`귀무 ${nullRuns}회: 거짓 local ${nullLocal}, 거짓 불확정 ${nullUnd} (${((100 * nullUnd) / nullRuns).toFixed(1)} %)`);
if (listFails) for (const f of fails) console.log(JSON.stringify(f));
