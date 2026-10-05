// 드레이프 정합 판정 연결 시험(T15.2, F-391 ⑨, F-403 ⑥). client/tower/drape 는 판정 코드를 갖지 않는다:
// 판정은 contracts/controlview isDrapeAligned(measure, tolPx), 측정은 server/terrain/drape measureDrapeAlignment(image, tile) 이다.
// 이 시험은 같은 합성 장면(위성 영상 + 높이 0 DEM)으로
//  (1) 서버 측정 출력을 그대로 isDrapeAligned 에 넣어, 정상 정합 타일은 참(unmeasuredLocalBlocks 0)이고
//      미측정 local 블록이 하나인 타일은 거짓(unmeasuredLocalBlocks 1, maxMisalignPx 는 허용 이하)임을 단언하고,
//  (2) 같은 타일을 클라이언트 드레이프 apply 로 연직 카메라에 입혀, 클라이언트 쪽 화면 이동량(DRAPE_ALIGN_MAX_PX 허용)이
//      서버 판정과 모순되지 않는지 본다: 정상 타일은 화면 전역 이동량 ≤ 1 px 이고 서버도 참, 블록 하나를 옮긴 타일은
//      그 블록 화면 구역의 이동량이 서버 블록 실측(dx)과 같다(클라이언트가 타일 내용을 그대로 옮긴다).
//      단, 블록 하나만 옮긴 타일의 화면 전역 이동량은 여전히 허용 안이다 — 클라이언트 허용 검사는 렌더 기하 검사라
//      서버 판정(미측정 local 블록 → 통과 아님)을 대신하지 못한다. 이것도 수치로 단언한다.
// 픽스처: 영상 무늬(TEX_A)·블록 옮기기는 server/terrain/drape/drape_unmeasured_summary.test.mjs 의 F-397 ④ 사례와 같다.
// 기준값(허용 1 px, 0.25 px 오차, 블록 위치·이동량)은 시험 안 숫자로 둔다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isDrapeAligned } from '../../../contracts/controlview/index.mjs';
import { measureDrapeAlignment, buildDrapeTile } from '../../../server/terrain/drape/index.mjs';
import { createTerrainLayer } from '../terrain/index.mjs';
import { createDrapeLayer } from './index.mjs';

const TOL_PX = 1; // 정합 허용(계약 ALIGN_TOLERANCE_PX·DRAPE_ALIGN_MAX_PX 와 같은 값을 숫자로)

// ---- 합성 위성 영상: ENU [-64, 128]², 0.5 m/px(384²). 타일 (0,0) 밉 0 = 영상 잘라 내기(128², 0.5 m/px) ----
const IMG_MIN = -64, IMG_PX_M = 0.5, IMG_N = 384;
const HASH = (c, r) => (((c * 73856093) ^ (r * 19349663)) >>> 0);
// 8 m 바둑판 + 사인 + 해시 무늬(잡음 0).
const TEX_A = (x, y, c, r) => [
  ((Math.floor(x / 8) + Math.floor(y / 8)) & 1) ? 200 : 40, Math.round(128 + 100 * Math.sin(x * 0.07) * Math.cos(y * 0.05)), HASH(c, r) % 256,
];
function makeImage() {
  const rgb = new Uint8Array(IMG_N * IMG_N * 3);
  const max = IMG_MIN + IMG_N * IMG_PX_M;
  for (let r = 0; r < IMG_N; r++) {
    for (let c = 0; c < IMG_N; c++) {
      const [R, G, B] = TEX_A(IMG_MIN + (c + 0.5) * IMG_PX_M, max - (r + 0.5) * IMG_PX_M, c, r);
      const o = (r * IMG_N + c) * 3;
      rgb[o] = R; rgb[o + 1] = G; rgb[o + 2] = B;
    }
  }
  return { width: IMG_N, height: IMG_N, rgb, bounds: { minX: IMG_MIN, minY: IMG_MIN, maxX: max, maxY: max } };
}
const IMAGE = makeImage();

// 옮길 블록: 타일 (0,0) 밉 0 의 블록 (64,32)(16×16 px), 내용을 x 로 1 px(= 0.5 m) 옮긴다(out(i) = 원래(i+1)).
const BLOCK = { i0: 64, j0: 32, size: 16, shift: 1 };
const alignedTile = () => buildDrapeTile(IMAGE, 0, 0, 0);
function shiftedBlockTile() {
  const t = alignedTile();
  const { i0, j0, size, shift } = BLOCK;
  for (let j = j0; j < j0 + size; j++) {
    for (let i = i0; i < i0 + size; i++) t.rgb.copyWithin((j * 128 + i) * 3, (j * 128 + i + shift) * 3, (j * 128 + i + shift + 1) * 3);
  }
  return t;
}

// ---- 서버 측정 → 판정 ----
const MEASURE = { aligned: measureDrapeAlignment(IMAGE, alignedTile()), shifted: measureDrapeAlignment(IMAGE, shiftedBlockTile()) };

test('(1) 정상 정합 타일: 서버 측정 unmeasuredLocalBlocks 0 → isDrapeAligned 참', () => {
  const m = MEASURE.aligned;
  console.log(`[서버 정상] status=${m.status} maxMisalignPx=${m.maxMisalignPx} unmeasuredLocalBlocks=${m.unmeasuredLocalBlocks} local=${m.blocks.filter((b) => b.local).length}`);
  assert.equal(m.status, 'measured', m.reason);
  assert.equal(m.unmeasuredLocalBlocks, 0);
  assert.ok(m.maxMisalignPx <= TOL_PX, `maxMisalignPx ${m.maxMisalignPx}`);
  assert.equal(isDrapeAligned(m, TOL_PX), true);
});

test('(1) 블록 하나를 1 px 옮긴 타일: 서버 측정 unmeasuredLocalBlocks 1(maxMisalignPx ≤ 1) → isDrapeAligned 거짓', () => {
  const m = MEASURE.shifted;
  const local = m.blocks.filter((b) => b.local);
  console.log(`[서버 블록 이동] status=${m.status} maxMisalignPx=${m.maxMisalignPx} localMaxPx=${m.localMaxPx} unexcludedMaxPx=${m.unexcludedMaxPx} unmeasuredLocalBlocks=${m.unmeasuredLocalBlocks} local=${JSON.stringify(local.map(({ i0, j0, dx, dy }) => [i0, j0, dx, dy]))}`);
  assert.equal(m.status, 'measured', m.reason);
  assert.deepEqual(local.map(({ i0, j0, dx, dy }) => [i0, j0, dx, dy]), [[BLOCK.i0, BLOCK.j0, BLOCK.shift, 0]]);
  // 이동량만 보면 허용 안이다 → 거짓의 원인은 미측정 수뿐이다.
  assert.ok(m.maxMisalignPx <= TOL_PX, `maxMisalignPx ${m.maxMisalignPx}`);
  assert.equal(m.unmeasuredLocalBlocks, 1);
  assert.equal(isDrapeAligned(m, TOL_PX), false);
});

test('(1) 경계: 같은 측정 출력에서 unmeasuredLocalBlocks 0 → 참, 1 → 거짓(그 밖 필드는 그대로)', () => {
  for (const base of [MEASURE.aligned, MEASURE.shifted]) {
    assert.equal(isDrapeAligned({ ...base, unmeasuredLocalBlocks: 0 }, TOL_PX), true);
    assert.equal(isDrapeAligned({ ...base, unmeasuredLocalBlocks: 1 }, TOL_PX), false);
  }
});

// ---- 클라이언트 apply: 연직 카메라, 화소 격자 = 타일 화소 격자(0.5 m/px, 128², 중심 ENU (32, 32)) ----
const CAM_N = 128, GSD = 0.5, CAM_H = 100;
const CAM = {
  width: CAM_N, height: CAM_N, K: { fx: CAM_H / GSD, fy: CAM_H / GSD, cx: CAM_N / 2, cy: CAM_N / 2 },
  R: [1, 0, 0, 0, -1, 0, 0, 0, -1], t: [-32, 32, CAM_H],
};
// DEM: 높이 0 의 평평한 타일 3×3(타일 (0,0) 둘레까지 덮어 카메라 화면 전체에 지형이 있다).
const TERRAIN_TILES = [];
for (let ty = -1; ty <= 1; ty++) for (let tx = -1; tx <= 1; tx++) TERRAIN_TILES.push({ tx, ty, lod: 0, cells: 2, heights: new Float32Array(4) });

function render(tile) {
  const terrain = createTerrainLayer();
  terrain.accept(0, TERRAIN_TILES);
  const t = terrain.render(CAM);
  const drape = createDrapeLayer({ shade: false });
  assert.equal(drape.accept(0, [tile]), 'first');
  return drape.apply(CAM, t);
}

/** 화소 (u, v) 연속 좌표 광선과 z = 0 평면의 교점에서 원본 영상을 이중선형 표본(타일·역투영 코드를 거치지 않는 기준). */
function refAt(u, v, out) {
  const x = 32 + (u - CAM.K.cx) * GSD;
  const y = 32 - (v - CAM.K.cy) * GSD;
  const fu = (x - IMG_MIN) / IMG_PX_M - 0.5, fv = (IMG_MIN + IMG_N * IMG_PX_M - y) / IMG_PX_M - 0.5;
  const i0 = Math.floor(fu), j0 = Math.floor(fv), fx = fu - i0, fy = fv - j0;
  const p = (i, j) => (j * IMG_N + i) * 3;
  for (let k = 0; k < 3; k++) {
    out[k] = (IMAGE.rgb[p(i0, j0) + k] * (1 - fx) + IMAGE.rgb[p(i0 + 1, j0) + k] * fx) * (1 - fy)
      + (IMAGE.rgb[p(i0, j0 + 1) + k] * (1 - fx) + IMAGE.rgb[p(i0 + 1, j0 + 1) + k] * fx) * fy;
  }
  return out;
}

/** 화소 목록에서 결과(i, j) ≈ 기준(i + 0.5 + dx, j + 0.5 + dy) 인 (dx, dy) 를 제곱합 최소로 찾는다(정수 ±3 → 1/16 px ±1). */
function measureShift(out, pixels) {
  const tmp = [0, 0, 0];
  const cost = (dx, dy) => {
    let s = 0;
    for (const p of pixels) {
      const i = p % CAM_N, j = (p - i) / CAM_N;
      refAt(i + 0.5 + dx, j + 0.5 + dy, tmp);
      for (let k = 0; k < 3; k++) { const d = out.color[p * 3 + k] - tmp[k]; s += d * d; }
    }
    return s / pixels.length;
  };
  let best = { dx: 0, dy: 0, e: Infinity };
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const e = cost(dx, dy); if (e < best.e) best = { dx, dy, e }; }
  const c = best;
  for (let b = -16; b <= 16; b++) {
    for (let a = -16; a <= 16; a++) {
      const dx = c.dx + a / 16, dy = c.dy + b / 16, e = cost(dx, dy);
      if (e < best.e) best = { dx, dy, e };
    }
  }
  return { dx: best.dx, dy: best.dy, px: Math.hypot(best.dx, best.dy), mse: best.e };
}

// 화소 집합: 전역 = 화면 가장자리 4 px 를 뺀 전체(4 px 간격 표본), 블록 = 옮긴 블록 안쪽(가장자리 2 px 뺌).
// 화소 격자가 타일 격자와 같아 화면 화소 (i, j) = 타일 화소 (i, j) 다.
const GLOBAL_PX = [], BLOCK_PX = [];
for (let j = 4; j < CAM_N - 4; j += 4) for (let i = 4; i < CAM_N - 4; i += 4) GLOBAL_PX.push(j * CAM_N + i);
for (let j = BLOCK.j0 + 2; j < BLOCK.j0 + BLOCK.size - 2; j++) for (let i = BLOCK.i0 + 2; i < BLOCK.i0 + BLOCK.size - 2; i++) BLOCK_PX.push(j * CAM_N + i);

const fmt = (s) => `dx=${s.dx.toFixed(4)} dy=${s.dy.toFixed(4)} |d|=${s.px.toFixed(4)} px mse=${s.mse.toFixed(3)}`;

test('(2) 정상 정합 타일: 클라이언트 화면 전역 이동량 ≤ 1 px 이고 서버 판정도 참(모순 없음)', () => {
  const out = render(alignedTile());
  const g = measureShift(out, GLOBAL_PX);
  const b = measureShift(out, BLOCK_PX);
  console.log(`[클라이언트 정상] 전역 ${fmt(g)} (화소 ${GLOBAL_PX.length}), 블록 구역 ${fmt(b)} (화소 ${BLOCK_PX.length})`);
  assert.ok(g.px <= TOL_PX, `전역 ${g.px}`);
  assert.ok(b.px <= 0.25, `블록 구역 ${b.px}`);
  assert.equal(isDrapeAligned(MEASURE.aligned, TOL_PX), g.px <= TOL_PX);
});

test('(2) 블록 이동 타일: 클라이언트 블록 구역 이동량 = 서버 블록 실측, 전역은 허용 안 — 서버 판정 거짓이 클라이언트 허용 검사로 대체되지 않음', () => {
  const out = render(shiftedBlockTile());
  const g = measureShift(out, GLOBAL_PX);
  const b = measureShift(out, BLOCK_PX);
  const sb = MEASURE.shifted.blocks.find((x) => x.local);
  console.log(`[클라이언트 블록 이동] 전역 ${fmt(g)}, 블록 구역 ${fmt(b)}, 서버 블록 dx=${sb.dx} dy=${sb.dy}`);
  // 화면 1 px = 타일 1 px 이므로 서버 블록 실측과 화면 구역 이동량이 같아야 한다.
  assert.ok(Math.abs(b.dx - sb.dx) <= 0.25 && Math.abs(b.dy - sb.dy) <= 0.25, `블록 구역 (${b.dx}, ${b.dy}) ≠ 서버 (${sb.dx}, ${sb.dy})`);
  // 블록 구역 이동량(1 px)은 허용 1 px 경계 안이고 전역도 허용 안이다: 화면 허용 검사만으로는 이 타일을 걸러 내지 못한다.
  assert.ok(g.px <= TOL_PX, `전역 ${g.px}`);
  assert.ok(b.px <= TOL_PX, `블록 구역 ${b.px}`);
  // 서버 판정은 거짓이다(미측정 local 블록 1): 클라이언트 허용 통과와 서버 판정 거짓은 다른 것을 재므로 모순이 아니다.
  assert.equal(isDrapeAligned(MEASURE.shifted, TOL_PX), false);
});
