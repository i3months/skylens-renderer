// 건물 외곽 돌출 장면 시험: 동 수·겹침 0(전수 쌍 검사)·bounds·결정성·두 형식.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSceneResult, resultHash } from '../../../contracts/scenes/index.mjs';
import { generate } from './index.mjs';

test('기본 1000동, 두 형식 통과', () => {
  for (const format of [1, 2]) {
    const r = generate({ seed: 7, format });
    assertSceneResult(r, { scene: 'buildings', count: 1000 });
    assert.equal(r.truth.buildings.length, 1000);
  }
});

test('count 지정 시 정확히 그 수', () => {
  for (const count of [1, 37, 250]) {
    const r = generate({ seed: 3, count });
    assertSceneResult(r, { scene: 'buildings', count });
    assert.equal(r.truth.buildings.length, count);
  }
});

test('겹침 0·간격 1 m 이상(전수 쌍 검사 499500쌍)', () => {
  const bs = generate({ seed: 11 }).truth.buildings;
  let pairs = 0;
  for (let i = 0; i < bs.length; i++) {
    for (let j = i + 1; j < bs.length; j++) {
      pairs++;
      const a = bs[i], b = bs[j];
      const gx = Math.max(a.min[0] - b.max[0], b.min[0] - a.max[0]);
      const gz = Math.max(a.min[1] - b.max[1], b.min[1] - a.max[1]);
      assert.ok(Math.max(gx, gz) >= 1 - 1e-9, `건물 ${i},${j} 간격 ${Math.max(gx, gz)}`);
    }
  }
  assert.equal(pairs, 499500);
});

test('모든 건물이 bounds 안, 밑면 8~30 m, 높이 5~60 m', () => {
  const r = generate({ seed: 5 });
  for (const b of r.truth.buildings) {
    for (let a = 0; a < 2; a++) {
      assert.ok(b.min[a] >= -1000 && b.max[a] <= 1000);
      const s = b.max[a] - b.min[a];
      assert.ok(s >= 8 - 1e-9 && s <= 30 + 1e-9, `밑면 ${s}`);
    }
    assert.ok(b.height >= 5 && b.height <= 60);
  }
  const c = r.cloud;
  for (let i = 0; i < c.count; i++) {
    assert.equal(c.normals[3 * i + 1], 1);
    assert.ok(Math.abs(c.positions[3 * i]) <= 1000 && Math.abs(c.positions[3 * i + 2]) <= 1000);
  }
});

test('같은 시드 해시 동일, 다른 시드 다름', () => {
  for (const format of [1, 2]) {
    assert.equal(resultHash(generate({ seed: 9, format })), resultHash(generate({ seed: 9, format })));
    assert.notEqual(resultHash(generate({ seed: 9, format })), resultHash(generate({ seed: 10, format })));
  }
  assert.deepEqual(generate({ seed: 9 }).truth, generate({ seed: 9 }).truth);
});

test('buildings: 점 수·시드·형식 거부, 0·1 은 통과', () => {
  const g = (o) => generate({ seed: 1, ...o });
  for (const count of [NaN, -5, 10.5, '10', Infinity]) assert.throws(() => g({ count }), /scene: count|buildings: count/, String(count));
  for (const seed of [1.5, NaN, 'abc', -1, 2 ** 32]) assert.throws(() => generate({ seed, count: 4  }), /scene: seed/, String(seed));
  for (const format of [0, 3, '1', NaN]) assert.throws(() => g({ count: 4, format  }), /scene: format/, String(format));
  for (const count of [0, 1]) assertSceneResult(g({ count  }), { scene: 'buildings', count });
});

test('buildings: format 2 의 positions 는 format 1 과 같고 fdc 는 색과 맞음', () => {
  const o = { seed: 4, count: 20  };
  const a = generate({ ...o, format: 1 }).cloud;
  const b = generate({ ...o, format: 2 }).cloud;
  assert.deepEqual(Array.from(b.positions), Array.from(a.positions));
  const C0 = 0.28209479177387814;
  for (let i = 0; i < 3 * a.count; i++) assert.ok(Math.abs(b.fdc[i] - (a.colors[i] / 255 - 0.5) / C0) < 1e-5);
  assert.ok(b.scales.every((v) => Math.abs(v - Math.log(0.05)) < 1e-6));
});

test('F-089: 지붕 점의 x·z 는 건물 중심, y 는 건물 높이와 같다(전수)', () => {
  const r = generate({ seed: 13, count: 300 });
  assert.equal(r.cloud.count, r.truth.buildings.length);
  r.truth.buildings.forEach((b, i) => {
    const c = r.cloud.positions;
    assert.ok(Math.abs(c[3 * i] - (b.min[0] + b.max[0]) / 2) <= 1e-3, `건물 ${i} x`);
    assert.ok(Math.abs(c[3 * i + 2] - (b.min[1] + b.max[1]) / 2) <= 1e-3, `건물 ${i} z`);
    assert.ok(Math.abs(c[3 * i + 1] - b.height) <= 1e-4, `건물 ${i} y`);
  });
});

test('F-091: opts 가 null 이어도 기본값으로 생성된다', () => {
  assert.equal(generate(null).count, 1000);
});
