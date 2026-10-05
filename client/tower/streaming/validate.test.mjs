// 조각 요청 입력 검사 시험: 옵션 각 분기, 타일 번호, pose·size 위임.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkOpts, checkTile, checkView, TILE_INDEX_MAX } from './validate.mjs';
import { TOWER_STREAMING_LIMITS as L } from '../../../contracts/controlview/streaming.mjs';

const T = TypeError, R = RangeError;
const pose = { pos: [0, 0, 100], quat: [0, 0, 0, 1], fovY: 1 };
const size = { width: 100, height: 80 };

test('checkOpts: 기본값은 TOWER_STREAMING_LIMITS', () => {
  const o = checkOpts();
  assert.deepEqual(o, { maxDistM: L.maxDistM, nearM: L.nearM, zRangeM: [L.zMinM, L.zMaxM], maxInflight: L.maxInflight, retainMargin: L.retainMargin, maxHeld: L.maxHeld });
  assert.deepEqual(checkOpts({}), o);
});

test('checkOpts: 지정한 값은 그대로 정규화된다', () => {
  const o = checkOpts({ maxDistM: 500, zRangeM: [-0, 50], maxInflight: 4, retainMargin: 0, maxHeld: 10, nearM: 1 });
  assert.deepEqual(o, { maxDistM: 500, nearM: 1, zRangeM: [0, 50], maxInflight: 4, retainMargin: 0, maxHeld: 10 });
  assert.ok(Object.is(o.zRangeM[0], 0));
});

test('checkOpts: 형식 위반은 TypeError', () => {
  for (const bad of [null, 5, 'x', [], () => 1]) assert.throws(() => checkOpts(bad), T);
  assert.throws(() => checkOpts({ maxDistM: '1' }), T);
  assert.throws(() => checkOpts({ nearM: null }), T);
  assert.throws(() => checkOpts({ maxInflight: '4' }), T);
  assert.throws(() => checkOpts({ retainMargin: true }), T);
  assert.throws(() => checkOpts({ maxHeld: {} }), T);
  assert.throws(() => checkOpts({ zRangeM: 'ab' }), T);
  assert.throws(() => checkOpts({ zRangeM: { 0: 1, 1: 2 } }), T);
  assert.throws(() => checkOpts({ zRangeM: [1] }), T);
  assert.throws(() => checkOpts({ zRangeM: [1, '2'] }), T);
});

test('checkOpts: 알 수 없는 키는 RangeError', () => {
  assert.throws(() => checkOpts({ foo: 1 }), R);
  assert.throws(() => checkOpts({ maxTilesPerUpdate: 5 }), R);
  assert.throws(() => checkOpts({ nearM: 1, bar: undefined }), R);
});

test('checkOpts: 형식 검사가 범위·키 검사보다 먼저다', () => {
  assert.throws(() => checkOpts({ foo: 1, nearM: 'x' }), T);
  assert.throws(() => checkOpts({ maxDistM: -1, maxHeld: 'x' }), T);
});

test('checkOpts: maxDistM·nearM 범위', () => {
  for (const v of [0, -1, NaN, Infinity, 1e300]) assert.throws(() => checkOpts({ maxDistM: v }), R);
  for (const v of [0, -1, NaN, Infinity, 1e-60]) assert.throws(() => checkOpts({ nearM: v }), R);
  assert.throws(() => checkOpts({ nearM: 10, maxDistM: 10 }), R);
  assert.throws(() => checkOpts({ nearM: 20, maxDistM: 10 }), R);
  assert.throws(() => checkOpts({ nearM: 2000 }), R); // 기본 maxDistM(1500) 보다 큼
  assert.equal(checkOpts({ nearM: 1, maxDistM: 1.5 }).maxDistM, 1.5);
});

test('checkOpts: zRangeM 범위', () => {
  assert.throws(() => checkOpts({ zRangeM: [5, 1] }), R);
  assert.throws(() => checkOpts({ zRangeM: [NaN, 1] }), R);
  assert.throws(() => checkOpts({ zRangeM: [0, Infinity] }), R);
  assert.deepEqual(checkOpts({ zRangeM: [3, 3] }).zRangeM, [3, 3]);
});

test('checkOpts: 정수 옵션 범위와 경계', () => {
  for (const k of ['maxInflight', 'retainMargin', 'maxHeld']) {
    assert.throws(() => checkOpts({ [k]: 1.5 }), R);
    assert.throws(() => checkOpts({ [k]: NaN }), R);
    assert.throws(() => checkOpts({ [k]: -1 }), R);
  }
  assert.throws(() => checkOpts({ maxInflight: 0 }), R);
  assert.throws(() => checkOpts({ maxInflight: 1_000_001 }), R);
  assert.throws(() => checkOpts({ retainMargin: 17 }), R);
  assert.throws(() => checkOpts({ maxHeld: 0 }), R);
  assert.equal(checkOpts({ maxInflight: 1 }).maxInflight, 1);
  assert.equal(checkOpts({ maxInflight: 1_000_000 }).maxInflight, 1_000_000);
  assert.equal(checkOpts({ retainMargin: 0 }).retainMargin, 0);
  assert.equal(checkOpts({ retainMargin: 16 }).retainMargin, 16);
});

test('checkOpts: 입력을 고치지 않고 메모리를 공유하지 않는다', () => {
  const z = Object.freeze([1, 2]);
  const inp = Object.freeze({ zRangeM: z, maxInflight: 3 });
  const o = checkOpts(inp);
  assert.notEqual(o.zRangeM, z);
  assert.deepEqual(z, [1, 2]);
  assert.deepEqual(Object.keys(inp), ['zRangeM', 'maxInflight']);
  o.zRangeM[0] = 9;
  assert.equal(z[0], 1);
  assert.notEqual(checkOpts().zRangeM, checkOpts().zRangeM);
});

test('checkTile: 정수·범위', () => {
  assert.deepEqual(checkTile(3, -4), { tx: 3, ty: -4 });
  assert.deepEqual(checkTile(-0, 0), { tx: 0, ty: 0 });
  assert.deepEqual(checkTile(TILE_INDEX_MAX, -TILE_INDEX_MAX), { tx: TILE_INDEX_MAX, ty: -TILE_INDEX_MAX });
  assert.throws(() => checkTile('1', 0), T);
  assert.throws(() => checkTile(0, null), T);
  assert.throws(() => checkTile(undefined, 0), T);
  assert.throws(() => checkTile(0.5, 0), R);
  assert.throws(() => checkTile(0, NaN), R);
  assert.throws(() => checkTile(Infinity, 0), R);
  assert.throws(() => checkTile(TILE_INDEX_MAX + 1, 0), R);
  assert.throws(() => checkTile(0, -TILE_INDEX_MAX - 1), R);
});

test('checkView: poseToView 규칙에 위임', () => {
  const v = checkView(pose, size);
  assert.equal(v.width, 100);
  assert.equal(v.R.length, 9);
  assert.throws(() => checkView(null, size), T);
  assert.throws(() => checkView({ ...pose, pos: 'x' }, size), T);
  assert.throws(() => checkView({ ...pose, quat: [0, 0, 0, 0] }, size), R);
  assert.throws(() => checkView({ ...pose, fovY: 4 }, size), R);
  assert.throws(() => checkView(pose, null), T);
  assert.throws(() => checkView(pose, { width: 0, height: 10 }), R);
});
