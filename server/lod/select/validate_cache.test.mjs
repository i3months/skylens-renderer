// F-121(assertCloud 부분)·F-122 ②⑧: 계층·점군 검사의 WeakMap 캐시.
//  - 같은 계층 객체의 두 번째 검사는 지문 비교만 한다(100만 점에서 1 ms 미만).
//  - cullAndSelect 한 번(앞의 assertHierarchyInput + 안의 selectLevels)에서 실제 검사는 계층마다 한 번.
//  - 계약(contracts/lod '검증 뒤 불변'): 검증 뒤 배열 내용을 제자리에서 바꾸면 캐시는 잡지 못한다. 이 동작을 여기서 고정한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { generate } from '../../../fixtures/scenes/flat_boxes/index.mjs';
import { viewpointToCamera } from '../../../tools/render_views/index.mjs';
import { buildHierarchy, assertHierarchyInput, assertCloudCached, selectLevels, validationStats } from './index.mjs';
import { cullAndSelect } from '../../cull/combine/index.mjs';

// 리프 하나·단계 하나인 계약상 올바른 계층(만들기 싸고 검사 비용은 점 수에 비례).
function bigHierarchy(n) {
  const positions = new Float32Array(3 * n);
  for (let i = 0; i < 3 * n; i++) positions[i] = (i % 1000) * 0.01;
  const cloud = { format: 1, count: n, positions, normals: new Float32Array(3 * n), colors: new Uint8Array(3 * n) };
  const ls = Uint32Array.from([0, n]);
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  return {
    cloud,
    edge0M: 0.05,
    octree: { nodeCount: 1, leafCount: 1, leafIndex: Int32Array.from([0]), boxMin: Float32Array.from([0, 0, 0]), boxMax: Float32Array.from([10, 10, 10]), leafStart: ls, order: idx },
    levels: [{ level: 0, edgeM: 0.05, count: n, indices: idx, leafStart: ls.slice(), positions, normals: cloud.normals, colors: cloud.colors }],
  };
}

test('N = 1e6: 첫 검사는 점 수에 비례, 같은 객체의 재검사(캐시 적중)는 1 ms 미만', () => {
  const h = bigHierarchy(1_000_000);
  const s0 = validationStats();
  let t = performance.now();
  assertHierarchyInput(h);
  const missMs = performance.now() - t;
  const hits = [];
  for (let i = 0; i < 50; i++) {
    t = performance.now();
    assertHierarchyInput(h);
    hits.push(performance.now() - t);
  }
  hits.sort((a, b) => a - b);
  const s1 = validationStats();
  assert.equal(s1.full - s0.full, 1, '실제 검사는 한 번');
  assert.equal(s1.cached - s0.cached, 50, '나머지는 캐시 적중');
  const median = hits[25], max = hits[49];
  console.log(`# validate N=1e6: miss ${missMs.toFixed(3)} ms, hit median ${median.toFixed(4)} ms, hit max ${max.toFixed(4)} ms`);
  assert.ok(median < 1, `캐시 적중 중앙값 ${median} ms < 1 ms`);
  // assertCloud 만 따로(캐시판)
  const c = bigHierarchy(1_000_000).cloud;
  t = performance.now();
  assertCloudCached(c);
  const cMiss = performance.now() - t;
  const cHits = [];
  for (let i = 0; i < 50; i++) {
    t = performance.now();
    assertCloudCached(c);
    cHits.push(performance.now() - t);
  }
  cHits.sort((a, b) => a - b);
  console.log(`# assertCloudCached N=1e6: miss ${cMiss.toFixed(3)} ms, hit median ${cHits[25].toFixed(4)} ms`);
  assert.ok(cHits[25] < 1, `assertCloudCached 적중 중앙값 ${cHits[25]} ms < 1 ms`);
});

test('cullAndSelect 한 번에 실제 계층 검사는 한 번(두 번째 호출부터는 0 번)', () => {
  const { cloud } = generate({ seed: 1, count: 3000 });
  const h = buildHierarchy(cloud, { edge0M: 0.5, levelCount: 3, maxLeafPoints: 256 });
  const cam = viewpointToCamera({ eye: [0, 120, 140], target: [0, 5, 0], up: [0, 1, 0], fov_y_deg: 50, width: 64, height: 48 });
  const ones = (hh) => new Uint8Array(hh.octree.leafCount).fill(1);
  const opts = { thresholdPx: 0.5, stages: ['frustum'], stageImpls: { frustum: ones } };
  const s0 = validationStats();
  const r1 = cullAndSelect(h, cam, opts);
  const s1 = validationStats();
  assert.equal(s1.full - s0.full, 1, '첫 호출: 실제 검사 1 번');
  assert.ok(s1.cached - s0.cached >= 1, '첫 호출 안의 selectLevels 재검사는 캐시 적중');
  const r2 = cullAndSelect(h, cam, opts);
  const s2 = validationStats();
  assert.equal(s2.full - s1.full, 0, '두 번째 호출: 실제 검사 0 번');
  assert.deepEqual(r2.selection, r1.selection);
});

function copyOf(base) {
  const o = base.octree;
  return {
    ...base,
    cloud: { ...base.cloud, positions: base.cloud.positions.slice() },
    octree: { ...o, leafIndex: o.leafIndex.slice(), boxMin: o.boxMin.slice(), boxMax: o.boxMax.slice() },
    levels: base.levels.map((l) => ({ ...l, leafStart: l.leafStart.slice() })),
  };
}
const { cloud: c0 } = generate({ seed: 2, count: 3000 });
const base = buildHierarchy(c0, { edge0M: 0.5, levelCount: 3, maxLeafPoints: 256 });

test('F-122 ②⑧ 고정: 검증 뒤 배열 내용을 제자리에서 바꾸면 캐시는 잡지 못한다(계약: 검증 뒤 불변)', () => {
  const cases = {
    'leafIndex[0] = -2': (h) => { h.octree.leafIndex[0] = -2; },
    'boxMin NaN': (h) => { h.octree.boxMin[4] = NaN; },
    'leafStart 끝값 변경': (h) => { const ls = h.levels[1].leafStart; ls[ls.length - 1] += 1; },
    'cloud.positions[0] = NaN': (h) => { h.cloud.positions[0] = NaN; },
  };
  for (const [name, fn] of Object.entries(cases)) {
    const h = copyOf(base);
    assert.doesNotThrow(() => assertHierarchyInput(h));
    fn(h);
    assert.doesNotThrow(() => assertHierarchyInput(h), `${name}: 같은 객체는 캐시 적중으로 통과(잡지 못함)`);
    // 같은 내용을 새 객체로 넘기면 처음부터 검사해 잡는다(규칙: 바꿔야 하면 새 객체로).
    assert.throws(() => assertHierarchyInput(copyOf(h)), /^Error: lod:/, `${name}: 새 객체는 잡음`);
  }
  // 점군 캐시판도 같다.
  const c = { ...base.cloud, positions: base.cloud.positions.slice() };
  assertCloudCached(c);
  c.positions[1] = NaN;
  assert.doesNotThrow(() => assertCloudCached(c));
  assert.throws(() => assertCloudCached({ ...c }), /^Error: lod:.*유한/);
});

test('검증 뒤 배열·객체를 바꿔 끼우거나 길이·수가 달라지면 매번 다시 검사한다', () => {
  const cases = {
    'levels[1].leafStart 교체': (h) => { const ls = h.levels[1].leafStart.slice(); ls[0] = 1; h.levels[1].leafStart = ls; },
    'levels[2] 객체 교체(colors 없음)': (h) => { const { colors, ...rest } = h.levels[2]; void colors; h.levels[2] = rest; },
    'levels 배열에서 단계 하나를 다른 것으로': (h) => { h.levels[0] = { ...h.levels[0], normals: h.levels[0].normals.subarray(3) }; },
    'cloud 교체(NaN 좌표)': (h) => { const p = h.cloud.positions.slice(); p[0] = NaN; h.cloud = { ...h.cloud, positions: p }; },
    'cloud.positions 교체': (h) => { const p = h.cloud.positions.slice(); p[0] = NaN; h.cloud.positions = p; },
    'cloud.count 변경': (h) => { h.cloud.count -= 1; },
    'nodeCount 변경': (h) => { h.octree.nodeCount = h.octree.leafCount - 1; },
  };
  for (const [name, fn] of Object.entries(cases)) {
    const h = copyOf(base);
    assert.doesNotThrow(() => assertHierarchyInput(h));
    fn(h);
    assert.throws(() => assertHierarchyInput(h), /^Error: lod:/, name);
    assert.throws(() => selectLevels(h, { width: 8, height: 8, K: { fx: 8, fy: 8, cx: 4, cy: 4 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }, { thresholdPx: 1 }), /^Error: lod:/, `${name} (selectLevels)`);
  }
});
