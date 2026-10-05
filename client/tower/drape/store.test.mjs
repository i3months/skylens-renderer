import test from 'node:test';
import assert from 'node:assert/strict';
import { createDrapeStore } from './store.mjs';

// 시험용 작은 타일(width 4, height 4): rgb 48, mask 16.
function tile(tx, ty, over = {}) {
  const w = 4;
  const h = 4;
  return {
    tx, ty, mip: 0, width: w, height: h,
    rgb: new Uint8Array(w * h * 3),
    coverage: { complete: true, fraction: 1, mask: new Uint8Array(w * h).fill(255), bounds: { minX: tx * 64, minY: ty * 64, maxX: tx * 64 + 64, maxY: ty * 64 + 64 } },
    ...over,
  };
}

test('처음 상태: 수준 -1, 타일 0, lookup null, peek first', () => {
  const s = createDrapeStore();
  assert.equal(s.level(), -1);
  assert.equal(s.count(), 0);
  assert.equal(s.lookup(0, 0), null);
  assert.equal(s.peek(0), 'first');
});

test('first/replace/skip 순서: 1 → 3 → 2 skip → 3 skip', () => {
  const s = createDrapeStore();
  assert.equal(s.accept(1, [tile(0, 0)]), 'first');
  assert.equal(s.level(), 1);
  assert.equal(s.accept(3, [tile(1, 1), tile(2, 2)]), 'replace');
  assert.equal(s.level(), 3);
  assert.equal(s.count(), 2);
  assert.equal(s.peek(2), 'skip');
  assert.equal(s.accept(2, [tile(5, 5)]), 'skip');
  assert.equal(s.accept(3, [tile(6, 6)]), 'skip');
  assert.equal(s.level(), 3);
  assert.equal(s.count(), 2);
});

test('건너뛴 뒤에도 lookup 은 수준 3 의 타일을 돌려준다(교체, 누적 아님)', () => {
  const s = createDrapeStore();
  const t0 = tile(0, 0);
  const t3 = tile(1, 1);
  s.accept(1, [t0]);
  s.accept(3, [t3]);
  s.accept(2, [tile(0, 0)]);
  assert.equal(s.lookup(70, 70), t3);
  assert.equal(s.lookup(10, 10), null);
});

test('수준 0 이 처음이면 first, 잘못된 수준은 던진다', () => {
  const s = createDrapeStore();
  assert.equal(s.accept(0, []), 'first');
  assert.equal(s.count(), 0);
  for (const bad of [-1, 4, 1.5, NaN, '1', undefined]) assert.throws(() => s.accept(bad, []));
  assert.throws(() => s.peek(4));
  assert.equal(s.level(), 0);
});

test('던지면 상태 불변', () => {
  const s = createDrapeStore();
  const a = tile(0, 0);
  s.accept(1, [a]);
  assert.throws(() => s.accept(3, [tile(2, 2), tile(3, 3, { width: 0 })]));
  assert.equal(s.level(), 1);
  assert.equal(s.count(), 1);
  assert.equal(s.lookup(1, 1), a);
  assert.equal(s.lookup(2 * 64 + 1, 2 * 64 + 1), null);
});

test('음수 타일 번호와 경계 좌표 lookup(floor 규약)', () => {
  const s = createDrapeStore();
  const neg = tile(-1, -1);
  const origin = tile(0, 0);
  const next = tile(1, 0);
  s.accept(0, [neg, origin, next]);
  assert.equal(s.lookup(-0.5, -0.5), neg);
  assert.equal(s.lookup(-64, -64), neg);
  assert.equal(s.lookup(-64.0001, -1), null);
  assert.equal(s.lookup(0, 0), origin);
  assert.equal(s.lookup(63.999, 63.999), origin);
  assert.equal(s.lookup(64, 0), next);
  assert.equal(s.lookup(64, 63), next);
  assert.equal(s.lookup(0, 64), null);
  assert.equal(s.lookup(-0, -0), origin);
});

test('비유한 좌표는 RangeError', () => {
  const s = createDrapeStore();
  for (const [x, y] of [[NaN, 0], [0, NaN], [Infinity, 0], [0, -Infinity]]) assert.throws(() => s.lookup(x, y), RangeError);
  assert.throws(() => s.lookup('1', 0), RangeError);
});

test('잘못된 타일 10종 거부', () => {
  const bad = {
    '실수 tx': tile(0.5, 0),
    'tx 문자열': tile('0', 0),
    '실수 ty': tile(0, 1.5),
    'mip 음수': tile(0, 0, { mip: -1 }),
    'mip 4': tile(0, 0, { mip: 4 }),
    'width 0': tile(0, 0, { width: 0 }),
    'height 음수': tile(0, 0, { height: -4 }),
    'width 실수': tile(0, 0, { width: 4.5 }),
    'rgb 길이 47': tile(0, 0, { rgb: new Uint8Array(47) }),
    'rgb 배열': tile(0, 0, { rgb: new Array(48).fill(0) }),
    'mask 길이 15': tile(0, 0, { coverage: { mask: new Uint8Array(15) } }),
    'coverage 없음': tile(0, 0, { coverage: undefined }),
    '타일 null': null,
  };
  for (const [name, t] of Object.entries(bad)) {
    const s = createDrapeStore();
    assert.throws(() => s.accept(1, [t]), Error, name);
    assert.equal(s.level(), -1, name);
    assert.equal(s.count(), 0, name);
  }
  assert.throws(() => createDrapeStore().accept(1, null), TypeError);
});

test('같은 (tx,ty) 중복은 거부, 다른 mip 이어도 거부', () => {
  const s = createDrapeStore();
  assert.throws(() => s.accept(1, [tile(2, 3), tile(2, 3)]), RangeError);
  assert.throws(() => s.accept(1, [tile(2, 3), tile(2, 3, { mip: 1 })]), RangeError);
  assert.equal(s.level(), -1);
  assert.equal(s.count(), 0);
  assert.equal(s.accept(1, [tile(2, 3), tile(3, 2)]), 'first');
  assert.equal(s.count(), 2);
});

test('skip 인 수준도 잘못된 묶음이면 던진다, 상태는 그대로', () => {
  const s = createDrapeStore();
  s.accept(3, [tile(0, 0)]);
  assert.throws(() => s.accept(1, [tile(0, 0, { mip: 9 })]));
  assert.equal(s.level(), 3);
  assert.equal(s.count(), 1);
});

test('보관 타일은 복사 없이 같은 객체를 참조한다', () => {
  const s = createDrapeStore();
  const t = tile(0, 0);
  s.accept(0, [t]);
  assert.equal(s.lookup(5, 5), t);
});
