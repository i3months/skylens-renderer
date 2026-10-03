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
