import test from 'node:test';
import assert from 'node:assert/strict';
import { validateScenario, validateResult } from './index.mjs';

const path = [{ t: 0, e: 0, n: 0, u: 100 }, { t: 10, e: 50, n: 0, u: 100 }];
const base = { name: 'steady30', kind: 'steady', clients: 30, durationS: 60, path };
const burst = { ...base, name: 'b', kind: 'burst', burstLevels: 4 };
const slow = { ...base, name: 's', kind: 'slow_link', linkBytesPerS: 125000 };
const rec = { metric: 'load.first_frame_p95', value: 2100, unit: 'ms', device: 'headless', method: 'sim', commit: 'abcdef1' };
const wp = (o) => ({ ...path[1], ...o });

test('T16.0: 정상 시나리오 3종·경계 양성', () => {
  assert.deepEqual(validateScenario(base), []);
  assert.deepEqual(validateScenario(burst), []);
  assert.deepEqual(validateScenario(slow), []);
  assert.deepEqual(validateScenario({ ...burst, burstLevels: 1 }), []);
  assert.deepEqual(validateScenario({ ...base, durationS: 10 }), []); // 끝 t = durationS
  assert.deepEqual(validateScenario({ ...base, clients: 1 }), []);
});

test('T16.0: 시나리오 음성 — 입력마다 정확한 오류', () => {
  const cases = [
    [null, ['scenario must be an object']], [[], ['scenario must be an object']],
    [{ ...base, name: undefined }, ['bad name']], [{ ...base, name: 'Abc' }, ['bad name']], [{ ...base, name: 'A b' }, ['bad name']],
    [{ ...base, kind: 'x' }, ['bad kind']],
    [{ ...base, clients: 0 }, ['bad clients']], [{ ...base, clients: 31 }, ['bad clients']], [{ ...base, clients: 1.5 }, ['bad clients']],
    [{ ...base, durationS: 0 }, ['bad durationS', 'path ends after durationS']], [{ ...base, durationS: Infinity }, ['bad durationS']],
    [{ ...base, extra: 1 }, ['unknown field extra']],
    [{ ...base, path: [path[0]] }, ['path needs >= 2 waypoints']],
    [{ ...base, path: undefined }, ['path needs >= 2 waypoints']],
    [{ ...base, path: [path[0], wp({ t: 0 })] }, ['path[1].t not increasing']],
    [{ ...base, path: [path[0], wp({ e: NaN })] }, ['path[1] needs finite t,e,n,u']],
    [{ ...base, path: [path[0], wp({ n: NaN })] }, ['path[1] needs finite t,e,n,u']],
    [{ ...base, path: [path[0], wp({ u: NaN })] }, ['path[1] needs finite t,e,n,u']],
    [{ ...base, path: [path[0], wp({ t: NaN })] }, ['path[1] needs finite t,e,n,u']],
    [{ ...base, path: [{ ...path[0], t: 100 }, wp({ t: 200 })] }, ['path[0].t must be 0', 'path ends after durationS']],
    [{ ...base, path: [{ ...path[0], t: -5 }, wp({ t: 10 })] }, ['path[0].t must be 0']],
    [{ ...base, path: [path[0], wp({ t: 61 })] }, ['path ends after durationS']],
    [{ ...base, path: [path[0], , path[1]] }, ['path[1] needs finite t,e,n,u']],
    [{ ...burst, burstLevels: undefined }, ['burst needs burstLevels']], [{ ...burst, burstLevels: 0 }, ['burst needs burstLevels']],
    [{ ...burst, burstLevels: 1.5 }, ['burst needs burstLevels']], [{ ...burst, burstLevels: 5 }, ['burst needs burstLevels']],
    [{ ...base, burstLevels: 2 }, ['burstLevels only for burst']],
    [{ ...slow, linkBytesPerS: undefined }, ['slow_link needs linkBytesPerS']], [{ ...slow, linkBytesPerS: 0 }, ['slow_link needs linkBytesPerS']],
    [{ ...slow, linkBytesPerS: Infinity }, ['slow_link needs linkBytesPerS']],
    [{ ...base, linkBytesPerS: 1 }, ['linkBytesPerS only for slow_link']],
  ];
  for (const [bad, want] of cases) assert.deepEqual(validateScenario(bad), want, JSON.stringify(bad));
});

const pc = (n, f = (i) => ({})) => Array.from({ length: n }, (_, i) => ({ id: i, bytes: 10, latencyMs: [1, 2], ...f(i) }));
const sc2 = { ...base, clients: 2 };
const res = (o) => ({ scenario: base, records: [rec], perClient: pc(30), ...o });

test('T16.0: 결과 양성 — id 순서 무관', () => {
  assert.deepEqual(validateResult(res()), []);
  assert.deepEqual(validateResult(res({ perClient: pc(30).reverse() })), []);
});

test('T16.0: 결과 음성 — 입력마다 정확한 오류', () => {
  const cases = [
    [null, ['result must be an object']], [[], ['result must be an object']],
    [res({ scenario: { ...base, clients: 0 } }), ['bad clients', 'perClient length != clients']],
    [res({ records: [] }), ['records empty']],
    [res({ records: [{ ...rec, unit: 'bogus' }] }), ['records[0]: bad unit']],
    [res({ perClient: undefined }), ['perClient missing']],
    [res({ perClient: pc(29) }), ['perClient length != clients']],
    [res({ scenario: sc2, perClient: [{ id: 0, bytes: 1, latencyMs: [1] }, { id: 0, bytes: 1, latencyMs: [1] }] }), ['perClient[1] duplicate id']],
    [res({ scenario: sc2, perClient: [{ id: 0, bytes: 1, latencyMs: [1] }, { id: 9, bytes: 1, latencyMs: [1] }] }), ['perClient[1] id out of range']],
    [res({ perClient: pc(30, (i) => (i === 0 ? { id: 'a' } : {})) }), ['perClient[0] bad']],
    [res({ perClient: pc(30, (i) => (i === 0 ? { bytes: -1 } : {})) }), ['perClient[0] bad']],
    [res({ perClient: pc(30, (i) => (i === 0 ? { bytes: 1.5 } : {})) }), ['perClient[0] bad']],
    [res({ perClient: pc(30, (i) => (i === 0 ? { latencyMs: [-5] } : {})) }), ['perClient[0] bad']],
    [res({ perClient: pc(30, (i) => (i === 0 ? { latencyMs: [] } : {})) }), ['perClient[0] bad']],
    [res({ perClient: pc(30, (i) => (i === 0 ? { latencyMs: [1, NaN] } : {})) }), ['perClient[0] bad']],
    [res({ perClient: pc(30, (i) => (i === 0 ? { latencyMs: undefined } : {})) }), ['perClient[0] bad']],
    [res({ perClient: [null, ...pc(29).map((c, i) => ({ ...c, id: i + 1 }))] }), ['perClient[0] bad']],
  ];
  cases.forEach(([bad, want], i) => assert.deepEqual(validateResult(bad), want, `result case #${i}`));
});

test('T16.0: 무효 원소가 매우 많아도 던지지 않는다', () => {
  const big = Array.from({ length: 300000 }, () => null);
  const e = validateScenario({ ...base, path: big });
  assert.equal(e.length, 300000); // 원소마다 오류 하나, 시작·끝 검사는 객체가 아니라 건너뜀
});

const holey = (arr, i) => { const a = [...arr]; delete a[i]; return a; };
const one = (o) => pc(30, (i) => (i === 0 ? o : {}));

test('F-519: sparse arrays and unknown fields are violations', () => {
  const cases = [
    [res({ perClient: holey(pc(30), 5) }), ['perClient[5] missing']],
    [res({ perClient: holey(pc(30), 0) }), ['perClient[0] missing']],
    [res({ perClient: one({ latencyMs: [1, , 2] }) }), ['perClient[0] bad']],
    [res({ records: [rec, , rec] }), ['records[1] missing']],
    [res({ records: holey([rec, rec], 0) }), ['records[0] missing']],
    [res({ extra: 1 }), ['unknown field extra']],
    [res({ perClient: one({ x: 1 }) }), ['perClient[0] unknown field x']],
    [res({ perClient: one({ x: 1, bytes: -1 }) }), ['perClient[0] unknown field x', 'perClient[0] bad']],
    [res({ perClient: one({ x: 1, y: 2 }) }), ['perClient[0] unknown field x', 'perClient[0] unknown field y']],
  ];
  cases.forEach(([bad, want], i) => assert.deepEqual(validateResult(bad), want, `result case #${i}`));
  assert.deepEqual(validateScenario({ ...base, path: [path[0], { ...path[1], x: 1 }] }), ['path[1] unknown field x']);
  assert.deepEqual(validateScenario({ ...base, path: [{ ...path[0], x: 1 }, path[1]] }), ['path[0] unknown field x']);
  assert.deepEqual(validateScenario({ ...base, path: [{ ...path[0], t: NaN }, path[1]] }), ['path[0] needs finite t,e,n,u']);
  assert.deepEqual(validateScenario({ ...base, path: [{ ...path[0], t: NaN }, wp({ t: 5 })] }), ['path[0] needs finite t,e,n,u']);
});

test('F-520: boundary values with exact messages', () => {
  const cases = [
    [res({ perClient: one({ id: 30 }) }), ['perClient[0] id out of range']],
    [res({ perClient: one({ id: 29 }) }), ['perClient[29] duplicate id']],
    [res({ perClient: one({ id: -1 }) }), ['perClient[0] id out of range']],
    [res({ perClient: one({ id: 1.5 }) }), ['perClient[0] bad']],
    [res({ perClient: one({ latencyMs: [Infinity] }) }), ['perClient[0] bad']],
    [res({ perClient: one({ latencyMs: [1, -0.5] }) }), ['perClient[0] bad']],
    [res({ records: undefined }), ['records empty']],
    [res({ records: {} }), ['records empty']],
    [res({ records: [rec, { ...rec, unit: 'bogus' }] }), ['records[1]: bad unit']],
    [res({ scenario: { ...base, name: 'ab-' } }), ['bad name']],
    [res({ scenario: { ...base, name: '' } }), ['bad name']],
  ];
  cases.forEach(([bad, want], i) => assert.deepEqual(validateResult(bad), want, `result case #${i}`));
  assert.deepEqual(validateScenario({ ...base, name: 'ab-' }), ['bad name']);
  assert.deepEqual(validateScenario({ ...base, name: '' }), ['bad name']);
  assert.deepEqual(validateScenario({ ...base, name: 'a_9' }), []);
  // Positive boundaries: zero bytes and zero latency are valid.
  assert.deepEqual(validateResult(res({ perClient: one({ bytes: 0 }) })), []);
  assert.deepEqual(validateResult(res({ perClient: one({ latencyMs: [0] }) })), []);
  assert.deepEqual(validateResult(res({ perClient: one({ id: 0, bytes: 0, latencyMs: [0, 0] }) })), []);
});

test('F-520: very large invalid perClient/records through validateResult do not throw', () => {
  const N = 300000;
  const e1 = validateResult(res({ perClient: Array.from({ length: N }, () => null) }));
  assert.equal(e1.length, N + 1); // length mismatch plus one 'bad' per element
  assert.equal(e1[0], 'perClient length != clients');
  assert.equal(e1[1], 'perClient[0] bad');
  assert.equal(e1[N], `perClient[${N - 1}] bad`);
  const e2 = validateResult(res({ records: Array.from({ length: N }, () => null) }));
  assert.equal(e2.length, N);
  assert.equal(e2[0], 'records[0]: record must be an object');
  assert.equal(e2[N - 1], `records[${N - 1}]: record must be an object`);
  const e3 = validateResult(res({ perClient: new Array(N) }));
  assert.equal(e3.length, N + 1);
  assert.equal(e3[N], `perClient[${N - 1}] missing`);
  const e4 = validateResult(res({ records: new Array(N) }));
  assert.equal(e4.length, N);
  assert.equal(e4[N - 1], `records[${N - 1}] missing`);
});

test('T16.0: 큰 배열에서도 오류가 스택을 넘기지 않고 전부 모인다', () => {
  const N = 300000;
  const bigPath = Array.from({ length: N }, () => ({ t: 0, e: 0, n: 0, u: 0 }));
  const bigPc = Array.from({ length: N }, () => null);
  const errs = validateResult({ scenario: { ...base, path: bigPath }, records: [rec], perClient: bigPc });
  // path[0] ok; path[1..N-1] not increasing; perClient: 1 length error + N bad entries
  assert.equal(errs.length, (N - 1) + 1 + N);
  assert.equal(errs[0], 'path[1].t not increasing');
  assert.equal(validateScenario({ ...base, path: bigPath }).length, N - 1);
});
