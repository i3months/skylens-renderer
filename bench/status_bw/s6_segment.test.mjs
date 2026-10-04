// SPEC §4 S6 구간당 문턱 시험(T13.B, 결정 0043). 구간당 250만 점 합성(SPEC 규모)에서 S6 송출 구성의 구간당 프레임 바이트 ≤ 3,000,000 B.
// 문턱은 SPEC 수치(MB = 10^6 B)를 이 파일 안에 숫자 리터럴로 둔다. 측정값에 맞춰 고치지 않는다.
// 송출 구성: codec 1(SKLC1, 무손실 색) + 구간 바이트 예산 안에서 수준마다 공간 균일 솎기(원본 점의 부분집합).
// 솎기는 화질 영향이 있다(시점 SSIM 은 bench/status_quality 에서 따로 잰다).
// `node --test bench/status_bw/s6_segment.test.mjs`
import test from 'node:test';
import assert from 'node:assert/strict';
import { measureStatusBandwidth, S6_SEND_CONFIG } from './index.mjs';

test('S6 송출 구성: codec 1, 구간 바이트 예산은 S6 구간당 문턱 3,000,000 B 그대로', () => {
  assert.equal(S6_SEND_CONFIG.codec, 1);
  assert.equal(S6_SEND_CONFIG.segmentByteBudget, 3_000_000);
});

const large = measureStatusBandwidth({ segments: 3, pointsPerSegment: 2500000, ...S6_SEND_CONFIG });

test('구간당 250만 점 합성(SPEC 규모): 구간당 프레임 바이트 ≤ 3,000,000 B, 초기 ≤ 15,000,000 B', () => {
  assert.equal(large.rows.length, 3);
  assert.ok(large.initialBytes <= 15_000_000, `초기 ${large.initialBytes}`);
  for (const r of large.rows) {
    console.log(`# 구간 ${r.segmentId}: ${r.frameBytes} B (S6 문턱의 ${(r.frameBytes / 3_000_000 * 100).toFixed(1)}%), 송출 점 ${r.points} / 원본 ${r.sourcePoints}, 수준별 ${r.levels.map((l) => l.points).join('/')}`);
    assert.ok(r.frameBytes <= 3_000_000, `구간 ${r.segmentId} ${r.frameBytes}`);
    assert.equal(r.frameBytes, r.levels.reduce((s, l) => s + l.frameBytes, 0));
  }
});

test('구간당 250만 점 합성: 4수준 모두 송출되고 원본 이하·수준마다 엄격 증가, 원본 수준 점 수는 SPEC 규모', () => {
  for (const r of large.rows) {
    assert.deepEqual(r.levels.map((l) => l.sourcePoints), [312500, 625000, 1250000, 2500000]);
    assert.equal(r.thinned, true);
    for (const l of r.levels) {
      assert.ok(l.points >= 1 && l.points <= l.sourcePoints, `수준 ${l.level} ${l.points}`);
      assert.ok(l.pieces >= 1);
      assert.equal(l.arrivedBytes, 23);
    }
    for (let k = 1; k < 4; k++) assert.ok(r.levels[k].points > r.levels[k - 1].points);
  }
});
