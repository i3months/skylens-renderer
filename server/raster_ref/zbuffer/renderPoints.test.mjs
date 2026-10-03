// T06.5 깊이 버퍼 시험. 기대값은 손계산 리터럴이다.
// 카메라: 8x8, fx=fy=100, 주점 (4,4), 단위 회전. 점 (0,0,d) 는 u=v=4 (픽셀 모서리)에 떨어진다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPoints, renderPointsWith } from './index.mjs';

const cam = (w = 8, h = 8) => ({ width: w, height: h, K: { fx: 100, fy: 100, cx: 4, cy: 4 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] });
const cloud = (pts, cols) => ({
  format: 1, count: pts.length,
  positions: Float32Array.from(pts.flat()),
  normals: new Float32Array(3 * pts.length),
  colors: Uint8Array.from(cols.flat()),
});
const filled = (r) => [...r.index].map((x, i) => (x === -1 ? -1 : i)).filter((i) => i >= 0);
const px = (i, j) => j * 8 + i;

// 손계산: 크기 0.2, d=5 → r=100·0.2/10=2, r²=4. 칸 중심 오프셋 ±0.5, ±1.5.
// 거리² = a²+b²: (.5,.5)=0.5, (.5,1.5)=2.5 은 안, (1.5,1.5)=4.5 는 밖 → 16−4 = 12 픽셀(4x4 블록의 모서리 4칸 제외).
test('단일 점: 12 픽셀, 번호 0, 깊이 5, 모서리 칸 제외', () => {
  const r = renderPoints(cam(), cloud([[0, 0, 5]], [[10, 20, 30]]), { pointSizeM: 0.2 });
  const f = filled(r);
  assert.equal(f.length, 12);
  assert.deepEqual(f, [px(3, 2), px(4, 2), px(2, 3), px(3, 3), px(4, 3), px(5, 3), px(2, 4), px(3, 4), px(4, 4), px(5, 4), px(3, 5), px(4, 5)]);
  for (const i of f) {
    assert.equal(r.index[i], 0);
    assert.equal(r.depth[i], 5);
    assert.deepEqual([r.color[3 * i], r.color[3 * i + 1], r.color[3 * i + 2]], [10, 20, 30]);
  }
  assert.equal(r.index[px(2, 2)], -1);
});

test('단일 점: 번호는 입력 순서(뒤에 놓인 점 하나만 보이는 경우 index=2)', () => {
  const r = renderPoints(cam(), cloud([[0, 0, -3], [500, 0, 5], [0, 0, 5]], [[1, 1, 1], [2, 2, 2], [9, 8, 7]]), { pointSizeM: 0.2 });
  assert.equal(filled(r).length, 12);
  for (const i of filled(r)) assert.equal(r.index[i], 2);
});

// 겹침: pointSizeM=0.4 에서 A(d=5) 반경 r=100·0.4/10=4, B(d=8) 반경 2.5. A 의 원이 B 의 원을 모두 덮는다(B 칸 최대 거리 √4.5 < 4).
test('겹침(pointSizeM 0.4): d=5 점이 d=8 점을 가린다, 입력 순서를 바꿔도 같은 결과', () => {
  const a = [0, 0, 5], b = [0, 0, 8];
  const r1 = renderPoints(cam(), cloud([a, b], [[200, 0, 0], [0, 0, 200]]), { pointSizeM: 0.4 });
  const r2 = renderPoints(cam(), cloud([b, a], [[0, 0, 200], [200, 0, 0]]), { pointSizeM: 0.4 });
  // 픽셀마다 번호만 서로 뒤바뀌고(0<->1) 깊이·색은 완전히 같다.
  assert.deepEqual(r1.depth, r2.depth);
  assert.deepEqual(r1.color, r2.color);
  assert.deepEqual([...r1.index].map((x) => (x < 0 ? -1 : 1 - x)), [...r2.index]);
  // A 의 칸 수: 오프셋 a,b ∈ {±.5,±1.5,±2.5,±3.5} 중 a²+b²≤16. |a|=.5→8, 1.5→8, 2.5→6, 3.5→4 (부호당 26) → 52.
  const fr = filled(r1);
  for (const i of fr) {
    assert.equal(r1.index[i], 0);
    assert.equal(r1.depth[i], 5);
    assert.deepEqual([r1.color[3 * i], r1.color[3 * i + 1], r1.color[3 * i + 2]], [200, 0, 0]);
  }
  assert.equal(fr.length, 52);
});

test('부분 겹침: 가까운 점은 자기 칸을, 먼 점은 가려지지 않은 칸만 차지한다', () => {
  // A=(−0.05,0,5): u=3, v=4, r=2(size 0.2). B=(0.08,0,8): u=5, v=4, r=100·0.2/16=1.25, r²=1.5625.
  const r = renderPoints(cam(), cloud([[-0.05, 0, 5], [0.08, 0, 8]], [[1, 0, 0], [0, 1, 0]]), { pointSizeM: 0.2 });
  // B 의 칸: 중심 오프셋 dx=i+.5−5, dy=j+.5−4. (4,3):(-.5,-.5) .5 ok; (5,3):(.5,-.5) ok; (4,4),(5,4) ok;
  // (3,3):(-1.5,-.5)=2.5 no; (6,3):(1.5,-.5)=2.5 no. 따라서 B 칸은 i∈{4,5}, j∈{3,4} 4칸.
  // A 의 칸(u=3,v=4,r=2): i∈{2,3}, 중심 dx=-.5,.5 ; dx=±1.5 (i=1,4) 도 가능: dy=±.5 이면 2.5 ≤ 4 ok → (1,3),(4,3),(1,4),(4,4).
  // 따라서 (4,3),(4,4) 는 A(깊이 5)가 가린다. B 는 (5,3),(5,4) 2칸만 남는다.
  assert.equal(r.index[px(4, 3)], 0);
  assert.equal(r.index[px(4, 4)], 0);
  assert.equal(r.index[px(5, 3)], 1);
  assert.equal(r.index[px(5, 4)], 1);
  assert.equal(r.depth[px(5, 3)], 8);
  assert.equal(r.index[px(6, 3)], -1);
});

test('같은 깊이: 번호 작은 점이 이긴다(입력 순서에서 먼저인 점)', () => {
  const r = renderPoints(cam(), cloud([[0, 0, 5], [0, 0, 5]], [[11, 0, 0], [0, 22, 0]]), { pointSizeM: 0.2 });
  assert.equal(filled(r).length, 12);
  for (const i of filled(r)) {
    assert.equal(r.index[i], 0);
    assert.deepEqual([r.color[3 * i], r.color[3 * i + 1], r.color[3 * i + 2]], [11, 0, 0]);
  }
  const r2 = renderPoints(cam(), cloud([[0, 0, 5], [0, 0, 5]], [[0, 22, 0], [11, 0, 0]]), { pointSizeM: 0.2 });
  for (const i of filled(r2)) assert.deepEqual([r2.color[3 * i], r2.color[3 * i + 1], r2.color[3 * i + 2]], [0, 22, 0]);
});

test('카메라 뒤 점과 카메라 평면 위 점은 그려지지 않는다', () => {
  const r = renderPoints(cam(), cloud([[0, 0, -5], [0, 0, 0]], [[9, 9, 9], [9, 9, 9]]));
  assert.equal(filled(r).length, 0);
});

test('화면 밖 점은 무시된다(양쪽 모두)', () => {
  const r = renderPoints(cam(), cloud([[100, 0, 5], [0, -100, 5], [0, 0, 5]], [[1, 1, 1], [2, 2, 2], [3, 3, 3]]), { pointSizeM: 0.2 });
  assert.equal(filled(r).length, 12);
  for (const i of filled(r)) assert.equal(r.index[i], 2);
});

test('빈 장면: 모든 픽셀 빔(depth 0, index -1, color 0)', () => {
  const r = renderPoints(cam(), { format: 1, count: 0, positions: new Float32Array(0), normals: new Float32Array(0), colors: new Uint8Array(0) });
  assert.equal(r.width, 8);
  assert.ok(r.index.every((x) => x === -1));
  assert.ok(r.depth.every((x) => x === 0));
  assert.ok(r.color.every((x) => x === 0));
});

// 형식 2: 색 = round(clamp(0.5+0.28209479177387814·f)·255). f=0 → 127.5 → 128, f=2 → 1.064 → 255, f=-2 → 0.
test('가우시안 형식 색 변환', () => {
  const c = { format: 2, count: 1, positions: Float32Array.of(0, 0, 5), fdc: Float32Array.of(0, 2, -2), opacity: new Float32Array(1), scales: new Float32Array(3), rotations: new Float32Array(4) };
  const r = renderPoints(cam(), c, { pointSizeM: 0.2 });
  const i = px(4, 4);
  assert.deepEqual([r.color[3 * i], r.color[3 * i + 1], r.color[3 * i + 2]], [128, 255, 0]);
});

test('pointSizeM 기본값 0.05: d=5 → r=0.5 → 중심 칸 1 픽셀', () => {
  const r = renderPoints(cam(), cloud([[0, 0, 5]], [[5, 5, 5]]));
  assert.equal(filled(r).length, 1);
});

// 변이: 먼 쪽이 이기는 규칙, <= 규칙은 위 리터럴 시험들을 통과하지 못한다.
test('변이: 먼 쪽이 이김 → 겹침 시험 실패', () => {
  const pts = cloud([[0, 0, 5], [0, 0, 8]], [[200, 0, 0], [0, 0, 200]]);
  const bad = renderPointsWith(cam(), pts, { pointSizeM: 0.4 }, (n, o) => n > o);
  const i = px(4, 4);
  assert.notEqual(bad.index[i], 0);
  assert.equal(bad.depth[i], 8);
});
test('변이: <= 규칙 → 같은 깊이에서 번호 큰 점이 이겨 시험 실패', () => {
  const pts = cloud([[0, 0, 5], [0, 0, 5]], [[11, 0, 0], [0, 22, 0]]);
  const bad = renderPointsWith(cam(), pts, { pointSizeM: 0.2 }, (n, o) => n <= o);
  assert.equal(bad.index[px(4, 4)], 1);
  const good = renderPoints(cam(), pts, { pointSizeM: 0.2 });
  assert.equal(good.index[px(4, 4)], 0);
});

// F-093 ④: 56 B(형식 2) 점의 opacity·scale·rot 는 그림에 영향을 주지 않고 pointSizeM 고정 원판만 쓴다는 선택(contracts/raster)을 고정한다.
test('형식 2: opacity·scales·rotations 를 바꿔도 결과가 같고 pointSizeM 만 크기를 정한다', () => {
  const mk = (op, sc, rot) => ({ format: 2, count: 1, positions: Float32Array.of(0, 0, 5), fdc: Float32Array.of(0, 0, 0), opacity: Float32Array.of(op), scales: Float32Array.of(...sc), rotations: Float32Array.of(...rot) });
  const base = renderPoints(cam(), mk(1, [0.01, 0.01, 0.01], [1, 0, 0, 0]), { pointSizeM: 0.2 });
  const other = renderPoints(cam(), mk(0, [5, 0.5, 9], [0, 1, 0, 0]), { pointSizeM: 0.2 });
  assert.deepEqual(other.index, base.index);
  assert.deepEqual(other.color, base.color);
  assert.deepEqual(other.depth, base.depth);
  assert.equal(filled(base).length, 12); // 위 단일 점 시험과 같은 pointSizeM 0.2 원판
  assert.ok(filled(renderPoints(cam(), mk(1, [0.01, 0.01, 0.01], [1, 0, 0, 0]), { pointSizeM: 0.4 })).length > 12);
});

// F-093 ③: 점 수 정의는 positions.length/3 이고 count 불일치는 zbuffer·no_fill 모두 'raster:' 오류다.
test('count 가 positions.length/3 과 다르면 raster: 오류', () => {
  const c = { ...cloud([[0, 0, 5], [0, 0, 6], [0, 0, 7]], [[1, 1, 1], [2, 2, 2], [3, 3, 3]]), count: 1 };
  assert.throws(() => renderPoints(cam(), c, { pointSizeM: 0.2 }), /^Error: raster:/);
});
