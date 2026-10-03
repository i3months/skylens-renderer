// F-148 1: getter/Proxy 가 던지는 계층에서 cullAndSelect·cachedNormalCones 는 'cull:' 오류를 던진다. 정상 입력은 캐시 적중 그대로.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHierarchy } from '../../lod/select/index.mjs';
import { cullAndSelect, cachedNormalCones } from './index.mjs';

const CAM = { width: 64, height: 48, K: { fx: 60, fy: 60, cx: 32, cy: 24 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
function scene() {
  const pos = [], nor = [];
  for (let i = 0; i < 100; i++) { pos.push((i % 10) * 0.1 - 0.5, Math.floor(i / 10) * 0.1 - 1, 5); nor.push(0, 0, -1); }
  const n = pos.length / 3;
  return buildHierarchy({ format: 1, count: n, positions: Float32Array.from(pos), normals: Float32Array.from(nor), colors: new Uint8Array(3 * n).fill(200) },
    { edge0M: 0.5, levelCount: 2, maxLeafPoints: 16 });
}
const boom = () => { throw new TypeError('boom'); };
const ones = (h) => new Uint8Array(h.octree.leafCount).fill(1);
const OPTS = { thresholdPx: 0.5, stages: ['distance'], stageImpls: { distance: ones } };
const RX = /^Error: cull:/;

function variants() {
  const h = scene();
  const getterLevels = { ...h }; Object.defineProperty(getterLevels, 'levels', { get: boom, enumerable: true });
  const getterOctree = { ...h }; Object.defineProperty(getterOctree, 'octree', { get: boom, enumerable: true });
  const lvN = Object.create(h.levels[0]); Object.defineProperty(lvN, 'normals', { get: boom });
  const getterNormals = { ...h, levels: [lvN, ...h.levels.slice(1)] };
  const lvS = Object.create(h.levels[0]); Object.defineProperty(lvS, 'leafStart', { get: boom });
  const getterLeafStart = { ...h, levels: [lvS, ...h.levels.slice(1)] };
  const oc = Object.create(h.octree); Object.defineProperty(oc, 'leafCount', { get: boom });
  const getterLeafCount = { ...h, octree: oc };
  const proxyOctree = { ...h, octree: new Proxy(h.octree, { get: boom }) };
  const proxyLevels = { ...h, levels: new Proxy(h.levels, { get: boom }) };
  const proxyAll = new Proxy(h, { get: boom });
  return { getterLevels, getterOctree, getterNormals, getterLeafStart, getterLeafCount, proxyOctree, proxyLevels, proxyAll };
}

for (const [name, bad] of Object.entries(variants())) {
  test(`cullAndSelect: ${name} 는 cull: 오류`, () => {
    assert.throws(() => cullAndSelect(bad, CAM, OPTS), (e) => RX.test(String(e)));
  });
  test(`cachedNormalCones: ${name} 는 cull: 오류`, () => {
    assert.throws(() => cachedNormalCones(bad, () => ({})), (e) => RX.test(String(e)));
  });
}

test('정상 양성 대조: cullAndSelect 성공, 캐시는 같은 입력이면 적중 / 입력이 바뀌면 재계산', () => {
  const h = scene();
  const r = cullAndSelect(h, CAM, OPTS);
  assert.equal(r.cull.mask.length, h.octree.leafCount);
  let calls = 0;
  const compute = () => { calls++; return {}; };
  const c1 = cachedNormalCones(h, compute);
  assert.equal(cachedNormalCones(h, compute), c1);
  assert.equal(calls, 1);
  const h2 = { ...h, levels: [{ ...h.levels[0], normals: h.levels[0].normals.slice() }, ...h.levels.slice(1)] };
  cachedNormalCones(h2, compute);
  cachedNormalCones(h2, compute);
  assert.equal(calls, 2);
});
