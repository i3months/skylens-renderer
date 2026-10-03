import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from './index.mjs';
import { assertSceneResult, resultHash } from '../../../contracts/scenes/index.mjs';

const inH = (holes, x, z) => holes.some((h) => x >= h.min[0] && x <= h.max[0] && z >= h.min[1] && z <= h.max[1]);

test('holes_기본_개수와_지정_개수', () => {
  assert.equal(generate({ seed: 1 }).count, 100000);
  assert.equal(generate({ seed: 1, count: 12345 }).count, 12345);
});

test('holes_빈자리_6곳_종류_크기_겹침없음', () => {
  for (const seed of [1, 2, 3, 99]) {
    const { holes } = generate({ seed, count: 10 }).truth;
    assert.equal(holes.length, 6);
    assert.equal(holes.filter((h) => h.kind === 'roof').length, 4);
    assert.equal(holes.filter((h) => h.kind === 'water').length, 2);
    for (const h of holes) {
      for (let a = 0; a < 2; a++) {
        const s = h.max[a] - h.min[a];
        assert.ok(s >= 10 && s <= 30, `크기 ${s}`);
        assert.ok(h.min[a] >= -100 && h.max[a] <= 100);
      }
    }
    for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) {
      const a = holes[i], b = holes[j];
      assert.ok(a.max[0] <= b.min[0] || b.max[0] <= a.min[0] || a.max[1] <= b.min[1] || b.max[1] <= a.min[1]);
    }
  }
});

test('holes_빈자리_안_점_수_0_전수검사', () => {
  for (const seed of [1, 7]) {
    const r = generate({ seed });
    const p = r.cloud.positions;
    let inside = 0;
    for (let i = 0; i < r.count; i++) if (inH(r.truth.holes, p[3 * i], p[3 * i + 2])) inside++;
    assert.equal(inside, 0);
  }
});

test('holes_holeFraction_해석값과_1e-12_이내', () => {
  const t = generate({ seed: 5, count: 10 }).truth;
  let area = 0;
  for (const h of t.holes) area += (h.max[0] - h.min[0]) * (h.max[1] - h.min[1]);
  assert.equal(t.areaM2, 40000);
  assert.ok(Math.abs(t.holeAreaM2 - area) <= 1e-12);
  assert.ok(Math.abs(t.holeFraction - area / 40000) <= 1e-12);
});

test('holes_빈자리_밖_밀도_균일_10x10_셀_15퍼센트', () => {
  const r = generate({ seed: 3 });
  const cells = new Array(100).fill(0);
  const p = r.cloud.positions;
  for (let i = 0; i < r.count; i++) {
    const cx = Math.min(9, Math.floor((p[3 * i] + 100) / 20)), cz = Math.min(9, Math.floor((p[3 * i + 2] + 100) / 20));
    cells[cz * 10 + cx]++;
  }
  const expectPerM2 = r.count / (40000 - r.truth.holeAreaM2);
  let checked = 0;
  for (let cz = 0; cz < 10; cz++) for (let cx = 0; cx < 10; cx++) {
    const x0 = -100 + cx * 20, z0 = -100 + cz * 20;
    if (r.truth.holes.some((h) => h.min[0] < x0 + 20 && h.max[0] > x0 && h.min[1] < z0 + 20 && h.max[1] > z0)) continue;
    checked++;
    const e = expectPerM2 * 400;
    assert.ok(Math.abs(cells[cz * 10 + cx] - e) <= 0.15 * e, `셀 ${cx},${cz}: ${cells[cz * 10 + cx]} vs ${e}`);
  }
  assert.ok(checked >= 40);
});

test('holes_평지_법선_단위_색_무늬', () => {
  const r = generate({ seed: 2, count: 2000 });
  for (let i = 0; i < r.count; i++) {
    assert.equal(r.cloud.positions[3 * i + 1], 0);
    assert.deepEqual([...r.cloud.normals.subarray(3 * i, 3 * i + 3)], [0, 1, 0]);
  }
  assert.ok(new Set(r.cloud.colors).size > 50);
});

test('holes_같은_시드_바이트_동일_다른_시드_다름_두_형식', () => {
  for (const format of [1, 2]) {
    const a = generate({ seed: 4, count: 3000, format }), b = generate({ seed: 4, count: 3000, format });
    assertSceneResult(a, { scene: 'holes', count: 3000 });
    assert.equal(resultHash(a), resultHash(b));
    assert.notEqual(resultHash(a), resultHash(generate({ seed: 5, count: 3000, format })));
  }
});
