// 기존 동작 대조표(cases.mjs)를 서버 수준 기계에 먹여 기대와 맞는지 본다(T10.10).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createLevelMachine } from '../state/index.mjs';
import { CASES, ESTIMATED } from './cases.mjs';

const sourced = CASES.filter((c) => c.source !== ESTIMATED);
const estimated = CASES.filter((c) => c.source === ESTIMATED);

function run(c) {
  const m = createLevelMachine();
  for (const [seg, level] of c.arrivals) m.arrive(seg, level);
  for (const [key, want] of Object.entries(c.expect)) {
    const s = m.snapshot(Number(key));
    assert.deepEqual(
      { level: s.level, final: s.final, missing: s.missing },
      want,
      `${c.name} / 구간 ${key}`,
    );
  }
}

describe('대조표 모양', () => {
  test('사례는 12건 이상이고 출처 있는 사례가 12건 이상이다', () => {
    assert.ok(CASES.length >= 12, `전체 ${CASES.length}`);
    assert.ok(sourced.length >= 12, `출처 있음 ${sourced.length}`);
  });

  test('모든 사례에 이름·출처·도착·기대가 있고 이름이 겹치지 않는다', () => {
    const names = new Set();
    for (const c of CASES) {
      assert.equal(typeof c.name, 'string');
      assert.ok(c.name.length > 0);
      assert.ok(!names.has(c.name), `이름 중복: ${c.name}`);
      names.add(c.name);
      assert.equal(typeof c.source, 'string');
      assert.ok(c.source.length > 0);
      assert.ok(Array.isArray(c.arrivals));
      for (const a of c.arrivals) assert.ok(Array.isArray(a) && a.length === 2);
      assert.ok(Object.keys(c.expect).length > 0, `${c.name}: 기대 없음`);
    }
  });

  test('출처 있는 사례는 파일:줄 꼴의 출처를 적는다', () => {
    for (const c of sourced) assert.match(c.source, /[\w./-]+\.md:\d+/, c.name);
  });

  test('요구된 유형(순서·건너뛰기·추월·중복·구간 독립·도착 전 없음)이 출처 있는 사례에 모두 있다', () => {
    const has = (pred) => sourced.some(pred);
    const one = (c, seq) => JSON.stringify(c.arrivals) === JSON.stringify(seq);
    assert.ok(has((c) => one(c, [[0, 0], [0, 1], [0, 2], [0, 3]])), '순서 도착');
    assert.ok(has((c) => one(c, [[0, 0], [0, 3]])), '건너뛰기 0→3');
    assert.ok(has((c) => one(c, [[0, 3], [0, 1]])), '추월 3→1');
    assert.ok(has((c) => one(c, [[0, 2], [0, 2]])), '같은 수준 중복');
    assert.ok(has((c) => new Set(c.arrivals.map((a) => a[0])).size > 1), '구간 독립');
    assert.ok(has((c) => c.arrivals.length === 0 && Object.values(c.expect).every((e) => e.missing)), '도착 전 없음');
  });
});

describe('출처 있는 사례: 서버 기계가 기존 동작과 일치', () => {
  for (const c of sourced) test(c.name, () => run(c));
});

describe('추정 사례: 서버 기계가 추정 기대와 일치', () => {
  for (const c of estimated) test(c.name, () => run(c));
});
