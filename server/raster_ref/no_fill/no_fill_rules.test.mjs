// no_fill 정답 집합 규칙 시험(F-094 ②, F-095 ②).
// 손으로 센 작은 장면 리터럴, 독립 스칼라 계산으로 holes 장면의 빈 픽셀 수 확인, 렌더러와 같은 건너뛰기 규칙.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reachablePixelSet, assertNoFill } from './index.mjs';
import { renderPoints } from '../zbuffer/index.mjs';
import { generate } from '../../../fixtures/scenes/holes/index.mjs';

// 6×6, fx=fy=2, 주점 (3,3), R=I, t=0, 점 크기 2 m.
// 점 P (0,0,1): u=v=3, d=1, 반경 r = 2·2/(2·1) = 2 px. 칸 중심이 원 안(거리² ≤ 4)인 칸을 손으로 센다.
//   중심 오프셋 dx = i+0.5−3 ∈ {−2.5,−1.5,−0.5,0.5,1.5,2.5}. dx²+dy² ≤ 4 가 되는 조합:
//   |dx|=0.5 인 열 i∈{2,3} × |dy|∈{0.5,1.5} 인 행 j∈{1,2,3,4} → 8칸
//   |dx|=1.5 인 열 i∈{1,4} × |dy|=0.5 인 행 j∈{2,3} → 4칸. (1.5,1.5) 는 4.5 > 4 라 제외. 합 12칸.
// 점 Q (−1.5,−1.5,1): u=v=0, d=1, r=2. 화면 안 칸은 i,j ≥ 0: (0,0)·(1,0)·(0,1) 은 오프셋 (0.5,0.5)·(1.5,0.5)·(0.5,1.5) 로 들어옴,
//   (1,1) 은 4.5 라 제외. 3칸(번호 0, 1, 6). P 와 겹치지 않는다.
// 카메라 뒤의 점 (0,0,−1) 은 건너뛴다. 합집합 15칸, 빈 칸 36 − 15 = 21.
const cam = { width: 6, height: 6, K: { fx: 2, fy: 2, cx: 3, cy: 3 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
const cloud = { format: 1, count: 3, colors: new Uint8Array(9).fill(200), positions: new Float32Array([0, 0, 1, -1.5, -1.5, 1, 0, 0, -1]) };
// 번호 = j·6+i. P: i∈{2,3}×j∈{1..4} → 8 9 14 15 20 21 26 27, i∈{1,4}×j∈{2,3} → 13 16 19 22. Q: 0 1 6.
const WANT = [0, 1, 6, 8, 9, 13, 14, 15, 16, 19, 20, 21, 22, 26, 27];

test('손으로 센 작은 장면: 합집합 15칸, 빈 칸 21', () => {
  const got = [...reachablePixelSet(cam, cloud, 2)].sort((a, b) => a - b);
  assert.deepEqual(got, WANT);
  assert.equal(got.length, 15);
  assert.equal(36 - got.length, 21);
});

test('손으로 센 작은 장면: 렌더러 결과와 assertNoFill 이 일치', () => {
  const r = renderPoints(cam, cloud, { pointSizeM: 2 });
  assertNoFill(r, cam, cloud, 2);
});

// 독립 스칼라 구현(project·splat 모듈을 쓰지 않는다)으로 holes 장면의 도달 픽셀 수를 센다.
// 카메라는 아래를 내려다본다: xc = x, yc = z, zc = 60 − y. 결과 1703 칸, 빈 칸 75097 (스크래치 스크립트로 같은 식을 따로 돌려 확인).
test('holes: 독립 스칼라 계산이 정답 집합과 같은 크기(빈 칸 75097)', () => {
  const camH = { width: 320, height: 240, K: { fx: 400, fy: 400, cx: 160, cy: 120 }, R: [1, 0, 0, 0, 0, 1, 0, -1, 0], t: [0, 0, 60] };
  const { cloud: c } = generate({ seed: 1, count: 5000 });
  const P = c.positions;
  const W = 320; const H = 240; const f = 400; const size = 0.5;
  const mine = new Set();
  for (let k = 0; k < 5000; k += 1) {
    const d = 60 - P[3 * k + 1];
    if (!(d > 0)) continue;
    const u = (f * P[3 * k]) / d + 160;
    const v = (f * P[3 * k + 2]) / d + 120;
    const r = (f * size) / (2 * d);
    for (let j = Math.max(0, Math.floor(v - r - 1)); j <= Math.min(H - 1, Math.ceil(v + r + 1)); j += 1) {
      for (let i = Math.max(0, Math.floor(u - r - 1)); i <= Math.min(W - 1, Math.ceil(u + r + 1)); i += 1) {
        const dx = i + 0.5 - u; const dy = j + 0.5 - v;
        if (dx * dx + dy * dy <= r * r || (i === Math.floor(u) && j === Math.floor(v))) mine.add(j * W + i);
      }
    }
  }
  assert.equal(W * H - mine.size, 75097);
  assert.deepEqual([...reachablePixelSet(camH, c, size)].sort((a, b) => a - b), [...mine].sort((a, b) => a - b));
});

// F-095 ②: 깊이가 Float32 로 0 이 되는 점은 렌더러가 건너뛴다. 정답 집합도 같은 규칙이어야 한다.
test('fround(d)=0 인 점은 정답 집합에서도 빠진다(렌더러와 같은 규칙)', () => {
  const tiny = { width: 3, height: 3, K: { fx: 1, fy: 1, cx: 1.5, cy: 1.5 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 1e-50] };
  const one = { format: 1, count: 1, colors: new Uint8Array(3).fill(200), positions: new Float32Array([0, 0, 0]) }; // d = 1e-50, Math.fround(d) = 0
  const r = renderPoints(tiny, one, { pointSizeM: 0.2 });
  assert.equal(r.index.every((x) => x === -1), true, '렌더러는 이 점을 그리지 않는다');
  assert.equal(reachablePixelSet(tiny, one, 0.2).size, 0);
  assertNoFill(r, tiny, one, 0.2);
});
