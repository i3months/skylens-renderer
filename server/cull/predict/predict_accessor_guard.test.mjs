// F-148: 계층 읽기의 getter·Proxy 예외는 cull: 오류가 되고, 리프 0 개 계층도 cull: 오류다(F-145).
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../../../fixtures/scenes/terrain/index.mjs';
import { buildHierarchy } from '../../lod/hierarchy/index.mjs';
import { predictiveMask } from './index.mjs';

const K = { fx: 400, fy: 400, cx: 320, cy: 240 };
const cam = { width: 640, height: 480, K, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 40] };
const state = { camera: cam, velocityMps: [1, 0, 0], angularRadPerS: [0, 0, 0] };
const opts = { horizonS: 1, steps: 2 };
const g = generate({ seed: 3, count: 5000 });
const mk = () => buildHierarchy(g.cloud ?? g, { edge0M: 0.4, levelCount: 3, maxLeafPoints: 512 });
const CULL = /^Error: cull:/;
const boom = () => { throw new TypeError('boom'); };

test('양성 대조: 정상 계층이면 마스크 유지', () => {
  const h = mk();
  const m = predictiveMask(h, state, opts);
  assert.equal(m.length, h.octree.leafCount);
  assert.ok(m.some((v) => v === 1));
  assert.deepEqual(predictiveMask(mk(), state, opts), m);
});

test('octree 필드 getter 예외는 cull: 오류', () => {
  for (const f of ['leafCount', 'leafIndex', 'boxMin', 'boxMax']) {
    const h = mk();
    Object.defineProperty(h.octree, f, { get: boom });
    assert.throws(() => predictiveMask(h, state, opts), CULL, f);
  }
  const h = mk();
  Object.defineProperty(h, 'octree', { get: boom });
  assert.throws(() => predictiveMask(h, state, opts), CULL);
  const h2 = mk();
  Object.defineProperty(h2, 'levels', { get: boom });
  assert.throws(() => predictiveMask(h2, state, opts), CULL);
});

test('Proxy 예외는 cull: 오류', () => {
  const trap = { get() { throw new RangeError('proxy'); } };
  const h = mk();
  h.octree = new Proxy(h.octree, trap);
  assert.throws(() => predictiveMask(h, state, opts), CULL);
  const h2 = mk();
  assert.throws(() => predictiveMask(new Proxy(h2, trap), state, opts), CULL);
  const h3 = mk();
  h3.octree.boxMin = new Proxy(h3.octree.boxMin, trap);
  assert.throws(() => predictiveMask(h3, state, opts), CULL);
});

test('리프 0 개(leafCount 0, leafStart 길이 1)도 cull: 오류(F-145)', () => {
  const h = mk();
  h.octree.leafCount = 0;
  h.levels[0].leafStart = new Uint32Array(1);
  assert.throws(() => predictiveMask(h, state, opts), CULL);
});

test('리프 0 개: leafIndex 도 전부 비어 있어도 cull: 오류(leafCount<1 검사 자체를 고정)', () => {
  const h = mk();
  h.octree.leafCount = 0;
  h.octree.leafIndex = new Int32Array(h.octree.leafIndex.length).fill(-1);
  h.levels[0].leafStart = new Uint32Array(1);
  assert.throws(() => predictiveMask(h, state, opts), CULL);
});
