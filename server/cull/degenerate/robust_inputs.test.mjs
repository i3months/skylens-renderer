// F-143 ⑨: 접근자가 던지는 카메라, leafBoxesOf(null), 리프 0 개 계층은 서버·클라이언트 모두 'cull:' 오류.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCameraShape } from './index.mjs';
import { assertCameraShapeClient, clientFrustumCull, leafBoxesOf } from '../../../client/cull/index.mjs';
import { predictiveMask } from '../predict/index.mjs';

const good = () => ({ width: 64, height: 48, K: { fx: 100, fy: 100, cx: 32, cy: 24 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] });
const CULL = /^Error: cull:/;
const boom = () => { throw new RangeError('getter boom'); };
const withGetter = (obj, key) => Object.defineProperty(obj, key, { get: boom, enumerable: true });

test('접근자가 던지는 카메라 필드는 서버·클라이언트 모두 cull: 오류', () => {
  const cams = [];
  for (const k of ['width', 'height', 'K', 'R', 't']) cams.push(withGetter(good(), k));
  const kk = good(); withGetter(kk.K, 'fx'); cams.push(kk);
  const rr = good(); withGetter(rr.R, '4'); cams.push(rr);
  for (const c of cams) {
    assert.throws(() => assertCameraShape(c), CULL);
    assert.throws(() => assertCameraShapeClient(c), CULL);
    assert.throws(() => clientFrustumCull({ boxMin: new Float32Array(3), boxMax: new Float32Array(3) }, c), CULL);
  }
});

test('Proxy 카메라의 던지는 get 도 cull: 오류', () => {
  const p = new Proxy(good(), { get: boom });
  assert.throws(() => assertCameraShape(p), CULL);
  assert.throws(() => assertCameraShapeClient(p), CULL);
});

test('정상 카메라는 그대로 통과', () => {
  assert.doesNotThrow(() => assertCameraShape(good()));
  assert.doesNotThrow(() => assertCameraShapeClient(good()));
});

test('leafBoxesOf(null/undefined/비객체) 는 TypeError 가 아니라 cull: 오류', () => {
  for (const v of [null, undefined, 0, 'x']) assert.throws(() => leafBoxesOf(v), CULL);
});

test('리프 0 개 계층(F-145): octree 형식이 있으면 서버·클라이언트 모두 cull: 오류', () => {
  // 리프 0 개 계층은 구조 오류로 취급되며, 모든 단계가 같은 'cull:' 오류를 던진다.
  const octree = { leafCount: 0, nodeCount: 1, leafIndex: new Int32Array([-1]), boxMin: new Float32Array(3), boxMax: new Float32Array(3) };
  assert.throws(() => leafBoxesOf(octree), CULL);
  assert.throws(() => predictiveMask({ octree, levels: [] }, { camera: good() }, { horizonS: 1, steps: 1 }), CULL);
});
