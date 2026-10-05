// 건물 층 대 독립 참조(광선 추적) 비교. 시드 1~6 × 카메라 3종 × 옵션 3종.
// 기준값은 이 파일 안 숫자: 면 화소 일치율·점 화소 일치율 하한.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBuildingsLayer } from './index.mjs';
import { makeBundle, makeCameras } from './fixtures.mjs';
import { refRenderBuildings } from './ref_trace.mjs';
import { DISPLAY_MODES } from '../../../contracts/tower_assets/index.mjs';

const SEEDS = [1, 2, 3, 4, 5, 6];
const MIN_FACE_AGREE = 0.99; // 면 화소(점유·색) 일치율 하한. 불일치는 삼각형 경계 화소뿐이어야 한다.
const MAX_DEPTH_ERR = 1e-3; // 같은 화소를 둘 다 덮을 때 깊이 오차(m)

test('층 render 는 광선 추적 참조와 일치한다(시드 6 × 카메라 3 × 옵션 3)', () => {
  const cams = makeCameras({ width: 160, height: 90 });
  let total = 0;
  for (const seed of SEEDS) {
    const bundle = makeBundle(seed, { count: 6 });
    const layer = createBuildingsLayer();
    layer.accept(3, bundle);
    for (const cam of cams) {
      for (const mode of DISPLAY_MODES) {
        layer.setMode(mode);
        const got = layer.render(cam);
        // black 은 모서리 선 화소가 경계에서 달라질 수 있어 면만 비교한다(선은 lines.test 가 검증).
        const ref = refRenderBuildings(cam, bundle, mode, { lines: false });
        const n = cam.width * cam.height;
        let agree = 0; let covered = 0; let worst = 0;
        for (let p = 0; p < n; p++) {
          const g = got.depth[p] > 0; const r = ref.depth[p] > 0;
          if (mode === 'black' && g && got.color[3 * p] > 0) { agree++; continue; } // 선 화소(검정이 아님)는 비교에서 제외
          if (g || r) covered++;
          if (g === r) {
            if (!g) { agree++; continue; }
            // 색은 채널당 ±3(원근 보간 반올림 차이)까지 같다고 본다. uv 방향이 뒤집히면 이 비교가 크게 어긋난다.
            const same = got.index[p] === ref.index[p]
              && Math.abs(got.color[3 * p] - ref.color[3 * p]) <= 3 && Math.abs(got.color[3 * p + 1] - ref.color[3 * p + 1]) <= 3 && Math.abs(got.color[3 * p + 2] - ref.color[3 * p + 2]) <= 3;
            const dz = Math.abs(got.depth[p] - ref.depth[p]);
            if (same) agree++;
            worst = Math.max(worst, dz);
          }
        }
        total++;
        assert.ok(covered > 0 || mode === 'points', `seed ${seed} ${cam.name} ${mode}: 덮인 화소 0`);
        const rate = agree / n;
        assert.ok(rate >= MIN_FACE_AGREE, `seed ${seed} ${cam.name} ${mode}: 일치율 ${rate.toFixed(4)} < ${MIN_FACE_AGREE}`);
        assert.ok(worst <= MAX_DEPTH_ERR, `seed ${seed} ${cam.name} ${mode}: 깊이 오차 ${worst}`);
      }
    }
  }
  assert.equal(total, 54);
});
