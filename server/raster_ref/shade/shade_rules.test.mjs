// shadeResult 입력 규칙 시험(F-093 ②, F-095 ⑦).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lambert, shadeResult } from './index.mjs';
import { emptyResult } from '../../../contracts/raster/index.mjs';

const cam = { width: 2, height: 2, K: { fx: 1, fy: 1, cx: 1, cy: 1 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

function sample() {
  const r = emptyResult(2, 2);
  r.index[0] = 0; r.index[1] = 1; r.index[3] = 2; // 픽셀 2 는 빈 칸
  for (const p of [0, 1, 3]) { r.color.set([200, 100, 50], 3 * p); r.depth[p] = 5; }
  return r;
}

test('법선 (0,0,0) 점이 섞여도 성공: 그 점은 셰이딩 생략(입력 색 유지), 나머지는 규칙대로', () => {
  const normals = new Float32Array([0, 0, 1, 0, 0, 0, 1, 0, 0]); // 점 1 의 법선 길이 0
  const out = shadeResult(sample(), cam, { format: 1, normals }, [0, 0, 1]);
  assert.deepEqual([...out.slice(0, 3)], [200, 100, 50]); // n=l → I=1
  assert.deepEqual([...out.slice(3, 6)], [200, 100, 50]); // 길이 0 → 입력 색 그대로
  assert.deepEqual([...out.slice(6, 9)], [0, 0, 0]); // 빈 칸
  assert.deepEqual([...out.slice(9, 12)], [60, 30, 15]); // n⊥l → I=0.3
});

test('길이 0 이 아닌 잘못된 법선(비유한)은 여전히 거부', () => {
  const normals = new Float32Array([0, 0, 1, NaN, 0, 0, 1, 0, 0]);
  assert.throws(() => shadeResult(sample(), cam, { format: 1, normals }, [0, 0, 1]), /^Error: shade:/);
});

test('법선 문자열 거부(lambert, shadeResult 모두)', () => {
  assert.throws(() => lambert(['0', '0', '1'], [0, 0, 1], [1, 2, 3]), /^Error: shade:/);
  assert.throws(() => lambert([0, 0, 1], ['0', '0', '1'], [1, 2, 3]), /^Error: shade:/);
  const normals = ['0', '0', '1', '0', '0', '1', '0', '0', '1'];
  assert.throws(() => shadeResult(sample(), cam, { format: 1, normals }, [0, 0, 1]), /^Error: shade:/);
});

test('format 2 도 광원 방향·ambient 를 검사한다', () => {
  const cloud = { format: 2 };
  assert.throws(() => shadeResult(sample(), cam, cloud, [0, 0, 0]), /^Error: shade:/);
  assert.throws(() => shadeResult(sample(), cam, cloud, [NaN, 0, 1]), /^Error: shade:/);
  assert.throws(() => shadeResult(sample(), cam, cloud, [0, 0, 1], { ambient: 2 }), /^Error: shade:/);
  // 올바른 입력이면 색을 그대로 복사한다.
  const r = sample();
  assert.deepEqual([...shadeResult(r, cam, cloud, [0, 0, 1])], [...r.color]);
});
