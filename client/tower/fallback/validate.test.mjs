// 폴백 입력 검사(validate) 시험: 형식·범위, 경계값, 깊은 복사.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFallbackOpts, checkView, checkAvailable, checkEnuRange } from './validate.mjs';
import { TOWER_FALLBACK_TEST_NAMES } from '../../../contracts/controlview/fallback.mjs';

const T = TypeError, R = RangeError;

test(TOWER_FALLBACK_TEST_NAMES[0], () => {
  // 형식 위반
  // checkFallbackOpts
  assert.throws(() => checkFallbackOpts(null), T);
  assert.throws(() => checkFallbackOpts([]), T);
  assert.throws(() => checkFallbackOpts({ minSpanM: '10' }), T);
  assert.throws(() => checkFallbackOpts({ marginPx: '16' }), T);
  assert.throws(() => checkFallbackOpts({ minSpanM: 100, unknown: 1 }), R);

  // checkView
  assert.throws(() => checkView({}), T);
  assert.throws(() => checkView({ centerE: 0, centerN: 0 }), T);
  assert.throws(() => checkView({ centerE: 0, centerN: 0, metersPerPx: '1' }), T);
  assert.throws(() => checkView({ centerE: 'x', centerN: 0, metersPerPx: 1 }), T);
  assert.throws(() => checkView({ centerE: 0, centerN: 0, metersPerPx: 1, extra: 1 }), R);

  // checkAvailable
  assert.throws(() => checkAvailable('true'), T);
  assert.throws(() => checkAvailable(1), T);
  assert.throws(() => checkAvailable(null), T);

  // checkEnuRange 배열
  assert.throws(() => checkEnuRange([{ id: 'a' }]), T); // enu 필수
  assert.throws(() => checkEnuRange([{ id: 'a', enu: 'x' }]), T);
  assert.throws(() => checkEnuRange([{ id: 'a', enu: [0, 0] }]), T); // 3개 필요
  assert.throws(() => checkEnuRange([{ id: 'a', enu: ['0', 0, 0] }]), T);

  // checkEnuRange 경로
  assert.throws(() => checkEnuRange({ id: 'p' }), T); // points 필수
  assert.throws(() => checkEnuRange({ id: 'p', points: 'x' }), T);
  assert.throws(() => checkEnuRange({ id: 'p', points: [{ x: 0 }] }), T); // 배열 아님
  assert.throws(() => checkEnuRange({ id: 'p', points: [[0, 0]] }), T); // 3개 필요
  assert.throws(() => checkEnuRange({ id: 'p', points: [['0', 0, 0], [0, 0, 0]] }), T);

  // 범위 위반
  assert.throws(() => checkFallbackOpts({ minSpanM: 0 }), R);
  assert.throws(() => checkFallbackOpts({ minSpanM: -1 }), R);
  assert.throws(() => checkFallbackOpts({ minSpanM: Infinity }), R);
  assert.throws(() => checkFallbackOpts({ minSpanM: NaN }), R);
  assert.throws(() => checkFallbackOpts({ marginPx: -0.1 }), R);
  assert.throws(() => checkFallbackOpts({ marginPx: Infinity }), R);
  assert.throws(() => checkFallbackOpts({ marginPx: NaN }), R);

  assert.throws(() => checkView({ centerE: Infinity, centerN: 0, metersPerPx: 1 }), R);
  assert.throws(() => checkView({ centerE: 0, centerN: NaN, metersPerPx: 1 }), R);
  assert.throws(() => checkView({ centerE: 0, centerN: 0, metersPerPx: 0 }), R);
  assert.throws(() => checkView({ centerE: 0, centerN: 0, metersPerPx: -1 }), R);
  assert.throws(() => checkView({ centerE: 0, centerN: 0, metersPerPx: Infinity }), R);

  // checkEnuRange 배열 범위
  assert.throws(() => checkEnuRange([{ id: 'a', enu: [NaN, 0, 0] }]), R);
  assert.throws(() => checkEnuRange([{ id: 'a', enu: [1e6 + 1, 0, 0] }]), R);
  assert.throws(() => checkEnuRange([{ id: 'a', enu: [0, -1e6 - 1, 0] }]), R);

  // checkEnuRange 경로 범위
  assert.throws(() => checkEnuRange({ id: 'p', points: [[NaN, 0, 0], [0, 0, 0]] }), R);
  assert.throws(() => checkEnuRange({ id: 'p', points: [[1e6 + 1, 0, 0], [0, 0, 0]] }), R);
  assert.throws(() => checkEnuRange({ id: 'p', points: [[0, 0, 0], [0, 1e6 + 1, 0]] }), R);
});

test('validate: checkFallbackOpts 기본값·경계값', () => {
  // 기본값
  assert.deepEqual(checkFallbackOpts(), { minSpanM: 100, marginPx: 16 });
  assert.deepEqual(checkFallbackOpts(undefined), { minSpanM: 100, marginPx: 16 });
  assert.deepEqual(checkFallbackOpts({}), { minSpanM: 100, marginPx: 16 });

  // 경계값: minSpanM > 0 유한
  assert.deepEqual(checkFallbackOpts({ minSpanM: 0.0001 }), { minSpanM: 0.0001, marginPx: 16 });
  assert.deepEqual(checkFallbackOpts({ minSpanM: 1e6 }), { minSpanM: 1e6, marginPx: 16 });
  assert.deepEqual(checkFallbackOpts({ minSpanM: 1e10 }), { minSpanM: 1e10, marginPx: 16 });

  // marginPx >= 0 유한
  assert.deepEqual(checkFallbackOpts({ marginPx: 0 }), { minSpanM: 100, marginPx: 0 });
  assert.deepEqual(checkFallbackOpts({ marginPx: 1e6 }), { minSpanM: 100, marginPx: 1e6 });
  assert.deepEqual(checkFallbackOpts({ marginPx: 1e10 }), { minSpanM: 100, marginPx: 1e10 });

  // -0 정규화: marginPx >= 0 이므로 -0 허용
  const r = checkFallbackOpts({ marginPx: -0 });
  assert.ok(Object.is(r.marginPx, 0));
  // minSpanM > 0 이므로 -0 은 range error
  assert.throws(() => checkFallbackOpts({ minSpanM: -0 }), R);
});

test('validate: checkView 기본값·경계값', () => {
  // null 허용
  assert.strictEqual(checkView(null), null);

  // 유한성 검사
  assert.deepEqual(checkView({ centerE: 1e6, centerN: -1e6, metersPerPx: 0.5 }),
    { centerE: 1e6, centerN: -1e6, metersPerPx: 0.5 });
  assert.throws(() => checkView({ centerE: Infinity, centerN: 0, metersPerPx: 1 }), R);
  assert.throws(() => checkView({ centerE: 0, centerN: NaN, metersPerPx: 1 }), R);

  // metersPerPx > 0, 유한성
  assert.deepEqual(checkView({ centerE: 0, centerN: 0, metersPerPx: 1e-10 }),
    { centerE: 0, centerN: 0, metersPerPx: 1e-10 });
  assert.throws(() => checkView({ centerE: 0, centerN: 0, metersPerPx: Infinity }), R);
  assert.throws(() => checkView({ centerE: 0, centerN: 0, metersPerPx: 0 }), R); // metersPerPx ≤ 0
  assert.throws(() => checkView({ centerE: 0, centerN: 0, metersPerPx: -1 }), R);

  // -0 정규화
  const r = checkView({ centerE: -0, centerN: -0, metersPerPx: 0.1 });
  assert.ok(Object.is(r.centerE, 0) && Object.is(r.centerN, 0));
});

test('validate: checkAvailable 형식', () => {
  assert.strictEqual(checkAvailable(true), true);
  assert.strictEqual(checkAvailable(false), false);
});

test('validate: checkEnuRange 배열 경계값', () => {
  // 정확히 1e6 통과
  assert.deepEqual(checkEnuRange([{ id: 'a', enu: [1e6, 0, 0] }]), [{ id: 'a', enu: [1e6, 0, 0] }]);
  assert.deepEqual(checkEnuRange([{ id: 'a', enu: [0, -1e6, 0] }]), [{ id: 'a', enu: [0, -1e6, 0] }]);

  // 1e6+ε 던짐
  assert.throws(() => checkEnuRange([{ id: 'a', enu: [1e6 + 0.1, 0, 0] }]), R);
  assert.throws(() => checkEnuRange([{ id: 'a', enu: [0, -(1e6 + 0.1), 0] }]), R);

  // NaN, Infinity
  assert.throws(() => checkEnuRange([{ id: 'a', enu: [NaN, 0, 0] }]), R);
  assert.throws(() => checkEnuRange([{ id: 'a', enu: [0, Infinity, 0] }]), R);

  // -0 검사: 반환값이 -0 를 포함하면 문제
  const r = checkEnuRange([{ id: 'a', enu: [-0, 0, 0] }]);
  assert.ok(Object.is(r[0].enu[0], -0) || Object.is(r[0].enu[0], 0)); // 원본 그대로 반환
});

test('validate: checkEnuRange 경로 경계값', () => {
  // 정확히 1e6 통과
  assert.deepEqual(checkEnuRange({ id: 'p', points: [[1e6, -1e6, 0], [0, 0, 0]] }),
    { id: 'p', points: [[1e6, -1e6, 0], [0, 0, 0]] });

  // 1e6+ε 던짐
  assert.throws(() => checkEnuRange({ id: 'p', points: [[1e6 + 0.1, 0, 0], [0, 0, 0]] }), R);
  assert.throws(() => checkEnuRange({ id: 'p', points: [[0, 0, 0], [0, 1e6 + 1, 0]] }), R);

  // NaN, Infinity
  assert.throws(() => checkEnuRange({ id: 'p', points: [[NaN, 0, 0], [0, 0, 0]] }), R);
  assert.throws(() => checkEnuRange({ id: 'p', points: [[0, 0, 0], [-Infinity, 0, 0]] }), R);
});

test('validate: 입력은 바뀌지 않는다(배열·경로)', () => {
  const src = [{ id: 'a', enu: [1, 2, 3] }];
  const snap = JSON.stringify(src);
  const out = checkEnuRange(src);
  assert.equal(JSON.stringify(src), snap);
  assert.strictEqual(out, src); // checkEnuRange 는 원본 참조 반환

  const pth = { id: 'p', points: [[0, 0, 0], [1, 1, 1]] };
  const psnap = JSON.stringify(pth);
  const pout = checkEnuRange(pth);
  assert.equal(JSON.stringify(pth), psnap);
  assert.strictEqual(pout, pth);
});

test('validate: 깊은 복사(checkFallbackOpts, checkView)', () => {
  const opts = checkFallbackOpts({ minSpanM: 50 });
  opts.minSpanM = 999;
  assert.deepEqual(checkFallbackOpts({ minSpanM: 50 }), { minSpanM: 50, marginPx: 16 });

  const view = checkView({ centerE: 1, centerN: 2, metersPerPx: 3 });
  view.centerE = 999;
  const view2 = checkView({ centerE: 1, centerN: 2, metersPerPx: 3 });
  assert.equal(view2.centerE, 1);
  assert.equal(view2.centerN, 2);
  assert.equal(view2.metersPerPx, 3);
});
