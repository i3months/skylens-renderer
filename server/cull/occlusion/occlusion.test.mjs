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
// 기준: 거짓 제거 0(MAX_FALSE_REMOVALS). 효과 하한은 측정값이 아니라 장면 구조에서 미리 정한다(F-119 ③):
//   flat_boxes 시점 4(street_level, 눈 높이 1.7 m, 원점 앵커 건물을 약 90 m 앞에서 정면으로 봄)와
//   시점 5(low_close_box, 눈 높이 3 m, (22,22) 앵커 건물을 약 25 m 앞에서 봄)는 각각 제거 ≥ 1.
//   이유: 생성기가 이 두 시점의 시선 위에 앵커 건물(바닥 8~14 m, 높이 12~40 m, ANCHORS)을 반드시 두고, 눈은 그 지붕보다 낮다.
//   그래서 건물 뒤 바닥은 장면 끝(z = −100)까지 화면에서 건물 윤곽 안에 든다(건물 아래쪽 행은 더 가까운 바닥이 덮는다).
//   점은 면적 비례(20만 점 / 약 5.6만 m² ≈ 3.6 점/m², 평균 간격 약 0.5 m < 점 지름 0.75 m)라 벽·바닥은 막힌 면으로 칠해진다.
//   바닥 리프는 팔진 트리 칸 200/32 = 6.25 m(6.25² × 3.6 ≈ 140 ≤ 256 점, 한 단계 위 12.5 m 는 약 560 점이라 쪼개짐).
//   fy ≈ 193(320×180, fov 50°), 0 단계 칸 5×2.8 px.
//   - 시점 5: 앵커 건물이 약 25 m 앞 → 폭 ≥ 8 m 가 약 60 px 이상. 그 뒤 바닥 리프(먼 쪽에서 리프 하나 + 여유 ≈ 10 px 남짓)는
//     덮인 칸 안에 넉넉히 든다.
//   - 시점 4: 앵커 건물 앞면이 약 86 m 앞 → 장면 끝(약 190 m)에서 건물이 가리는 띠는 ≥ 8·190/86 ≈ 18 px, 바닥 리프 사각형은
//     6.25 m ≈ 6.4 px + 양쪽 여유 약 1.4 px ≈ 10 px. 칸 정렬(5 px)로 양쪽 최대 4 px 를 잃어도 10 px 가 남아 먼 줄 리프 중
//     적어도 하나는 든다(여유가 좁아 하한을 1 로 둔다).
//   둘 중 한 곳이라도 0 이면 판정이 효과를 잃은 것이다(예: 피라미드가 비거나, 깊이 비교 방향이 뒤집히거나, 사각형이 화면 전체로
//   커짐, 가림막 상한·생략이 가까운 건물을 빼먹음). 높은 시점(1·2·3·6)은 내려다보아 가림이 보장되지 않고, 7·8 은 앵커 건물이
//   시선 위에 있다는 보장이 없어 하한을 두지 않는다.
//   하한을 1 보다 높이지 않는 이유(F-131 ⑧): 시점별 제거 수의 더 높은 하한은 기하만으로 논증되지 않는다. 제거되는 리프 수는 덮인 띠 안에
//   완전히 드는 리프의 수인데, 그것은 팔진 트리 분할 결과(리프 크기가 6.25 m 보다 크거나 작은 곳, 건물·상자 벽 리프와 섞이는 곳),
//   64×64 피라미드 칸 정렬, 가림막 상한 처리에 달려 있어 생성기가 보장하는 구조량이 아니다. 시점 4 는 여유가 이미 좁고(위 논증),
//   시점 5 는 여유가 넉넉해도 "몇 개"를 구조에서 정할 근거가 없다. 측정값(29·66)에 맞춰 사후에 하한을 잡지 않는다.
//   따라서 이 장면 시험은 '거짓 제거 0'과 '효과가 완전히 사라지지 않음(≥1)'만 확인한다. 제거 수를 줄이는 보수적 변이 중
//   일부(빈 블록 무시·점 크기·피라미드 최솟값 등 구조 변이)는 occlusion_unit.test.mjs 가, 깊이 허용오차를 키워 제거를 줄이는 변이는
//   occlusion_tolerance.test.mjs 가 판별한다. 그 밖의 보수적 변이(예: 제거 수만 줄이는 다른 상수)는 이 파일들이 판별한다고 주장하지 않는다.
//   하한은 측정값(29·66)에서 끌어낸 것이 아니라 위 구조 논증에서 나온 것이며, 측정값에 맞춰 올리거나 내리지 않는다.
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
    const rows = [], removedOf = {};
    for (const vp of VP) {
      const r = check(name, vp);
      rows.push(`${vp.id}:${r.removed}/${r.leaves}(보임 ${r.visible})`);
      removedOf[vp.id] = r.removed;
      assert.ok(r.falseRemoved <= MAX_FALSE_REMOVALS, `${name} 시점 ${vp.id} 거짓 제거 ${r.falseRemoved}`);
    }
    console.log(`# ${name} 제거/리프: ${rows.join(' ')}`);
    if (name === 'flat_boxes') {
      for (const id of [4, 5]) assert.ok(removedOf[id] >= 1, `flat_boxes 시점 ${id}(앵커 건물 앞 낮은 눈) 가림 제거 ${removedOf[id]} < 1`);
    }
  });
}

test('변이 4종은 장면 시점에서 거짓 제거를 낸다(시험이 잘못을 잡는지 확인)', () => {
  for (const mut of ['emptyAsOccluder', 'noShrink', 'noSplatMargin', 'pyramidMin']) {
    let total = 0;
    for (const vp of VP) total += check('flat_boxes', vp, { [mut]: true }).falseRemoved;
    assert.ok(total > 0, `변이 ${mut} 가 거짓 제거를 내지 않음`);
  }
});
