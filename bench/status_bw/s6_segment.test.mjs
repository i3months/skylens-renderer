// S6 송출 구성 시험(T13.HQ, 사람 결정: 대역폭 상한 없음, 화질 우선). 구간당 250만 점 합성(SPEC 규모)에서
// 송출 점 = 원본 점(솎기·구간 바이트 예산 없음)이고 압축은 무손실 codec 1 만이다. 구간당 바이트는 출력만 하고 단언하지 않는다.
// `node --test bench/status_bw/s6_segment.test.mjs`
import test from 'node:test';
import assert from 'node:assert/strict';
import { measureStatusBandwidth, S6_SEND_CONFIG } from './index.mjs';

test('S6 송출 구성: codec 1 만, 솎기·바이트 예산 항목 없음', () => {
  assert.deepEqual({ ...S6_SEND_CONFIG }, { codec: 1 });
});

for (const seed of [1, 42]) {
  test(`구간당 250만 점 합성(seed ${seed}): 4수준 송출 점 = 원본 점 [312500, 625000, 1250000, 2500000], 바이트는 출력만`, (t) => {
    const r6 = measureStatusBandwidth({ segments: 3, pointsPerSegment: 2500000, seed, ...S6_SEND_CONFIG });
    assert.equal(r6.rows.length, 3);
    assert.equal(r6.codec, 1);
    t.diagnostic(`초기 ${r6.initialBytes} B`);
    for (const r of r6.rows) {
      t.diagnostic(`구간 ${r.segmentId}: ${r.frameBytes} B, 송출 점 ${r.points} / 원본 ${r.sourcePoints}, 수준별 바이트 ${r.levels.map((l) => l.frameBytes).join('/')}`);
      assert.deepEqual(r.levels.map((l) => l.sourcePoints), [312500, 625000, 1250000, 2500000]);
      assert.deepEqual(r.levels.map((l) => l.points), [312500, 625000, 1250000, 2500000]);
      assert.equal(r.points, r.sourcePoints);
      assert.equal(r.frameBytes, r.levels.reduce((s, l) => s + l.frameBytes, 0));
      for (const l of r.levels) {
        assert.ok(l.pieces >= 1);
        assert.equal(l.arrivedBytes, 23);
      }
    }
  });
}
