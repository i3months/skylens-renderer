// b5_measure 의 --only 검증과 열 머리 단위 표기 시험(느린 측정 없음).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOnly, summarize, formatB5, B5_OPTIONS } from './b5_measure.mjs';

test('parseOnly: 정상 이름은 통과', () => {
  assert.deepEqual(parseOnly('lowNoise:1,hill:1/0.015'), ['lowNoise:1', 'hill:1/0.015']);
  assert.equal(parseOnly(null), null);
});

test('parseOnly: 오타·빈 값은 throw', () => {
  assert.throws(() => parseOnly('lowNoize:1'), /알 수 없는 이름/);
  assert.throws(() => parseOnly('lowNoise:1,nope'), /nope/);
  assert.throws(() => parseOnly(''), /비어/);
  assert.throws(() => parseOnly('  '), /비어/);
  assert.throws(() => parseOnly('lowNoise:1,'), /빈 이름/);
});

function level(stride) {
  return { stride, ssimMin8: 0.99, meshRawBytes: 10, heightOnlyRawBytes: 5, maxErrorM: 0.3 };
}
function synth() {
  const opts = {};
  for (const k of Object.keys(B5_OPTIONS)) opts[k] = { levels: [level(1), level(2), level(2), level(4)] };
  return {
    options: B5_OPTIONS, ssimMin: 0.95, initialLimitBytes: 1000,
    results: [
      { dem: 'lowNoise:1', group: 'lowNoise', options: opts },
      { dem: 'lowNoise2m:1', group: 'lowNoise2m', cellM: 2, options: opts },
    ],
  };
}

test('summarize: cellM 포함(없으면 그룹 규칙으로 보충)', () => {
  const rows = summarize(synth());
  assert.equal(rows.find((r) => r.group === 'lowNoise').cellM, 1);
  assert.equal(rows.find((r) => r.group === 'lowNoise2m').cellM, 2);
});

test('summarize: cellM 없는 lowNoise2m 행은 그룹 규칙으로 2 를 채운다', () => {
  const s = synth();
  s.results = [{ dem: 'lowNoise2m:2', group: 'lowNoise2m', options: s.results[0].options }];
  const rows = summarize(s);
  assert.ok(rows.length >= 1);
  for (const r of rows) {
    assert.equal(r.group, 'lowNoise2m');
    assert.equal(r.cellM, 2);
  }
});

test('formatB5: 열 머리에 간격(셀)·cellM 표기', () => {
  const out = formatB5(synth());
  assert.match(out, /간격\(셀\) LOD0\.\.3/);
  assert.match(out, /cellM\(m\)/);
  assert.match(out, /lowNoise2m \| i \| 1 \| 2 \|/);
  assert.match(out, /cellM 2 m/);
});
