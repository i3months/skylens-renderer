// F-120 회귀: 주입 없는 cullAndSelect 와 cullAndSelectDefault 가 퇴화 시점을 같은 규칙(isDegenerateView)으로 처리한다.
// 퇴화 카메라는 던지지 않고 빈 결과(마스크 0, 조각 없음, NOT_DRAWN, 점 0, stats.degenerate)를 돌려준다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../../../fixtures/scenes/terrain/index.mjs';
import { viewpointToCamera } from '../../../tools/render_views/index.mjs';
import { NOT_DRAWN } from '../../../contracts/lod/index.mjs';
import { buildHierarchy } from '../../lod/select/index.mjs';
import { cullAndSelect, cullAndSelectDefault } from './index.mjs';

const cloud = generate({ seed: 2, count: 20000 }).cloud;
const h = buildHierarchy(cloud, { edge0M: 0.5, levelCount: 3, maxLeafPoints: 512 });
const L = h.octree.leafCount;
const TAU = 0.5;
const ones = () => new Uint8Array(L).fill(1);
const stub = { frustum: ones, backface: ones, occlusion: ones, distance: ones };

const base = viewpointToCamera({ eye: [-120, 60, -120], target: [0, 10, 0], up: [0, 1, 0], width: 160, height: 90, fov_y_deg: 70 });
const withK = (cam, over) => ({ ...cam, ...over, K: { ...cam.K, ...(over.K ?? {}) } });
const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];

const DEGENERATE = {
  'width1·fx1e7': withK(base, { width: 1, height: 1, K: { fx: 1e7, fy: 1e7, cx: 0.5, cy: 0.5 } }),
  '8193x8193': withK(base, { width: 8193, height: 8193, K: { fx: 6000, fy: 6000, cx: 4096, cy: 4096 } }),
  '해상도 2e9': withK(base, { width: 2e9, height: 2e9 }),
  'R=2I': { ...base, R: I.map((x) => 2 * x) },
  '반사(det=-1)': { ...base, R: [1, 0, 0, 0, 1, 0, 0, 0, -1] },
  'NaN': withK(base, { K: { fx: NaN } }),
};

function assertEmpty(r, label) {
  assert.equal(r.cull.stats.degenerate, true, `${label} degenerate`);
  assert.equal(r.cull.mask.length, L, `${label} mask 길이`);
  assert.ok(r.cull.mask.every((v) => v === 0), `${label} mask 전부 0`);
  assert.equal(r.cull.chunks.length, 0, `${label} chunks 비어 있음`);
  assert.equal(r.cull.stats.removedFrustum, 0, `${label} removedFrustum`);
  assert.equal(r.cull.stats.kept, 0, `${label} kept`);
  assert.equal(r.selection.leafLevel.length, L);
  assert.ok(r.selection.leafLevel.every((v) => v === NOT_DRAWN), `${label} leafLevel 전부 NOT_DRAWN`);
  assert.equal(r.selection.pointCount, 0, `${label} pointCount`);
}

for (const [pointSizeM, tag] of [[undefined, 'pointSizeM 없음'], [0.05, 'pointSizeM 0.05']]) {
  const o = pointSizeM === undefined ? {} : { pointSizeM };
  for (const [name, cam] of Object.entries(DEGENERATE)) {
    test(`퇴화(${name}, ${tag}): cullAndSelect 주입 없음 → 빈 결과, 던지지 않음`, () => {
      assertEmpty(cullAndSelect(h, cam, { thresholdPx: TAU, stageImpls: stub, ...o }), name);
    });
    test(`퇴화(${name}, ${tag}): cullAndSelectDefault → 빈 결과, 던지지 않음`, async () => {
      assertEmpty(await cullAndSelectDefault(h, cam, { thresholdPx: TAU, ...o }), name);
    });
  }
  test(`정상 카메라(${tag}): 퇴화 아님`, async () => {
    const a = cullAndSelect(h, base, { thresholdPx: TAU, stageImpls: stub, ...o });
    assert.notEqual(a.cull.stats.degenerate, true);
    assert.ok(a.selection.pointCount > 0);
    const b = await cullAndSelectDefault(h, base, { thresholdPx: TAU, ...o });
    assert.notEqual(b.cull.stats.degenerate, true);
  });
}
