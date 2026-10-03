// 계층의 positions 가 원본 클라우드의 각 indices 해당 위치를 순서대로 복사한 것인지 확인한다.
// 구조: levels[l].positions[3k..3k+2] == cloud.positions[3·indices[k]..]
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../../../fixtures/scenes/flat_boxes/index.mjs';
import { buildHierarchy } from '../hierarchy/index.mjs';

const { cloud } = generate({ seed: 3, count: 40000 });
const h = buildHierarchy(cloud, { edge0M: 0.5, levelCount: 4, maxLeafPoints: 512 });

const bytes = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);

test('levels[l].positions: 원본 위치를 indices 순서로 정확히 복사(구조·길이·바이트 일치)', () => {
  for (const lv of h.levels) {
    // positions 는 Float32Array 이어야 함
    assert.ok(lv.positions instanceof Float32Array);

    // positions 길이는 3·count 여야 함
    const expectedLen = 3 * lv.count;
    assert.equal(lv.positions.length, expectedLen,
      `단계 ${lv.level}: 길이 ${lv.positions.length} != ${expectedLen}`);

    // indices 도 있어야 함
    assert.ok(Array.isArray(lv.indices) || lv.indices instanceof Uint32Array,
      `단계 ${lv.level}: indices 가 배열이 아님`);
    assert.equal(lv.indices.length, lv.count,
      `단계 ${lv.level}: indices.length ${lv.indices.length} != count ${lv.count}`);

    // 각 k 에 대해 positions[3k..3k+2] == cloud.positions[3·indices[k]..]
    for (let k = 0; k < lv.count; k++) {
      const srcIdx = lv.indices[k];
      const dstIdx = k;

      // 구조 단언: 3k 와 3k+1, 3k+2 가 정확히 대응되는지 확인
      for (let d = 0; d < 3; d++) {
        const actual = lv.positions[3 * dstIdx + d];
        const expected = cloud.positions[3 * srcIdx + d];
        assert.equal(actual, expected,
          `단계 ${lv.level} 점 ${k}: positions[${3 * dstIdx + d}] = ${actual}, ` +
          `cloud.positions[${3 * srcIdx + d}] = ${expected}`);
      }
    }
  }
});

test('levels[l].positions: 바이트 동일 검증(Float32Array 내용)', () => {
  for (const lv of h.levels) {
    // 참조 구현: indices 순서로 cloud.positions 복사
    const ref = new Float32Array(3 * lv.count);
    for (let s = 0; s < lv.count; s++) {
      ref.set(cloud.positions.subarray(3 * lv.indices[s], 3 * lv.indices[s] + 3), 3 * s);
    }

    // 바이트 동일성 확인
    assert.ok(bytes(lv.positions).equals(bytes(ref)), `단계 ${lv.level}`);
  }
});
