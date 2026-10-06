import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS, runScenario } from './run.mjs';
import { validateScenario } from '../../../contracts/load/index.mjs';

test('T16.10: 시나리오 3종 유효, 30 클라이언트', () => {
  assert.equal(SCENARIOS.length, 3);
  for (const s of SCENARIOS) { assert.deepEqual(validateScenario(s), []); assert.equal(s.clients, 30); }
});
test('T16.10: 시나리오별 실행이 위반 0·결과 유효, 30개 기록', () => {
  for (const s of SCENARIOS) {
    const { result, violations } = runScenario(s, 'abcdef1');
    assert.deepEqual(violations, [], s.name);
    assert.equal(result.perClient.length, 30);
    assert.equal(result.records.length, 3);
  }
});
