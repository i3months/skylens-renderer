// 기존 동작 대조표(cases.mjs)를 서버 수준 기계에 먹여 기대와 맞는지 본다(T10.10).
// T10.10L: 모든 사례에 원본 코드 줄 출처(origin)를 달고, 같은 줄을 옮긴 기준 모형(origin.mjs)과도 대조한다.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createLevelMachine } from '../state/index.mjs';
import { CASES, ESTIMATED, MISMATCHES, NOT_MODELED } from './cases.mjs';
import { replayOrigin, alphaForLevel, toOrigin, ORIGIN_COMMIT } from './origin.mjs';

const sourced = CASES.filter((c) => c.source !== ESTIMATED);
const estimated = CASES.filter((c) => c.source === ESTIMATED);
const ORIGIN_LINE = /[\w.]+\.ts:L\d+(-L\d+)?/;

function feed(c) {
  const m = createLevelMachine({ recordHistory: true });
  for (const id of c.registered || []) m.expect(id);
  for (const [seg, level] of c.arrivals) m.arrive(seg, level);
  return m;
}

function run(c) {
  const m = feed(c);
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
  test('사례는 손으로 센 개수와 같다: 전체 24건, 출처 있음 24건, 추정 0건', () => {
    // T10.10L 에서 추정 4건은 원본 코드 줄로 출처를 바꿨고 UNVERIFIED 항목용 사례 4건을 더했다.
    // 개수를 바꾸려면 이 숫자와 cases.mjs 를 함께 고친다.
    assert.equal(CASES.length, 24);
    assert.equal(sourced.length, 24);
    assert.equal(estimated.length, 0);
  });

  test('모든 사례에 이름·출처·원본 줄·도착·기대가 있고 이름이 겹치지 않는다', () => {
    const names = new Set();
    for (const c of CASES) {
      assert.equal(typeof c.name, 'string');
      assert.ok(c.name.length > 0);
      assert.ok(!names.has(c.name), `이름 중복: ${c.name}`);
      names.add(c.name);
      assert.equal(typeof c.source, 'string');
      assert.ok(c.source.length > 0);
      assert.equal(typeof c.origin, 'string', `${c.name}: origin 없음`);
      assert.ok(Array.isArray(c.arrivals));
      for (const a of c.arrivals) assert.ok(Array.isArray(a) && a.length === 2);
      assert.ok(Object.keys(c.expect).length > 0, `${c.name}: 기대 없음`);
    }
  });

  test('출처 있는 사례는 파일:줄 꼴의 출처를 적는다(문서 .md:줄 또는 원본 .ts:L줄)', () => {
    for (const c of sourced) assert.match(c.source, /[\w./-]+\.md:\d+|[\w.]+\.ts:L\d+/, c.name);
  });

  test(`모든 사례의 origin 은 원본(${ORIGIN_COMMIT}) 코드 줄을 적는다`, () => {
    for (const c of CASES) {
      assert.match(c.origin, ORIGIN_LINE, c.name);
      assert.ok(c.origin.includes(ORIGIN_COMMIT), `${c.name}: 커밋 표기 없음`);
    }
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

describe('원본 기준 모형(splatScene.ts noteChunk·splatReveal.ts noteArrival 옮김)이 손으로 적은 기대와 같다', () => {
  for (const c of CASES) {
    test(c.name, () => {
      const o = replayOrigin(c.arrivals);
      for (const [key, want] of Object.entries(c.expect)) {
        assert.deepEqual(o.state(Number(key)), want, `구간 ${key}`);
      }
      if (c.counters) assert.deepEqual({ chunks: o.chunks, refined: o.refined }, c.counters);
      for (const [key, want] of Object.entries(c.reveal || {})) {
        assert.equal(o.revealTarget(Number(key)), want, `노출 구간 ${key}`);
      }
    });
  }
});

describe('출처 있는 사례: 서버 기계가 기존 동작과 일치', () => {
  for (const c of sourced) test(c.name, () => run(c));
});

describe('원본 카운터·노출과 서버 기계 대응', () => {
  for (const c of CASES.filter((x) => x.counters)) {
    test(`카운터: ${c.name}`, () => {
      // 원본 _chunks 는 건너뛴 도착까지 센다 = 우리 history 길이(skip 포함).
      // 원본 _refined 는 수준이 오른 횟수 = 우리 history 의 replace 수.
      const h = feed(c).history();
      assert.equal(h.length, c.counters.chunks, 'chunks');
      assert.equal(h.filter((e) => e.action === 'replace').length, c.counters.refined, 'refined');
    });
  }
  // 서버에는 노출 로직이 없다. 서버 수준 → 원본 alphaForLevel(origin.mjs) 대응만 본다.
  // alphaForLevel 은 origin.mjs 의 함수라 그 값을 바꾸면 서버를 건드리지 않아도 이 묶음이 바뀐다.
  for (const c of CASES.filter((x) => x.reveal)) {
    test(`서버 수준 → 원본 alpha 대응(서버 노출 없음, origin.mjs alphaForLevel 사용): ${c.name}`, () => {
      const m = feed(c);
      for (const [key, want] of Object.entries(c.reveal)) {
        const s = m.snapshot(Number(key));
        const got = s.missing ? 0 : alphaForLevel(toOrigin(s.level), s.final);
        assert.equal(got, want, `구간 ${key}`);
      }
    });
  }
});

describe('원본과 어긋나는 점(제품 코드는 고치지 않고 기록만)', () => {
  test('불일치 기록은 2건 이상이고 모두 이름·원본 줄·우리 쪽을 적는다', () => {
    assert.ok(MISMATCHES.length >= 2);
    for (const x of MISMATCHES) {
      assert.ok(x.name && x.ours, x.name);
      assert.match(x.origin, ORIGIN_LINE, x.name);
    }
  });

  for (const x of MISMATCHES) test.todo(`${x.name} — 원본 ${x.origin} / 우리 ${x.ours}`);

  test('현재 동작 고정: final 판정 — 원본 3칸(top 3)이면 우리 수준 2 가 final, 우리 기계는 아니다', () => {
    const x = MISMATCHES.find((m) => m.ourLevel !== undefined);
    const arrivals = [[0, x.ourLevel]];
    // 4칸 가정(top 4)에서는 원본도 final 아님, 알파 0.95. 기록된 대조표의 기대다.
    const four = replayOrigin(arrivals);
    assert.equal(four.state(0).final, false);
    assert.equal(four.revealTarget(0), 0.95);
    // 원본 기본 3칸(config.ts:L97)이면 final, 알파 1.0.
    const three = replayOrigin(arrivals, { top: 3 });
    assert.equal(three.state(0).final, true);
    assert.equal(three.revealTarget(0), 1.0);
    // 우리 기계는 사다리 칸 수와 무관하게 수준 3 만 final.
    const m = createLevelMachine();
    m.arrive(0, x.ourLevel);
    assert.equal(m.snapshot(0).final, false);
  });

  const limit = MISMATCHES.find((m) => m.segmentId !== undefined);
  test(`현재 동작 고정: ${limit.name}`, () => {
    // 원본은 구간 번호 상한이 없다(segmenter.ts:L134-L137, Math.floor 만). 모형에 상한을 넣으면 아래가 실패한다.
    for (const id of [limit.segmentId, 2 ** 31, Number.MAX_SAFE_INTEGER]) {
      const o = replayOrigin([[id, 0], [id, 1]]);
      assert.deepEqual(o.state(id), { level: 1, final: false, missing: false }, `구간 ${id}`);
      assert.throws(() => createLevelMachine().arrive(id, 0), RangeError, `우리 기계 구간 ${id}`);
    }
    // 상한 바로 아래는 우리도 받는다(경계가 2^30 임을 고정).
    assert.doesNotThrow(() => createLevelMachine().arrive(limit.segmentId - 1, 0));
  });
});

describe('원본 모형이 옮기지 않은 것', () => {
  test('슬랩 접힘·float32 저장 생략이 이름 붙여 기록돼 있다', () => {
    assert.equal(NOT_MODELED.length, 2);
    assert.ok(NOT_MODELED.some((x) => x.name.includes('슬랩 접힘')));
    assert.ok(NOT_MODELED.some((x) => x.name.includes('float32')));
    for (const x of NOT_MODELED) assert.match(x.origin, ORIGIN_LINE, x.name);
  });
});
