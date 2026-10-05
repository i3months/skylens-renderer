// 관제탑 폴백 조립(T15.8). 서명은 contracts/controlview/fallback.mjs 를 따른다.
// 동기 계산만 쓴다. 네트워크·타이머 없음. 받은 것만 그리고 지어내지 않는다.
import { checkFallbackOpts, checkView, checkAvailable, checkEnuRange, checkDrones, checkDetections, checkPath, checkSize } from './validate.mjs';
import { createOverlayStore } from '../overlay/store.mjs';
import { fitView } from './view.mjs';
import { buildMarkers } from './markers.mjs';
import { buildPaths } from './paths.mjs';
import { createModeState } from './mode.mjs';
import { TOWER_FALLBACK_BANNER } from '../../../contracts/controlview/fallback.mjs';
import { TOWER_OVERLAY_LIMITS } from '../../../contracts/controlview/overlay.mjs';

export function createTowerFallback(opts) {
  const fitOpts = checkFallbackOpts(opts);
  const store = createOverlayStore();
  const modeState = createModeState();
  let manualView = null;
  return {
    setAvailable(v) { modeState.set(checkAvailable(v)); },
    mode() { return modeState.mode(); },
    setDrones(list) { store.setDrones(checkEnuRange(checkDrones(list))); },
    setDetections(list) { store.setDetections(checkEnuRange(checkDetections(list))); },
    setPath(path) {
      const checked = checkEnuRange(checkPath(path));
      if (!store.hasPath(checked.id) && store.counts().paths >= TOWER_OVERLAY_LIMITS.maxPaths) {
        throw new RangeError(`경로는 ${TOWER_OVERLAY_LIMITS.maxPaths} 개 이하여야 한다`);
      }
      store.setPath(checked);
    },
    removePath(id) { return store.removePath(id); },
    clear() { store.clear(); },
    counts() { return store.counts(); },
    setView(view) { manualView = checkView(view); },
    frame(size) {
      const sz = checkSize(size);
      const drones = store.dronesRaw();
      const detections = store.detectionsRaw();
      const paths = store.pathsRaw();
      const empty = drones.length === 0 && detections.length === 0 && paths.length === 0;
      if (modeState.mode() === 'live') return { mode: 'live', banner: null, empty, view: null, drones: [], detections: [], paths: [] };
      let view = manualView;
      if (view === null) {
        // 점을 직접 순회해 경계 상자만 갱신한다(점마다 배열 할당 0). 상자 모서리 두 점만 fitView 에 넘기므로 결과는 같다.
        let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
        let any = false;
        for (let i = 0; i < drones.length; i++) {
          const q = drones[i].enu;
          const e = q[0], n = q[1];
          if (e < minE) minE = e;
          if (e > maxE) maxE = e;
          if (n < minN) minN = n;
          if (n > maxN) maxN = n;
          any = true;
        }
        for (let i = 0; i < detections.length; i++) {
          const q = detections[i].enu;
          const e = q[0], n = q[1];
          if (e < minE) minE = e;
          if (e > maxE) maxE = e;
          if (n < minN) minN = n;
          if (n > maxN) maxN = n;
          any = true;
        }
        for (let k = 0; k < paths.length; k++) {
          const pp = paths[k].points;
          for (let i = 0; i < pp.length; i++) {
            const q = pp[i];
            const e = q[0], n = q[1];
            if (e < minE) minE = e;
            if (e > maxE) maxE = e;
            if (n < minN) minN = n;
            if (n > maxN) maxN = n;
            any = true;
          }
        }
        view = any ? fitView([[minE, minN], [maxE, maxN]], sz, fitOpts) : null;
      } else view = { ...view };
      if (view === null) return { mode: 'fallback', banner: TOWER_FALLBACK_BANNER, empty, view: null, drones: [], detections: [], paths: [] };
      return {
        mode: 'fallback', banner: TOWER_FALLBACK_BANNER, empty, view,
        drones: buildMarkers(view, sz, drones, false),
        detections: buildMarkers(view, sz, detections, true),
        paths: buildPaths(view, sz, paths),
      };
    },
  };
}
