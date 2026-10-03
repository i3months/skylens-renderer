// DEM 장면 시험. 완료 기준 수치는 아래 상수로 고정한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSceneResult, resultHash } from '../../../contracts/scenes/index.mjs';
import { generate, quantizeTile, dequantize, heightAt } from './index.mjs';

const HALF_STEP = 100 / 65535 / 2; // 양자화 반 단계(m)
const EPS = 1e-9; // 부동소수 여유

test('양자화 왕복 오차는 전 칸에서 0.1 m 이하이고 실제로는 반 단계 이하', () => {
  for (const seed of [1, 7, 12345]) {
    const t = quantizeTile({ seed });
    assert.equal(t.tile, 129);
    assert.equal(t.cell, 10);
    assert.equal(t.heights.length, 129 * 129);
    const params = generate({ seed }).truth.params;
    let worst = 0;
    for (let j = 0; j < t.tile; j++) for (let i = 0; i < t.tile; i++) {
      const x = (i - 64) * 10, z = (j - 64) * 10;
      const e = Math.abs(dequantize(t, i, j) - heightAt(params, x, z));
      if (e > worst) worst = e;
    }
    assert.ok(worst <= 0.1);
    assert.ok(worst <= HALF_STEP + EPS, `worst ${worst}`);
  }
});

test('점의 y 는 heightAt 과 1e-4 m 이내, 법선은 단위 길이이고 위를 향함', () => {
  const r = generate({ seed: 3, tile: 33, cell: 7 });
  assertSceneResult(r, { scene: 'dem', count: 33 * 33 });
  const c = r.cloud;
  for (let p = 0; p < r.count; p++) {
    const y = heightAt(r.truth.params, c.positions[3 * p], c.positions[3 * p + 2]);
    assert.ok(Math.abs(c.positions[3 * p + 1] - y) <= 1e-4);
    assert.ok(y >= 0 && y <= 100);
    const nl = Math.hypot(c.normals[3 * p], c.normals[3 * p + 1], c.normals[3 * p + 2]);
    assert.ok(Math.abs(nl - 1) < 1e-5);
    assert.ok(c.normals[3 * p + 1] > 0);
  }
  assert.deepEqual(r.truth.quant, { minH: 0, maxH: 100, levels: 65536 });
});

test('법선이 해석 기울기와 맞음(유한 차분)', () => {
  const r = generate({ seed: 9, tile: 9, cell: 10 });
  const P = r.truth.params, c = r.cloud, d = 1e-3;
  for (let p = 0; p < r.count; p++) {
    const x = c.positions[3 * p], z = c.positions[3 * p + 2];
    const gx = (heightAt(P, x + d, z) - heightAt(P, x - d, z)) / (2 * d);
    const gz = (heightAt(P, x, z + d) - heightAt(P, x, z - d)) / (2 * d);
    const l = Math.hypot(gx, 1, gz);
    assert.ok(Math.abs(c.normals[3 * p] + gx / l) < 1e-4);
    assert.ok(Math.abs(c.normals[3 * p + 2] + gz / l) < 1e-4);
  }
});

test('같은 시드 바이트 동일, 다른 시드는 다름, 두 형식 통과', () => {
  for (const format of [1, 2]) {
    const a = generate({ seed: 5, tile: 17, format });
    const b = generate({ seed: 5, tile: 17, format });
    const c = generate({ seed: 6, tile: 17, format });
    assertSceneResult(a, { scene: 'dem', count: 289 });
    assert.equal(resultHash(a), resultHash(b));
    assert.notEqual(resultHash(a), resultHash(c));
  }
});

test('count 는 tile² 만 허용, 기본값은 129²', () => {
  assert.equal(generate({ seed: 1 }).count, 129 * 129);
  assert.equal(generate({ seed: 1, tile: 5, count: 25 }).count, 25);
  assert.throws(() => generate({ seed: 1, tile: 5, count: 24 }));
});

test('색에 무늬가 있음(체크·잡음으로 색 종류가 다양)', () => {
  const r = generate({ seed: 2, tile: 33 });
  const s = new Set();
  for (let p = 0; p < r.count; p++) s.add(r.cloud.colors.slice(3 * p, 3 * p + 3).join(','));
  assert.ok(s.size > 200);
});

test('dem: 점 수·시드·형식 거부(count 는 tile² 만이라 0·1 은 tile 로 허용 불가)', () => {
  const o = { tile: 2, cell: 10 };
  for (const count of [NaN, -5, 10.5, '4', Infinity]) assert.throws(() => generate({ seed: 1, ...o, count }), /scene: count/, String(count));
  for (const seed of [1.5, NaN, 'abc', -1, 2 ** 32]) assert.throws(() => generate({ seed, ...o }), /scene: seed/, String(seed));
  for (const format of [0, 3, '1', NaN]) assert.throws(() => generate({ seed: 1, ...o, format }), /scene: format/, String(format));
  assertSceneResult(generate({ seed: 1, ...o, count: 4 }), { scene: 'dem', count: 4 });
  assert.equal(resultHash(generate(o)), resultHash(generate({ seed: 1, ...o })), '시드 생략 = 1');
});

test('dem: format 2 의 positions 는 format 1 과 같고 fdc 는 색과 맞음', () => {
  const o = { seed: 4, tile: 9 };
  const a = generate({ ...o, format: 1 }).cloud;
  const b = generate({ ...o, format: 2 }).cloud;
  assert.deepEqual(Array.from(b.positions), Array.from(a.positions));
  const C0 = 0.28209479177387814;
  for (let i = 0; i < 3 * a.count; i++) assert.ok(Math.abs(b.fdc[i] - (a.colors[i] / 255 - 0.5) / C0) < 1e-5);
  assert.ok(b.scales.every((v) => Math.abs(v - Math.log(0.05)) < 1e-6));
});

test('F-090: cell 이 비유한이거나 범위 밖이면 거부한다', () => {
  for (const cell of [Infinity, -Infinity, NaN, 0, -3, 2e5, '10']) assert.throws(() => generate({ seed: 1, tile: 4, cell }), /dem: cell/, String(cell));
  assert.equal(generate({ seed: 1, tile: 4, cell: 1e5 }).count, 16);
});

test('F-091: opts 가 null 이어도 기본값으로 생성된다', () => {
  assert.equal(generate(null).count, 129 * 129);
});
