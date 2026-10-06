import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCENARIOS, runScenario, main } from './run.mjs';
import { validateScenario } from '../../../contracts/load/index.mjs';

const steady = SCENARIOS[0];
const slow = SCENARIOS[2];

test('T16.10: 시나리오 3종 유효, 30 클라이언트', () => {
  assert.equal(SCENARIOS.length, 3);
  for (const s of SCENARIOS) { assert.deepEqual(validateScenario(s), []); assert.equal(s.clients, 30); }
});
test('T16.10: 시나리오별 실행이 위반 0·결과 유효, 기록 3개, 서버 샘플 60개', () => {
  for (const s of SCENARIOS) {
    const { result, violations, serverSamples } = runScenario(s, { commit: 'abcdef1' });
    assert.deepEqual(violations, [], s.name);
    assert.equal(result.perClient.length, 30);
    assert.equal(result.records.length, 3);
    assert.equal(serverSamples.length, 60, s.name);
    assert.deepEqual(serverSamples.map((x) => x.tS).slice(0, 3), [1, 2, 3]);
  }
});
test('T16.10: 낮춘 문턱이면 위반 1건 이상, 문구 고정', () => {
  const { violations } = runScenario(steady, { commit: 'abcdef1', thresholds: { 'load.first_frame_p95': { max: 1 } } });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /^steady30: load\.first_frame_p95: .* > max 1$/);
});
test('T16.10: 문턱 주입이 slow_link 는 면제', () => {
  const { violations } = runScenario(slow, { commit: 'abcdef1', thresholds: { 'load.first_frame_p95': { max: 1 } } });
  assert.deepEqual(violations, []);
});
test('T16.10: 서버 샘플 시계가 끊기면 샘플 부족 위반', () => {
  const { violations, serverSamples } = runScenario(steady, { commit: 'abcdef1', statsClock: { now: () => 0 } });
  assert.equal(serverSamples.length, 0);
  assert.deepEqual(violations, ['steady30: 0 server samples, expected 60']);
});
test('T16.10: main 은 위반이 있으면 종료 코드 1, 없으면 0', () => {
  const quiet = console.error; const log = console.log;
  console.error = () => {}; console.log = () => {};
  try {
    assert.equal(main(mkdtempSync(join(tmpdir(), 'load-')), { commit: 'abcdef1', thresholds: { 'load.first_frame_p95': { max: 1 } } }), 1);
    assert.equal(main(mkdtempSync(join(tmpdir(), 'load-')), { commit: 'abcdef1' }), 0);
  } finally { console.error = quiet; console.log = log; }
});
