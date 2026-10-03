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

test('F-130 backface: 배열을 바꿔 끼운 같은 객체의 결과가 새 객체와 같다', () => {
  const { fresh, got } = staleVsFresh(bface, 60) // backface 는 덮임 판정의 사각형만 상자에 의존해 이동량이 커야 차이가 드러난다;
  assert.ok(fresh.includes(0), '시험 장면에서 제거가 있어야 의미가 있다');
  assert.equal(diff(got, fresh), 0);
});
