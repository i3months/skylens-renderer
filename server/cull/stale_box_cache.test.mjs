// F-130: 같은 계층 객체에서 배열을 바꿔 끼운 뒤에도 딱 맞는 상자 캐시가 옛 입력의 상자를 쓰지 않는다.
// 계약(contracts/lod): 배열·객체를 바꿔 끼우면 지문이 달라져 다시 검증된다 → 상자 캐시도 같은 기준으로 다시 만든다.
import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { buildHierarchy } from '../lod/hierarchy/index.mjs';
import { generate as genFlat } from '../../fixtures/scenes/flat_boxes/index.mjs';
import { viewpointToCamera } from '../../tools/render_views/index.mjs';
import { buildDepthPyramid, occlusionCull } from './occlusion/index.mjs';
import { leafNormalCones, backfaceCull } from './backface/index.mjs';

const W = 320, H = 180, PS = 0.75;
const OPTS = { edge0M: 0.5, levelCount: 1, maxLeafPoints: 256 };
const VP = JSON.parse(readFileSync(new URL('../../fixtures/viewpoints/synthetic.json', import.meta.url), 'utf8')).viewpoints;
// 시점 5(낮은 눈, 건물 앞): occlusion·backface 2단계 모두 제거가 생긴다.
const cam = viewpointToCamera({ ...VP.find((v) => v.id === 5), width: W, height: H });

function shifted(cloud, dz) {
  const positions = Float32Array.from(cloud.positions);
  for (let i = 2; i < positions.length; i += 3) positions[i] += dz;
  return { ...cloud, positions };
}
const occ = (h) => occlusionCull(h, cam, buildDepthPyramid(h, cam, { pointSizeM: PS }));
const bface = (h) => backfaceCull(h, cam, leafNormalCones(h), { pointSizeM: PS });
const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };

// 옛 입력으로 캐시를 채운 객체에 hB 의 배열을 Object.assign 한 결과가 hB 로 새로 만든 객체와 같아야 한다.
function staleVsFresh(cull, dz) {
  const { cloud } = genFlat({ seed: 1, count: 200000 });
  const fresh = cull(buildHierarchy(shifted(cloud, dz), OPTS));
  const h = buildHierarchy(cloud, OPTS);
  cull(h);
  Object.assign(h, buildHierarchy(shifted(cloud, dz), OPTS));
  return { fresh, got: cull(h) };
}

test('F-130 occlusion: 배열을 바꿔 끼운 같은 객체의 결과가 새 객체와 같다', () => {
  const { fresh, got } = staleVsFresh(occ, 3);
  assert.ok(fresh.includes(0), '시험 장면에서 제거가 있어야 의미가 있다');
  assert.equal(diff(got, fresh), 0);
});

// backface 는 덮임 판정의 사각형만 상자에 의존해 이동량이 커야(dz=30) 판정이 바뀐다.
// 오라클은 같은 필드를 가진 새 객체(상자 캐시 없음)의 결과다.
function backfaceStaleVsFresh(swap, dz) {
  const { cloud } = genFlat({ seed: 1, count: 200000 });
  const h = buildHierarchy(cloud, OPTS);
  const before = bface(h);
  swap(h, buildHierarchy(shifted(cloud, dz), OPTS));
  const fresh = bface({ ...h, levels: h.levels.map((l) => ({ ...l })) });
  return { before, fresh, got: bface(h) };
}

test('F-130 backface: 배열을 바꿔 끼운 같은 객체의 결과가 같은 필드의 새 객체와 같다', () => {
  const { before, fresh, got } = backfaceStaleVsFresh((h, hNew) => Object.assign(h, hNew), 30);
  assert.ok(fresh.includes(0), '시험 장면에서 제거가 있어야 의미가 있다');
  assert.notEqual(diff(before, fresh), 0, '이동이 판정을 바꾸지 못하면 시험이 의미 없다');
  assert.equal(diff(got, fresh), 0);
});

// F-138 ④: positions만 교체(leafStart는 그대로)하는 사례
// 딱 맞는 상자 캐시가 positions 참조를 확인하지 않으면 캐시가 제거되지 않아 잘못된 결과가 생긴다.
function staleVsFreshPositionsOnly(cull, dz) {
  const { cloud } = genFlat({ seed: 1, count: 200000 });
  const fresh = cull(buildHierarchy(shifted(cloud, dz), OPTS));
  const h = buildHierarchy(cloud, OPTS);
  cull(h);
  // 새 계층을 만들지만 positions만 교체한다 (leafStart와 다른 properties는 유지)
  const hNew = buildHierarchy(shifted(cloud, dz), OPTS);
  h.levels[0].positions = hNew.levels[0].positions;
  return { fresh, got: cull(h) };
}

test('F-138 ④ occlusion: positions만 교체했을 때 결과가 새 객체와 같다', () => {
  const { fresh, got } = staleVsFreshPositionsOnly(occ, 3);
  assert.ok(fresh.includes(0), '시험 장면에서 제거가 있어야 의미가 있다');
  assert.equal(diff(got, fresh), 0);
});

test('F-138 ④ backface: positions만 교체했을 때 결과가 같은 필드의 새 객체와 같다', () => {
  const { before, fresh, got } = backfaceStaleVsFresh((h, hNew) => { h.levels[0].positions = hNew.levels[0].positions; }, 30);
  assert.ok(fresh.includes(0), '시험 장면에서 제거가 있어야 의미가 있다');
  assert.notEqual(diff(before, fresh), 0, '이동이 판정을 바꾸지 못하면 시험이 의미 없다');
  assert.equal(diff(got, fresh), 0);
});
