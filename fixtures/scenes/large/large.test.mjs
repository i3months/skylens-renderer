// 대규모 장면 생성 테스트(T05.5)

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { generate } from './index.mjs';
import { resultHash, assertSceneResult, FORMAT_POINT27, FORMAT_GAUSS56 } from '../../../contracts/scenes/index.mjs';

test('large 장면: 100k 빠른 테스트 - 속성 확인', (t) => {
  const count = 100000;
  const seed = 42;

  // 생성
  const r1 = generate({ seed, count });
  const r2 = generate({ seed, count });

  // 기본 구조 검사
  assertSceneResult(r1, { scene: 'large', count });
  assert.equal(r1.scene, 'large', 'scene name');
  assert.equal(r1.seed, seed, 'seed 보존');
  assert.equal(r1.count, count, 'count 정확함');

  // 형식 1: 같은 seed → 같은 해시
  const hash1 = resultHash(r1);
  const hash2 = resultHash(r2);
  assert.equal(hash1, hash2, '같은 seed → 같은 해시');

  // 형식 2: 가우시안 변환 후에도 유효
  const r3 = generate({ seed, count, format: FORMAT_GAUSS56 });
  assertSceneResult(r3, { scene: 'large', count });
  assert.equal(r3.format, FORMAT_GAUSS56, 'format 2 유지');

  // truth 확인
  assert(r1.truth.bounds, 'bounds 있음');
  assert.deepEqual(r1.truth.bounds.min, [-250, 0, -250], 'bounds.min');
  assert.deepEqual(r1.truth.bounds.max, [250, 0, 250], 'bounds.max');
  assert.equal(r1.truth.areaM2, 250000, 'areaM2 = 500*500');
});

test('large 장면: 250만 점 정확성(기본 npm test 에서 실행)', () => {
  const count = 2500000;
  const seed = 12345;
  const r1 = generate({ seed, count });
  const r2 = generate({ seed, count });
  assertSceneResult(r1, { scene: 'large', count });
  assert.equal(resultHash(r1), resultHash(r2), '250만 점: 같은 seed → 같은 해시');
  assert.notEqual(resultHash(r1), resultHash(generate({ seed: seed + 1, count })), '다른 seed → 다른 해시');

  // bounds·y=0·법선 (0,1,0) 전수 검사
  const { positions: P, normals: N } = r1.cloud;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const CELL = 10, NC = 50; // 10 m 셀 50x50 = 2500 칸, 칸당 기대 1000 점
  const bins = new Int32Array(NC * NC);
  for (let i = 0; i < count; i++) {
    const x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2];
    assert.ok(x >= -250 && x <= 250 && z >= -250 && z <= 250, `점 ${i} 경계 밖`);
    assert.equal(y, 0);
    assert.ok(N[3 * i] === 0 && N[3 * i + 1] === 1 && N[3 * i + 2] === 0, `점 ${i} 법선`);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    const bx = Math.min(NC - 1, Math.floor((x + 250) / CELL));
    const bz = Math.min(NC - 1, Math.floor((z + 250) / CELL));
    bins[bz * NC + bx]++;
  }
  // 가장자리 띠가 비지 않음: 네 변 모두 0.5 m 이내까지 점이 있다
  assert.ok(minX < -249.5 && maxX > 249.5 && minZ < -249.5 && maxZ > 249.5, `끝 ${minX} ${maxX} ${minZ} ${maxZ}`);
  // 셀 밀도 균일: 모든 10 m 셀이 기대값 1000 의 ±10 % 이내
  let lo = Infinity, hi = -Infinity;
  for (const b of bins) { if (b < lo) lo = b; if (b > hi) hi = b; }
  assert.ok(lo >= 900 && hi <= 1100, `셀 밀도 범위 ${lo}..${hi}`);
});

test('large 장면: 가장자리 띠 균일(+x 끝 2 m 띠 밀도가 평균의 ±10 %)', () => {
  const count = 200000;
  const r = generate({ seed: 3, count });
  let band = 0, mid = 0;
  for (let i = 0; i < count; i++) {
    const x = r.cloud.positions[3 * i];
    if (x >= 248) band++;
    else if (x >= -1 && x < 1) mid++;
  }
  assert.ok(band >= 0.9 * mid && band <= 1.1 * mid, `띠 ${band} vs 중앙 ${mid}`);
});

test('large 장면: 점 수·시드·형식 거부, 0·1 은 통과', () => {
  for (const count of [NaN, -5, 10.5, '10', Infinity]) assert.throws(() => generate({ seed: 1, count }), /scene: count/, String(count));
  for (const seed of [1.5, NaN, 'abc', -1, 2 ** 32]) assert.throws(() => generate({ seed, count: 10 }), /scene: seed/, String(seed));
  for (const format of [0, 3, '1', NaN]) assert.throws(() => generate({ seed: 1, count: 10, format }), /scene: format/, String(format));
  for (const count of [0, 1]) assertSceneResult(generate({ seed: 1, count }), { scene: 'large', count });
  assert.equal(resultHash(generate({ count: 5 })), resultHash(generate({ seed: 1, count: 5 })), '시드 생략 = 1');
});

test('large 장면: format 2 의 positions 는 format 1 과 같고 fdc 는 색과 맞음', () => {
  const a = generate({ seed: 4, count: 500, format: 1 }).cloud;
  const b = generate({ seed: 4, count: 500, format: 2 }).cloud;
  assert.deepEqual(Array.from(b.positions), Array.from(a.positions));
  const C0 = 0.28209479177387814;
  for (let i = 0; i < 3 * 500; i++) assert.ok(Math.abs(b.fdc[i] - (a.colors[i] / 255 - 0.5) / C0) < 1e-5);
  assert.ok(b.scales.every((v) => Math.abs(v - Math.log(0.05)) < 1e-6));
});

test('F-091: opts 가 null 이어도 기본값으로 생성된다', () => {
  assert.equal(generate(null).count, 2500000);
});
