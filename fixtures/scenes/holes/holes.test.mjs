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

test('F-091: 색 무늬가 잡음이 아니라 2 m 체크에서 온다(밝은 칸 R 평균이 어두운 칸보다 40 이상 큼)', () => {
  const r = generate({ seed: 2, count: 20000 });
  const p = r.cloud.positions, c = r.cloud.colors;
  const sum = [0, 0], n = [0, 0];
  for (let i = 0; i < r.count; i++) {
    const k = ((Math.floor(p[3 * i] / 2) + Math.floor(p[3 * i + 2] / 2)) & 1) === 0 ? 0 : 1;
    sum[k] += c[3 * i]; n[k]++;
  }
  assert.ok(n[0] > 1000 && n[1] > 1000);
  // 기준: 밝은 칸 150, 어두운 칸 70 (차 80, 잡음 ±25 는 평균에서 상쇄)
  assert.ok(sum[0] / n[0] - sum[1] / n[1] >= 40, `칸 평균 차 ${sum[0] / n[0] - sum[1] / n[1]}`);
});

test('F-091: 모든 점이 truth.bounds 안에 있다(전수)', () => {
  const r = generate({ seed: 6 });
  const { min, max } = r.truth.bounds, p = r.cloud.positions;
  for (let i = 0; i < r.count; i++) for (let a = 0; a < 3; a++) assert.ok(p[3 * i + a] >= min[a] && p[3 * i + a] <= max[a], `점 ${i} 축 ${a}`);
});

test('F-091: opts 가 null 이어도 기본값으로 생성된다', () => {
  assert.equal(generate(null).count, 100000);
});

test('holes_같은_시드_바이트_동일_다른_시드_다름_두_형식', () => {
  for (const format of [1, 2]) {
    const a = generate({ seed: 4, count: 3000, format }), b = generate({ seed: 4, count: 3000, format });
    assertSceneResult(a, { scene: 'holes', count: 3000 });
    assert.equal(resultHash(a), resultHash(b));
    assert.notEqual(resultHash(a), resultHash(generate({ seed: 5, count: 3000, format })));
  }
});

// ---- 반려 수정(F-085 ③, F-086, F-083): 시험 안에서 독립적으로 정답을 만든다 ----
const C0 = 0.28209479177387814;

test('holes_holeFraction_을_구멍_사각형_면적_직접_합으로_독립_계산', () => {
  for (const seed of [1, 5, 42]) {
    const t = generate({ seed, count: 10 }).truth;
    let sum = 0;
    for (const h of t.holes) sum += (h.max[0] - h.min[0]) * (h.max[1] - h.min[1]);
    assert.equal(t.holes.length, 6);
    assert.ok(sum > 0 && sum < 40000);
    assert.ok(Math.abs(t.holeFraction - sum / (200 * 200)) <= 1e-12);
    assert.ok(Math.abs(t.holeAreaM2 - sum) <= 1e-9);
  }
});

test('holes_구멍_가장자리_바깥_0_1m_띠에_점_밀도_하한', () => {
  for (const seed of [1, 3, 8]) {
    const r = generate({ seed });
    const H = r.truth.holes, p = r.cloud.positions;
    // 띠: 어떤 구멍의 1 m 확장 안이면서 어떤 구멍 안도 아닌 곳
    const inBand = (x, z) => !inH(H, x, z) && H.some((h) => x >= h.min[0] - 1 && x <= h.max[0] + 1 && z >= h.min[1] - 1 && z <= h.max[1] + 1);
    let pts = 0;
    for (let i = 0; i < r.count; i++) if (inBand(p[3 * i], p[3 * i + 2])) pts++;
    // 띠 면적: 0.25 m 격자 중심 표집
    let cells = 0;
    for (let a = 0; a < 800; a++) for (let b = 0; b < 800; b++) if (inBand(-100 + (a + 0.5) * 0.25, -100 + (b + 0.5) * 0.25)) cells++;
    const bandArea = cells * 0.0625;
    let holeArea = 0;
    for (const h of H) holeArea += (h.max[0] - h.min[0]) * (h.max[1] - h.min[1]);
    const expected = r.count / (40000 - holeArea) * bandArea; // 균일 분포일 때 띠 안 점 수
    assert.ok(bandArea > 100, `띠 면적 ${bandArea}`);
    assert.ok(pts >= 0.9 * expected, `시드 ${seed}: 띠 점 ${pts} < 기대 ${expected} 의 90%`);
    assert.ok(pts <= 1.2 * expected);
  }
});

test('holes_잘못된_개수_시드_형식은_거부하고_0_1은_통과', () => {
  for (const count of [NaN, -5, 10.5, 'abc']) assert.throws(() => generate({ seed: 1, count }), /scene:/);
  for (const seed of [NaN, -5, 10.5, 'abc']) assert.throws(() => generate({ seed, count: 10 }), /scene:/);
  for (const format of [0, 3, '2']) assert.throws(() => generate({ seed: 1, count: 10, format }), /scene:/);
  assert.equal(generate({ seed: 1, count: 0 }).count, 0);
  assert.equal(generate({ seed: 1, count: 1 }).count, 1);
});

test('holes_format2_위치는_format1과_같고_fdc는_색에서_역변환한_값', () => {
  const a = generate({ seed: 6, count: 3000, format: 1 }), b = generate({ seed: 6, count: 3000, format: 2 });
  assert.deepEqual([...b.cloud.positions], [...a.cloud.positions]);
  for (let i = 0; i < 3 * 3000; i++) assert.ok(Math.abs(b.cloud.fdc[i] - (a.cloud.colors[i] / 255 - 0.5) / C0) <= 1e-6);
});
