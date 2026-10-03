// T08.3 가림 컬링 장면 시험. 합성 장면 3종 × 고정 시점 8곳(fixtures/viewpoints/synthetic.json)에서
// 참조 래스터 renderPoints(원본 전체, 같은 점 크기)의 index 에 나타난 점이 속한 리프가 모두 마스크 1 인지(거짓 제거 0) 단언한다.
//
// 고정 파라미터(시험 리터럴):
//   장면     flat_boxes(상자 건물 12동, 가림이 생김) 200000 점 · terrain(완만한 지형) 100000 점 · holes(빈자리 6곳 평지) 100000 점, 시드 1.
//            fixtures/scenes/buildings 는 점군이 건물마다 지붕 중심점 1개뿐이라 가림막이 생기지 않아 flat_boxes 를 건물 장면으로 쓴다.
//   해상도 320×180(K 는 viewpointToCamera 가 같은 fov 로 다시 계산), POINT_SIZE_M 0.75(select.test 와 같음), size 64,
//   buildHierarchy edge0M 0.5, levelCount 1, maxLeafPoints 256.
//
// 기록(이 설정에서 측정, 리프 수 / 참조 렌더에 보이는 리프 / 가림 제거 / 거짓 제거):
//   flat_boxes(리프 1484): 시점 4 street_level 제거 29, 시점 5 low_close_box 66, 그 외 6곳 0. 거짓 0.
//   terrain·holes: 8곳 모두 제거 0(가리는 물체가 거의 없는 장면), 거짓 0.
//   → 이 거친 판정은 낮은 시점의 건물 뒤에서만 효과가 있다. 제거율 표는 보고에 남긴다.
// 기준(사후에 낮추지 않음): 거짓 제거 0(MAX_FALSE_REMOVALS), flat_boxes 8곳 제거 합 ≥ 95(측정값 그대로).
//
// 변이 확인(아래 마지막 시험): 빈 블록 무시(emptyAsOccluder) · 점 크기 줄이지 않음(noShrink) · 원판 반경 여유 없음(noSplatMargin)
//   · 피라미드 최솟값(pyramidMin) 네 가지 모두 이 장면들에서 거짓 제거를 낸다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildHierarchy } from '../../lod/hierarchy/index.mjs';
import { viewpointToCamera } from '../../../tools/render_views/index.mjs';
import { renderPoints } from '../../raster_ref/zbuffer/index.mjs';
import { MAX_FALSE_REMOVALS, assertLeafMask } from '../../../contracts/cull/index.mjs';
import { buildDepthPyramid, occlusionCull, buildDepthPyramidWith, occlusionCullWith } from './index.mjs';
import { generate as genFlat } from '../../../fixtures/scenes/flat_boxes/index.mjs';
import { generate as genTerrain } from '../../../fixtures/scenes/terrain/index.mjs';
import { generate as genHoles } from '../../../fixtures/scenes/holes/index.mjs';

const W = 320, H = 180, POINT_SIZE_M = 0.75, SIZE = 64;
const VP = JSON.parse(readFileSync(new URL('../../../fixtures/viewpoints/synthetic.json', import.meta.url), 'utf8')).viewpoints;
const SCENES = { flat_boxes: [genFlat, 200000], terrain: [genTerrain, 100000], holes: [genHoles, 100000] };
const cache = new Map();

function scene(name) {
  if (!cache.has(name)) {
    const [gen, count] = SCENES[name];
    const { cloud } = gen({ seed: 1, count });
    const h = buildHierarchy(cloud, { edge0M: 0.5, levelCount: 1, maxLeafPoints: 256 });
    const oc = h.octree;
    const leafOf = new Int32Array(cloud.count);
    for (let k = 0; k < oc.leafCount; k++) for (let s = oc.leafStart[k]; s < oc.leafStart[k + 1]; s++) leafOf[oc.order[s]] = k;
    cache.set(name, { cloud, h, leafOf, ref: new Map() });
  }
  return cache.get(name);
}
const camOf = (vp) => viewpointToCamera({ ...vp, width: W, height: H });

/** 참조 렌더에 보이는 리프(1) 표시. */
function visibleLeaves(sc, vp) {
  if (!sc.ref.has(vp.id)) {
    const r = renderPoints(camOf(vp), sc.cloud, { pointSizeM: POINT_SIZE_M, validate: false });
    const vis = new Uint8Array(sc.h.octree.leafCount);
    for (const i of r.index) if (i >= 0) vis[sc.leafOf[i]] = 1;
    sc.ref.set(vp.id, vis);
  }
  return sc.ref.get(vp.id);
}

function check(name, vp, mut) {
  const sc = scene(name), cam = camOf(vp);
  const mask = mut
    ? occlusionCullWith(sc.h, cam, buildDepthPyramidWith(sc.h, cam, { size: SIZE, pointSizeM: POINT_SIZE_M }, mut), mut)
    : occlusionCull(sc.h, cam, buildDepthPyramid(sc.h, cam, { size: SIZE, pointSizeM: POINT_SIZE_M }));
  assertLeafMask(mask, sc.h.octree.leafCount);
  const vis = visibleLeaves(sc, vp);
  let removed = 0, falseRemoved = 0, visible = 0;
  for (let k = 0; k < mask.length; k++) {
    if (vis[k]) visible++;
    if (!mask[k]) { removed++; if (vis[k]) falseRemoved++; }
  }
  return { leaves: mask.length, visible, removed, falseRemoved };
}

test('고정 시점 8곳', () => assert.equal(VP.length, 8));

for (const name of Object.keys(SCENES)) {
  test(`${name}: 시점 8곳에서 거짓 제거 0, 제거율 기록`, () => {
    const rows = [];
    let removedSum = 0;
    for (const vp of VP) {
      const r = check(name, vp);
      rows.push(`${vp.id}:${r.removed}/${r.leaves}(보임 ${r.visible})`);
      removedSum += r.removed;
      assert.ok(r.falseRemoved <= MAX_FALSE_REMOVALS, `${name} 시점 ${vp.id} 거짓 제거 ${r.falseRemoved}`);
    }
    console.log(`# ${name} 제거/리프: ${rows.join(' ')}`);
    if (name === 'flat_boxes') assert.ok(removedSum >= 95, `flat_boxes 가림 제거 합 ${removedSum} < 95`);
  });
}

test('변이 4종은 장면 시점에서 거짓 제거를 낸다(시험이 잘못을 잡는지 확인)', () => {
  for (const mut of ['emptyAsOccluder', 'noShrink', 'noSplatMargin', 'pyramidMin']) {
    let total = 0;
    for (const vp of VP) total += check('flat_boxes', vp, { [mut]: true }).falseRemoved;
    assert.ok(total > 0, `변이 ${mut} 가 거짓 제거를 내지 않음`);
  }
});
