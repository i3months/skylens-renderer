// F-125 ②: pointSizeM 이 없을 때 0.05 같은 기본값으로 대체되지 않음을 지키는 시험.
// 장면: 카메라 R = I, t = 0, fx = 400, 320×180, +z 방향을 본다.
//   앞층: z = 1.2 m 평면의 격자(간격 0.025 m = 화면 약 8 px, 법선은 카메라 쪽 (0,0,-1)).
//   뒤층: z = 1.7 m 평면의 같은 격자(앞층 뒤, 법선은 카메라 반대쪽 (0,0,1)).
//   pointSizeM = 0.05 이면 앞층 원판 반경이 1.2 m 에서 약 8 px 라 격자 간격(8 px)을 덮어 뒤층을 가린다 → 가림·뒷면 제거 > 0.
//   pointSizeM 이 없으면 원판 크기를 모르므로 제거는 정확히 0 이어야 한다(0.05 로 대체되면 이 시험이 실패).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHierarchy } from '../../lod/select/index.mjs';
import { cullAndSelect, loadDefaultImpls } from './index.mjs';
import { backfaceCull, leafNormalCones } from '../backface/index.mjs';

const CAM = { width: 320, height: 180, K: { fx: 400, fy: 400, cx: 160, cy: 90 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
const SIZE_M = 0.05, STEP = 0.025, NX = 40, NY = 24;

const pos = [], nor = [];
for (const [z, nz] of [[1.2, -1], [1.7, 1]]) {
  for (let i = 0; i < NX; i++) for (let j = 0; j < NY; j++) { pos.push((i - NX / 2) * STEP, (j - NY / 2) * STEP, z); nor.push(0, 0, nz); }
}
const n = pos.length / 3;
const cloud = { format: 1, count: n, positions: Float32Array.from(pos), normals: Float32Array.from(nor), colors: new Uint8Array(3 * n).fill(200) };
const h = buildHierarchy(cloud, { edge0M: 0.5, levelCount: 2, maxLeafPoints: 64 });

test('pointSizeM 있으면 뒷면·가림 제거 > 0, 없으면 정확히 0 (같은 시험에서 둘 다 단언)', async (t) => {
  const d = await loadDefaultImpls();
  for (const stage of ['backface', 'occlusion']) {
    const run = (extra) => cullAndSelect(h, CAM, { thresholdPx: 0.5, stages: [stage], stageImpls: d.stageImpls, orderChunks: d.orderChunks, isDegenerateView: d.isDegenerateView, ...extra });
    const withSize = run({ pointSizeM: SIZE_M }).cull.stats;
    const without = run({}).cull.stats;
    const key = stage === 'backface' ? 'removedBackface' : 'removedOcclusion';
    t.diagnostic(`${stage}: 리프 ${withSize.leafCount}, pointSizeM=0.05 제거 ${withSize[key]}, 없음 제거 ${without[key]}`);
    assert.ok(withSize[key] > 0, `${stage} pointSizeM=0.05 제거 ${withSize[key]}`);
    assert.equal(without[key], 0, `${stage} pointSizeM 없음 제거 ${without[key]}`);
  }
});

// backfaceCull 직접 호출: pointSizeM 을 생략하면 0.05 같은 값으로 대체되지 않고 제거 0, 0.05 를 주면 제거 > 0.
test('backfaceCull 직접 호출: pointSizeM 생략은 제거 0, 0.05 명시는 제거 > 0', () => {
  const cones = leafNormalCones(h);
  const removed = (m) => m.reduce((a, v) => a + (v === 0 ? 1 : 0), 0);
  const omitted = removed(backfaceCull(h, CAM, cones, {}));
  const omittedNoOpts = removed(backfaceCull(h, CAM, cones));
  const explicit = removed(backfaceCull(h, CAM, cones, { pointSizeM: SIZE_M }));
  assert.equal(omitted, 0, `생략 제거 ${omitted}`);
  assert.equal(omittedNoOpts, 0, `opts 없음 제거 ${omittedNoOpts}`);
  assert.ok(explicit > 0, `0.05 명시 제거 ${explicit}`);
});
