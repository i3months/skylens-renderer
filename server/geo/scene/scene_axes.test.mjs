import test from 'node:test';
import assert from 'node:assert/strict';
import { enuArrayToScene, sceneArrayToEnu } from './index.mjs';
import { enuToScene, sceneToEnu, GeoError } from '../../../contracts/geo/index.mjs';

const f = (a) => Array.from(a);

test('scene_axes: 단위 벡터 동·북·위', () => {
  assert.deepEqual(f(enuArrayToScene(new Float64Array([1, 0, 0]))), [1, 0, 0]);
  assert.deepEqual(f(enuArrayToScene(new Float64Array([0, 1, 0]))), [0, 0, -1]);
  assert.deepEqual(f(enuArrayToScene(new Float64Array([0, 0, 1]))), [0, 1, 0]);
  assert.deepEqual(f(sceneArrayToEnu(new Float32Array([0, 0, -1]))), [0, 1, 0]);
});

test('scene_axes: 단일 점 계약 함수와 일치', () => {
  const p = [3.5, -7.25, 120];
  assert.deepEqual(f(enuArrayToScene(new Float64Array(p))), enuToScene(p));
});

test('scene_axes: 1만 점 왕복 f32 정밀도', () => {
  // mulberry32 고정 시드
  let s = 20240603;
  const rnd = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const N = 10000;
  const enu = new Float64Array(N * 3);
  for (let i = 0; i < enu.length; i++) enu[i] = (rnd() - 0.5) * 20000; // ±10 km
  const back = sceneArrayToEnu(enuArrayToScene(enu));
  let maxErr = 0, maxRel = 0;
  for (let i = 0; i < enu.length; i++) {
    const e = Math.abs(back[i] - enu[i]);
    maxErr = Math.max(maxErr, e);
    maxRel = Math.max(maxRel, e / Math.max(Math.abs(enu[i]), 1));
  }
  console.log(`max abs err = ${maxErr}, max rel err = ${maxRel}`);
  // f32 반올림 1회: 상대 오차 ≤ 2^-24, 절대 ≤ 1e4 * 2^-24 ≈ 6.0e-4
  assert.ok(maxRel <= 2 ** -24 * 1.0001, `rel ${maxRel}`);
  assert.ok(maxErr <= 6.1e-4, `abs ${maxErr}`);
  // f32 입력이면 정확히 일치
  const e32 = Float32Array.from(enu);
  assert.deepEqual(f(sceneArrayToEnu(enuArrayToScene(e32))), f(e32));
});

test('scene_axes: 입력 불변 및 새 배열', () => {
  const inp = new Float64Array([1, 2, 3, 4, 5, 6]);
  const copy = Float64Array.from(inp);
  const out = enuArrayToScene(inp);
  assert.deepEqual(inp, copy);
  assert.ok(out instanceof Float32Array);
  assert.notEqual(out.buffer, inp.buffer);
  const in32 = new Float32Array([1, 2, 3]);
  const out32 = sceneArrayToEnu(in32);
  assert.notEqual(out32, in32);
  assert.deepEqual(f(in32), [1, 2, 3]);
  assert.equal(enuArrayToScene(new Float32Array(0)).length, 0);
});

test('scene_axes: 오류 음성', () => {
  const isRange = (e) => e instanceof GeoError && e.code === 'range';
  for (const fn of [enuArrayToScene, sceneArrayToEnu]) {
    for (const bad of [new Float64Array(4), new Float32Array(1), new Float32Array(5)]) {
      assert.throws(() => fn(bad), isRange);
    }
    for (const v of [NaN, Infinity, -Infinity]) {
      for (let k = 0; k < 3; k++) {
        const a = new Float64Array([0, 0, 0, 1, 1, 1]);
        a[3 + k] = v;
        assert.throws(() => fn(a), isRange);
      }
    }
    assert.throws(() => fn([1, 2, 3]), isRange);
  }
});

test('scene_axes: 우수 좌표계 유지(행렬식 +1)', () => {
  // 기저 벡터를 변환해 열로 구성한 행렬의 행렬식
  const [a, b, c] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((v) => f(enuArrayToScene(new Float64Array(v))));
  const det =
    a[0] * (b[1] * c[2] - c[1] * b[2]) -
    b[0] * (a[1] * c[2] - c[1] * a[2]) +
    c[0] * (a[1] * b[2] - b[1] * a[2]);
  assert.equal(det, 1);
  // e×n = u 관계가 씬에서도 유지
  const cross = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  assert.deepEqual(cross.map((x) => x + 0), c);
});

test('scene_axes: 배열이 아닌 입력(객체 {e,n,u} 등)은 GeoError(range)(F-072)', () => {
  const isRange = (e) => e instanceof GeoError && e.code === 'range';
  for (const fn of [enuArrayToScene, sceneArrayToEnu]) {
    for (const bad of [{ e: 1, n: 2, u: 3 }, { x: 1, y: 2, z: 3 }, { 0: 1, 1: 2, 2: 3, length: 3 }, null, undefined, 3, 'abc']) {
      assert.throws(() => fn(bad), isRange);
    }
  }
});

test('scene_axes: −0 은 +0 으로 정규화, 계약 enuToScene·sceneToEnu 와 deepStrictEqual', () => {
  const show = (p) => p.map((v) => (Object.is(v, -0) ? '-0' : v)).join(',');
  const pts = [[1, 0, 2], [1, -0, 2], [-0, -0, -0], [0, 0, 0], [-0, 5, -0], [3.5, -0, 120]];
  for (const p of pts) {
    const arr = f(enuArrayToScene(new Float64Array(p)));
    assert.deepStrictEqual(arr, enuToScene(p), `enu ${show(p)}`);
    assert.ok(arr.every((v) => !Object.is(v, -0)), `씬에 −0 없음 ${show(p)}`);
    const back = f(sceneArrayToEnu(new Float32Array(p)));
    assert.deepStrictEqual(back, sceneToEnu(p), `scene ${show(p)}`);
    assert.ok(back.every((v) => !Object.is(v, -0)), `ENU 에 −0 없음 ${show(p)}`);
  }
});
