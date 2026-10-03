// levels 장면 시험: 수준별 점 수 사다리, 부분집합 포함, 합계, 결정성, 두 형식.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSceneResult, resultHash, LEVEL_STEPS } from '../../../contracts/scenes/index.mjs';
import { generate, levelCloud } from './index.mjs';

// 시험 안 독립 정답: 기복 높이 식을 직접 쓰고 중앙 유한차분으로 법선을 만든다(모듈 함수 미사용).
const hRef = (p, x, z) => Math.sin(0.11 * x + p[0]) * Math.cos(0.09 * z + p[1]) + 0.6 * Math.sin(0.23 * x + 0.19 * z + p[2]) + 0.4 * Math.cos(0.31 * z + p[3]);
const EPS = 1e-3;
const fdNormal = (p, x, z) => {
  const hx = (hRef(p, x + EPS, z) - hRef(p, x - EPS, z)) / (2 * EPS);
  const hz = (hRef(p, x, z + EPS) - hRef(p, x, z - EPS)) / (2 * EPS);
  const l = Math.hypot(hx, 1, hz);
  return [-hx / l, 1 / l, -hz / l];
};
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));

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

test('법선이 시험 안 중앙 유한차분 법선과 1e-3 rad 이내(두 형식)', () => {
  for (const format of [1, 2]) {
    const r = generate({ seed: 6, segments: 3, count: 1500, format });
    const p = r.truth.relief.phases;
    let worst = 0, maxTilt = 0;
    for (let s = 0; s < 3; s++) {
      const c = levelCloud(r, s, 3);
      for (let i = 0; i < c.count; i++) {
        const e = fdNormal(p, c.positions[3 * i], c.positions[3 * i + 2]);
        const g = [c.normals[3 * i], c.normals[3 * i + 1], c.normals[3 * i + 2]];
        worst = Math.max(worst, angle(e, g));
        maxTilt = Math.max(maxTilt, Math.acos(e[1]));
      }
    }
    assert.ok(worst <= 1e-3, `format ${format} 각도 오차 ${worst}`);
    // 시험 민감도: 기울어진 법선이 실제로 있어야 부호 반전이 잡힌다(최소 3°).
    assert.ok(maxTilt > 3 * Math.PI / 180, `기울기 ${maxTilt}`);
  }
});

test('format 2 결과의 위치·색이 format 1 과 일치한다', () => {
  const a = generate({ seed: 9, segments: 3, count: 600, format: 1 });
  const b = generate({ seed: 9, segments: 3, count: 600, format: 2 });
  assert.equal(b.cloud.positions.length, a.cloud.positions.length);
  assert.deepEqual(Array.from(b.cloud.positions), Array.from(a.cloud.positions));
  assert.ok(a.cloud.positions.some((v) => v !== 0));
  let colorSum = 0;
  for (let s = 0; s < 3; s++) {
    for (let k = 0; k < 4; k++) {
      const c1 = levelCloud(a, s, k), c2 = levelCloud(b, s, k);
      assert.deepEqual(Array.from(c2.positions), Array.from(c1.positions));
      assert.deepEqual(Array.from(c2.colors), Array.from(c1.colors));
      for (const v of c1.colors) colorSum += v;
      for (let i = 0; i < 3 * c1.count; i++) assert.ok(Math.abs(c2.normals[i] - c1.normals[i]) < 1e-6);
    }
  }
  assert.ok(colorSum > 0);
  // 체크 무늬(밝은 칸 ≥190, 어두운 칸 ≤ 80+tint+잡음)가 있어 색 범위가 넓다.
  const all = Array.from(a.cloud.colors);
  assert.ok(Math.max(...all) - Math.min(...all) >= 80);
});

test('입력 검증: count·seed·format 거부, levels=4 는 count 8 미만 거부, levels<4 는 해당 최소값', () => {
  for (const count of [NaN, -5, 10.5, '5']) assert.throws(() => generate({ seed: 1, count, segments: 1 }), /count/);
  for (const seed of [1.5, NaN, 'abc']) assert.throws(() => generate({ seed, count: 8 }), /seed/);
  for (const format of [3, 0, '2']) assert.throws(() => generate({ seed: 1, count: 8, format }), /format/);
  for (const count of [0, 1, 7]) assert.throws(() => generate({ seed: 1, segments: 1, count }), RangeError);
  assert.equal(generate({ seed: 1, segments: 1, count: 8 }).count, 8);
  assert.throws(() => generate({ seed: 1, segments: 1, levels: 3, count: 3 }), RangeError);
  assert.equal(generate({ seed: 1, segments: 1, levels: 3, count: 4 }).count, 4);
  assert.throws(() => generate({ seed: 1, segments: 1, levels: 2, count: 1 }), RangeError);
  assert.equal(generate({ seed: 1, segments: 1, levels: 1, count: 1 }).count, 1);
});

test('count 8 이상이면 어떤 levels 에서도 수준 점 수가 엄격 증가한다', () => {
  for (const levels of [1, 2, 3, 4]) {
    for (const count of [8, 9, 11, 15, 33]) {
      const cs = generate({ seed: 1, segments: 1, levels, count }).truth.segments[0].levels.map((l) => l.count);
      for (let k = 1; k < cs.length; k++) assert.ok(cs[k] > cs[k - 1], `levels ${levels} count ${count}: ${cs}`);
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
  // levels<4 면 낮은 수준이 아니라 높은 수준 끝에 맞춰 step 을 붙인다(최고 수준 = 7000).
  for (const [levels, steps] of [[1, [7000]], [2, [3500, 7000]], [3, [1000, 3500, 7000]], [4, [250, 1000, 3500, 7000]]]) {
    const g = generate({ seed: 1, segments: 1, levels, count: 16 });
    assert.deepEqual(g.truth.segments[0].levels.map((l) => l.step), steps);
    assert.deepEqual(steps, LEVEL_STEPS.slice(4 - levels));
  }
});
