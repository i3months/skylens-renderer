// F-363 음성 대조: 저대비 블록 + ±2·±3 DN 잡음 + 이동 0 타일에서 잡음 최소를 국소 어긋남(local)으로 보고하지 않는다.
// F-359 검토 #4 이후 계약: 이동 0 에서 거짓 local 은 0. 불확정(undecided) 블록은 허용하되(정합 증거가 없다는 보수적 표시) 그 수를
// 기록값 이하로 고정하고, 불확정이 없는 타일은 maxMisalignPx < 1 이어야 한다.
// 도우미(makeImage·boxMean·warpedTile·HASH·TEX_A·LOW·lowContrastImage)는 drape.test.mjs 에서 그대로 복사했다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ALIGN_TOLERANCE_PX, TERRAIN_TILE_SIZE_M, tileBounds } from '../../../contracts/tower_assets/index.mjs';
import { buildDrapeTile, measureDrapeAlignment, drapeTileSize, DRAPE_PAIRED_K } from './index.mjs';

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

/**
 * 이동 0 음성 결과 m 의 위반을 돌려준다(없으면 null): 거짓 local, 측정 불가, 불확정이 없는데 maxMisalignPx ≥ 1.
 * 불확정 타일은 maxMisalignPx ≥ 1 이어도 위반이 아니다(정합 통과를 내지 않는 보수적 실패) — 그 수는 호출 쪽이 센다.
 */
function nullViolation(m) {
  if (m.status !== 'measured') return `${m.status} ${m.reason}`;
  const local = m.blocks.filter((b) => b.local).map(({ i0, j0, dx, dy }) => [i0, j0, dx, dy]);
  if (local.length) return `거짓 local ${JSON.stringify(local)}`;
  if (m.undecidedBlocks !== m.blocks.filter((b) => b.undecided).length) return '불확정 수 불일치';
  // 실제 이동 0 이므로 불확정 블록의 배제 못 한 이동량 = 자기 최소 크기 |o| + 걸어 나간 거리다. 코드가 블록 탐색을 전역 가설 g 둘레
  // BLOCK_SEARCH_PX(4 px, 정사각 창이라 모서리 4√2)로, 걸음을 UNDECIDED_REACH_PX(1 px)로 묶으므로 상한은 |g| + 4√2 + 1 이다
  // (상한은 코드 상수에서 정했고 측정값에 맞춰 조정하지 않는다. 처음 쓴 0.5 + 1 과 g 없는 4 + 1 은 |o| 가정이 틀려 원본이 실패했다).
  if (m.undecidedBlocks && !(m.undecidedMaxPx <= Math.hypot(m.globalDxPx, m.globalDyPx) + 4 * Math.SQRT2 + 1 + 1e-9)) return `불확정 상한 초과 ${m.undecidedMaxPx}`;
  if (!m.undecidedBlocks && !(m.maxMisalignPx < ALIGN_TOLERANCE_PX)) return `불확정 없이 보고 ${m.maxMisalignPx}`;
  return null;
}
// 이동 0 음성 입력의 불확정 타일 수 기록(측정값, 줄면 좋고 늘면 실패).
const F363_UNDECIDED = 11, REVIEW2_UNDECIDED = 8, TAIL_UNDECIDED = 8;
// 시드 k·7919, k = 1..20(drape.test.mjs 의 SEEDS 와 같은 생성식).
const NOISE_SEEDS = Array.from({ length: 20 }, (_, i) => (i + 1) * 7919);

test('F-363 저대비 사인 블록 + ±2·±3 DN 잡음, 이동 0: 시드 20개 — 거짓 local 0, 불확정 타일 기록값 이하', () => {
  // 수정 전(재적합 이상치의 잔차 ≥ 0.5 만으로 local): 사인 2 DN ±3 DN 에서 시드 55433·87109·118785·142542 의 블록 (64,32) 가
  // 거짓 local(142542 는 maxMisalignPx 1.412 — 어긋남이 없는데 정합 ≤ 1 px 실패), 사인 1 DN ±3 DN 에서도 2개.
  // 불확정 타일(측정, F-359 검토 #4): 80회 중 F363_UNDECIDED 회 — 거짓 불확정 비율로 기록한다(0 이 아니다).
  const id = (p) => p;
  const bad = [];
  let undecided = 0;
  for (const [amp, noises] of [[2, [2, 3]], [1, [2, 3]]]) {
    const img = lowContrastImage(LOW.sine(amp));
    for (const noise of noises) {
      for (const seed of NOISE_SEEDS) {
        const m = measureDrapeAlignment(img, warpedTile(img, 0, 0, 0, id, { noise, seed }));
        const why = nullViolation(m);
        if (why) bad.push([amp, noise, seed, why]);
        if (m.undecidedBlocks) undecided++;
      }
    }
  }
  assert.deepEqual(bad, []);
  assert.ok(undecided <= F363_UNDECIDED, `불확정 타일 ${undecided} > 기록 ${F363_UNDECIDED}`);
});

/** ±amp DN 균등 잡음(128 중심)만 있는 0.5 m/px 영상, 타일 (0,0) 과 맞물림(drape.test.mjs 에서 복사). */
function noiseImage(n, amp, seed) {
  let s = seed;
  const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 2 ** 32; };
  return makeImage({ minX: 0, minY: 0, maxX: 64, maxY: 64 }, n, n, () => [0, 1, 2].map(() => 128 + Math.round((rnd() * 2 - 1) * amp)));
}

test('±1 DN 잡음만 있는 128² 영상(F-363 감독 입력 아님), 이동 0, 밉 0~2: local 0, 측정되면 maxMisalignPx < 1(측정 불가는 허용)', () => {
  // 감독 F-363 입력(noiseImage(128,±3,104729)+타일 잡음)은 아래 검토 #2 시험. 무늬가 없어 높은 밉은 비용면이 평평해 측정 불가일 수 있다.
  const img = noiseImage(128, 1, 7919);
  for (let mip = 0; mip <= 2; mip++) {
    for (const tile of [buildDrapeTile(img, 0, 0, mip), warpedTile(img, 0, 0, mip, (p) => p)]) {
      const m = measureDrapeAlignment(img, tile);
      assert.deepEqual(m.blocks.filter((b) => b.local).map(({ i0, j0 }) => [i0, j0]), [], `밉 ${mip}`);
      if (m.status === 'measured') assert.equal(nullViolation(m), null, `밉 ${mip}`);
      if (m.status === 'measured') assert.equal(m.undecidedBlocks, 0, `밉 ${mip}`);
      else assert.ok(Number.isNaN(m.maxMisalignPx), `밉 ${mip}`);
    }
  }
});

test('F-359 검토 #2 음성 대조(짝 검정): 감독 F-363 입력과 사인 2 DN ±3 DN 시드 21~40, 이동 0 — 거짓 local 0, 불확정 기록값 이하', () => {
  // 잔차 경로의 유의성을 같은 표본 픽셀 짝 검정으로 바꾼 뒤에도 잡음 최소를 국소 어긋남으로 보고하지 않는다.
  const id = (p) => p;
  const runs = [];
  const nimg = noiseImage(128, 3, 104729);
  for (const seed of [7919, 79190]) runs.push([`noiseImage(128,±3,104729) 밉 2 ±1 seed ${seed}`, nimg, warpedTile(nimg, 0, 0, 2, id, { noise: 1, seed })]);
  const s1 = lowContrastImage(LOW.sine(1));
  runs.push(['사인 1 DN 밉 1 ±3 seed 87109', s1, warpedTile(s1, 0, 0, 1, id, { noise: 3, seed: 87109 })]);
  const s2 = lowContrastImage(LOW.sine(2));
  for (let k = 21; k <= 40; k++) runs.push([`사인 2 DN ±3 seed ${k * 7919}`, s2, warpedTile(s2, 0, 0, 0, id, { noise: 3, seed: k * 7919 })]);
  const bad = [];
  let undecided = 0;
  for (const [at, img, tile] of runs) {
    const m = measureDrapeAlignment(img, tile);
    const why = nullViolation(m);
    if (why) bad.push([at, why]);
    if (m.undecidedBlocks) undecided++;
  }
  assert.deepEqual(bad, []);
  assert.ok(undecided <= REVIEW2_UNDECIDED, `불확정 타일 ${undecided} > 기록 ${REVIEW2_UNDECIDED}`);
});

// F-359 검토 #3 귀무(이동 0) 측정에서 짝 검정 t 가 가장 컸던 입력: [사인 진폭, 잡음, 시드, 측정 t].
// 귀무 측정 전체(36설정 3510회, 짝 검정 호출 293회)는 index.mjs 의 PAIRED_K 주석. 여기에는 t ≥ 1.8 인 8회를 그대로 둔다
// (측정에서 고른 음성 입력 — 문턱을 맞추려는 것이 아니라 문턱 근처의 귀무 꼬리를 지키려는 것). 입력별 t 는 결정적이라 ±0.01 로
// 단언한다(F-378 ③: 짝 검정 통계를 바꾸는 회귀 — t 를 0.3 옮기는 변이 — 를 잡는다).
const NULL_TAIL = [
  [2, 2, 443464, 2.238], [2.5, 2, 443464, 2.045], [2.5, 3, 443464, 1.897], [1, 4, 15485863, 2.331], [1, 3, 15485863, 1.951],
  [1, 4, 1904761149, 1.803], [2, 3, 449090027, 1.861], [2, 4, 449090027, 1.832],
];

test('F-359 검토 #3 귀무 꼬리: 짝 검정 t 가 큰 이동 0 입력 8회 — 거짓 local 0, 입력별 t = 기록 ±0.01, PAIRED_K 리터럴·여유', () => {
  const id = (p) => p;
  const bad = [];
  let undecided = 0;
  for (const [amp, noise, seed, tRec] of NULL_TAIL) {
    const img = lowContrastImage(LOW.sine(amp));
    const m = measureDrapeAlignment(img, warpedTile(img, 0, 0, 0, id, { noise, seed }));
    const at = `사인 ${amp} DN ±${noise} seed ${seed}`;
    const tested = m.blocks.filter((b) => Number.isFinite(b.pairedT));
    // 이 입력들은 짝 검정 경로를 실제로 지나야 한다(경로가 바뀌어 검정을 안 하면 이 시험은 아무것도 지키지 않는다).
    if (!tested.length) { bad.push([at, '짝 검정 없음']); continue; }
    const t = Math.max(...tested.map((b) => b.pairedT));
    if (!(Math.abs(t - tRec) <= 0.01)) bad.push([at, `t ${t} ≠ 기록 ${tRec}`]);
    const why = nullViolation(m);
    if (why) bad.push([at, why]);
    if (m.undecidedBlocks) undecided++;
  }
  assert.deepEqual(bad, []);
  assert.ok(undecided <= TAIL_UNDECIDED, `불확정 타일 ${undecided} > 기록 ${TAIL_UNDECIDED}`);
  // PAIRED_K 는 local 표시와 불확정 범위 끝을 가르는 진단값이다. 리터럴과, 귀무 측정 최대 t(2.331, index.mjs 주석)에 대한 여유를
  // 고정한다(F-374: 제품 상수와 비교하는 순환 단언은 PAIRED_K 를 2.4·2.9 로 바꿔도 통과했다).
  assert.equal(DRAPE_PAIRED_K, 2.75);
  assert.ok(DRAPE_PAIRED_K - 2.331 >= 0.4, `PAIRED_K 여유 ${DRAPE_PAIRED_K - 2.331}`);
});

test('F-376 채널 상관 잡음(세 채널에 같은 ±3 DN) 귀무: 사인 2 DN 시드 60개 — 거짓 local 0, 짝 검정 t 최대 기록값 이하', () => {
  // pairedT 는 표본을 픽셀 × 3채널로 센다(m = 3n, 채널 잡음 독립 가정). 채널 잡음이 같으면 유효 표본이 n 이라 t 가 부풀 수 있다.
  // 측정(사인 1.5·2·2.5 DN × 같은 ±3 DN × 시드 60, 180회): 거짓 local 0, t 최대 1.427 — 귀무 최대 2.331·PAIRED_K 2.75 아래라
  // 픽셀 단위 d 로 바꾸지 않았다. 다시 볼 조건: 이 시험의 t 최대가 PAIRED_K 에 다가갈 때.
  const id = (p) => p;
  const img = lowContrastImage(LOW.sine(2));
  const bad = [];
  let maxT = -Infinity;
  for (let k = 1; k <= 60; k++) {
    const seed = k * 7919 + 13;
    const m = measureDrapeAlignment(img, warpedTile(img, 0, 0, 0, id, { noise: 3, seed, sameNoise: true }));
    const why = nullViolation(m);
    if (why) bad.push([seed, why]);
    for (const b of m.blocks) if (Number.isFinite(b.pairedT)) maxT = Math.max(maxT, b.pairedT);
  }
  assert.deepEqual(bad, []);
  assert.ok(maxT <= 1.427 + 0.01, `채널 상관 귀무 t 최대 ${maxT}`);
});

// F-359 검토 #4 양성: 블록 x 32..40·y 40..48 m 만 g+e, 나머지 g 만큼 동쪽(실제 블록 이동 |g+e| = 1.5 px).
const POS_CASES = [[1.5, -0.125, -1.375], [2, -0.25, -1.25], [2.5, -0.25, -1.25], [2, -0.375, -1.125]];
const POS_SEEDS = Array.from({ length: 30 }, (_, i) => 2000003 + i * 7919);

// 알려진 실패(미해결): [잡음 DN, 사인 진폭, g, seed]. 이 목록 밖의 입력은 아래 일반 시험이 단언한다 — todo 는 이 목록에만 건다(F-379).
// T14.R10: 재적합 이상치의 자기 최소–예측 거리 판정(F-359 (A)) 뒤 남은 경우 — 적합(inlier) 블록의 자기 최소가 예측에서 0.5 px 안
// (−0.63~−0.89 px, 비용 함수가 0 쪽으로 치우침)이라 정합 블록으로 남는다(보고 0.15~0.40 px). 적합 블록 불확정 규칙(F-359 (B))은
// 거리 0.35·배제 못 한 이동량 1.25 px 에서 이 목록을 3건으로 줄이고 귀무 거짓 불확정 52/360 이었지만, 고대비 회전·축척 시험(F-317)의
// 보고를 4.5~4.9 px 로 부풀리고 불확정 기록값(F-363 11→20, 검토 #2 8→10)을 넘겨 채택하지 않았다 — 미해결.
const POS_KNOWN_FAIL = [
  [2, 2, -0.25, 2079193],
  [2, 2, -0.25, 2142545],
  [2, 2, -0.25, 2174221],
  [2, 2, -0.25, 2205897],
  [2, 2.5, -0.25, 2126707],
  [2, 2.5, -0.25, 2134626],
  [1, 2, -0.375, 2007922],
  [1, 2, -0.375, 2142545],
  [1, 2, -0.375, 2205897],
  [2, 2, -0.375, 2007922],
  [2, 2, -0.375, 2015841],
  [2, 2, -0.375, 2023760],
  [2, 2, -0.375, 2031679],
  [2, 2, -0.375, 2071274],
  [2, 2, -0.375, 2079193],
  [2, 2, -0.375, 2134626],
  [2, 2, -0.375, 2142545],
  [2, 2, -0.375, 2150464],
  [2, 2, -0.375, 2166302],
  [2, 2, -0.375, 2174221],
  [2, 2, -0.375, 2205897],
];
const posKey = (noise, amp, g, seed) => `${noise}|${amp}|${g}|${seed}`;
const POS_KNOWN = new Set(POS_KNOWN_FAIL.map((k) => posKey(...k)));
/** 양성 입력에서 'measured 이면서 maxMisalignPx ≤ 1' 인 [진폭, g, seed, 보고, 불확정 수] 목록. pick 으로 알려진 실패 포함 여부를 고른다. */
function posFailures(noise, pick) {
  const bad = [];
  for (const [amp, g, e] of POS_CASES) {
    const img = lowContrastImage(LOW.sine(amp));
    const warp = (p) => ({ x: p.x + (p.x >= 32 && p.x < 40 && p.y >= 40 && p.y < 48 ? g + e : g) * 0.5, y: p.y });
    for (const seed of POS_SEEDS) {
      if (!pick(POS_KNOWN.has(posKey(noise, amp, g, seed)))) continue;
      const m = measureDrapeAlignment(img, warpedTile(img, 0, 0, 0, warp, { noise, seed }));
      if (m.status === 'measured' && m.maxMisalignPx <= ALIGN_TOLERANCE_PX) bad.push([amp, g, seed, m.maxMisalignPx, m.undecidedBlocks]);
    }
  }
  return bad;
}
for (const noise of [1, 2]) {
  test(`F-359 검토 #4 양성: warpedTile 사인 1.5·2·2.5 DN(g −0.125·−0.25·−0.375) ±${noise} DN, 시드 30개, 실제 1.5 px — 알려진 실패 밖 'measured 이면서 maxMisalignPx ≤ 1' 0건`, () => {
    // 수정 전(PAIRED_K 2.75 로만 가름): 시드 10개에서 ±2 DN 5~7/10, ±1 DN 사인 2 DN 7/10 이 정합 통과(거짓 통과).
    assert.deepEqual(posFailures(noise, (known) => !known), []);
  });
}
const posKnownFor = (noise) => POS_KNOWN_FAIL.filter((k) => k[0] === noise);
for (const noise of [1, 2]) {
  if (posKnownFor(noise).length === 0) continue;
  test(`F-359 양성 알려진 실패 ±${noise} DN ${posKnownFor(noise).length}건도 정합 통과가 아니어야 한다`, {
    todo: '적합 블록의 자기 최소가 예측 ±0.5 px 안이라 정합 블록으로 남는다(비용 함수 치우침, F-359 (B) 미채택) — 미해결',
  }, () => {
    assert.deepEqual(posFailures(noise, (known) => known), []);
  });
}

test('F-380 불확정 블록은 측정값처럼 읽히지 않는다: 사인 1.5 DN ±1 DN seed 2007922 — dx·dy NaN, blockMaxPx·residualMaxPx ≥ undecidedMaxPx', () => {
  // 수정 전: x 평평·자기 최소 −1.28 px·예측 −0.125 px 인 블록이 blocks[].dx ≈ −0.125, blockMaxPx 작음 — maxMisalignPx 만 컸다.
  const [amp, g, e] = POS_CASES[0];
  const img = lowContrastImage(LOW.sine(amp));
  const warp = (p) => ({ x: p.x + (p.x >= 32 && p.x < 40 && p.y >= 40 && p.y < 48 ? g + e : g) * 0.5, y: p.y });
  const m = measureDrapeAlignment(img, warpedTile(img, 0, 0, 0, warp, { noise: 1, seed: 2007922 }));
  assert.equal(m.status, 'measured');
  const und = m.blocks.filter((b) => b.undecided);
  assert.ok(und.length >= 1 && m.undecidedBlocks === und.length, `불확정 블록 ${und.length}`);
  for (const b of und) assert.ok(Number.isNaN(b.dx) && Number.isNaN(b.dy), `불확정 블록 (${b.i0},${b.j0}) dx ${b.dx} dy ${b.dy}`);
  for (const b of m.blocks.filter((q) => !q.undecided)) assert.ok(Number.isFinite(b.dx) && Number.isFinite(b.dy));
  assert.ok(m.undecidedMaxPx > ALIGN_TOLERANCE_PX, `undecidedMaxPx ${m.undecidedMaxPx}`);
  assert.ok(m.blockMaxPx >= m.undecidedMaxPx, `blockMaxPx ${m.blockMaxPx} < undecidedMaxPx ${m.undecidedMaxPx}`);
  assert.ok(m.residualMaxPx >= m.undecidedMaxPx, `residualMaxPx ${m.residualMaxPx} < undecidedMaxPx ${m.undecidedMaxPx}`);
});
