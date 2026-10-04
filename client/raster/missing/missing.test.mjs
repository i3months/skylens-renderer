// T12.6 시험. 합성 장면(holes)과 손으로 만든 마스크를 정답 숫자와 비교한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCoverage, compareWithReference, drawnMask, assertNoFilled, nonEmptyValuesInEmpty } from './index.mjs';
import { emptyResult } from '../../../contracts/raster/index.mjs';
import { renderPoints } from '../../../server/raster_ref/zbuffer/index.mjs';
import { reachablePixelSet } from '../../../server/raster_ref/no_fill/index.mjs';
import { generate } from '../../../fixtures/scenes/holes/index.mjs';

// 아래를 내려다보는 카메라(카메라 z = 세계 −y), 높이 60 m. xc=x, yc=z, zc=60−y.
const cam = { width: 320, height: 240, K: { fx: 400, fy: 400, cx: 160, cy: 120 }, R: [1, 0, 0, 0, 0, 1, 0, -1, 0], t: [0, 0, 60] };
const SIZE = 0.5;
const scene = generate({ seed: 1, count: 5000 });

function hand() {
  const r = emptyResult(3, 3);
  for (const p of [0, 4]) { r.index[p] = p; r.depth[p] = 5; r.color[3 * p] = 9; }
  return r;
}

test('computeCoverage: 3×3 손 마스크 → 칠해짐 2, 빈 7', () => {
  const c = computeCoverage(hand());
  assert.equal(c.total, 9);
  assert.equal(c.drawn, 2);
  assert.equal(c.empty, 7);
  assert.equal(c.emptyFraction, 7 / 9);
  assert.deepEqual(computeCoverage({ width: 2, height: 2, drawn: new Uint8Array([1, 0, 0, 0]) }).empty, 3);
});

test('computeCoverage: 빈 영상은 전부 빈 픽셀', () => {
  assert.equal(computeCoverage(emptyResult(4, 5)).empty, 20);
});

test('compareWithReference: 메운 픽셀과 사라진 픽셀을 따로 센다', () => {
  const ref = { width: 3, height: 3, drawn: new Uint8Array([1, 0, 0, 0, 1, 0, 0, 0, 0]) };
  const cand = { width: 3, height: 3, drawn: new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 1]) };
  const r = compareWithReference(cand, ref);
  assert.deepEqual(r.filled, [8]);
  assert.deepEqual(r.lost, [4]);
  assert.equal(r.ok, false);
  assert.throws(() => assertNoFilled(cand, ref), /^Error: missing:/);
  assert.equal(compareWithReference(ref, ref).ok, true);
  assert.throws(() => compareWithReference({ width: 1, height: 1, drawn: new Uint8Array(1) }, ref), /^Error: missing:/);
});

test('holes: 도달 가능 픽셀 1703, 빈 픽셀 75097 이고 빈 픽셀은 빈 값 그대로', () => {
  const r = renderPoints(cam, scene.cloud, { pointSizeM: SIZE });
  const c = computeCoverage(r);
  assert.equal(c.drawn, 1703);
  assert.equal(c.empty, 75097);
  const mask = drawnMask(r);
  const emptyPix = [];
  for (let i = 0; i < mask.length; i += 1) if (!mask[i]) emptyPix.push(i);
  assert.equal(nonEmptyValuesInEmpty(r, emptyPix).length, 0);
});

test('holes: 빈자리 안쪽(원판 반지름만큼 안으로 줄인 영역)의 픽셀은 모두 빈 값', () => {
  const r = renderPoints(cam, scene.cloud, { pointSizeM: SIZE });
  const { fx, fy, cx, cy } = cam.K;
  const rPx = (fx * SIZE) / 2 / 60; // 원판 반지름(픽셀), 높이 60 m 평지
  const marginM = (SIZE / 2) + (rPx * 60) / fx + 1; // 원판 반지름 + 칸 한 개 여유
  let checked = 0;
  for (const h of scene.truth.holes) {
    const x0 = h.min[0] + marginM, x1 = h.max[0] - marginM, z0 = h.min[1] + marginM, z1 = h.max[1] - marginM;
    for (let j = 0; j < cam.height; j += 1) {
      for (let i = 0; i < cam.width; i += 1) {
        // 칸 중심이 세계 평지에서 닿는 곳(독립 계산: u = fx·x/60 + cx)
        const x = ((i + 0.5 - cx) * 60) / fx, z = ((j + 0.5 - cy) * 60) / fy;
        if (x < x0 || x > x1 || z < z0 || z > z1) continue;
        checked += 1;
        assert.equal(r.index[j * cam.width + i], -1, `픽셀 (${i},${j}) 가 빈자리 안인데 칠해짐`);
      }
    }
  }
  assert.ok(checked > 0, '빈자리 안쪽 픽셀이 하나도 검사되지 않음');
});

// 속성: 도착하지 않은 점(부분집합 밖)이 닿는 픽셀은 칠해지지 않고, 칠해진 픽셀은 도착한 점이 닿는 집합의 부분집합이다.
function lcg(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

test('속성: 점 부분집합(도착분)만 그리면 칠해진 픽셀은 도착분이 닿는 집합과 정확히 같다(20 시드)', () => {
  const full = renderPoints(cam, scene.cloud, { pointSizeM: SIZE });
  const n = scene.cloud.count;
  for (let seed = 1; seed <= 20; seed += 1) {
    const rnd = lcg(seed);
    const keep = [];
    for (let k = 0; k < n; k += 1) if (rnd() < 0.5) keep.push(k);
    const pos = new Float32Array(3 * keep.length);
    keep.forEach((k, a) => pos.set(scene.cloud.positions.subarray(3 * k, 3 * k + 3), 3 * a));
    const sub = { format: 1, count: keep.length, positions: pos, colors: new Uint8Array(3 * keep.length) };
    const r = renderPoints(cam, sub, { pointSizeM: SIZE });
    const want = reachablePixelSet(cam, sub, SIZE);
    const c = computeCoverage(r);
    assert.equal(c.drawn, want.size, `시드 ${seed}: 칠해진 수`);
    // 부분집합은 전체의 부분집합이므로 전체 참조에서 빈 픽셀은 후보에서도 비어야 한다(메움 0).
    assert.deepEqual(compareWithReference(r, full).filled, [], `시드 ${seed}: 메움`);
    const m = drawnMask(r);
    for (const p of want) assert.equal(m[p], 1);
  }
});

test('속성: 점이 하나도 도착하지 않으면 모든 픽셀이 빈 값(번호 −1, 깊이 0, 색 0)', () => {
  const r = renderPoints(cam, { format: 1, count: 0, positions: new Float32Array(0), colors: new Uint8Array(0) }, { pointSizeM: SIZE });
  assert.equal(computeCoverage(r).empty, 320 * 240);
  assert.equal(r.index.every((v) => v === -1) && r.depth.every((v) => v === 0) && r.color.every((v) => v === 0), true);
});
