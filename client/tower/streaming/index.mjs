// 관제탑 조각 요청(T15.7) 조립. 계약: contracts/controlview/streaming.mjs.
// 상태는 held·inflight 두 집합뿐이다. 계산은 tilesInView·planRequests 에 맡기고, 던지면 상태를 바꾸지 않는다(계산 후 한 번에 반영).
// 네트워크·타이머를 쓰지 않는다.
import { TOWER_STREAMING_LIMITS } from '../../../contracts/controlview/streaming.mjs';
import { checkOpts, checkTile, checkView } from './validate.mjs';
import { tilesInView } from './visible.mjs';
import { planRequests, tileKey } from './plan.mjs';

const DEFAULT_DEPS = { tilesInView, planRequests, tileKey };

const sortedTiles = (set) =>
  [...set]
    .map((k) => {
      const [tx, ty] = k.split(',');
      return { tx: Number(tx), ty: Number(ty) };
    })
    .sort((a, b) => a.tx - b.tx || a.ty - b.ty);

const copyTiles = (list) => list.map((t) => ({ tx: t.tx, ty: t.ty }));

/** @param {object} [opts] @param {{tilesInView:Function, planRequests:Function, tileKey:Function}} [deps] 시험용 주입 */
export function createTowerStreaming(opts, deps = DEFAULT_DEPS) {
  const o = checkOpts(opts);
  const d = { ...DEFAULT_DEPS, ...deps };
  const maxTiles = TOWER_STREAMING_LIMITS.maxTilesPerUpdate;
  let held = new Set();
  let inflight = new Set();

  // 시점 → needed (상태를 바꾸지 않는다). 검사 위반은 여기서 던진다.
  function neededFor(pose, size) {
    const view = checkView(pose, size);
    const needed = d.tilesInView(view, o);
    if (needed.length > maxTiles) throw new RangeError(`needed ${needed.length} 개가 maxTilesPerUpdate(${maxTiles}) 를 넘는다`);
    return needed;
  }

  return {
    update(pose, size) {
      const needed = neededFor(pose, size);
      const center = [pose.pos[0], pose.pos[1]]; // poseToView 가 pos 형식을 이미 검사했다
      const r = d.planRequests({ needed, held: new Set(held), inflight: new Set(inflight), opts: o, center });
      held = new Set(r.held);
      inflight = new Set(r.inflight);
      const p = r.plan;
      return { needed: copyTiles(p.needed), request: copyTiles(p.request), cancel: copyTiles(p.cancel), evict: copyTiles(p.evict), deferred: copyTiles(p.deferred) };
    },
    arrived(tx, ty) {
      checkTile(tx, ty);
      const k = d.tileKey(tx, ty);
      if (!inflight.has(k)) return false;
      inflight.delete(k);
      held.add(k);
      return true;
    },
    failed(tx, ty) {
      checkTile(tx, ty);
      return inflight.delete(d.tileKey(tx, ty));
    },
    missing(pose, size) {
      return copyTiles(neededFor(pose, size).filter((t) => !held.has(d.tileKey(t.tx, t.ty))));
    },
    state() {
      return { held: sortedTiles(held), inflight: sortedTiles(inflight) };
    },
    reset() {
      held = new Set();
      inflight = new Set();
    },
  };
}
