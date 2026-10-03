// T08.10 퇴화 시점 시험. 기준값은 모두 시험 안의 숫자다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generate } from '../../../fixtures/scenes/flat_boxes/index.mjs';
import { viewpointToCamera } from '../../../tools/render_views/index.mjs';
import { buildHierarchy } from '../../lod/hierarchy/index.mjs';
import { isDegenerateView, emptyMask, assertHierarchyForCull } from './index.mjs';

const { cloud } = generate({ seed: 1, count: 3000 });
const hier = buildHierarchy(cloud, { edge0M: 0.5, levelCount: 3, maxLeafPoints: 256 });
const vps = JSON.parse(readFileSync(new URL('../../../fixtures/viewpoints/synthetic.json', import.meta.url), 'utf8'));
const vpList = Array.isArray(vps) ? vps : (vps.viewpoints ?? Object.values(vps));

const good = () => viewpointToCamera({ eye: [0, 120, 140], target: [0, 5, 0], up: [0, 1, 0], fov_y_deg: 50, width: 64, height: 48 });
const clone = (c) => structuredClone(c);

test('정상 카메라: 고정 시점 8곳은 퇴화가 아님', () => {
  assert.equal(vpList.length, 8);
  for (const vp of vpList) assert.equal(isDegenerateView(viewpointToCamera({ ...vp, width: 64, height: 48 })), false);
  assert.equal(isDegenerateView(good()), false);
});

test('지면 아래 카메라(위·아래를 봄)는 퇴화가 아님', () => {
  let ymin = Infinity;
  for (let i = 0; i < hier.octree.nodeCount; i++) ymin = Math.min(ymin, hier.octree.boxMin[3 * i + 1]);
  const y = ymin - 50;
  for (const [target, up] of [[[0, y + 100, 0], [0, 0, -1]], [[0, y - 100, 0], [0, 0, -1]], [[30, y + 1, 40], [0, 1, 0]]]) {
    const cam = viewpointToCamera({ eye: [0, y, 0], target, up, fov_y_deg: 50, width: 64, height: 48 });
    assert.equal(isDegenerateView(cam), false);
  }
});

test('NaN/Infinity/-Infinity 를 필드별로 넣으면 모두 퇴화이고 던지지 않음(30가지)', () => {
  const muts = [];
  for (const v of [NaN, Infinity, -Infinity]) {
    muts.push((c) => { c.K.fx = v; }, (c) => { c.K.fy = v; }, (c) => { c.K.cx = v; }, (c) => { c.K.cy = v; });
    muts.push((c) => { c.width = v; }, (c) => { c.height = v; });
    muts.push((c) => { c.R[0] = v; }, (c) => { c.R[8] = v; });
    muts.push((c) => { c.t[0] = v; }, (c) => { c.t[2] = v; });
  }
  assert.equal(muts.length, 30);
  for (const m of muts) { const c = good(); m(c); assert.equal(isDegenerateView(c), true); }
});

test('해상도 0·음수, fx=0, 화각 0, 비회전 R, t 길이 오류', () => {
  const cases = {
    'width 0': (c) => { c.width = 0; }, 'height 0': (c) => { c.height = 0; },
    'width 음수': (c) => { c.width = -64; }, 'height 음수': (c) => { c.height = -1; },
    'fx 0': (c) => { c.K.fx = 0; }, 'fy 0': (c) => { c.K.fy = 0; }, 'fx 음수': (c) => { c.K.fx = -100; },
    '화각 0(fx 1e12)': (c) => { c.K.fx = 1e12; }, '화각 0(fy 1e12)': (c) => { c.K.fy = 1e12; },
    'R 스케일 2': (c) => { c.R = c.R.map((x) => 2 * x); }, 'R 영행렬': (c) => { c.R = new Array(9).fill(0); },
    'R 반사(det -1)': (c) => { c.R = [1, 0, 0, 0, 1, 0, 0, 0, -1]; },
    'R 전단': (c) => { c.R = [1, 0.1, 0, 0, 1, 0, 0, 0, 1]; },
    'R 길이 8': (c) => { c.R = c.R.slice(0, 8); }, 'R 문자열': (c) => { c.R = 'abc'; },
    't 길이 2': (c) => { c.t = [0, 0]; }, 't 길이 4': (c) => { c.t = [0, 0, 0, 0]; }, 't 없음': (c) => { delete c.t; },
    'K 없음': (c) => { delete c.K; }, 'fx 문자열': (c) => { c.K.fx = '100'; },
  };
  for (const [name, m] of Object.entries(cases)) { const c = clone(good()); m(c); assert.equal(isDegenerateView(c), true, name); }
});

test('시야각 경계: 1e-6 rad 미만은 퇴화, 그 이상(1e-3 rad)은 정상', () => {
  const c = good();
  c.K.fx = c.width / (2 * Math.tan(0.5e-6 / 2)); // 가로 시야각 0.5e-6
  c.K.fy = c.K.fx;
  assert.equal(isDegenerateView(c), true);
  const d = good();
  d.K.fx = d.width / (2 * Math.tan(1e-3 / 2)); d.K.fy = d.K.fx; // 1e-3 rad
  assert.equal(isDegenerateView(d), false);
});

test('undefined/null/문자열/숫자/배열 카메라와 던지는 접근자도 던지지 않고 true', () => {
  for (const c of [undefined, null, 'camera', 7, true, [], {}, () => 1]) assert.equal(isDegenerateView(c), true);
  const evil = good();
  Object.defineProperty(evil, 'K', { get() { throw new Error('boom'); } });
  assert.equal(isDegenerateView(evil), true);
});

test('emptyMask: 길이 leafCount 의 전부 0', () => {
  const m = emptyMask(hier);
  assert.ok(m instanceof Uint8Array);
  assert.equal(m.length, hier.octree.leafCount);
  assert.ok(hier.octree.leafCount > 1);
  assert.equal(m.reduce((a, b) => a + b, 0), 0);
  const c = good(); c.K.fx = NaN;
  assert.equal(isDegenerateView(c), true);
  assert.equal(emptyMask(hier).some((v) => v !== 0), false);
});

test('assertHierarchyForCull: 정상은 통과, 변조 계층은 cull: 로 던지고 원인 보존', () => {
  assert.doesNotThrow(() => assertHierarchyForCull(hier));
  const bad = {
    '길이 틀림': (h) => { h.octree.leafIndex = h.octree.leafIndex.subarray(1); },
    'boxMin 길이': (h) => { h.octree.boxMin = h.octree.boxMin.subarray(3); },
    'colors 없음': (h) => { delete h.levels[0].colors; },
  };
  for (const [name, fn] of Object.entries(bad)) {
    const h = { ...hier, octree: { ...hier.octree }, levels: hier.levels.map((l) => ({ ...l })) };
    fn(h);
    assert.throws(() => assertHierarchyForCull(h), (e) => e.message.startsWith('cull:') && !e.message.includes('lod:') && e.message.length > 10, name);
    assert.throws(() => emptyMask(h), /^Error: cull:/, name);
  }
  assert.throws(() => assertHierarchyForCull(null), /^Error: cull:/);
  assert.throws(() => assertHierarchyForCull(undefined), /^Error: cull:/);
});

test('해상도 경계: 8192x8192(=2^26)는 정상, 8193x8193·2^13 x (2^13+1)은 퇴화', () => {
  const sized = (w, h) => { const c = good(); c.width = w; c.height = h; return c; };
  assert.equal(isDegenerateView(sized(8192, 8192)), false);
  assert.equal(isDegenerateView(sized(8193, 8193)), true);
  assert.equal(isDegenerateView(sized(8192, 8193)), true);
  assert.equal(isDegenerateView(sized(8193, 8191)), false); // 67,100,863 < 2^26
  assert.equal(isDegenerateView(sized(1, 2 ** 26 + 1)), true);
  assert.equal(isDegenerateView(sized(2 ** 26 + 1, 1)), true);
  assert.equal(isDegenerateView(sized(64.5, 48)), true);
  assert.equal(isDegenerateView(sized(64, 48.5)), true);
});

test('해상도 한 변 경계: 1e6 은 정상(픽셀 수 허용 시), 1e6+1 은 퇴화', () => {
  const sized = (w, h) => { const c = good(); c.width = w; c.height = h; return c; };
  assert.equal(isDegenerateView(sized(1e6, 1)), false);
  assert.equal(isDegenerateView(sized(1e6 + 1, 1)), true);
  assert.equal(isDegenerateView(sized(1, 1e6 + 1)), true);
  assert.equal(isDegenerateView(sized(1e6, 67)), false);
  assert.equal(isDegenerateView(sized(1e6, 68)), true);
});

test('60000x60000 은 퇴화이고 빠르게 판정한다', () => {
  const c = good(); c.width = 60000; c.height = 60000;
  const t0 = performance.now();
  assert.equal(isDegenerateView(c), true);
  assert.ok(performance.now() - t0 < 100);
});

test('R 거의 직교 경계: 오차 1e-6 이하는 정상, 그 위는 퇴화', () => {
  const rot = (d) => { const c = good(); c.R = [1 + d, 0, 0, 0, 1, 0, 0, 0, 1]; return c; };
  assert.equal(isDegenerateView(rot(4e-7)), false);
  assert.equal(isDegenerateView(rot(-4e-7)), false);
  assert.equal(isDegenerateView(rot(2e-6)), true);
  assert.equal(isDegenerateView(rot(-2e-6)), true);
  const skew = (e) => { const c = good(); c.R = [1, e, 0, 0, 1, 0, 0, 0, 1]; return c; };
  assert.equal(isDegenerateView(skew(5e-7)), false);
  assert.equal(isDegenerateView(skew(2e-6)), true);
});
