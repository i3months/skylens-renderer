// 관제탑 건물 층(T15.3). 도착한 건물 묶음만 CPU 래스터로 그린다(없는 곳은 빈 화소, 메우지 않는다).
// 표시 옵션 3종(points / black / aerial)의 자료는 accept 한 번에 모두 들어오고, 옵션 전환은 로컬 상태만 바꾼다(네트워크 요청 0).
// 수준(딜레이 0..3)은 교체이고 추월당한 수준은 건너뛴다(contracts/levels). 좌표: GeoAnchor 기준 ENU, 1 unit = 1 m.
// 계약: contracts/controlview/buildings.mjs. 이 파일은 조립만 한다.
import { BUILDINGS_DEFAULTS } from '../../../contracts/controlview/buildings.mjs';
import { assertCamera, emptyResult } from '../../../contracts/raster/index.mjs';
import { createBuildingsState } from './levels.mjs';
import { createModeState } from './mode.mjs';
import { rasterizeFlat } from './raster_flat.mjs';
import { rasterizeTextured } from './raster_tex.mjs';
import { rasterizeLines } from './lines.mjs';
import { rasterizePoints } from './points.mjs';

/**
 * @param {{ mode?:string, lineRgb?:number[], pointRgb?:number[] }|null} [opts] null/undefined 는 기본값을 쓴다.
 */
export function createBuildingsLayer(opts) {
  const o = opts ?? {};
  const lineRgb = o.lineRgb ?? BUILDINGS_DEFAULTS.lineRgb;
  const pointRgb = o.pointRgb ?? BUILDINGS_DEFAULTS.pointRgb;
  const modeState = createModeState(o.mode);
  const state = createBuildingsState();
  const face = BUILDINGS_DEFAULTS.faceRgb;
  // 생성 시점에 색 인자를 한 번 검사한다(잘못된 값은 render 가 아니라 생성에서 던진다).
  rasterizeLines({ width: 1, height: 1, K: { fx: 1, fy: 1, cx: 0.5, cy: 0.5 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }, [], lineRgb, emptyResult(1, 1));
  rasterizePoints({ width: 1, height: 1, K: { fx: 1, fy: 1, cx: 0.5, cy: 0.5 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }, [], pointRgb, emptyResult(1, 1));

  return {
    /** @returns {'first'|'replace'|'skip'} skip 이면 상태를 바꾸지 않는다. 던지면 상태는 그대로다. */
    accept(level, bundle) {
      return state.accept(level, bundle);
    },
    setMode(mode) {
      modeState.set(mode);
    },
    mode() {
      return modeState.get();
    },
    render(camera) {
      assertCamera(camera);
      const out = emptyResult(camera.width, camera.height);
      const bundle = state.bundle();
      if (!bundle) return out;
      const mode = modeState.get();
      if (mode === 'points') rasterizePoints(camera, bundle.groups, pointRgb, out);
      else if (mode === 'aerial') rasterizeTextured(camera, bundle.groups, bundle.image, out);
      else {
        rasterizeFlat(camera, bundle.groups, () => face, out);
        rasterizeLines(camera, bundle.groups, lineRgb, out);
      }
      return out;
    },
    state() {
      const b = state.bundle();
      const buildingCount = b ? b.groups.reduce((n, g) => n + g.ids.length, 0) : 0;
      return { level: state.level(), groupCount: b ? b.groups.length : 0, buildingCount, mode: modeState.get() };
    },
  };
}
