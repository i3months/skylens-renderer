// 관제탑 드론·경로·탐지 마커 조립(T15.6). 서명은 contracts/controlview/overlay.mjs 를 따른다.
// 동기 계산만 쓴다. 네트워크·타이머 없음. 받은 것만 그리고 지어내지 않는다.
import { checkOpts, checkDrones, checkDetections, checkPath, checkSize } from './validate.mjs';
import { createOverlayStore } from './store.mjs';
import { poseToView } from './view.mjs';
import { projectPoints, unprojectPoint } from './project.mjs';
import { clipPolyline } from './clip.mjs';

export function createTowerOverlay(opts) {
  const { nearM } = checkOpts(opts);
  const store = createOverlayStore();
  return {
    setDrones(list) { store.setDrones(checkDrones(list)); },
    setDetections(list) { store.setDetections(checkDetections(list)); },
    setPath(path) { store.setPath(checkPath(path)); },
    removePath(id) { return store.removePath(id); },
    clear() { store.clear(); },
    counts() { return store.counts(); },
    project(pose, size) {
      const sz = checkSize(size);
      const view = poseToView(pose, sz);
      const drones = store.drones();
      const detections = store.detections();
      const pd = projectPoints(view, drones).map((r, i) => (drones[i].yaw === undefined ? r : { ...r, yaw: drones[i].yaw }));
      const pt = projectPoints(view, detections).map((r, i) => {
        const d = detections[i];
        const o = { ...r, kind: d.kind };
        if (d.confidence !== undefined) o.confidence = d.confidence;
        return o;
      });
      const paths = store.paths().map((p) => ({ id: p.id, polylines: clipPolyline(view, p.points, nearM) }));
      return { drones: pd, detections: pt, paths };
    },
    unproject(pose, size, u, v, depth) {
      return unprojectPoint(poseToView(pose, checkSize(size)), u, v, depth);
    },
  };
}
