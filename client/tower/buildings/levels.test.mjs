// 건물 수준 상태(createBuildingsState) 시험: 교체·추월 건너뛰기·skip 상태 불변·검증 원자성·사본 분리.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBuildingsState } from './levels.mjs';

// 삼각형 하나짜리 묶음. ids 로 묶음을 구별한다.
function group(ids, x = 0) {
  return {
    ids,
    mesh: { positions: new Float32Array([x, 0, 0, x + 10, 0, 0, x, 10, 0]), indices: new Uint32Array([0, 1, 2]) },
    edgeLines: new Float32Array([x, 0, 0, x + 10, 0, 0]),
    uv: new Float32Array([0, 0, 1, 0, 0, 1]),
    wallMask: new Uint8Array([0, 1, 0]),
    points: new Float32Array([x + 1, 1, 0]),
  };
}
const bundle = (...idLists) => ({ groups: idLists.map((ids, i) => group(ids, i * 20)), image: null });
const idsOf = (s) => s.bundle().groups.map((g) => [...g.ids]);

test('초기 상태: 수준 -1, 묶음 null', () => {
  const s = createBuildingsState();
  assert.equal(s.level(), -1);
  assert.equal(s.bundle(), null);
});

test('0→1→3 도착은 first·replace·replace 이고 마지막 묶음만 남는다(누적 없음)', () => {
  const s = createBuildingsState();
  assert.equal(s.accept(0, bundle([1], [2])), 'first');
  assert.equal(s.level(), 0);
  assert.deepEqual(idsOf(s), [[1], [2]]);
  assert.equal(s.accept(1, bundle([3, 4])), 'replace');
  assert.equal(s.level(), 1);
  assert.deepEqual(idsOf(s), [[3, 4]]);
  assert.equal(s.accept(3, bundle([5], [6], [7])), 'replace');
  assert.equal(s.level(), 3);
  assert.deepEqual(idsOf(s), [[5], [6], [7]]);
  // 세 번째 묶음은 x = 2·20 = 40 에서 시작한다.
  assert.deepEqual([...s.bundle().groups[2].mesh.positions], [40, 0, 0, 50, 0, 0, 40, 10, 0]);
});

test('추월당한 낮은 수준(3 뒤 1)은 skip 이고 상태가 그대로다', () => {
  const s = createBuildingsState();
  s.accept(3, bundle([9]));
  const before = s.bundle();
  assert.equal(s.accept(1, bundle([1], [2])), 'skip');
  assert.equal(s.level(), 3);
  assert.equal(s.bundle(), before);
  assert.deepEqual(idsOf(s), [[9]]);
});

test('같은 수준이 다시 오면 skip 이고 기존 묶음을 유지한다', () => {
  const s = createBuildingsState();
  s.accept(2, bundle([1]));
  const before = s.bundle();
  assert.equal(s.accept(2, bundle([8], [9])), 'skip');
  assert.equal(s.level(), 2);
  assert.equal(s.bundle(), before);
  assert.deepEqual(idsOf(s), [[1]]);
});

test('첫 도착이 2 여도 first, 이후 0 은 skip, 3 은 replace', () => {
  const s = createBuildingsState();
  assert.equal(s.accept(2, bundle([1])), 'first');
  assert.equal(s.accept(0, bundle([2])), 'skip');
  assert.deepEqual(idsOf(s), [[1]]);
  assert.equal(s.accept(3, bundle([3])), 'replace');
  assert.deepEqual(idsOf(s), [[3]]);
});

test('image 도 교체된다: 영상 있는 묶음 뒤 image null 묶음이 오면 영상이 사라진다', () => {
  const s = createBuildingsState();
  s.accept(0, { groups: [group([1])], image: { width: 1, height: 1, rgb: new Uint8Array([10, 20, 30]) } });
  assert.deepEqual([...s.bundle().image.rgb], [10, 20, 30]);
  s.accept(1, { groups: [], image: null });
  assert.equal(s.bundle().image, null);
  assert.equal(s.bundle().groups.length, 0);
});

test('잘못된 묶음·수준은 던지고 상태가 그대로다(원자성)', () => {
  const s = createBuildingsState();
  s.accept(1, bundle([1], [2]));
  const before = s.bundle();
  assert.throws(() => s.accept(2, bundle([])), RangeError, '빈 ids');
  assert.throws(() => s.accept(2, { groups: [{ ...group([1]), uv: new Float32Array([0, 0, 2, 0, 0, 1]) }], image: null }), RangeError, 'uv 범위');
  assert.throws(() => s.accept(2, { groups: 'x', image: null }), TypeError, 'groups 아님');
  assert.throws(() => s.accept(4, bundle([1])), RangeError, '수준 4');
  assert.throws(() => s.accept(1.5, bundle([1])), TypeError, '수준 소수');
  assert.equal(s.level(), 1);
  assert.equal(s.bundle(), before);
  assert.deepEqual(idsOf(s), [[1], [2]]);
});

test('수준과 묶음이 둘 다 틀리면 수준 오류가 먼저 난다', () => {
  const s = createBuildingsState();
  assert.throws(() => s.accept(4, bundle([])), (e) => e instanceof RangeError && /level 범위 밖: 4/.test(e.message));
  assert.throws(() => s.accept('1', { groups: 'x', image: null }), (e) => e instanceof TypeError && /level 은 정수/.test(e.message));
  assert.equal(s.level(), -1);
});

test('첫 도착이 잘못이면 던지고 수준 -1·묶음 null 이 유지된다', () => {
  const s = createBuildingsState();
  assert.throws(() => s.accept(0, bundle([])), RangeError);
  assert.equal(s.level(), -1);
  assert.equal(s.bundle(), null);
});

test('검증은 skip 판정보다 먼저다: 추월 수준의 잘못된 묶음도 던진다', () => {
  const s = createBuildingsState();
  s.accept(3, bundle([1]));
  assert.equal(s.peek(1), 'skip');
  assert.throws(() => s.accept(1, bundle([])), RangeError);
  assert.throws(() => s.accept(1, { groups: [null], image: null }), TypeError);
  assert.equal(s.level(), 3);
  assert.deepEqual(idsOf(s), [[1]]);
});

test('보관 묶음은 입력과 떨어져 있고 동결돼 있다', () => {
  const s = createBuildingsState();
  const input = { groups: [group([1, 2])], image: { width: 1, height: 1, rgb: new Uint8Array([1, 2, 3]) } };
  s.accept(0, input);
  input.groups[0].ids.push(3);
  input.groups[0].mesh.positions[0] = 99;
  input.groups[0].uv[0] = 0.5;
  input.groups[0].wallMask[1] = 0;
  input.groups[0].points[0] = 99;
  input.groups[0].edgeLines[0] = 99;
  input.groups[0].mesh.indices[0] = 2;
  input.image.rgb[0] = 200;
  input.groups.push(group([4]));
  const g = s.bundle().groups[0];
  assert.deepEqual([...g.ids], [1, 2]);
  assert.equal(g.mesh.positions[0], 0);
  assert.equal(g.mesh.indices[0], 0);
  assert.equal(g.uv[0], 0);
  assert.equal(g.wallMask[1], 1);
  assert.equal(g.points[0], 1);
  assert.equal(g.edgeLines[0], 0);
  assert.equal(s.bundle().image.rgb[0], 1);
  assert.equal(s.bundle().groups.length, 1);
  assert.ok(Object.isFrozen(s.bundle()));
  assert.ok(Object.isFrozen(s.bundle().groups));
  assert.ok(Object.isFrozen(g));
  assert.ok(Object.isFrozen(g.ids));
  assert.ok(Object.isFrozen(g.mesh));
});

test('peek 는 상태를 바꾸지 않고 결정만 돌려준다', () => {
  const s = createBuildingsState();
  assert.equal(s.peek(2), 'first');
  assert.equal(s.level(), -1);
  assert.equal(s.bundle(), null);
  s.accept(2, bundle([1]));
  assert.equal(s.peek(1), 'skip');
  assert.equal(s.peek(2), 'skip');
  assert.equal(s.peek(3), 'replace');
  assert.equal(s.level(), 2);
  assert.throws(() => s.peek(4), RangeError);
  assert.throws(() => s.peek(-1), RangeError);
});
