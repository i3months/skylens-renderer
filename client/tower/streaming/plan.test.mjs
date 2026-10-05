// planRequests 시험: 손으로 계산한 사례 + 무작위 불변식.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planRequests, tileKey } from './plan.mjs';

const T = (tx, ty) => ({ tx, ty });
const S = (...ts) => new Set(ts.map(([x, y]) => tileKey(x, y)));
const ids = (a) => a.map((t) => `${t.tx},${t.ty}`);
const base = { maxInflight: 2, retainMargin: 1, maxHeld: 10 };
const run = (o) => planRequests({ needed: [], held: new Set(), inflight: new Set(), opts: base, center: [0, 0], ...o });

test('빈 입력', () => {
  const r = run({});
  assert.deepEqual(r.plan, { needed: [], request: [], cancel: [], evict: [], deferred: [] });
  assert.equal(r.held.size, 0);
  assert.equal(r.inflight.size, 0);
});

test('전부 held 이면 요청 없음', () => {
  const r = run({ needed: [T(0, 0), T(1, 0)], held: S([0, 0], [1, 0]) });
  assert.deepEqual(r.plan.request, []);
  assert.deepEqual(r.plan.deferred, []);
  assert.deepEqual([...r.held].sort(), ['0,0', '1,0']);
  assert.equal(r.inflight.size, 0);
});

test('maxInflight 가 차면 나머지는 deferred (needed 순서)', () => {
  const r = run({ needed: [T(3, 0), T(1, 0), T(2, 0), T(0, 0)] });
  assert.deepEqual(ids(r.plan.request), ['3,0', '1,0']);
  assert.deepEqual(ids(r.plan.deferred), ['2,0', '0,0']);
  assert.equal(r.inflight.size, 2);
});

test('이미 inflight 인 것은 자리를 차지하고 다시 요청하지 않는다', () => {
  const r = run({ needed: [T(0, 0), T(1, 0), T(2, 0)], inflight: S([0, 0]) });
  assert.deepEqual(ids(r.plan.request), ['1,0']);
  assert.deepEqual(ids(r.plan.deferred), ['2,0']);
  assert.deepEqual([...r.inflight].sort(), ['0,0', '1,0']);
});

test('취소: retain 밖 inflight 를 빼고, 빈 자리가 요청에 반영된다', () => {
  const r = run({ needed: [T(0, 0)], inflight: S([5, 5]), opts: { ...base, maxInflight: 1 } });
  assert.deepEqual(ids(r.plan.cancel), ['5,5']);
  assert.deepEqual(ids(r.plan.request), ['0,0']);
  assert.deepEqual([...r.inflight], ['0,0']);
});

test('팽창 경계: 체비쇼프 1 안은 유지, 밖은 evict/cancel', () => {
  const r = run({ needed: [T(0, 0)], held: S([1, 1], [2, 0], [-1, -1], [0, -2]), inflight: S([-1, 0], [0, 2]) });
  assert.deepEqual(ids(r.plan.evict), ['0,-2', '2,0']);
  assert.deepEqual([...r.held].sort(), ['-1,-1', '1,1']);
  assert.deepEqual(ids(r.plan.cancel), ['0,2']);
  assert.ok(r.inflight.has('-1,0'));
});

test('팽창 0 이면 needed 밖은 모두 evict', () => {
  const r = run({ needed: [T(0, 0)], held: S([0, 0], [1, 1]), opts: { ...base, retainMargin: 0 } });
  assert.deepEqual(ids(r.plan.evict), ['1,1']);
});

test('maxHeld 초과: retain 안 비 needed 를 center 에서 먼 순으로 evict', () => {
  // 타일 중심 거리(center=[100,10]): (1,0)=22.4, (0,0)=71.5, (1,1)=86.1, (0,1)=109.6
  const r = run({
    needed: [T(0, 0)], held: S([0, 0], [1, 0], [0, 1], [1, 1]), center: [100, 10],
    opts: { ...base, maxHeld: 2 },
  });
  assert.deepEqual(ids(r.plan.evict), ['0,1', '1,1']);
  assert.deepEqual([...r.held].sort(), ['0,0', '1,0']);
});

test('maxHeld 초과 동률은 (tx,ty) 사전순으로 먼저 evict', () => {
  // center=[32,32]: (1,0)·(0,1) 모두 64 m
  const r = run({
    needed: [T(0, 0)], held: S([0, 0], [1, 0], [0, 1]), center: [32, 32],
    opts: { ...base, maxHeld: 2 },
  });
  assert.deepEqual(ids(r.plan.evict), ['0,1']);
});

test('needed 는 maxHeld 를 넘어도 evict 하지 않는다', () => {
  const r = run({
    needed: [T(0, 0), T(1, 0), T(2, 0)], held: S([0, 0], [1, 0], [2, 0], [3, 0]),
    opts: { ...base, maxHeld: 1 },
  });
  assert.deepEqual(ids(r.plan.evict), ['3,0']);
  assert.equal(r.held.size, 3);
});

test('중복 needed 는 한 번만', () => {
  const r = run({ needed: [T(0, 0), T(0, 0), T(1, 0)] });
  assert.deepEqual(ids(r.plan.needed), ['0,0', '1,0']);
  assert.deepEqual(ids(r.plan.request), ['0,0', '1,0']);
});

test('입력은 바뀌지 않고 출력 집합은 새것', () => {
  const held = S([0, 0], [9, 9]);
  const inflight = S([8, 8]);
  const r = run({ needed: [T(0, 0), T(1, 0)], held, inflight });
  assert.deepEqual([...held], ['0,0', '9,9']);
  assert.deepEqual([...inflight], ['8,8']);
  assert.notEqual(r.held, held);
  assert.notEqual(r.inflight, inflight);
});

test('음수 좌표 사전순 정렬은 수치 기준', () => {
  const r = run({ needed: [T(0, 0)], held: S([-10, 0], [-2, 0], [-3, 5]), opts: { ...base, retainMargin: 0 } });
  assert.deepEqual(ids(r.plan.evict), ['-10,0', '-3,5', '-2,0']);
});

test('형식 위반', () => {
  assert.throws(() => run({ needed: 'x' }), TypeError);
  assert.throws(() => run({ held: [] }), TypeError);
  assert.throws(() => run({ center: [0] }), TypeError);
  for (const bad of ['a,b', '1', '1,2,3', '01,2', '-0,1', '1.5,2', ' 1,2', '1,']) {
    assert.throws(() => run({ held: new Set([bad]) }), TypeError, `held ${bad}`);
    assert.throws(() => run({ inflight: new Set([bad]) }), TypeError, `inflight ${bad}`);
  }
  assert.throws(() => run({ held: new Set([5]) }), TypeError);
  assert.throws(() => run({ inflight: new Set([null]) }), TypeError);
  assert.doesNotThrow(() => run({ held: new Set(['-12,0', '0,-7']) }));
  assert.throws(() => run({ opts: { ...base, maxHeld: -1 } }), RangeError);
});

// 간단한 시드 난수(결정적).
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

test('무작위 불변식 500회', () => {
  const rnd = rng(20260101);
  const ri = (n) => Math.floor(rnd() * n);
  const sorted = (a) => a.every((t, i) => i === 0 || a[i - 1].tx < t.tx || (a[i - 1].tx === t.tx && a[i - 1].ty < t.ty));
  for (let it = 0; it < 500; it++) {
    const rt = () => T(ri(9) - 4, ri(9) - 4);
    const needed = Array.from({ length: ri(12) }, rt);
    const held = new Set(Array.from({ length: ri(25) }, () => { const t = rt(); return tileKey(t.tx, t.ty); }));
    const inflight = new Set(Array.from({ length: ri(8) }, () => { const t = rt(); return tileKey(t.tx, t.ty); }));
    const opts = { maxInflight: ri(6), retainMargin: ri(3), maxHeld: ri(20) };
    const center = [rnd() * 600 - 300, rnd() * 600 - 300];
    const h0 = [...held], i0 = [...inflight];
    const r = planRequests({ needed, held, inflight, opts, center });
    const p = r.plan;
    assert.deepEqual([...held], h0); assert.deepEqual([...inflight], i0);
    const nk = new Set(ids(p.needed));
    assert.equal(nk.size, p.needed.length, '중복 없음');
    for (const k of nk) assert.ok(r.held.has(k) || r.inflight.has(k) || ids(p.deferred).includes(k), `needed 소실 ${k}`);
    const rq = new Set(ids(p.request));
    assert.equal(rq.size, p.request.length);
    for (const k of ids(p.deferred)) assert.ok(!rq.has(k), 'request∩deferred');
    for (const k of ids(p.evict)) { assert.ok(!nk.has(k), 'evict∩needed'); assert.ok(!r.held.has(k)); }
    for (const k of ids(p.cancel)) assert.ok(!r.inflight.has(k));
    assert.ok(r.inflight.size <= opts.maxInflight || p.request.length === 0, 'inflight ≤ maxInflight');
    for (const k of ids(p.request)) assert.ok(!held.has(k) && !inflight.has(k), "request 는 새 타일");
    for (const k of ids(p.deferred)) assert.ok(!held.has(k) && !inflight.has(k) && !r.inflight.has(k), "deferred 는 새 타일");
    assert.ok(sorted(p.cancel) && sorted(p.evict), '사전순');
    const keepNeededHeld = [...nk].filter((k) => held.has(k)).length;
    assert.ok(r.held.size <= Math.max(opts.maxHeld, keepNeededHeld), 'maxHeld');
  }
});
