// 입력 검사(validate) 시험: 형식·범위·중복 id, 경계값, 깊은 복사, 던지는 순서.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkOpts, checkDrones, checkDetections, checkPath, checkSize } from './validate.mjs';
import { TOWER_OVERLAY_TEST_NAMES } from '../../../contracts/controlview/overlay.mjs';

const T = TypeError, R = RangeError;
const d = (id, enu = [1, 2, 3], extra = {}) => ({ id, enu, ...extra });
const ids = (n) => Array.from({ length: n }, (_, i) => d(`d${i}`));

test(TOWER_OVERLAY_TEST_NAMES[1], () => {
  // 형식 위반
  assert.throws(() => checkDrones('x'), T);
  assert.throws(() => checkDrones(null), T);
  assert.throws(() => checkDrones({}), T);
  assert.throws(() => checkDrones([null]), T);
  assert.throws(() => checkDrones([[]]), T);
  assert.throws(() => checkDrones([{ id: 1, enu: [0, 0, 0] }]), T);
  assert.throws(() => checkDrones([{ id: 'a', enu: 'x' }]), T);
  assert.throws(() => checkDrones([{ id: 'a' }]), T);
  assert.throws(() => checkDrones([d('a', [0, '1', 0])]), T);
  assert.throws(() => checkDrones([d('a', [0, null, 0])]), T);
  assert.throws(() => checkDrones([d('a', [0, 0, 0], { yaw: '1' })]), T);
  assert.throws(() => checkDetections([d('a', [0, 0, 0], { confidence: '0.5' })]), T);
  assert.throws(() => checkDetections([d('a', [0, 0, 0], { kind: 3 })]), T);
  assert.throws(() => checkPath(null), T);
  assert.throws(() => checkPath({ id: 'p', points: 'x' }), T);
  assert.throws(() => checkPath({ id: 'p', points: [[0, 0, 0], 5] }), T);
  assert.throws(() => checkSize(null), T);
  assert.throws(() => checkSize({ width: '10', height: 10 }), T);
  assert.throws(() => checkOpts(null), T);
  assert.throws(() => checkOpts([]), T);
  assert.throws(() => checkOpts({ nearM: '1' }), T);
  // 범위 위반
  assert.throws(() => checkDrones([d('a', [NaN, 0, 0])]), R);
  assert.throws(() => checkDrones([d('a', [0, Infinity, 0])]), R);
  assert.throws(() => checkDrones([d('a', [0, 0])]), R);
  assert.throws(() => checkDrones([d('a', [0, 0, 0], { yaw: NaN })]), R);
  assert.throws(() => checkDrones([d('a', [0, 0, 0], { foo: 1 })]), R);
  assert.throws(() => checkDetections([d('a', [0, 0, 0], { kind: 'bogus' })]), R);
  assert.throws(() => checkDetections([d('a', [0, 0, 0], { confidence: NaN })]), R);
  assert.throws(() => checkPath({ id: 'p', points: [[0, 0, 0]] }), R);
  assert.throws(() => checkPath({ id: 'p', points: [] }), R);
  assert.throws(() => checkPath({ id: 'p', points: [[0, 0, 0], [1, 1, 1]], extra: 1 }), R);
  assert.throws(() => checkSize({ width: 1.5, height: 10 }), R);
  assert.throws(() => checkSize({ width: 0, height: 10 }), R);
  assert.throws(() => checkSize({ width: 10, height: -1 }), R);
  assert.throws(() => checkSize({ width: NaN, height: 10 }), R);
  assert.throws(() => checkSize({ width: 10, height: 10, dpr: 2 }), R);
  assert.throws(() => checkOpts({ nearM: 0 }), R);
  assert.throws(() => checkOpts({ nearM: -1 }), R);
  assert.throws(() => checkOpts({ nearM: NaN }), R);
  assert.throws(() => checkOpts({ nearM: Infinity }), R);
  assert.throws(() => checkOpts({ far: 1 }), R);
  // 중복 id
  assert.throws(() => checkDrones([d('a'), d('b'), d('a')]), R);
  assert.throws(() => checkDetections([d('a'), d('a')]), R);
});

test('validate: 한도 경계 maxDrones 256 정확히 통과, 257 은 RangeError', () => {
  assert.equal(checkDrones(ids(256)).length, 256);
  assert.throws(() => checkDrones(ids(257)), R);
  assert.deepEqual(checkDrones([]), []);
});

test('validate: maxDetections 4096 정확히 통과, 4097 은 RangeError', () => {
  assert.equal(checkDetections(ids(4096)).length, 4096);
  assert.throws(() => checkDetections(ids(4097)), R);
});

test('validate: 경로 점 100000 개 정확히 통과, 100001 은 RangeError, 2개 미만은 RangeError', () => {
  const pts = (n) => Array.from({ length: n }, (_, i) => [i, 0, 0]);
  assert.equal(checkPath({ id: 'p', points: pts(100000) }).points.length, 100000);
  assert.throws(() => checkPath({ id: 'p', points: pts(100001) }), R);
  assert.equal(checkPath({ id: 'p', points: pts(2) }).points.length, 2);
  assert.throws(() => checkPath({ id: 'p', points: pts(1) }), R);
});

test('validate: id 64자 통과, 65자·빈 문자열은 RangeError', () => {
  assert.equal(checkDrones([d('a'.repeat(64))])[0].id.length, 64);
  assert.throws(() => checkDrones([d('a'.repeat(65))]), R);
  assert.throws(() => checkDrones([d('')]), R);
  assert.throws(() => checkPath({ id: '', points: [[0, 0, 0], [1, 0, 0]] }), R);
  assert.throws(() => checkPath({ id: 'a'.repeat(65), points: [[0, 0, 0], [1, 0, 0]] }), R);
});

test('validate: confidence 0·1 통과, 1.0000001·-0.0000001 은 RangeError', () => {
  assert.equal(checkDetections([d('a', [0, 0, 0], { confidence: 0 })])[0].confidence, 0);
  assert.equal(checkDetections([d('a', [0, 0, 0], { confidence: 1 })])[0].confidence, 1);
  assert.throws(() => checkDetections([d('a', [0, 0, 0], { confidence: 1.0000001 })]), R);
  assert.throws(() => checkDetections([d('a', [0, 0, 0], { confidence: -0.0000001 })]), R);
  assert.throws(() => checkDetections([d('a', [0, 0, 0], { confidence: Infinity })]), R);
});

test('validate: enu 는 float32 로도 유한해야 한다(3.4e38 통과, 4e38 은 RangeError)', () => {
  assert.deepEqual(checkDrones([d('a', [3.4e38, -3.4e38, 0])])[0].enu, [3.4e38, -3.4e38, 0]);
  assert.throws(() => checkDrones([d('a', [4e38, 0, 0])]), R);
  assert.throws(() => checkDrones([d('a', [0, 0, -4e38])]), R);
  assert.throws(() => checkDetections([d('a', [0, 4e38, 0])]), R);
  assert.throws(() => checkPath({ id: 'p', points: [[0, 0, 0], [0, 0, 4e38]] }), R);
  // 배정밀도 값은 줄이지 않고 그대로 돌려준다
  assert.equal(checkDrones([d('a', [1.0000000001, 0, 0])])[0].enu[0], 1.0000000001);
});

test('validate: nearM 은 float32 로도 유한한 양수, 기본 0.1', () => {
  assert.deepEqual(checkOpts(), { nearM: 0.1 });
  assert.deepEqual(checkOpts({}), { nearM: 0.1 });
  assert.deepEqual(checkOpts({ nearM: undefined }), { nearM: 0.1 });
  assert.deepEqual(checkOpts({ nearM: 0.5 }), { nearM: 0.5 });
  assert.deepEqual(checkOpts({ nearM: 3.4e38 }), { nearM: 3.4e38 });
  assert.throws(() => checkOpts({ nearM: 4e38 }), R);
  assert.throws(() => checkOpts({ nearM: 1e-50 }), R);
});

test('validate: kind 기본값 detection 을 채우고 alert 는 유지한다', () => {
  const [a, b] = checkDetections([d('a'), d('b', [0, 0, 0], { kind: 'alert', confidence: 0.5 })]);
  assert.deepEqual(a, { id: 'a', enu: [1, 2, 3], kind: 'detection' });
  assert.deepEqual(b, { id: 'b', enu: [0, 0, 0], kind: 'alert', confidence: 0.5 });
  assert.equal('confidence' in a, false);
});

test('validate: yaw 는 유한 수이면 그대로, 없으면 키 없음', () => {
  const [a, b] = checkDrones([d('a', [0, 0, 0], { yaw: 1.5 }), d('b'), ]);
  assert.equal(a.yaw, 1.5);
  assert.equal('yaw' in b, false);
  assert.equal('yaw' in checkDrones([d('c', [0, 0, 0], { yaw: undefined })])[0], false);
  assert.throws(() => checkDrones([d('a', [0, 0, 0], { yaw: null })]), T);
  assert.throws(() => checkDrones([d('a', [0, 0, 0], { yaw: Infinity })]), R);
});

test('validate: -0 은 0 으로 정규화한다', () => {
  const o = checkDrones([d('a', [-0, 0, -0], { yaw: -0 })])[0];
  assert.ok(Object.is(o.enu[0], 0) && Object.is(o.enu[2], 0) && Object.is(o.yaw, 0));
  assert.ok(Object.is(checkDetections([d('a', [0, 0, 0], { confidence: -0 })])[0].confidence, 0));
});

test('validate: 희소 배열은 TypeError', () => {
  const sp = new Array(3); sp[0] = d('a'); sp[2] = d('b');
  assert.throws(() => checkDrones(sp), T);
  assert.throws(() => checkDrones([d('a', [1, , 3])]), T);
  assert.throws(() => checkPath({ id: 'p', points: [[0, 0, 0], , [1, 1, 1]] }), T);
  assert.throws(() => checkDetections(new Array(2)), T);
});

test('validate: 배열 서브클래스는 받고 결과는 일반 배열이다', () => {
  class Sub extends Array {}
  const src = Sub.from([d('a'), d('b')]);
  const out = checkDrones(src);
  assert.equal(Object.getPrototypeOf(out), Array.prototype);
  assert.equal(out.length, 2);
  const enu = Sub.from([1, 2, 3]);
  assert.equal(Object.getPrototypeOf(checkDrones([{ id: 'a', enu }])[0].enu), Array.prototype);
});

test('validate: 입력 불변이고 결과는 입력과 메모리를 공유하지 않는다', () => {
  const src = [d('a', [1, 2, 3], { yaw: 0.5 })];
  const snap = JSON.stringify(src);
  const out = checkDrones(src);
  assert.equal(JSON.stringify(src), snap);
  assert.notEqual(out, src);
  assert.notEqual(out[0], src[0]);
  assert.notEqual(out[0].enu, src[0].enu);
  src[0].enu[0] = 99; src[0].id = 'z';
  assert.deepEqual(out[0], { id: 'a', enu: [1, 2, 3], yaw: 0.5 });
  const pin = { id: 'p', points: [[0, 0, 0], [1, 1, 1]] };
  const pout = checkPath(pin);
  assert.notEqual(pout.points[0], pin.points[0]);
  pin.points[1][0] = 7;
  assert.deepEqual(pout, { id: 'p', points: [[0, 0, 0], [1, 1, 1]] });
  assert.deepEqual(checkSize({ width: 800, height: 600 }), { width: 800, height: 600 });
});

test('validate: 던지는 순서는 결정적이다(형식 위반이 범위 위반보다 먼저)', () => {
  // 앞 항목은 범위 위반, 뒤 항목은 형식 위반이어도 TypeError
  assert.throws(() => checkDrones([d('a', [NaN, 0, 0]), { id: 5, enu: [0, 0, 0] }]), T);
  assert.throws(() => checkDrones([d('a'), d('a'), null]), T);
  assert.throws(() => checkDrones([...ids(257), null]), T);
  assert.throws(() => checkPath({ id: '', points: [[0, 0, 0], 'x'] }), T);
  assert.throws(() => checkPath({ id: 'p', foo: 1, points: 'x' }), T);
  assert.throws(() => checkSize({ width: 0, height: 'x', extra: 1 }), T);
  assert.throws(() => checkOpts({ nearM: 'x', far: 1 }), T);
  // 같은 입력은 매번 같은 오류
  const bad = [d('a', [NaN, 0, 0]), d('a')];
  for (let i = 0; i < 3; i++) assert.throws(() => checkDrones(bad), { name: 'RangeError', message: /drones\[0\]\.enu\[0\]/ });
});

test('validate: 실패하면 부분 결과 없이 던지고 입력은 그대로다', () => {
  const src = [d('a'), d('b'), d('c', [0, 0, 4e38])];
  const snap = JSON.stringify(src);
  let got;
  assert.throws(() => { got = checkDrones(src); }, R);
  assert.equal(got, undefined);
  assert.equal(JSON.stringify(src), snap);
});

test('validate: 접근자는 한 번만 읽는다(읽을 때마다 바뀌는 입력에 속지 않는다)', () => {
  let n = 0;
  const item = { id: 'a', get enu() { n++; return n === 1 ? [1, 2, 3] : [NaN, 0, 0]; } };
  assert.deepEqual(checkDrones([item])[0].enu, [1, 2, 3]);
  assert.equal(n, 1);
});

test('validate: 크기는 양의 정수만 통과한다', () => {
  assert.deepEqual(checkSize({ width: 1, height: 1 }), { width: 1, height: 1 });
  assert.throws(() => checkSize({ width: 100 }), T);
  assert.throws(() => checkSize({ width: 100, height: Infinity }), R);
  assert.throws(() => checkSize({ width: 0.5, height: 1 }), R);
});

test('validate: Object.create 상속 속성은 읽지 않는다(드론)', () => {
  const drone = Object.create({ id: 'z', enu: [0, 0, 0] });
  assert.throws(() => checkDrones([drone]), T);
});

test('validate: Object.create 상속 속성은 읽지 않는다(탐지)', () => {
  const detection = Object.create({ id: 'z', enu: [0, 0, 0] });
  assert.throws(() => checkDetections([detection]), T);
});

test('validate: Object.create 상속 속성은 읽지 않는다(경로)', () => {
  const path = Object.create({ id: 'p', points: [[0, 0, 0], [1, 1, 1]] });
  assert.throws(() => checkPath(path), T);
});
