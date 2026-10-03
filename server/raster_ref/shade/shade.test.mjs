// T06.6 램버트 셰이딩 시험. 기대값은 해석해 리터럴이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lambert, shadeResult } from './index.mjs';
import { emptyResult } from '../../../contracts/raster/index.mjs';

const RGB = [200, 100, 50];
const S = Math.SQRT1_2;

test('n=l 이면 I=1, 색 그대로', () => {
  assert.deepEqual(lambert([0, 0, 1], [0, 0, 1], RGB), [200, 100, 50]);
});

test('n 이 l 에 수직이면 I=0.3 → 60,30,15', () => {
  assert.deepEqual(lambert([1, 0, 0], [0, 0, 1], RGB), [60, 30, 15]);
});

test('n=−l 이면 ambient 만 → 60,30,15', () => {
  assert.deepEqual(lambert([0, 0, -1], [0, 0, 1], RGB), [60, 30, 15]);
});

// I = 0.3+0.7·cos45° = 0.7949747: 200→158.99→159, 100→79.497→79, 50→39.75→40
test('45도: I=0.7949747 → 159,79,40', () => {
  assert.deepEqual(lambert([S, 0, S], [0, 0, 1], RGB), [159, 79, 40]);
});

test('정규화 불변: n, l 에 스케일을 곱해도 같다', () => {
  assert.deepEqual(lambert([7, 0, 7], [0, 0, 0.001], RGB), [159, 79, 40]);
  assert.deepEqual(lambert([1e200, 0, 1e200], [0, 0, 5], RGB), [159, 79, 40]);
});

test('해석해와 정수 일치(오차 ≤ 1/255 기준)', () => {
  for (let deg = 0; deg <= 180; deg += 7) {
    const th = (deg * Math.PI) / 180;
    const I = 0.3 + 0.7 * Math.max(0, Math.cos(th));
    const got = lambert([Math.sin(th), 0, Math.cos(th)], [0, 0, 1], [255, 128, 7]);
    const exact = [255 * I, 128 * I, 7 * I];
    got.forEach((g, c) => {
      assert.ok(Number.isInteger(g));
      assert.ok(Math.abs(g - exact[c]) <= 0.5 + 1e-9);
    });
  }
});

test('ambient 옵션', () => {
  assert.deepEqual(lambert([1, 0, 0], [0, 0, 1], RGB, { ambient: 0.5 }), [100, 50, 25]);
  assert.deepEqual(lambert([1, 0, 0], [0, 0, 1], RGB, { ambient: 0 }), [0, 0, 0]);
});

test('거부 입력', () => {
  const bad = [
    () => lambert([0, 0, 0], [0, 0, 1], RGB),
    () => lambert([0, 0, 1], [0, 0, 0], RGB),
    () => lambert([NaN, 0, 1], [0, 0, 1], RGB),
    () => lambert([0, 0, 1], [Infinity, 0, 1], RGB),
    () => lambert([0, 1], [0, 0, 1], RGB),
    () => lambert([0, 0, 1], [0, 0, 1], [1, 2]),
    () => lambert([0, 0, 1], [0, 0, 1], [1, NaN, 3]),
    () => lambert([0, 0, 1], [0, 0, 1], RGB, { ambient: 2 }),
    () => lambert([0, 0, 1], [0, 0, 1], RGB, { ambient: NaN }),
  ];
  for (const f of bad) assert.throws(f, /^Error: shade:/);
});

// 변이 검출: max 제거, ambient 무시 식은 리터럴을 못 맞춘다.
test('변이: max 제거·ambient 무시는 실패', () => {
  // 실제 구현: ambient=0.3 에서 d=-1 일 때 I = 0.3 + 0.7*max(0,-1) = 0.3, 결과 200*0.3 = 60
  assert.equal(lambert([0, 0, -1], [0, 0, 1], RGB)[0], 60, '실제 구현');
});

const cam = {
  width: 2, height: 2, K: { fx: 1, fy: 1, cx: 1, cy: 1 },
  R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0],
};

function sample() {
  const r = emptyResult(2, 2);
  r.index[0] = 0; r.index[1] = 1; r.index[3] = 2; // 픽셀 2 는 빈 칸
  for (const p of [0, 1, 3]) { r.color.set([200, 100, 50], 3 * p); r.depth[p] = 5; }
  return r;
}

test('shadeResult: format 1, 빈 픽셀 유지, 입력 불변, 등진 법선도 계산', () => {
  const r = sample();
  const before = Uint8Array.from(r.color);
  const cloud = { format: 1, normals: new Float32Array([0, 0, 1, 1, 0, 0, 0, 0, -1]) };
  const out = shadeResult(r, cam, cloud, [0, 0, 1]);
  assert.deepEqual([...out.slice(0, 3)], [200, 100, 50]);
  assert.deepEqual([...out.slice(3, 6)], [60, 30, 15]);
  assert.deepEqual([...out.slice(6, 9)], [0, 0, 0]);
  assert.deepEqual([...out.slice(9, 12)], [60, 30, 15]);
  assert.deepEqual([...r.color], [...before]);
  assert.notEqual(out, r.color);
});

test('shadeResult: format 2 는 색 그대로', () => {
  const r = sample();
  const out = shadeResult(r, cam, { format: 2 }, [0, 0, 1]);
  assert.deepEqual([...out], [...r.color]);
});

test('shadeResult: 거부', () => {
  const r = sample();
  assert.throws(() => shadeResult(r, cam, { format: 1 }, [0, 0, 1]), /^Error: shade:/);
  assert.throws(() => shadeResult(r, cam, { format: 1, normals: new Float32Array(3) }, [0, 0, 1]), /^Error: shade:/);
  // 길이 0 법선은 거부가 아니라 셰이딩 생략(입력 색 유지)이다(F-093 ②, shade_rules.test.mjs 에서 자세히 검사).
  assert.deepEqual([...shadeResult(r, cam, { format: 1, normals: new Float32Array(9) }, [0, 0, 1])], [...r.color]);
  assert.throws(() => shadeResult(r, cam, { format: 1, normals: new Float32Array(9).fill(1) }, [0, 0, 0]), /^Error: shade:/);
});
