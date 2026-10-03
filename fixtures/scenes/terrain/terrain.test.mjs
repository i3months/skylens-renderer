import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from './index.mjs';
import { assertSceneResult, resultHash } from '../../../contracts/scenes/index.mjs';

const N = 20000;

// 시험 안 독립 정답: params 만 받아 높이를 직접 계산하고 중앙 유한차분으로 기울기를 구한다(모듈의 gradientAt 미사용).
const hRef = (params, x, z) => params.offset + params.waves.reduce((s, w) => s + w.a * Math.sin(w.kx * x + w.kz * z + w.phase), 0);
const EPS = 1e-3;
const fdGrad = (params, x, z) => [
  (hRef(params, x + EPS, z) - hRef(params, x - EPS, z)) / (2 * EPS),
  (hRef(params, x, z + EPS) - hRef(params, x, z - EPS)) / (2 * EPS),
];

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
  test(`높이는 시험 안 hRef 와 1e-4 m 이내, 0~30 m, 범위 안 (seed ${seed})`, () => {
    const r = generate({ seed, count: N });
    const { params } = r.truth.heightAt;
    const p = r.cloud.positions;
    for (let i = 0; i < N; i++) {
      const x = p[3 * i], y = p[3 * i + 1], z = p[3 * i + 2];
      assert.ok(Math.abs(x) <= 100 && Math.abs(z) <= 100);
      assert.ok(Math.abs(y - hRef(params, x, z)) <= 1e-4);
      assert.ok(y >= 0 && y <= 30);
    }
    for (let a = 0; a < 3; a++) assert.ok(r.truth.bounds.min[a] <= r.truth.bounds.max[a]);
  });

  test(`법선은 단위·위쪽이며 시험 안 중앙 유한차분 법선과 각도 오차 1e-3 rad 이하, 최대 경사 15° 이하 (seed ${seed})`, () => {
    const r = generate({ seed, count: N });
    const { params } = r.truth.heightAt;
    const p = r.cloud.positions, nn = r.cloud.normals;
    let maxSlope = 0, maxAng = 0;
    for (let i = 0; i < N; i++) {
      const x = p[3 * i], z = p[3 * i + 2];
      const [hx, hz] = fdGrad(params, x, z);
      const l = Math.hypot(hx, 1, hz);
      const e = [-hx / l, 1 / l, -hz / l];
      const g = [nn[3 * i], nn[3 * i + 1], nn[3 * i + 2]];
      assert.ok(g[1] > 0);
      assert.ok(Math.abs(Math.hypot(...g) - 1) < 1e-6);
      const dot = Math.max(-1, Math.min(1, e[0] * g[0] + e[1] * g[1] + e[2] * g[2]));
      maxAng = Math.max(maxAng, Math.acos(dot));
      maxSlope = Math.max(maxSlope, Math.atan(Math.hypot(hx, hz)) * 180 / Math.PI);
    }
    assert.ok(maxAng <= 1e-3, `최대 각도 오차 ${maxAng}`);
    assert.ok(maxSlope <= 15, `유한차분 최대 경사 ${maxSlope}`);
    assert.ok(maxSlope <= r.truth.maxSlopeDeg + 1e-6);
    assert.ok(r.truth.maxSlopeDeg <= 15);
  });
}

test('법선 시험이 방향을 가린다: 해석 법선의 x·z 성분을 뒤집으면 오차가 1e-3 rad 를 넘는다', () => {
  const r = generate({ seed: 1, count: 2000 });
  const { params } = r.truth.heightAt;
  let worst = 0;
  for (let i = 0; i < 2000; i++) {
    const [hx, hz] = fdGrad(params, r.cloud.positions[3 * i], r.cloud.positions[3 * i + 2]);
    const l = Math.hypot(hx, 1, hz);
    const f = [hx / l, 1 / l, hz / l]; // 부호 반전 법선
    const g = [r.cloud.normals[3 * i], r.cloud.normals[3 * i + 1], r.cloud.normals[3 * i + 2]];
    worst = Math.max(worst, Math.acos(Math.min(1, f[0] * g[0] + f[1] * g[1] + f[2] * g[2])));
  }
  assert.ok(worst > 1e-3);
});

test('입력 검증: count·seed·format 이상값 거부, count 0·1 통과', () => {
  for (const count of [NaN, -5, 10.5, '5', Infinity]) assert.throws(() => generate({ seed: 1, count }), /count/);
  for (const seed of [1.5, NaN, 'abc', -1, 2 ** 32]) assert.throws(() => generate({ seed, count: 10 }), /seed/);
  for (const format of [3, 0, '1', NaN]) assert.throws(() => generate({ seed: 1, count: 10, format }), /format/);
  assert.equal(generate({ seed: 1, count: 0 }).count, 0);
  assert.equal(generate({ seed: 1, count: 1 }).count, 1);
  assert.equal(resultHash(generate({ count: 10 })), resultHash(generate({ seed: 1, count: 10 })));
});

test('F-091: 모든 점이 truth.bounds 안에 있다(전수)', () => {
  const r = generate({ seed: 4, count: N });
  const { min, max } = r.truth.bounds, p = r.cloud.positions;
  for (let i = 0; i < N; i++) for (let a = 0; a < 3; a++) assert.ok(p[3 * i + a] >= min[a] && p[3 * i + a] <= max[a], `점 ${i} 축 ${a}`);
});

test('F-091: opts 가 null 이어도 기본값으로 생성된다', () => {
  assert.equal(generate(null).count, 200000);
});
