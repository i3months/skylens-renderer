// 관제탑 드레이프 층(T15.2). 지형 층이 그린 RenderResult 의 화소를 역투영해 ENU (x, y) 를 얻고, 도착한 위성 타일의 색으로 바꾼다.
// 계약: contracts/controlview/drape.mjs. 이 파일은 조립만 한다(unproject·sample·store·shade).
// 원칙: 도착한 타일만 입힌다. 타일이 없거나 coverage.mask 가 0 인 화소는 지형 색 그대로(메우지 않는다). 수준은 교체이고 추월당한 수준은 건너뛴다.
import { assertCamera } from '../../../contracts/raster/index.mjs';
import { pixelToEnu } from './unproject.mjs';
import { sampleDrape } from './sample.mjs';
import { createDrapeStore } from './store.mjs';
import { shadeRatio, applyRatio } from './shade.mjs';
import { TERRAIN_DEFAULTS } from '../../../contracts/controlview/terrain.mjs';

/** @param {{ shade?: boolean }|null} [opts] */
export function createDrapeLayer(opts) {
  const useShade = (opts ?? {}).shade ?? true;
  const store = createDrapeStore();
  return {
    accept(level, tiles) { return store.accept(level, tiles); },
    apply(camera, terrain, o) {
      assertCamera(camera);
      const { width, height } = camera;
      if (!terrain || terrain.width !== width || terrain.height !== height) throw new RangeError('drape: terrain 해상도가 카메라와 다르다');
      const baseRgb = (o ?? {}).baseRgb ?? TERRAIN_DEFAULTS.baseRgb;
      const out = { width, height, color: terrain.color.slice(), depth: terrain.depth.slice(), index: terrain.index.slice() };
      if (store.count() === 0) return out;
      for (let j = 0; j < height; j++) {
        for (let i = 0; i < width; i++) {
          const p = j * width + i;
          const d = terrain.depth[p];
          if (!(d > 0)) continue;
          const { x, y } = pixelToEnu(camera, i, j, d);
          const tile = store.lookup(x, y);
          if (!tile) continue;
          const rgb = sampleDrape(tile, x, y);
          if (!rgb) continue;
          const c = useShade
            ? applyRatio(rgb, shadeRatio([terrain.color[3 * p], terrain.color[3 * p + 1], terrain.color[3 * p + 2]], baseRgb))
            : rgb;
          out.color[3 * p] = c[0]; out.color[3 * p + 1] = c[1]; out.color[3 * p + 2] = c[2];
        }
      }
      return out;
    },
    state() { return { level: store.level(), tileCount: store.count() }; },
  };
}
