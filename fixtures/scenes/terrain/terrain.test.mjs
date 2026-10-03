import test from 'node:test';
import assert from 'node:assert/strict';
import { generate, heightAt, gradientAt, normalAt } from './index.mjs';
import { assertSceneResult, resultHash } from '../../../contracts/scenes/index.mjs';

const N = 20000;

test('같은 시드는 바이트 동일, 다른 시드는 다름', () => {
  const a = resultHash(generate({ seed: 7, count: N }));
  assert.equal(resultHash(generate({ seed: 7, count: N })), a);
  assert.notEqual(resultHash(generate({ seed: 8, count: N })), a);
});

test('기본 점 수는 200000, 지정하면 정확히 그 수', () => {
  assert.equal(generate({ seed: 1 }).count, 200000);
  assert.equal(generate({ seed: 1, count: 1234 }).count, 1234);
});

test('두 형식 모두 assertSceneResult 통과', () => {
  for (const format of [1, 2]) assertSceneResult(generate({ seed: 3, count: 500, format }), { scene: 'terrain', count: 500 });
});

for (const seed of [1, 2, 99, 123456]) {
  test(`높이는 heightAt 과 1e-4 m 이내, 0~30 m, 범위 안 (seed ${seed})`, () => {
    const r = generate({ seed, count: N });
    const { params } = r.truth.heightAt;
    const p = r.cloud.positions;
    for (let i = 0; i < N; i++) {
      const x = p[3 * i], y = p[3 * i + 1], z = p[3 * i + 2];
      assert.ok(Math.abs(x) <= 100 && Math.abs(z) <= 100);
      assert.ok(Math.abs(y - heightAt(params, x, z)) <= 1e-4);
      assert.ok(y >= 0 && y <= 30);
    }
    for (let a = 0; a < 3; a++) assert.ok(r.truth.bounds.min[a] <= r.truth.bounds.max[a]);
  });

  test(`법선은 단위·위쪽이며 해석 법선과 각도 오차 1e-3 rad 이하, 최대 경사 15° 이하 (seed ${seed})`, () => {
    const r = generate({ seed, count: N });
    const { params } = r.truth.heightAt;
    const p = r.cloud.positions, nn = r.cloud.normals;
    let maxSlope = 0;
    for (let i = 0; i < N; i++) {
      const x = p[3 * i], z = p[3 * i + 2];
      const e = normalAt(params, x, z);
      const g = [nn[3 * i], nn[3 * i + 1], nn[3 * i + 2]];
      assert.ok(g[1] > 0);
      assert.ok(Math.abs(Math.hypot(...g) - 1) < 1e-6);
      const dot = Math.max(-1, Math.min(1, e[0] * g[0] + e[1] * g[1] + e[2] * g[2]));
      assert.ok(Math.acos(dot) <= 1e-3);
      const [gx, gz] = gradientAt(params, x, z);
      maxSlope = Math.max(maxSlope, Math.atan(Math.hypot(gx, gz)) * 180 / Math.PI);
    }
    assert.ok(maxSlope <= 15);
    assert.ok(r.truth.maxSlopeDeg <= 15);
  });
}
