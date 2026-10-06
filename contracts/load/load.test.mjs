import test from 'node:test';
import assert from 'node:assert/strict';
import { validateScenario, validateResult } from './index.mjs';

const path = [{ t: 0, e: 0, n: 0, u: 100 }, { t: 10, e: 50, n: 0, u: 100 }];
const base = { name: 'steady30', kind: 'steady', clients: 30, durationS: 60, path };
const rec = { metric: 'load.first_frame_p95', value: 2.1, unit: 'ms', device: 'headless', method: 'sim', commit: 'abcdef1' };

test('T16.0: 정상 시나리오 3종은 통과', () => {
  assert.deepEqual(validateScenario(base), []);
  assert.deepEqual(validateScenario({ ...base, name: 'b', kind: 'burst', burstLevels: 4 }), []);
  assert.deepEqual(validateScenario({ ...base, name: 's', kind: 'slow_link', linkBytesPerS: 125000 }), []);
});

test('T16.0: 시나리오 음성 — 접속 수·경로·종류별 필드', () => {
  for (const bad of [
    { ...base, clients: 0 }, { ...base, clients: 31 }, { ...base, clients: 1.5 },
    { ...base, durationS: 0 }, { ...base, kind: 'x' }, { ...base, name: 'A b' },
    { ...base, path: [path[0]] }, { ...base, path: [path[0], { ...path[1], t: 0 }] },
    { ...base, path: [path[0], { ...path[1], e: NaN }] },
    { ...base, kind: 'burst' }, { ...base, kind: 'slow_link' },
    { ...base, burstLevels: 2 }, { ...base, linkBytesPerS: 1 }, { ...base, extra: 1 }, null, [],
  ]) assert.notDeepEqual(validateScenario(bad), [], JSON.stringify(bad));
});

test('T16.0: 결과 — metrics 스키마 재사용·클라이언트별 기록 수', () => {
  const pc = Array.from({ length: 30 }, (_, i) => ({ id: i, bytes: 10, latencyMs: [1, 2] }));
  assert.deepEqual(validateResult({ scenario: base, records: [rec], perClient: pc }), []);
  assert.notDeepEqual(validateResult({ scenario: base, records: [rec], perClient: pc.slice(1) }), []);
  assert.notDeepEqual(validateResult({ scenario: base, records: [{ ...rec, unit: 'bogus' }], perClient: pc }), []);
  assert.notDeepEqual(validateResult({ scenario: base, records: [], perClient: pc }), []);
  assert.notDeepEqual(validateResult({ scenario: base, records: [rec], perClient: [...pc.slice(1), { id: 0, bytes: -1, latencyMs: [] }] }), []);
});
