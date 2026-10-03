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
