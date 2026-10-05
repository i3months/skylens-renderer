// 관제탑 화면 조립(T15.9). 계약: contracts/controlview/e2e.mjs(TOWER_E2E_API).
// 입력·추적·오버레이·스트리밍·폴백 모듈을 각자의 공개 index.mjs 로만 묶는다. 네트워크·타이머·난수를 쓰지 않는다.
// 한 프레임(step): 입력 적분 → 추적 목표 갱신 → 카메라 → 스트리밍 update. 던지면 상태 불변(검사 뒤 실패하면 이전 상태로 되돌린다).
// 원칙: 도착한 것만 그린다. fallback 모드에서는 3D 층 결과(camera·overlay·streaming)를 내지 않는다(null).
import { createTowerInput } from '../input/index.mjs';
import { createChaseCamera } from '../chase/index.mjs';
import { createTowerOverlay } from '../overlay/index.mjs';
import { createTowerStreaming } from '../streaming/index.mjs';
import { createTowerFallback } from '../fallback/index.mjs';

const OPT_KEYS = ['input', 'chase', 'overlay', 'streaming', 'fallback'];

function checkViewOpts(opts) {
  if (opts === undefined) return {};
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) throw new TypeError('opts 는 객체여야 한다');
  for (const k of Object.keys(opts)) {
    if (!OPT_KEYS.includes(k)) throw new RangeError(`알 수 없는 opts 키: ${k}`);
  }
  return opts;
}

// 모듈 opts 는 되살리기(재생성)에 다시 쓰므로 얕은 복사로 붙잡아 둔다(호출자가 나중에 고쳐도 영향 없음).
const copyOpts = (o) => (o === undefined ? undefined : { ...o });

const copyVec = (v) => [v[0], v[1], v[2]];

/**
 * createControlView(opts?) -> ControlView
 * opts: {input?, chase?, overlay?, streaming?, fallback?} 각 모듈 opts 를 그대로 넘긴다. 알 수 없는 키는 RangeError.
 */
export function createControlView(opts) {
  const o = checkViewOpts(opts);
  const inputOpts = copyOpts(o.input);
  const chaseOpts = copyOpts(o.chase);

  let input = createTowerInput(inputOpts);
  let chase = createChaseCamera(chaseOpts);
  const overlay = createTowerOverlay(o.overlay);
  const streaming = createTowerStreaming(o.streaming);
  const fallback = createTowerFallback(o.fallback);

  // 입력 되살리기용: 지금 눌린 키(입력 층이 받아들인 것만).
  const heldCodes = new Set();
  // 추적 상태 사본: 목표 유무, 마지막으로 넣은 목표, 마지막 감쇠 상태.
  let tracking = false;
  let chaseTarget = null; // {id, pos, yaw}
  let chaseCur = null; // {pos, yaw}
  // 추적에 쓸 드론 목록 사본(받은 그대로, 검사를 통과한 것만).
  let drones = [];
  // 폴백 되돌리기용 사본: 마지막으로 받아들인 탐지·경로.
  let detections = [];
  let paths = new Map(); // id -> path

  // 입력 층을 자세·눌린 키로 다시 만든다(실패한 step 되돌리기).
  function rebuildInput(pose) {
    const next = createTowerInput({ ...(inputOpts ?? {}), pos: copyVec(pose.pos), yaw: pose.yaw });
    for (const code of heldCodes) next.keyDown(code);
    input = next;
  }

  // 추적 층을 감쇠 상태·목표로 다시 만든다. 첫 setTarget 은 그 자리에 놓이고 두 번째는 목표만 바꾼다.
  function rebuildChase(wasTracking, cur, target) {
    const next = createChaseCamera(chaseOpts);
    if (wasTracking && cur !== null && target !== null) {
      next.setTarget(copyVec(cur.pos), cur.yaw);
      next.setTarget(copyVec(target.pos), target.yaw);
    }
    chase = next;
  }

  function activeCamera() {
    return tracking ? chase.camera() : input.camera();
  }

  function snapshot(size) {
    // 크기 검사는 폴백 frame 이 한다(overlay 와 같은 규칙). 상태를 바꾸지 않는다.
    const fb = fallback.frame(size);
    if (fb.mode === 'fallback') {
      return { mode: 'fallback', camera: null, overlay: null, streaming: null, fallback: fb };
    }
    const camera = activeCamera();
    const st = streaming.state();
    return {
      mode: 'live',
      camera: { pos: copyVec(camera.pos), quat: [...camera.quat], fovY: camera.fovY },
      overlay: overlay.project(camera, size),
      streaming: { held: st.held, inflight: st.inflight },
      fallback: fb,
    };
  }

  function step(dtSec, size) {
    if (typeof dtSec !== 'number') throw new TypeError('dtSec 는 number 여야 한다');
    if (!Number.isFinite(dtSec) || dtSec < 0) throw new RangeError('dtSec 는 유한 ≥ 0 이어야 한다');
    fallback.frame(size); // 크기 검사만(상태 불변)

    const savedPose = input.pose();
    const savedTracking = tracking;
    const savedTarget = chaseTarget;
    const savedCur = chaseCur;
    try {
      // 1) 입력 적분
      input.step(dtSec);
      // 2) 추적 목표 갱신: 드론이 있으면 첫 드론, 없으면 해제
      if (drones.length > 0) {
        const d = drones[0];
        // 방위가 없으면 같은 드론의 이전 목표 방위를 유지하고, 처음이면 0(북)으로 둔다.
        const yaw = d.yaw !== undefined ? d.yaw : (chaseTarget !== null && chaseTarget.id === d.id ? chaseTarget.yaw : 0);
        chase.setTarget(copyVec(d.enu), yaw);
        // 목표가 새로 생기면(또는 다른 드론으로 바뀌면) 옛 자리에서 날아오지 않게 컷 전환한다.
        if (!tracking || chaseTarget === null || chaseTarget.id !== d.id) chase.snap();
        tracking = true;
        chaseTarget = { id: d.id, pos: copyVec(d.enu), yaw };
        const s = chase.step(dtSec);
        chaseCur = { pos: copyVec(s.pos), yaw: s.yaw };
      } else {
        chase.clearTarget();
        tracking = false;
        chaseTarget = null;
        chaseCur = null;
      }
      // 3) 카메라 → 4) 스트리밍 update
      streaming.update(activeCamera(), size);
      return snapshot(size);
    } catch (err) {
      rebuildInput(savedPose);
      rebuildChase(savedTracking, savedCur, savedTarget);
      tracking = savedTracking;
      chaseTarget = savedTarget;
      chaseCur = savedCur;
      throw err;
    }
  }

  return {
    keyDown(code) {
      const ok = input.keyDown(code);
      if (ok) heldCodes.add(code);
      return ok;
    },
    keyUp(code) {
      const ok = input.keyUp(code);
      if (ok) heldCodes.delete(code);
      return ok;
    },
    releaseAll() {
      input.releaseAll();
      heldCodes.clear();
    },
    step,
    // 데이터는 폴백(검사가 더 엄격: |e|,|n| 상한) 먼저, 그다음 오버레이에 넣는다. 오버레이가 던지면 폴백을 이전 값으로 되돌린다.
    setDrones(list) {
      const prev = drones;
      fallback.setDrones(list);
      try {
        overlay.setDrones(list);
      } catch (err) {
        fallback.setDrones(prev);
        throw err;
      }
      drones = list.map((d) => (d.yaw === undefined ? { id: d.id, enu: copyVec(d.enu) } : { id: d.id, enu: copyVec(d.enu), yaw: d.yaw }));
    },
    setDetections(list) {
      const prev = detections;
      fallback.setDetections(list);
      try {
        overlay.setDetections(list);
      } catch (err) {
        fallback.setDetections(prev);
        throw err;
      }
      detections = list.map((d) => ({ ...d, enu: copyVec(d.enu) }));
    },
    setPath(path) {
      fallback.setPath(path);
      const id = path.id;
      try {
        overlay.setPath(path);
      } catch (err) {
        if (paths.has(id)) fallback.setPath(paths.get(id));
        else fallback.removePath(id);
        throw err;
      }
      paths.set(id, { id, points: path.points.map(copyVec) });
    },
    removePath(id) {
      const a = overlay.removePath(id);
      fallback.removePath(id);
      paths.delete(id);
      return a;
    },
    clear() {
      overlay.clear();
      fallback.clear();
      drones = [];
      detections = [];
      paths = new Map();
    },
    setAvailable(available) {
      fallback.setAvailable(available);
    },
    mode: () => fallback.mode(),
    arrived: (tx, ty) => streaming.arrived(tx, ty),
    failed: (tx, ty) => streaming.failed(tx, ty),
    snapshot,
  };
}
