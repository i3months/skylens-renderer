import test from 'node:test';
import assert from 'node:assert/strict';
import { voxelReduce } from './index.mjs';
import { generate } from '../../../fixtures/scenes/terrain/index.mjs';

// 점 배열 [[x,y,z],...] 로 format 1 점군을 만든다.
function cloudOf(pts) {
  const n = pts.length;
  const positions = new Float32Array(3 * n);
  pts.forEach((q, i) => positions.set(q, 3 * i));
  return { format: 1, count: n, positions, normals: new Float32Array(3 * n), colors: new Uint8Array(3 * n) };
}

test('3x3x3 격자점(간격 1 m), edge 2: 칸 8개, 칸당 점 수와 대표점을 손으로 센 값과 비교', () => {
  // 좌표 0,1,2 → floor(x/2) = 0,0,1. 축마다 칸 2개이므로 2^3 = 8 칸.
  const pts = [];
  for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) for (let z = 0; z < 3; z++) pts.push([x, y, z]);
  const r = voxelReduce(cloudOf(pts), 2);
  assert.equal(r.count, 8);
  assert.equal(r.rep.length, 8);
  assert.equal(r.cellOfPoint.length, 27);
  // 칸 번호순(사전순) 칸당 점 수를 손으로 센 값. 축마다 {0,1}→2개, {2}→1개.
  const sizes = new Array(8).fill(0);
  for (const c of r.cellOfPoint) sizes[c]++;
  assert.deepEqual(sizes, [8, 4, 4, 2, 4, 2, 2, 1]);
  // 칸 0 = (0,0,0): 중심 (1,1,1) 이므로 대표점은 점 (1,1,1) = 번호 1*9+1*3+1 = 13.
  assert.equal(r.rep[0], 13);
  // 칸 7 = (1,1,1): 점 (2,2,2) 하나뿐 = 번호 26.
  assert.equal(r.rep[7], 26);
  // floor→round 변이 방지: round(0.5)=1 이면 좌표 1 이 칸 1 로 가서 아래 단언이 깨진다.
  assert.equal(r.cellOfPoint[0], r.cellOfPoint[13]); // (0,0,0) 과 (1,1,1)
  assert.notEqual(r.cellOfPoint[13], r.cellOfPoint[26]); // (1,1,1) 과 (2,2,2)
  assert.equal(r.cellOfPoint[26], 7);
});

test('칸 경계: 정확히 경계 위의 점은 위쪽 칸에 속한다(floor)', () => {
  const r = voxelReduce(cloudOf([[0, 0, 0], [0.5, 0, 0], [1, 0, 0], [2, 0, 0]]), 1);
  assert.equal(r.count, 3);
  assert.deepEqual([...r.cellOfPoint], [0, 0, 1, 2]);
  // 칸 0 중심 0.5 → 점 1(x=0.5)이 대표.
  assert.deepEqual([...r.rep], [1, 2, 3]);
});

test('음수 좌표: floor 이므로 -0.5 는 칸 -1 (trunc 이면 칸 0 과 섞임)', () => {
  // edge 1: -1.5→-2, -1→-1, -0.5→-1, 0→0, 0.5→0. 칸 순서 -2,-1,0 → 번호 0,1,2.
  const r = voxelReduce(cloudOf([[0.5, 0, 0], [-0.5, 0, 0], [0, 0, 0], [-1, 0, 0], [-1.5, 0, 0]]), 1);
  assert.equal(r.count, 3);
  assert.deepEqual([...r.cellOfPoint], [2, 1, 2, 1, 0]);
  // 칸 -2 는 점 4 하나, 칸 -1 중심 -0.5 → 점 1, 칸 0 중심 0.5 → 점 0.
  assert.deepEqual([...r.rep], [4, 1, 0]);
});

test('칸 번호는 (x,y,z) 사전순: x 가 가장 우선', () => {
  const r = voxelReduce(cloudOf([[1.5, 0.5, 0.5], [0.5, 1.5, 0.5], [0.5, 0.5, 1.5], [0.5, 0.5, 0.5]]), 1);
  assert.deepEqual([...r.cellOfPoint], [3, 2, 1, 0]);
});

test('동률이면 입력 번호가 작은 점이 대표', () => {
  // 칸 [0,2) 중심 1: x=0.5 와 x=1.5 는 중심에서 같은 거리.
  assert.deepEqual([...voxelReduce(cloudOf([[0.5, 1, 1], [1.5, 1, 1]]), 2).rep], [0]);
  assert.deepEqual([...voxelReduce(cloudOf([[1.5, 1, 1], [0.5, 1, 1]]), 2).rep], [0]);
});

test('빈 점군은 칸 0개', () => {
  const r = voxelReduce(cloudOf([]), 1);
  assert.equal(r.count, 0);
  assert.equal(r.rep.length, 0);
});

test('같은 입력은 같은 출력(결정적)', () => {
  const c = generate({ seed: 5, count: 5000 }).cloud;
  const a = voxelReduce(c, 0.5), b = voxelReduce(c, 0.5);
  assert.deepEqual(a.rep, b.rep);
  assert.deepEqual(a.cellOfPoint, b.cellOfPoint);
});

// 시험 안 독립 정답: 문자열 키 맵으로 칸을 센다(모듈 코드 미사용).
function refCells(cloud, edge) {
  const m = new Map();
  const p = cloud.positions;
  for (let i = 0; i < cloud.count; i++) {
    const key = [0, 1, 2].map((d) => Math.floor(p[3 * i + d] / edge)).join(',');
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(i);
  }
  return m;
}

test('terrain 250k 점: edge 0.1·0.2·0.4 에서 count 단조 감소, 독립 정답과 일치, rep 은 부분집합이고 칸별 1개', () => {
  const cloud = generate({ seed: 1, count: 250000 }).cloud;
  const counts = [];
  for (const edge of [0.1, 0.2, 0.4]) {
    const r = voxelReduce(cloud, edge);
    const ref = refCells(cloud, edge);
    assert.equal(r.count, ref.size);
    assert.equal(r.rep.length, r.count);
    assert.ok(r.count <= 250000);
    // 모든 입력 점이 정확히 한 칸: 칸 번호가 범위 안이고 칸별 점 수 합 = n.
    const per = new Uint32Array(r.count);
    for (let i = 0; i < 250000; i++) { assert.ok(r.cellOfPoint[i] < r.count); per[r.cellOfPoint[i]]++; }
    assert.ok(per.every((v) => v >= 1));
    // rep 은 입력 번호 범위, 중복 없음(부분집합), rep[c] 는 칸 c 에 속한다.
    const seen = new Set();
    for (let c = 0; c < r.count; c++) {
      const i = r.rep[c];
      assert.ok(i < 250000);
      assert.ok(!seen.has(i));
      seen.add(i);
      assert.equal(r.cellOfPoint[i], c);
    }
    counts.push(r.count);
  }
  console.log(`terrain 250k voxel counts (edge 0.1, 0.2, 0.4): ${counts.join(', ')}`);
  assert.ok(counts[0] > counts[1] && counts[1] > counts[2], `단조 감소 아님: ${counts}`);
});

test('terrain 12k 점: rep 은 칸 중심에 가장 가까운 점(독립 정답), 서로 다른 칸의 rep 은 다른 위치', () => {
  const cloud = generate({ seed: 2, count: 12000 }).cloud;
  const edge = 4;
  const r = voxelReduce(cloud, edge);
  const ref = refCells(cloud, edge);
  const p = cloud.positions;
  assert.equal(r.count, ref.size);
  const keys = [...ref.keys()].sort((a, b) => {
    const x = a.split(',').map(Number), y = b.split(',').map(Number);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
  const posSeen = new Set();
  keys.forEach((key, c) => {
    const k = key.split(',').map(Number);
    let best = -1, bd = Infinity;
    for (const i of ref.get(key)) {
      let d = 0;
      for (let a = 0; a < 3; a++) d += (p[3 * i + a] - (k[a] + 0.5) * edge) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    assert.equal(r.rep[c], best);
    posSeen.add(`${p[3 * best]},${p[3 * best + 1]},${p[3 * best + 2]}`);
  });
  assert.equal(posSeen.size, r.count);
});

test('거부: edge 가 0·음수·NaN·Infinity·비숫자, format 2, count 불일치, 비유한 좌표', () => {
  const c = cloudOf([[0, 0, 0]]);
  for (const e of [0, -1, NaN, Infinity, -Infinity, '1', undefined, null]) assert.throws(() => voxelReduce(c, e), /lod:/);
  const g2 = generate({ seed: 1, count: 10, format: 2 }).cloud;
  assert.throws(() => voxelReduce(g2, 1), /lod:/);
  assert.throws(() => voxelReduce({ ...c, count: 2 }, 1), /lod:/);
  for (const bad of [NaN, Infinity, -Infinity]) assert.throws(() => voxelReduce(cloudOf([[0, bad, 0]]), 1), /lod:/);
  assert.throws(() => voxelReduce(null, 1), /lod:/);
});
