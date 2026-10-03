// flat_boxes 장면 시험: 결정성, 상자 겹침 없음, 법선, 시점 가시성, 두 형식.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resultHash, assertSceneResult } from '../../../contracts/scenes/index.mjs';
import { generate } from './index.mjs';

const VP = JSON.parse(readFileSync(new URL('../../viewpoints/synthetic.json', import.meta.url), 'utf8')).viewpoints;
const N = 20000;

test('같은_시드는_해시가_같다', () => {
  assert.equal(resultHash(generate({ seed: 5, count: N })), resultHash(generate({ seed: 5, count: N })));
});
test('다른_시드는_해시가_다르다', () => {
  assert.notEqual(resultHash(generate({ seed: 5, count: N })), resultHash(generate({ seed: 6, count: N })));
});
test('기본_개수는_200000', () => {
  assert.equal(generate({ seed: 1 }).count, 200000);
});
test('개수를_주면_정확히_그_수', () => {
  for (const c of [1, 17, 999, 12345]) assert.equal(generate({ seed: 3, count: c }).count, c);
});
test('두_형식_모두_검사_통과', () => {
  for (const format of [1, 2]) assertSceneResult(generate({ seed: 2, count: N, format }), { scene: 'flat_boxes', count: N });
});
test('상자_12동_겹침_0_높이_밑면_범위', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const { buildings } = generate({ seed, count: 100 }).truth;
    assert.equal(buildings.length, 12);
    for (const b of buildings) {
      assert.ok(b.height >= 6 && b.height <= 40);
      const w = b.max[0] - b.min[0], d = b.max[2] - b.min[2];
      assert.ok(w >= 8 - 1e-9 && w <= 25 + 1e-9 && d >= 8 - 1e-9 && d <= 25 + 1e-9);
      assert.equal(b.min[1], 0);
    }
    for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) {
      const a = buildings[i], b = buildings[j];
      const overlap = a.min[0] < b.max[0] && a.max[0] > b.min[0] && a.min[2] < b.max[2] && a.max[2] > b.min[2];
      assert.equal(overlap, false, `시드 ${seed}: ${i} 와 ${j} 겹침`);
    }
  }
});
test('법선_길이_1_오차_1e-6_이내와_점이_bounds_안', () => {
  const r = generate({ seed: 9, count: N });
  const { positions: P, normals: Nn } = r.cloud;
  const { min, max } = r.truth.bounds;
  assert.equal(r.truth.ground.size, 200);
  for (let i = 0; i < N; i++) {
    const len = Math.hypot(Nn[3 * i], Nn[3 * i + 1], Nn[3 * i + 2]);
    assert.ok(Math.abs(len - 1) <= 1e-6);
    for (let a = 0; a < 3; a++) assert.ok(P[3 * i + a] >= min[a] && P[3 * i + a] <= max[a]);
  }
});
test('바닥_점은_y0_법선_위', () => {
  const { cloud } = generate({ seed: 4, count: N });
  let ground = 0;
  for (let i = 0; i < N; i++) if (cloud.positions[3 * i + 1] === 0 && cloud.normals[3 * i + 1] === 1) ground++;
  assert.ok(ground > N * 0.5);
});
test('시점_8곳_시선_원뿔_안에_상자_점이_있다', () => {
  assert.equal(VP.length, 8);
  for (const seed of [1, 2, 3, 7, 42, 1234, 99999]) {
    const { cloud } = generate({ seed, count: 100000 });
    for (const v of VP) {
      const d = v.target.map((t, k) => t - v.eye[k]);
      const dl = Math.hypot(...d);
      const cosMin = Math.cos((v.fov_y_deg / 2) * Math.PI / 180);
      let hit = 0;
      for (let i = 0; i < cloud.count; i++) {
        const y = cloud.positions[3 * i + 1];
        if (y <= 0.01) continue; // 바닥 제외
        const q = [0, 1, 2].map((k) => cloud.positions[3 * i + k] - v.eye[k]);
        const ql = Math.hypot(...q);
        if (ql > 0 && (q[0] * d[0] + q[1] * d[1] + q[2] * d[2]) / (ql * dl) >= cosMin) hit++;
      }
      assert.ok(hit >= 100, `시드 ${seed} 시점 ${v.id}: 원뿔 안 상자 점 ${hit}`);
    }
  }
});

// ---- 반려 수정(F-085 ②, F-086, F-083): 시험 안에서 독립적으로 정답을 만든다 ----
const C0 = 0.28209479177387814; // SH 0차 계수(해석값)
const TOL = 1e-4;

test('상자_면_위_점은_면_위_1e-4_이내이고_바깥_법선', () => {
  for (const seed of [1, 9, 77]) {
    const r = generate({ seed, count: 60000 });
    const { positions: P, normals: Nn } = r.cloud;
    const B = r.truth.buildings;
    let wall = 0;
    for (let i = 0; i < r.count; i++) {
      const x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2];
      if (y === 0) continue;
      const n = [Nn[3 * i], Nn[3 * i + 1], Nn[3 * i + 2]];
      let ok = false;
      for (const b of B) {
        const inX = x >= b.min[0] - TOL && x <= b.max[0] + TOL;
        const inY = y >= -TOL && y <= b.max[1] + TOL;
        const inZ = z >= b.min[2] - TOL && z <= b.max[2] + TOL;
        if (!(inX && inY && inZ)) continue;
        // 면: [축, 면 위치, 바깥 법선]
        const faces = [[0, b.max[0], [1, 0, 0]], [0, b.min[0], [-1, 0, 0]], [2, b.max[2], [0, 0, 1]], [2, b.min[2], [0, 0, -1]], [1, b.max[1], [0, 1, 0]]];
        for (const [axis, pos, fn] of faces) {
          const c = axis === 0 ? x : axis === 1 ? y : z;
          if (Math.abs(c - pos) <= TOL && fn.every((v, k) => Math.abs(v - n[k]) <= 1e-6)) ok = true;
        }
      }
      assert.ok(ok, `시드 ${seed} 점 ${i} (${x},${y},${z}) 법선 ${n}: 어느 상자 면 위의 바깥 법선도 아님`);
      wall++;
    }
    assert.ok(wall > 10000);
    // 네 방향 벽이 모두 존재(+x 벽은 법선 [1,0,0])
    const seen = new Set();
    for (let i = 0; i < r.count; i++) if (P[3 * i + 1] !== 0) seen.add(`${Nn[3 * i]},${Nn[3 * i + 1]},${Nn[3 * i + 2]}`);
    for (const k of ['1,0,0', '-1,0,0', '0,0,1', '0,0,-1', '0,1,0']) assert.ok(seen.has(k), `법선 ${k} 없음`);
  }
});

test('y0_바닥_점은_모든_상자_밑면_밖', () => {
  for (const seed of [1, 4, 33]) {
    const r = generate({ seed, count: 60000 });
    const { positions: P } = r.cloud;
    let ground = 0;
    for (let i = 0; i < r.count; i++) {
      if (P[3 * i + 1] !== 0) continue;
      ground++;
      const x = P[3 * i], z = P[3 * i + 2];
      for (const b of r.truth.buildings) {
        assert.ok(!(x > b.min[0] && x < b.max[0] && z > b.min[2] && z < b.max[2]), `시드 ${seed}: 바닥 점 (${x},${z}) 가 상자 밑면 안`);
      }
    }
    assert.ok(ground > 10000);
  }
});

test('잘못된_개수_시드_형식은_거부하고_0_1은_통과', () => {
  for (const count of [NaN, -5, 10.5, 'abc', Infinity]) assert.throws(() => generate({ seed: 1, count }), /scene:/);
  for (const seed of [NaN, -5, 10.5, 'abc', 2 ** 32]) assert.throws(() => generate({ seed, count: 10 }), /scene:/);
  for (const format of [0, 3, '1', NaN]) assert.throws(() => generate({ seed: 1, count: 10, format }), /scene:/);
  assert.equal(generate({ seed: 1, count: 0 }).count, 0);
  assert.equal(generate({ seed: 1, count: 1 }).count, 1);
});

test('format2_위치는_format1과_같고_fdc는_색에서_역변환한_값', () => {
  const a = generate({ seed: 6, count: 3000, format: 1 }), b = generate({ seed: 6, count: 3000, format: 2 });
  assert.deepEqual([...b.cloud.positions], [...a.cloud.positions]);
  for (let i = 0; i < 3 * 3000; i++) assert.ok(Math.abs(b.cloud.fdc[i] - (a.cloud.colors[i] / 255 - 0.5) / C0) <= 1e-6);
  assert.ok(Math.abs(b.cloud.scales[0] - Math.log(0.05)) <= 1e-6);
});

test('F-091: 색 무늬가 잡음이 아니라 바닥 4 m 체크와 지붕 2 m 체크에서 온다', () => {
  const r = generate({ seed: 3, count: 100000 });
  const P = r.cloud.positions, C = r.cloud.colors;
  // 바닥: 초록 채널 평균 차(기준 밝은 칸 120 vs 어두운 칸 92, 차 28)
  const gs = [0, 0], gn = [0, 0];
  // 지붕: 최댓값 채널 평균 차(v 0.85 vs 0.55, 차 약 76)
  const rs = [0, 0], rn = [0, 0];
  for (let i = 0; i < r.count; i++) {
    const x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2];
    if (y === 0) {
      const k = (Math.floor((x + 100) / 4) + Math.floor((z + 100) / 4)) & 1;
      gs[k] += C[3 * i + 1]; gn[k]++;
      continue;
    }
    for (const b of r.truth.buildings) {
      if (Math.abs(y - b.height) > 1e-4 || x < b.min[0] || x > b.max[0] || z < b.min[2] || z > b.max[2]) continue;
      const k = (Math.floor((x - b.min[0]) / 2) + Math.floor((z - b.min[2]) / 2)) & 1;
      rs[k] += Math.max(C[3 * i], C[3 * i + 1], C[3 * i + 2]); rn[k]++;
    }
  }
  assert.ok(gn[0] > 1000 && gn[1] > 1000 && rn[0] > 300 && rn[1] > 300, `${gn} ${rn}`);
  assert.ok(gs[1] / gn[1] - gs[0] / gn[0] >= 15, `바닥 평균 차 ${gs[1] / gn[1] - gs[0] / gn[0]}`);
  assert.ok(rs[1] / rn[1] - rs[0] / rn[0] >= 40, `지붕 평균 차 ${rs[1] / rn[1] - rs[0] / rn[0]}`);
});
