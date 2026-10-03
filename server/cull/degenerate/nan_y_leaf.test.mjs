// 계약: 리프 상자 좌표에 NaN 이 있으면 그 리프는 통과(거짓 제거 0). y 좌표만 NaN 인 리프가 세 컬링 함수에서 제거되던 버그의 회귀 시험.
// 원인: NaN 꼭짓점은 z>0·좌·우·위·아래 비교를 모두 거짓으로 만들어, 정상 꼭짓점만으로는 어떤 평면도 못 채울 때 리프가 밖으로 판정된다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../../../fixtures/scenes/flat_boxes/index.mjs';
import { viewpointToCamera } from '../../../tools/render_views/index.mjs';
import { buildHierarchy } from '../../lod/hierarchy/index.mjs';
import { frustumCull } from '../frustum/index.mjs';
import { predictiveMask } from '../predict/index.mjs';
import { clientFrustumCull, leafBoxesOf } from '../../../client/cull/index.mjs';

const { cloud } = generate({ seed: 1, count: 3000 });
const hier = buildHierarchy(cloud, { edge0M: 0.5, levelCount: 3, maxLeafPoints: 256 });
const oc = hier.octree;
const cams = [
  viewpointToCamera({ eye: [0, 120, 140], target: [0, 5, 0], up: [0, 1, 0], fov_y_deg: 50, width: 64, height: 48 }),
  viewpointToCamera({ eye: [0, 40, 60], target: [0, 5, 0], up: [0, 1, 0], fov_y_deg: 30, width: 64, height: 48 }),
];
const POINT = [undefined, 0.1];
const runs = {
  frustum: (cam, p) => frustumCull(hier, cam, { pointSizeM: p }),
  predict0: (cam, p) => predictiveMask(hier, { camera: cam }, { horizonS: 1, steps: 2, pointSizeM: p }),
  predictMove: (cam, p) => predictiveMask(hier, { camera: cam, velocityMps: [1, 0, 0], angularRadPerS: [0, 0.01, 0] }, { horizonS: 1, steps: 2, pointSizeM: p }),
  client: (cam, p) => clientFrustumCull(leafBoxesOf(oc), cam, { pointSizeM: p }),
};

for (const [name, run] of Object.entries(runs)) {
  for (const which of ['boxMin', 'boxMax']) {
    test(`${name}: ${which} 의 y 가 NaN 인 리프는 마스크에 남는다(모든 리프·카메라)`, () => {
      let checked = 0;
      for (const cam of cams) for (const p of POINT) {
        const base = run(cam, p);
        for (let node = 0; node < oc.nodeCount; node++) {
          const k = oc.leafIndex[node];
          if (k < 0 || !base[k]) continue; // 정상에서 남던 리프만
          const arr = oc[which], i = 3 * node + 1, saved = arr[i];
          arr[i] = NaN;
          try { assert.equal(run(cam, p)[k], 1, `leaf ${k} (${which}.y = NaN) 가 제거됨`); } finally { arr[i] = saved; }
          checked++;
        }
      }
      assert.ok(checked > 0);
    });
  }
}

test('정상 입력 출력은 NaN 시험 뒤에도 그대로', () => {
  for (const run of Object.values(runs)) assert.deepEqual(run(cams[0], 0.1), run(cams[0], 0.1));
  assert.ok(frustumCull(hier, cams[0], { pointSizeM: 0.1 }).some((v) => v === 1));
});
