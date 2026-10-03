// T06.7 메우지 않음 시험. 합성 결과 시험은 렌더러와 무관하고, holes 장면 시험은 renderPoints 가 있을 때만 돈다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countEmpty, reachablePixelSet, assertNoFill } from './index.mjs';
import { emptyResult } from '../../../contracts/raster/index.mjs';
import { generate } from '../../../fixtures/scenes/holes/index.mjs';

let renderPoints = null;
try { ({ renderPoints } = await import('../zbuffer/index.mjs')); } catch { renderPoints = null; }

// 3×3, 중심 (1,1) 과 모서리 (0,0) 만 칠해진 결과. 빈 픽셀 7.
function hand() {
  const r = emptyResult(3, 3);
  for (const p of [0, 4]) { r.index[p] = p; r.depth[p] = 5; r.color[3 * p] = 9; }
  return r;
}

test('countEmpty: 손으로 만든 3×3 → 7', () => {
  assert.equal(countEmpty(hand()), 7);
  assert.equal(countEmpty(emptyResult(3, 3)), 9);
});

test('countEmpty: index 와 depth 가 어긋나면 no_fill: 오류', () => {
  const r = hand();
  r.depth[0] = 0;
  assert.throws(() => countEmpty(r), /^Error: no_fill:/);
});

// 3×3, fx=fy=1, 주점 (1.5,1.5), 점 크기 0.2 m. 반경 = 1·0.2/(2·1)=0.1 px(최소 1 픽셀만 덮음).
const cam3 = { width: 3, height: 3, K: { fx: 1, fy: 1, cx: 1.5, cy: 1.5 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
// 점 A (-1,-1,1) → (0.5,0.5) 칸 (0,0) = 0, 점 B (0,0,1) → (1.5,1.5) 칸 (1,1) = 4.
const cloud2 = { count: 2, positions: new Float32Array([-1, -1, 1, 0, 0, 1]) };

test('reachablePixelSet: 두 점 장면 → {0, 4}', () => {
  assert.deepEqual([...reachablePixelSet(cam3, cloud2, 0.2)].sort((a, b) => a - b), [0, 4]);
});

test('assertNoFill: 정답 결과는 통과, 빈 픽셀 = 9 − 2', () => {
  const r = hand();
  assertNoFill(r, cam3, cloud2, 0.2);
  assert.equal(countEmpty(r), 7);
});

test('assertNoFill: 메운 픽셀 하나 → no_fill: 오류', () => {
  const r = hand();
  r.index[8] = 1; r.depth[8] = 5;
  assert.throws(() => assertNoFill(r, cam3, cloud2, 0.2), /^Error: no_fill:/);
});

test('assertNoFill: 빠진 픽셀 하나 → no_fill: 오류', () => {
  const r = hand();
  r.index[4] = -1; r.depth[4] = 0; r.color[12] = 0;
  assert.throws(() => assertNoFill(r, cam3, cloud2, 0.2), /^Error: no_fill:/);
});

// holes 장면: 아래를 내려다보는 카메라(카메라 z = 세계 −y), 높이 60 m. R 행: xc=x, yc=z, zc=−y.
const camH = { width: 320, height: 240, K: { fx: 400, fy: 400, cx: 160, cy: 120 }, R: [1, 0, 0, 0, 0, 1, 0, -1, 0], t: [0, 0, 60] };
const SIZE = 0.5;
const EXPECTED_EMPTY = 75097; // 320·240 − 도달 가능 픽셀 1703
const holes = generate({ seed: 1, count: 5000 });

test('holes: 점이 화면에 보인다(합집합이 비어 있지 않고 전체보다 작음)', () => {
  const s = reachablePixelSet(camH, holes.cloud, SIZE);
  assert.ok(s.size > 0 && s.size < 320 * 240, `size=${s.size}`);
});

test('holes: 빈 픽셀 수 정답(리터럴)', () => {
  const s = reachablePixelSet(camH, holes.cloud, SIZE);
  assert.equal(320 * 240 - s.size, EXPECTED_EMPTY);
});

test('holes: renderPoints 결과가 assertNoFill 통과, 빈 픽셀 수 일치', { skip: renderPoints ? false : 'zbuffer 모듈 없음' }, () => {
  const r = renderPoints(camH, holes.cloud, { pointSizeM: SIZE });
  assertNoFill(r, camH, holes.cloud, SIZE);
  assert.equal(countEmpty(r), EXPECTED_EMPTY);
});
