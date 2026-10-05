// 지형 수준 상태(createTerrainState) 시험: 교체·건너뛰기·검증·원자성.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerrainState } from './levels.mjs';

const tile = (tx, ty, cells = 4, lod = 0) => ({ tx, ty, lod, cells, heights: new Float32Array((cells + 1) * (cells + 1)) });
const coords = (state) => state.tiles().map((t) => `${t.tx},${t.ty}`);

test('초기 상태는 수준 -1 이고 타일이 없다', () => {
  const s = createTerrainState();
  assert.equal(s.level(), -1);
  assert.deepEqual(s.tiles(), []);
});

test('0→1→3 순서로 도착하면 first, replace, replace 이고 마지막 묶음만 남는다', () => {
  const s = createTerrainState();
  assert.equal(s.accept(0, [tile(0, 0, 2), tile(1, 0, 2)]), 'first');
  assert.equal(s.level(), 0);
  assert.equal(s.tiles().length, 2);
  assert.equal(s.accept(1, [tile(0, 0, 4)]), 'replace');
  assert.equal(s.level(), 1);
  assert.equal(s.tiles().length, 1);
  assert.equal(s.accept(3, [tile(0, 0, 8), tile(0, 1, 8), tile(1, 1, 8)]), 'replace');
  assert.equal(s.level(), 3);
  assert.deepEqual(coords(s), ['0,0', '0,1', '1,1']);
  assert.equal(s.tiles()[0].cells, 8);
});

test('3 뒤에 1 이 도착하면 skip 이고 상태가 변하지 않는다', () => {
  const s = createTerrainState();
  s.accept(3, [tile(5, 6, 8)]);
  const before = s.tiles();
  assert.equal(s.accept(1, [tile(0, 0, 4), tile(1, 1, 4)]), 'skip');
  assert.equal(s.level(), 3);
  assert.equal(s.tiles().length, 1);
  assert.deepEqual(s.tiles(), before);
  assert.equal(s.tiles()[0].tx, 5);
});

test('같은 수준이 다시 도착하면 skip 이고 기존 묶음을 유지한다', () => {
  const s = createTerrainState();
  s.accept(2, [tile(0, 0)]);
  assert.equal(s.accept(2, [tile(9, 9), tile(8, 8)]), 'skip');
  assert.equal(s.level(), 2);
  assert.deepEqual(coords(s), ['0,0']);
});

test('수준을 건너뛰어 첫 도착이 2 여도 first 이다', () => {
  const s = createTerrainState();
  assert.equal(s.accept(2, [tile(3, 4)]), 'first');
  assert.equal(s.level(), 2);
  assert.deepEqual(coords(s), ['3,4']);
  assert.equal(s.accept(0, [tile(0, 0)]), 'skip');
  assert.equal(s.accept(3, [tile(1, 1)]), 'replace');
});

test('빈 묶음은 유효하다: 첫 도착이면 수준만 정해지고, 교체면 이전 타일을 지운다', () => {
  const s = createTerrainState();
  assert.equal(s.accept(0, []), 'first');
  assert.equal(s.level(), 0);
  assert.equal(s.tiles().length, 0);
  assert.equal(s.accept(1, [tile(0, 0), tile(1, 0)]), 'replace');
  assert.equal(s.tiles().length, 2);
  assert.equal(s.accept(2, []), 'replace');
  assert.equal(s.level(), 2);
  assert.equal(s.tiles().length, 0);
});

test('누적되지 않는다: 새 묶음에 없는 (tx,ty) 는 사라진다', () => {
  const s = createTerrainState();
  s.accept(0, [tile(0, 0), tile(1, 0), tile(2, 0)]);
  s.accept(1, [tile(1, 0), tile(7, 7)]);
  assert.deepEqual(coords(s).sort(), ['1,0', '7,7']);
  assert.equal(s.tiles().length, 2);
  assert.ok(!coords(s).includes('0,0'));
  assert.ok(!coords(s).includes('2,0'));
});

test('잘못된 입력은 던지고 상태는 그대로다(원자성)', () => {
  const s = createTerrainState();
  s.accept(1, [tile(0, 0, 4), tile(1, 0, 4)]);
  const before = s.tiles();
  assert.throws(() => s.accept(2, [tile(0, 0), tile(0, 0)]), RangeError, '(tx,ty) 중복');
  assert.throws(() => s.accept(2, [tile(0, 0, 4), tile(1, 0, 8)]), RangeError, 'cells 불일치');
  assert.throws(() => s.accept(2, [{ ...tile(0, 0), tx: 1.5 }]), TypeError, '정수 아닌 tx');
  assert.throws(() => s.accept(2, [{ ...tile(0, 0), ty: '1' }]), TypeError, '문자열 ty');
  assert.throws(() => s.accept(2, [null]), TypeError, '타일이 null');
  assert.throws(() => s.accept(2, 'tiles'), TypeError, '배열 아님');
  assert.throws(() => s.accept(4, [tile(0, 0)]), RangeError, '수준 범위 밖');
  assert.throws(() => s.accept(1.5, [tile(0, 0)]), TypeError, '정수 아닌 수준');
  assert.equal(s.level(), 1);
  assert.deepEqual(s.tiles(), before);
  assert.equal(s.tiles().length, 2);
});

test('첫 도착이 잘못된 입력이면 던지고 수준 -1 이 유지된다', () => {
  const s = createTerrainState();
  assert.throws(() => s.accept(0, [tile(0, 0), tile(0, 0)]), RangeError);
  assert.equal(s.level(), -1);
  assert.equal(s.tiles().length, 0);
});

test('낮은 수준의 잘못된 묶음도 던진다(검증이 skip 판정보다 먼저)', () => {
  const s = createTerrainState();
  s.accept(3, [tile(0, 0)]);
  assert.throws(() => s.accept(0, [tile(1, 1), tile(1, 1)]), RangeError);
  assert.equal(s.level(), 3);
  assert.equal(s.tiles().length, 1);
});

test('tiles() 는 복사본이라 바깥에서 바꿔도 상태가 불변이다', () => {
  const s = createTerrainState();
  const input = [tile(0, 0), tile(1, 1)];
  s.accept(0, input);
  input.push(tile(5, 5));
  input[0].tx = 99;
  assert.equal(s.tiles().length, 2);
  assert.equal(s.tiles()[0].tx, 0);
  const out = s.tiles();
  out.length = 0;
  out.push(tile(8, 8));
  assert.equal(s.tiles().length, 2);
  assert.deepEqual(coords(s), ['0,0', '1,1']);
  assert.ok(Object.isFrozen(s.tiles()[0]));
  assert.notEqual(s.tiles(), s.tiles());
});

test('peek 는 상태를 바꾸지 않고 결정만 돌려준다', () => {
  const s = createTerrainState();
  assert.equal(s.peek(2), 'first');
  assert.equal(s.level(), -1);
  s.accept(2, [tile(0, 0, 2)]);
  assert.equal(s.peek(1), 'skip');
  assert.equal(s.peek(2), 'skip');
  assert.equal(s.peek(3), 'replace');
  assert.equal(s.level(), 2);
  assert.throws(() => s.peek(4));
});

test('묶음은 수준별 화면 전체 완전 묶음이다: 높은 수준이 이전 묶음에 없는 타일을 남기지 않는다(누적 없음)', () => {
  const s = createTerrainState();
  s.accept(0, [tile(0, 0, 2), tile(1, 0, 2), tile(2, 0, 2)]);
  s.accept(1, [tile(0, 0, 4)]);
  assert.deepEqual(coords(s), ['0,0']);
});
