import test from 'node:test';
import assert from 'node:assert/strict';
import { representativeColors, meanColorError } from './index.mjs';
import { mulberry32 } from '../../../contracts/scenes/index.mjs';

// VoxelResult 를 손으로 만든 픽스처: cellOfPoint 만 쓰인다.
const make = (rgbList, cells) => {
  const n = rgbList.length;
  const count = Math.max(...cells) + 1;
  const cloud = { format: 1, count: n, positions: new Float32Array(3 * n), normals: new Float32Array(3 * n), colors: Uint8Array.from(rgbList.flat()) };
  const voxel = { edgeM: 1, count, rep: new Uint32Array(count), cellOfPoint: Uint32Array.from(cells) };
  return { cloud, voxel };
};

test('두 점 (0,0,0)+(255,255,255) 평균 127.5 는 128 로 올림', () => {
  const { cloud, voxel } = make([[0, 0, 0], [255, 255, 255]], [0, 0]);
  assert.deepEqual([...representativeColors(cloud, voxel)], [128, 128, 128]);
});

test('같은 색 세 점은 같은 색', () => {
  const { cloud, voxel } = make([[10, 20, 30], [10, 20, 30], [10, 20, 30]], [0, 0, 0]);
  assert.deepEqual([...representativeColors(cloud, voxel)], [10, 20, 30]);
});

test('1점 칸은 원색, 여러 칸은 칸마다 따로', () => {
  const { cloud, voxel } = make([[1, 2, 3], [200, 100, 0], [100, 50, 255], [7, 8, 9]], [0, 1, 1, 2]);
  assert.deepEqual([...representativeColors(cloud, voxel)], [1, 2, 3, 150, 75, 128, 7, 8, 9]);
});

test('반올림 경계: 1/3 은 내림, 2/3 은 올림, 정확히 .5 는 올림', () => {
  const a = make([[0, 0, 0], [0, 1, 0], [1, 1, 0]], [0, 0, 0]); // 채널 합 1/3, 2/3, 0
  assert.deepEqual([...representativeColors(a.cloud, a.voxel)], [0, 1, 0]);
  const b = make([[0, 0, 0], [0, 0, 0], [1, 1, 1], [1, 1, 1]], [0, 0, 0, 0]); // 2/4 = .5
  assert.deepEqual([...representativeColors(b.cloud, b.voxel)], [1, 1, 1]);
});

test('합 누락 방지: 마지막 점·마지막 칸·각 채널이 결과에 반영됨', () => {
  const { cloud, voxel } = make([[0, 0, 0], [0, 0, 0], [30, 60, 90]], [0, 0, 1]);
  assert.deepEqual([...representativeColors(cloud, voxel)], [0, 0, 0, 30, 60, 90]);
  const m = make([[0, 0, 0], [0, 0, 0], [0, 0, 0], [255, 255, 255]], [0, 0, 0, 0]);
  assert.deepEqual([...representativeColors(m.cloud, m.voxel)], [64, 64, 64]); // 63.75 -> 64
});

test('meanColorError 손 계산', () => {
  const { cloud, voxel } = make([[0, 0, 0], [255, 255, 255]], [0, 0]);
  assert.equal(meanColorError(cloud, voxel, Uint8Array.of(128, 128, 128)), 0.5 / 255);
  assert.equal(meanColorError(cloud, voxel, Uint8Array.of(127, 128, 130)), 2.5 / 255);
  const t = make([[0, 0, 0], [0, 0, 0], [1, 1, 1]], [0, 0, 0]); // 평균 1/3
  assert.ok(Math.abs(meanColorError(t.cloud, t.voxel, Uint8Array.of(0, 0, 0)) - (1 / 3) / 255) < 1e-15);
});

test('10만 점 무작위: 모든 칸 오차 ≤ 0.5/255, 전체 최대 ≤ 1/255', (t) => {
  const n = 100000, cells = 2000;
  const rnd = mulberry32(20240607);
  const colors = new Uint8Array(3 * n).map(() => Math.floor(rnd() * 256));
  const cellOfPoint = new Uint32Array(n);
  for (let i = 0; i < n; i++) cellOfPoint[i] = i < cells ? i : Math.floor(rnd() * cells); // 빈 칸 없음
  const cloud = { format: 1, count: n, positions: new Float32Array(3 * n), normals: new Float32Array(3 * n), colors };
  const voxel = { edgeM: 1, count: cells, rep: new Uint32Array(cells), cellOfPoint };
  const out = representativeColors(cloud, voxel);
  assert.equal(out.length, 3 * cells);

  // 독립 검증: BigInt 정수 합으로 칸마다 정확한 평균과 비교
  const sum = Array.from({ length: cells }, () => [0n, 0n, 0n]);
  const size = new Array(cells).fill(0n);
  for (let i = 0; i < n; i++) {
    const c = cellOfPoint[i];
    size[c]++;
    for (let h = 0; h < 3; h++) sum[c][h] += BigInt(colors[3 * i + h]);
  }
  let worst = 0, differsFromFloor = 0;
  for (let c = 0; c < cells; c++) for (let h = 0; h < 3; h++) {
    const o = BigInt(out[3 * c + h]);
    const d = o * size[c] - sum[c][h];
    const err = Number(d < 0n ? -d : d) / Number(size[c]); // 값 단위(0..255) 오차
    assert.ok(err <= 0.5, `칸 ${c} 채널 ${h} 오차 ${err}`);
    worst = Math.max(worst, err);
    if (o !== sum[c][h] / size[c]) differsFromFloor++; // BigInt 나눗셈은 내림
  }
  const e = meanColorError(cloud, voxel, out);
  t.diagnostic(`최대 평균색 오차 = ${worst}/255 (칸 ${cells}, 점 ${n})`);
  assert.ok(e <= 0.5 / 255);
  assert.ok(e <= 1 / 255);
  assert.ok(Math.abs(e * 255 - worst) < 1e-9);
  // 내림 변이를 잡는다: 반올림 결과가 내림 결과와 다른 칸·채널이 충분히 많아야 한다
  assert.ok(differsFromFloor > 1000, `내림과 다른 경우 ${differsFromFloor}`);
});

test('입력 검증: 길이 불일치·범위 밖 칸·빈 칸은 lod: 오류', () => {
  const { cloud, voxel } = make([[1, 1, 1], [2, 2, 2]], [0, 0]);
  assert.throws(() => representativeColors(cloud, { ...voxel, cellOfPoint: new Uint32Array(1) }), /^Error: lod:/);
  assert.throws(() => representativeColors(cloud, { ...voxel, count: 0 }), /^Error: lod:/);
  assert.throws(() => representativeColors(cloud, { ...voxel, count: 2 }), /^Error: lod:/);
  assert.throws(() => meanColorError(cloud, voxel, new Uint8Array(2)), /^Error: lod:/);
});
