import test from 'node:test';
import assert from 'node:assert/strict';
import { representativeNormals, maxAngleErrorDeg } from './index.mjs';
import { generate, makeParams } from '../../../fixtures/scenes/terrain/index.mjs';

const R = Math.SQRT1_2;

// 손으로 만든 VoxelResult 픽스처: cells[i] = i 번 점의 칸 번호. rep 은 칸마다 첫 점(이 모듈은 rep 을 쓰지 않는다).
function fixture(normalList, cells) {
  const n = normalList.length;
  const count = Math.max(...cells) + 1;
  const normals = new Float32Array(3 * n);
  normalList.forEach((v, i) => normals.set(v, 3 * i));
  const rep = new Uint32Array(count);
  const seen = new Set();
  cells.forEach((c, i) => { if (!seen.has(c)) { seen.add(c); rep[c] = i; } });
  return {
    cloud: { format: 1, count: n, positions: new Float32Array(3 * n), normals, colors: new Uint8Array(3 * n) },
    voxel: { edgeM: 1, count, rep, cellOfPoint: Uint32Array.from(cells) },
  };
}
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const vec = (arr, c) => [arr[3 * c], arr[3 * c + 1], arr[3 * c + 2]];
const assertVec = (got, want, eps = 1e-6) => want.forEach((w, k) => near(got[k], w, eps));

test('같은 방향 법선들은 그대로(칸이 여럿이어도 칸별로 독립)', () => {
  const { cloud, voxel } = fixture([[0, 1, 0], [0, 1, 0], [0, 1, 0], [1, 0, 0], [1, 0, 0]], [0, 0, 0, 1, 1]);
  const out = representativeNormals(cloud, voxel);
  assert.equal(out.length, 6);
  assertVec(vec(out, 0), [0, 1, 0]);
  assertVec(vec(out, 1), [1, 0, 0]);
});

test('(1,0,0)+(0,1,0) → (0.7071,0.7071,0)', () => {
  const { cloud, voxel } = fixture([[1, 0, 0], [0, 1, 0]], [0, 0]);
  assertVec(vec(representativeNormals(cloud, voxel), 0), [R, R, 0]);
});

test('비정규 입력도 먼저 정규화: (5,0,0)+(0,0.01,0) → (0.7071,0.7071,0)', () => {
  const { cloud, voxel } = fixture([[5, 0, 0], [0, 0.01, 0]], [0, 0]);
  assertVec(vec(representativeNormals(cloud, voxel), 0), [R, R, 0]);
});

test('반대 방향 상쇄 → (0,0,0), 다른 칸은 영향 없음', () => {
  const { cloud, voxel } = fixture([[0, 0, 1], [0, 0, -1], [0, 0, -1]], [0, 0, 1]);
  const out = representativeNormals(cloud, voxel);
  assert.deepEqual(vec(out, 0), [0, 0, 0]);
  assertVec(vec(out, 1), [0, 0, -1]);
});

test('길이 0 입력은 합에서 제외: (0,0,0)+(0,1,0) → (0,1,0), 전부 길이 0 → (0,0,0)', () => {
  const { cloud, voxel } = fixture([[0, 0, 0], [0, 1, 0], [0, 0, 0], [0, 0, 0]], [0, 0, 1, 1]);
  const out = representativeNormals(cloud, voxel);
  assertVec(vec(out, 0), [0, 1, 0]);
  assert.deepEqual(vec(out, 1), [0, 0, 0]);
});

test('결과는 단위 길이(1e-6) 또는 (0,0,0): 무작위 입력', () => {
  let s = 12345;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  const list = [], cells = [];
  for (let i = 0; i < 600; i++) { list.push(i % 7 === 0 ? [0, 0, 0] : [rnd() * 3, rnd(), rnd() * 0.2]); cells.push(i % 30); }
  const { cloud, voxel } = fixture(list, cells);
  const out = representativeNormals(cloud, voxel);
  let nonzero = 0;
  for (let c = 0; c < voxel.count; c++) {
    const len = Math.hypot(...vec(out, c));
    assert.ok(len === 0 || Math.abs(len - 1) <= 1e-6, `칸 ${c} 길이 ${len}`);
    if (len > 0) nonzero++;
  }
  assert.ok(nonzero > 0);
});

test('입력 법선 배열을 바꾸지 않는다', () => {
  const { cloud, voxel } = fixture([[5, 0, 0], [0, 2, 0]], [0, 0]);
  const before = Float32Array.from(cloud.normals);
  representativeNormals(cloud, voxel);
  assert.deepEqual(cloud.normals, before);
});

test('잘못된 voxel 은 lod: 오류', () => {
  const { cloud, voxel } = fixture([[1, 0, 0], [0, 1, 0]], [0, 0]);
  assert.throws(() => representativeNormals(cloud, { ...voxel, cellOfPoint: new Uint32Array(1) }), /^Error: lod:/);
  assert.throws(() => representativeNormals(cloud, { ...voxel, cellOfPoint: Uint32Array.of(0, 3) }), /^Error: lod:/);
  assert.throws(() => representativeNormals(cloud, null), /^Error: lod:/);
});

test('maxAngleErrorDeg: 직교 두 법선의 대표는 각각 45°', () => {
  const { cloud, voxel } = fixture([[1, 0, 0], [0, 1, 0]], [0, 0]);
  const e = maxAngleErrorDeg(cloud, voxel, representativeNormals(cloud, voxel));
  near(e.max, 45, 1e-4);
  near(e.mean, 45, 1e-4);
});

test('maxAngleErrorDeg: 최대와 평균이 다르고, 길이 0 입력은 제외, 대표 (0,0,0)은 180°', () => {
  // (0,1,0) x3 + (1,0,0) → 대표는 (1,3)/√10 방향. (0,1,0)과의 각 a = atan(1/3), (1,0,0)과의 각 = 90°-a
  const { cloud, voxel } = fixture([[0, 1, 0], [0, 1, 0], [0, 1, 0], [1, 0, 0], [0, 0, 0]], [0, 0, 0, 0, 0]);
  const a = Math.atan(1 / 3) * 180 / Math.PI;
  const e = maxAngleErrorDeg(cloud, voxel, representativeNormals(cloud, voxel));
  near(e.max, 90 - a, 1e-4);
  near(e.mean, (3 * a + 90 - a) / 4, 1e-4);
  const f = fixture([[0, 0, 1], [0, 0, -1]], [0, 0]);
  const g = maxAngleErrorDeg(f.cloud, f.voxel, representativeNormals(f.cloud, f.voxel));
  assert.equal(g.max, 180);
  assert.equal(g.mean, 180);
  const z = fixture([[0, 0, 0]], [0]);
  assert.deepEqual(maxAngleErrorDeg(z.cloud, z.voxel, representativeNormals(z.cloud, z.voxel)), { max: 0, mean: 0 });
});

// ---- 완만한 지형: 이론 상한 ----
// 높이장 h 의 법선 n=(-∇h,1)/|.| . 기울기→법선 대응은 1-립시츠(각 ≤ |Δ∇h|)다(gnomonic 사영은 거리를 줄이기만 한다).
// 한 칸(한 변 e)의 점들은 xz 평면에서 지름 ≤ e·√2 안에 있고, |∇²h| ≤ H = Σ a·|k|² 이므로
// 칸 안 두 법선의 각 ≤ H·e·√2. 평균 방향은 칸 안 법선들의 원뿔 안에 있어 어느 점과도 그 각을 넘지 않는다.
// 상한은 측정이 아니라 params 와 e 에서 계산한다.
const hessBound = (params) => params.waves.reduce((s, w) => s + Math.abs(w.a) * (w.kx * w.kx + w.kz * w.kz), 0);

function gridVoxel(cloud, edge) {
  const key = new Map(), cells = new Uint32Array(cloud.count);
  const p = cloud.positions;
  for (let i = 0; i < cloud.count; i++) {
    const k = `${Math.floor(p[3 * i] / edge)},${Math.floor(p[3 * i + 1] / edge)},${Math.floor(p[3 * i + 2] / edge)}`;
    if (!key.has(k)) key.set(k, key.size);
    cells[i] = key.get(k);
  }
  return { edgeM: edge, count: key.size, rep: new Uint32Array(key.size), cellOfPoint: cells };
}

for (const edge of [1, 2, 4, 8]) {
  test(`terrain 칸 한 변 ${edge} m: 최대 각 오차 ≤ 이론 상한(H·e·√2)`, () => {
    const seed = 5;
    const { cloud } = generate({ seed, count: 40000, format: 1 });
    const H = hessBound(makeParams(seed));
    const bound = H * edge * Math.SQRT2 * 180 / Math.PI;
    const voxel = gridVoxel(cloud, edge);
    const out = representativeNormals(cloud, voxel);
    const err = maxAngleErrorDeg(cloud, voxel, out);
    console.log(`terrain edge=${edge} m cells=${voxel.count} max=${err.max.toFixed(4)} deg mean=${err.mean.toFixed(4)} deg bound=${bound.toFixed(4)} deg`);
    assert.ok(err.max <= bound + 1e-3, `max ${err.max} > bound ${bound}`);
    assert.ok(err.max > 0, '칸 안 법선이 모두 같다면 시험이 의미 없음');
    assert.ok(err.mean <= err.max);
    for (let c = 0; c < voxel.count; c++) {
      const len = Math.hypot(...vec(out, c));
      assert.ok(Math.abs(len - 1) <= 1e-6);
    }
  });
}
