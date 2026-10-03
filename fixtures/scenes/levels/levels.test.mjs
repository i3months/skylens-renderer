// levels 장면 시험: 수준별 점 수 사다리, 부분집합 포함, 합계, 결정성, 두 형식.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSceneResult, resultHash, LEVEL_STEPS } from '../../../contracts/scenes/index.mjs';
import { generate, levelCloud } from './index.mjs';

const key = (c, i) => `${c.positions[3 * i]},${c.positions[3 * i + 1]},${c.positions[3 * i + 2]}`;

test('구간 합계가 정확히 segments×count 이고 두 형식이 계약을 통과한다', () => {
  for (const format of [1, 2]) {
    const r = generate({ seed: 1, segments: 5, count: 800, format });
    assertSceneResult(r, { scene: 'levels', count: 4000 });
    assert.equal(r.truth.segments.length, 5);
  }
  assert.equal(generate({ seed: 2 }).count, 8 * 20000);
});

test('수준별 점 수가 구간마다 엄격 증가하고 step 이 LEVEL_STEPS 와 같다', () => {
  const r = generate({ seed: 3, segments: 8, count: 8 });
  for (const seg of r.truth.segments) {
    const cs = seg.levels.map((l) => l.count);
    assert.deepEqual(cs, [1, 2, 4, 8]);
    seg.levels.forEach((l, k) => { assert.equal(l.step, LEVEL_STEPS[k]); assert.equal(l.level, k); });
  }
  const r2 = generate({ seed: 3, segments: 3, count: 20000 });
  assert.deepEqual(r2.truth.segments[0].levels.map((l) => l.count), [2500, 5000, 10000, 20000]);
});

test('낮은 수준 점이 모두 높은 수준에 포함된다(전수, 두 형식)', () => {
  for (const format of [1, 2]) {
    const r = generate({ seed: 4, segments: 3, count: 1000, format });
    for (let s = 0; s < 3; s++) {
      for (let k = 0; k < 3; k++) {
        const lo = levelCloud(r, s, k), hi = levelCloud(r, s, k + 1);
        assert.equal(lo.count, r.truth.segments[s].levels[k].count);
        const set = new Set();
        for (let i = 0; i < hi.count; i++) set.add(key(hi, i));
        for (let i = 0; i < lo.count; i++) assert.ok(set.has(key(lo, i)), `seg ${s} L${k} 점 ${i}`);
      }
      assert.equal(levelCloud(r, s, 3).count, 1000);
    }
  }
});

test('점이 구간 띠와 기복 범위 안에 있고 법선이 단위 길이로 위쪽이다', () => {
  const r = generate({ seed: 5, segments: 4, count: 500 });
  for (let s = 0; s < 4; s++) {
    const c = levelCloud(r, s, 3);
    for (let i = 0; i < c.count; i++) {
      const x = c.positions[3 * i], y = c.positions[3 * i + 1], z = c.positions[3 * i + 2];
      assert.ok(x >= 50 * s && x <= 50 * (s + 1) && z >= -50 && z <= 50 && Math.abs(y) <= 2 + 1e-5);
      const n = [c.normals[3 * i], c.normals[3 * i + 1], c.normals[3 * i + 2]];
      assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-5 && n[1] > 0);
    }
  }
});

test('같은 시드는 바이트 동일, 다른 시드는 다르다', () => {
  for (const format of [1, 2]) {
    const a = resultHash(generate({ seed: 7, segments: 2, count: 300, format }));
    assert.equal(a, resultHash(generate({ seed: 7, segments: 2, count: 300, format })));
    assert.notEqual(a, resultHash(generate({ seed: 8, segments: 2, count: 300, format })));
  }
});

test('levels<4 옵션과 잘못된 옵션', () => {
  const r = generate({ seed: 1, segments: 2, levels: 2, count: 100 });
  assert.deepEqual(r.truth.segments[0].levels.map((l) => l.count), [50, 100]);
  assert.throws(() => generate({ seed: 1, levels: 5 }), RangeError);
});
