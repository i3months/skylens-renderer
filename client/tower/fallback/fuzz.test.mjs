// 폴백 퍼즈 시험: 고정 시드 200 개의 무작위 입력(NaN·Infinity·±1e308·문자열·null·희소 배열·중복 id·거대 크기)을 넣는다.
// 불변식: (1) TypeError/RangeError 외의 예외가 없다 (2) 던진 뒤 상태(counts·frame)가 그대로다
// (3) 통과한 입력에서는 frame 의 모든 x·y 가 유한하다. 실패하면 메시지에 시드가 찍힌다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTowerFallback } from './index.mjs';

const SEEDS = Array.from({ length: 200 }, (_, i) => 7001 + i * 13);
const SIZE = { width: 800, height: 600 };

// mulberry32: 32 비트 시드 하나로 결정적 난수열을 만든다.
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
  };
}

const WEIRD = [NaN, Infinity, -Infinity, 1e308, -1e308, 3.5e38, -3.5e38, 1e6 + 1, -1e6 - 1, 0, -0, '1', '', null, undefined, true, {}, [], [1], () => 0, Symbol('s'), 10n];

// 성분: 대부분 정상 값, 가끔 이상한 값
function comp(r, pBad) { return r.next() < pBad ? r.pick(WEIRD) : r.range(-1e4, 1e4); }
function enu(r, pBad) {
  const v = [comp(r, pBad), comp(r, pBad), comp(r, pBad)];
  if (r.next() < pBad / 2) v.length = r.pick([0, 1, 2, 4]);
  if (r.next() < pBad / 2) delete v[r.int(0, 2)]; // 희소 칸
  return v;
}
function id(r, i, pBad) {
  const x = r.next();
  if (x < pBad) return r.pick(WEIRD);
  if (x < pBad * 1.5) return 'dup'; // 중복 id
  if (x < pBad * 1.8) return 'x'.repeat(r.pick([65, 100000])); // 거대 길이
  return `i${i}`;
}
function genDrones(r, pBad) {
  const n = r.next() < 0.05 ? r.pick([257, 300]) : r.int(0, 10); // 한도 초과
  const list = Array.from({ length: n }, (_, i) => {
    const d = { id: id(r, i, pBad), enu: enu(r, pBad) };
    if (r.next() < 0.5) d.yaw = comp(r, pBad);
    if (r.next() < pBad / 3) d.extra = 1; // 알 수 없는 키
    return d;
  });
  if (r.next() < pBad / 2) delete list[r.int(0, Math.max(0, n - 1))];
  return r.next() < pBad / 3 ? r.pick([null, 'str', 5, {}, undefined, NaN]) : list;
}
function genDets(r, pBad) {
  const list = Array.from({ length: r.int(0, 10) }, (_, i) => {
    const d = { id: id(r, i, pBad), enu: enu(r, pBad) };
    if (r.next() < 0.5) d.kind = r.next() < pBad ? r.pick(WEIRD) : r.pick(['detection', 'alert']);
    if (r.next() < 0.5) d.confidence = r.next() < pBad ? r.pick([...WEIRD, 1.5, -0.1]) : r.next();
    return d;
  });
  return r.next() < pBad / 3 ? r.pick([null, 'str', 5, {}, undefined]) : list;
}
function genPath(r, pBad) {
  const n = r.next() < 0.05 ? r.pick([0, 1, 100001]) : r.int(2, 8); // 점 수 한도
  const points = Array.from({ length: n }, () => enu(r, pBad));
  return r.next() < pBad / 3 ? r.pick([null, 'p', 3, [], { id: 1 }]) : { id: id(r, 0, pBad), points };
}
function genSize(r, pBad) {
  const dim = () => (r.next() < pBad ? r.pick(WEIRD) : r.pick([1, 2, 800, 4096, 1e9]));
  return r.next() < pBad / 3 ? r.pick([null, 5, 'x', []]) : { width: dim(), height: dim() };
}
function genView(r, pBad) {
  const c = () => (r.next() < pBad ? r.pick(WEIRD) : r.range(-1e5, 1e5));
  return r.next() < pBad / 3 ? r.pick([5, 'v', undefined, []]) : { centerE: c(), centerN: c(), metersPerPx: r.next() < pBad ? r.pick(WEIRD) : r.range(0.01, 100) };
}
function genOpts(r, pBad) {
  const o = {};
  if (r.next() < 0.5) o.minSpanM = r.next() < pBad ? r.pick(WEIRD) : r.range(1, 500);
  if (r.next() < 0.5) o.marginPx = r.next() < pBad ? r.pick(WEIRD) : r.range(0, 50);
  if (r.next() < pBad / 3) o.unknown = 1;
  return r.next() < pBad / 4 ? r.pick([5, 'o', []]) : o;
}

function isAllowed(e) { return e instanceof TypeError || e instanceof RangeError; }

// frame 의 모든 x·y 가 유한한지 본다.
function assertFinite(out) {
  const chk = (v, name) => assert.ok(Number.isFinite(v), `${name} 비유한 ${v}`);
  if (out.view) { chk(out.view.centerE, 'view.centerE'); chk(out.view.centerN, 'view.centerN'); assert.ok(out.view.metersPerPx > 0 && Number.isFinite(out.view.metersPerPx)); }
  for (const m of [...out.drones, ...out.detections]) { chk(m.x, `${m.id}.x`); chk(m.y, `${m.id}.y`); }
  for (const p of out.paths) for (const q of p.polyline) { chk(q.x, `${p.id}.x`); chk(q.y, `${p.id}.y`); }
}

// 입력 호출 하나: 던지면 허용 예외인지, 상태가 그대로인지 본다. 통과했는지를 돌려준다.
function attempt(fb, call) {
  const before = { counts: fb.counts(), frame: fb.frame(SIZE), mode: fb.mode() };
  try { call(); } catch (e) {
    assert.ok(isAllowed(e), `TypeError/RangeError 외의 예외: ${e && e.constructor && e.constructor.name}: ${e && e.message}`);
    assert.deepStrictEqual(fb.counts(), before.counts, '던진 뒤 counts 가 변했다');
    assert.deepStrictEqual(fb.frame(SIZE), before.frame, '던진 뒤 frame 이 변했다');
    assert.equal(fb.mode(), before.mode, '던진 뒤 mode 가 변했다');
    return false;
  }
  return true;
}

function run(seed, body) {
  try { body(rng(seed), seed); } catch (e) {
    if (e && typeof e === 'object') e.message = `시드 ${seed}: ${e.message}`;
    throw e;
  }
}

test('퍼즈: 고정 시드 200 개 — 허용 예외만, 던진 뒤 상태 불변, 통과 시 frame 유한', () => {
  assert.equal(SEEDS.length, 200);
  let accepted = 0, rejected = 0;
  for (const seed of SEEDS) run(seed, (r) => {
    // 생성자 옵션도 퍼즈한다
    let fb;
    try { fb = createTowerFallback(genOpts(r, 0.4)); } catch (e) { assert.ok(isAllowed(e), `생성자 예외: ${e}`); rejected += 1; fb = createTowerFallback(); }
    // 바탕이 되는 정상 상태
    fb.setDrones([{ id: 'g0', enu: [1, 2, 3] }]);
    fb.setDetections([{ id: 'k0', enu: [7, 8, 9], kind: 'alert', confidence: 0.5 }]);
    fb.setPath({ id: 'gp', points: [[0, 0, 0], [10, 10, 10]] });
    fb.setAvailable(r.next() < 0.7 ? false : true);
    for (let step = 0; step < 6; step += 1) {
      const pBad = r.pick([0.02, 0.1, 0.4]);
      const calls = [
        () => fb.setDrones(genDrones(r, pBad)),
        () => fb.setDetections(genDets(r, pBad)),
        () => fb.setPath(genPath(r, pBad)),
        () => fb.removePath(r.pick(['gp', 'none', ...WEIRD])),
        () => fb.setView(genView(r, pBad)),
        () => fb.setView(null),
        () => fb.setAvailable(r.next() < 0.5 ? r.pick([true, false]) : r.pick(WEIRD)),
        () => fb.frame(genSize(r, pBad)),
      ];
      const ok = attempt(fb, r.pick(calls));
      if (ok) accepted += 1; else rejected += 1;
      // 통과·거절과 상관없이 정상 크기의 frame 은 유한해야 한다
      assertFinite(fb.frame(SIZE));
    }
  });
  console.log(`fallback fuzz: 통과 ${accepted}, 거절 ${rejected}`);
  assert.ok(accepted > 0 && rejected > 0, '두 갈래가 모두 시험되어야 한다');
});

test('퍼즈: 거대 크기(경계 상수) 입력도 허용 예외만 던지고 상태를 지킨다', () => {
  const fb = createTowerFallback();
  fb.setAvailable(false);
  fb.setDrones([{ id: 'a', enu: [0, 0, 0] }]);
  const huge = [
    () => fb.setDrones(Array.from({ length: 257 }, (_, i) => ({ id: `d${i}`, enu: [0, 0, 0] }))),
    () => fb.setDetections(Array.from({ length: 4097 }, (_, i) => ({ id: `t${i}`, enu: [0, 0, 0] }))),
    () => fb.setPath({ id: 'big', points: Array.from({ length: 100001 }, (_, j) => [j, 0, 0]) }),
    () => fb.setDrones([{ id: 'e', enu: [1e308, -1e308, 0] }]),
    () => fb.setDrones([{ id: 'e', enu: [1e6 + 1, 0, 0] }]),
    () => fb.setDrones([{ id: 'dup', enu: [0, 0, 0] }, { id: 'dup', enu: [1, 1, 0] }]),
    () => fb.setDrones([, { id: 'sp', enu: [0, 0, 0] }]), // 희소 배열
    () => fb.setView({ centerE: 0, centerN: 0, metersPerPx: 1e308 * 10 }),
    () => fb.frame({ width: 1e308, height: Infinity }),
  ];
  for (const c of huge) assert.equal(attempt(fb, c), false);
  assert.deepEqual(fb.counts(), { drones: 1, detections: 0, paths: 0 });
  assertFinite(fb.frame(SIZE));
});
